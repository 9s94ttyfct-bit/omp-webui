import { dirname, join } from "node:path";
import { isRecord } from "../shared/guards.ts";
import type { ServerMessage } from "../shared/protocol.ts";
import {
	isRemoteOn,
	parseRemoteConfigPatch,
	type RemoteConfig,
	RemoteConfigError,
	type RemoteLogin,
	type RemoteSnapshot,
	remoteUrl,
} from "../shared/remote.ts";
import type { RemoteCheck } from "../shared/remote-ai.ts";
import { RemoteAi, type RemoteAiHooks } from "./remote-ai.ts";
import { checkAddress } from "./remote-check.ts";
import { RemoteStore, remoteConfigPath } from "./remote-config.ts";
import { Tunnel, TunnelError, type TunnelTimings } from "./remote-tunnel.ts";
import { isThisComputer } from "./this-computer.ts";

/**
 * The HTTP API of remote access (`/api/remote*`) and the one `Tunnel` the server runs. The API is for the person at this
 * computer: a request that came through the tunnel, or over a network address the server listens on, is refused,
 * whatever it carries. A remote page that could change the tunnel or the allow-list could let anybody in.
 *
 * What a button of the card does is a method here (`saveConfig`, `install`, `login`, `setup`, `start`, `stop`, `check`),
 * and a route only reads its request and answers with the snapshot. The AI help (`RemoteAi`) calls the same methods, so
 * what the agent can do is what the card can, checked by the same code.
 */

type Env = Record<string, string | undefined>;

export interface RemoteOptions {
	dataDir: string;
	/** The address and port the server listens on (`OMP_WEBUI_HOST`), and the port it got. */
	host: string;
	port: number;
	/** Said to every open page. */
	broadcast: (msg: ServerMessage) => void;
	env?: Env;
	home?: string;
	/** Where Homebrew's programs are, searched after `PATH` (specs have none). */
	extraDirs?: string[];
	timings?: Partial<TunnelTimings>;
	/** What starting a conversation for the AI help needs of the server; without it "Set up with AI" is refused. */
	ai?: RemoteAiHooks;
	/** Told the settings after a change of them was saved (main ends remote pages' shells when they are turned off). */
	onSaved?: (config: RemoteConfig) => void;
}

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const fail = (error: string, status: number) => json({ error }, status);

/** The API, the tunnel and the settings it changes. */
export class RemoteService {
	readonly store: RemoteStore;
	readonly tunnel: Tunnel;
	/** The AI help: the switch, and the tools of the conversations that were started with it. */
	readonly ai: RemoteAi;
	private readonly env: Env;

	constructor(private readonly opts: RemoteOptions) {
		const env = opts.env ?? process.env;
		this.env = env;
		this.store = new RemoteStore(remoteConfigPath(opts.dataDir, env));
		this.tunnel = new Tunnel({
			dataDir: opts.dataDir,
			port: () => opts.port,
			host: opts.host,
			store: this.store,
			env,
			home: opts.home,
			extraDirs: opts.extraDirs,
			timings: opts.timings,
			onStatus: (status) => opts.broadcast({ t: "remote", status }),
		});
		// Beside the settings, wherever they are kept (a spec points them at a directory of its own).
		const settings = remoteConfigPath(opts.dataDir, env);
		this.ai = new RemoteAi(
			this,
			{ file: join(dirname(settings), "remote-ai.json"), folder: join(opts.dataDir, "remote-help") },
			opts.ai ?? null,
			() => this.announce(),
		);
	}

	snapshot(): RemoteSnapshot {
		const config = this.store.read();
		const loginUrl = this.tunnel.loginPending();
		return {
			config,
			status: this.tunnel.status(),
			installed: this.tunnel.installed(),
			loggedIn: this.tunnel.loggedIn(),
			url: remoteUrl(config.hostname),
			...(loginUrl === null ? {} : { loginUrl }),
			ai: this.ai.state(),
		};
	}

	/** Tell every open page that something changed: its card asks again. */
	announce(): void {
		this.opts.broadcast({ t: "remote", status: this.tunnel.status() });
	}

	// ------------------------------------------------------------------ what the card's buttons do

