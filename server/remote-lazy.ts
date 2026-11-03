import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ServerMessage } from "../shared/protocol.ts";
import { asciiLower, isRemoteOn, parseRemoteConfig, type RemoteConfig } from "../shared/remote.ts";
import { DEFAULT_FILE_TRANSFER, type FileTransfer } from "../shared/transfer.ts";
import type { RemoteAiHooks } from "./remote-ai.ts";
import type { RemoteAuth, RemoteIdentity } from "./remote-auth.ts";
import type { RemoteService } from "./remote-routes.ts";

/**
 * Remote access, loaded only when it is used.
 *
 * The remote chain (`remote-auth.ts`, `remote-routes.ts`, `remote-tunnel.ts`) is a few thousand lines of code the
 * server needs for nothing else: it verifies Cloudflare Access tokens, runs `cloudflared` and keeps the settings of
 * the tunnel. Remote access is off unless the settings file says so, and a server that never turns it on should not
 * pay for it: the chain is loaded the first time something needs it, and never at all when nothing does.
 *
 * What needs the chain, and when:
 *
 *   - a request that may be a remote one (`RemoteAuth.verify`, `isPublicHost`): every request, since the server does
 *     not know the public hostname before the settings are read. While the settings say remote access is off, the
 *     request is a local one and the chain is not loaded.
 *   - the remote settings themselves (`/api/remote*`): the page asks for them, and the chain is loaded then.
 *   - the tunnel the server starts with the app (`LazyRemote.start`): only when the settings ask for it.
 *
 * The settings are read from the file with the same parser the chain uses (`shared/remote.ts`), so the decision to
 * load the chain is made by the same file the chain would read: a file that is not valid settings, or settings that
 * are off, means remote access off, and no chain.
 */

/** What the loader needs of the chain. */
interface Chain {
	auth: RemoteAuth;
	service: RemoteService;
}

/** The remote access, loaded when it is first needed. */
export class LazyRemote {
	private chain: Chain | null = null;
	private loading: Promise<Chain> | null = null;
	private readonly listeners = new Set<() => void>();
	/** The settings file, as `remote-config.ts` names it. */
	private readonly file: string;
	/** The settings as they were read without the chain; null while they are off. */
	private off: RemoteConfig | null = null;
	/** What the settings file looked like when it was read: its modification time and size. */
	private stamp = "";

	constructor(
		private readonly dataDir: string,
		/** Said to every open page. */
		private readonly broadcast: (msg: ServerMessage) => void,
		/** The address the server listens on (the tunnel carries requests to it). */
		private readonly host: string,
		private readonly port: () => number,
		/** What the AI help needs of the server (see `RemoteAiHooks`); without it "Set up with AI" is refused. */
		private readonly ai?: RemoteAiHooks,
		/** Told the settings after the card (or the AI help) saved a change of them. */
		private readonly onSaved?: (config: RemoteConfig) => void,
	) {
		this.file = process.env.OMP_WEBUI_REMOTE_CONFIG || join(dataDir, "remote.json");
	}

	/**
	 * The settings in force, or null while remote access is off. Without the chain they are read from the file, with
	 * the same parser the chain uses; with it, the chain's own reader answers.
	 */
	settings(): RemoteConfig | null {
		if (this.chain) return this.chain.auth.current();
		return this.readOff();
	}

	/** What the settings file said about the three switches below when it was last read, and how the file looked then. */
	private confirm = false;
	private transfer: FileTransfer = DEFAULT_FILE_TRANSFER;
	private shell = true;
	private switchStamp: string | null = null;

	/**
	 * Look at the file for the switches that are read without the chain, again whenever the file changes: "Confirm risky
	 * commands from remote pages" (off unless the file says so), the file transfer (on in both directions unless the
	 * file says otherwise) and shells for remote pages (on unless the file says otherwise). They are read whether or not
	 * remote access is on (the person may set them first). A file that is there and cannot be read or trusted says no to
	 * all of them, as it does for remote access itself.
	 */
	private readSwitches(): void {
		let stamp = "";
		try {
			const stat = statSync(this.file);
			stamp = `${stat.mtimeMs}:${stat.size}`;
		} catch {
			// No file: the defaults.
		}
		if (stamp === this.switchStamp) return;
		this.switchStamp = stamp;
		if (stamp === "") {
			this.confirm = false;
			this.transfer = DEFAULT_FILE_TRANSFER;
			this.shell = true;
			return;
		}
		try {
			const config = parseRemoteConfig(JSON.parse(readFileSync(this.file, "utf8")));
			this.confirm = config.confirmRisky;
			this.transfer = config.fileTransfer ?? DEFAULT_FILE_TRANSFER;
			this.shell = config.remoteShell;
		} catch {
			this.confirm = false;
			this.transfer = "off";
			this.shell = false;
		}
	}

	/** Whether "Confirm risky commands from remote pages" is on. The chain is not needed for it. */
	confirmRisky(): boolean {
		this.readSwitches();
		return this.confirm;
	}

	/** What a page that is not on this computer may do with the files of a conversation's folder (see `shared/transfer.ts`). */
	fileTransfer(): FileTransfer {
		this.readSwitches();
		return this.transfer;
	}

	/** Whether a page that is not on this computer may open a shell in the Terminal tab (see `RemoteConfig.remoteShell`). */
	remoteShell(): boolean {
		this.readSwitches();
		return this.shell;
	}

	/**
	 * The settings in the file, or null when there is no file, it cannot be read, or it is not settings that are on.
	 *
	 * The file is read again when it changes: the person turns remote access on by writing to it, and that must take
	 * effect without a restart of the server (the chain, once loaded, reads it itself on every request).
	 */
	private readOff(): RemoteConfig | null {
		let stamp = "";
		try {
			const stat = statSync(this.file);
			stamp = `${stat.mtimeMs}:${stat.size}`;
		} catch {
			// No file: remote access is off.
		}
		if (stamp === this.stamp) return this.off;
		this.stamp = stamp;
		if (!stamp) {
			this.off = null;
			return null;
		}
		let raw: unknown;
		try {
			raw = JSON.parse(readFileSync(this.file, "utf8"));
		} catch {
			this.off = null;
			return null;
		}
		try {
			// The same parser the chain uses, so that what is decided here and what it reads are the same thing.
			const config = parseRemoteConfig(raw);
			this.off = isRemoteOn(config) ? config : null;
		} catch {
			this.off = null;
		}
		return this.off;
	}

	/** The chain, loaded. It is loaded once, whatever asks for it first. */
	private async load(): Promise<Chain> {
		if (this.chain) return this.chain;
		if (!this.loading) {
			this.loading = (async () => {
				const [{ RemoteAuth }, { RemoteService }] = await Promise.all([
					import("./remote-auth.ts"),
					import("./remote-routes.ts"),
				]);
				const auth = new RemoteAuth(this.file, { certsUrl: process.env.OMP_WEBUI_ACCESS_CERTS_URL });
				const service = new RemoteService({
					dataDir: this.dataDir,
					host: this.host,
					port: this.port(),
					broadcast: this.broadcast,
					ai: this.ai,
					onSaved: this.onSaved,
				});
				auth.onChange(() => {
					for (const listener of this.listeners) listener();
				});
				this.chain = { auth, service };
				return this.chain;
			})();
		}
		return this.loading;
	}

	/** Whether `host` is the public hostname (and remote access is on). */
	isPublicHost(host: string | null): boolean {
		if (this.chain) return this.chain.auth.isPublicHost(host);
		const settings = this.readOff();
		return settings !== null && host !== null && asciiLower(host) === settings.hostname;
	}

	/** Who `req` is from, when it is a remote request that may be served. */
	async verify(req: Request): Promise<RemoteIdentity | null> {
		// Nothing to verify while remote access is off: the request is a local one, and the chain is not loaded.
		if (!this.chain && !this.readOff()) return null;
		const chain = await this.load();
		return chain.auth.verify(req);
	}

	/** The answer of a request for `/api/remote*` from a connection from `peer`; null when it is not one. */
	async handle(req: Request, url: URL, peer: string | undefined): Promise<Response | null> {
		// The path is checked before the chain is loaded: a request for anything else must not load it.
		const path = url.pathname;
		if (path !== "/api/remote" && !path.startsWith("/api/remote/")) return null;
		const chain = await this.load();
		return chain.service.handle(req, url, peer);
	}

	/** The settings as the card shows them (the chain is loaded for them, as for the card). */
	async config(): Promise<RemoteConfig> {
		return (await this.load()).service.snapshot().config;
	}

	/** Change the settings as the card's Save does (`RemoteService.saveConfig`): refused whole when a value does not fit. */
	async saveConfig(patch: Partial<RemoteConfig>): Promise<void> {
		await (await this.load()).service.saveConfig(patch);
	}

	/**
	 * The chain is loaded and started: the tunnel comes up when the settings ask for it.
	 *
	 * A tunnel a crashed server left behind is ended even when the settings do not ask for a tunnel: that is what the
	 * record of it (a file beside the settings) is for. The chain is loaded for that only when the record is there.
	 */
	start(): void {
		if (!this.readOff() && !this.hasLeftover()) return;
		void (async () => {
			const chain = await this.load();
			await chain.service.autostart();
		})().catch((e: unknown) => {
			console.warn(`omp-webui: remote access could not be started: ${e instanceof Error ? e.message : String(e)}`);
		});
	}

	/** Whether a tunnel a former server left behind is on record: it is to be ended. */
	private hasLeftover(): boolean {
		return existsSync(join(this.dataDir, "cloudflared.pid"));
	}

	/** The server is going away: the tunnel (and what it started) ends first. */
	async stop(): Promise<void> {
		if (!this.chain) return;
		await this.chain.service.close();
	}

	/** Called whenever the settings in force change. */
	onChange(listener: () => void): void {
		this.listeners.add(listener);
	}
}