	/** Change the settings. Refused whole (`RemoteConfigError`) when a value does not fit. Turned off, the tunnel has nothing to carry. */
	async saveConfig(patch: Partial<RemoteConfig>): Promise<RemoteSnapshot> {
		this.store.patch(patch);
		if (patch.enabled === false) await this.tunnel.stop();
		this.opts.onSaved?.(this.store.read());
		this.announce();
		return this.snapshot();
	}

	async install(): Promise<RemoteSnapshot> {
		await this.tunnel.install();
		return this.snapshot();
	}

	async login(): Promise<RemoteLogin> {
		const loginUrl = await this.tunnel.login();
		return { ...this.snapshot(), loginUrl };
	}

	async setup(): Promise<RemoteSnapshot> {
		await this.tunnel.setup();
		return this.snapshot();
	}

	async start(): Promise<RemoteSnapshot> {
		await this.tunnel.start();
		return this.snapshot();
	}

	async stop(): Promise<RemoteSnapshot> {
		// Off means off: the part of the server that lets remote requests in reads `enabled`, and refuses at once.
		this.store.patch({ enabled: false });
		await this.tunnel.stop();
		return this.snapshot();
	}

	/** Look at the public address from outside (see `checkAddress`). */
	async check(): Promise<RemoteCheck> {
		const { hostname, team } = this.store.read();
		if (hostname === "") throw new TunnelError("Set a hostname first", 400);
		return checkAddress(hostname, team, this.env.OMP_WEBUI_REMOTE_CHECK_URL || undefined);
	}

	/**
	 * What a server does when it comes up: a tunnel that the last one left behind (it crashed) is ended whatever the
	 * settings say, since it carries the hostname to a port where this server may not listen; then the tunnel starts with
	 * the app when the person asked for that and everything it needs is there.
	 */
	async autostart(): Promise<void> {
		await this.tunnel.reapLeftover().catch((e: unknown) => {
			console.warn(`omp-webui: a tunnel left by an earlier server could not be ended: ${(e as Error).message}`);
		});
		const config = this.store.read();
		if (!config.autostart || !isRemoteOn(config) || !config.tunnelId || !this.tunnel.installed()) return;
		try {
			await this.tunnel.start();
		} catch (e) {
			console.warn(`omp-webui: the remote tunnel did not start with the app: ${(e as Error).message}`);
		}
	}

	close(): Promise<void> {
		return this.tunnel.close();
	}

	// ------------------------------------------------------------------ the routes

	/**
	 * The answer to `req` when it is one for `/api/remote*`; null when it is not. `peer` is the address its connection is
	 * from: the API is for the person at this computer (see `isThisComputer`), whatever address the server listens on.
	 */
	async handle(req: Request, url: URL, peer: string | undefined): Promise<Response | null> {
		const path = url.pathname;
		if (path !== "/api/remote" && !path.startsWith("/api/remote/")) return null;
		if (!isThisComputer(req, peer)) return fail("Remote access is managed from this computer only", 403);
		try {
			return await this.answer(req, path);
		} catch (e) {
			if (e instanceof TunnelError) return fail(e.message, e.status);
			if (e instanceof RemoteConfigError) return fail(e.message, 400);
			throw e;
		}
	}

	private async answer(req: Request, path: string): Promise<Response> {
		if (path === "/api/remote") return req.method === "GET" ? json(this.snapshot()) : fail("GET required", 405);
		if (req.method !== "POST") return fail("POST required", 405);
		switch (path) {
			case "/api/remote/config":
				return json(await this.saveConfig(parseRemoteConfigPatch(await req.json().catch(() => null))));
			case "/api/remote/install":
				return json(await this.install());
			case "/api/remote/login":
				return json(await this.login());
			case "/api/remote/setup":
				return json(await this.setup());
			case "/api/remote/start":
				return json(await this.start());
			case "/api/remote/stop":
				return json(await this.stop());
			case "/api/remote/check":
				return json(await this.check());
			case "/api/remote/ai": {
				// The switch is the person's: only this route turns it on or off, and only for a request that is theirs.
				const body: unknown = await req.json().catch(() => null);
				if (!isRecord(body) || typeof body.enabled !== "boolean")
					throw new RemoteConfigError("enabled must be true or false");
				await this.ai.setEnabled(body.enabled);
				return json(this.snapshot());
			}
			case "/api/remote/ai/start":
				return json(await this.ai.start());
			default:
				return fail("Not found", 404);
		}
	}
}
