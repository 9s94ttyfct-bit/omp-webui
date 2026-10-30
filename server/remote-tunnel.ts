import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { isRecord } from "../shared/guards.ts";
import {
	isTunnelId,
	isTunnelName,
	missingRemoteSettings,
	type RemoteState,
	type RemoteStatus,
	withoutLinks,
} from "../shared/remote.ts";
import { childEnv } from "./env.ts";
import { commandOf } from "./instance.ts";
import { isExecutableFile, which } from "./omp/install.ts";
import { type Ran, RunTimeout, run } from "./omp/run.ts";
import type { RemoteStore } from "./remote-config.ts";

/**
 * Remote access is a `cloudflared` the server runs: it carries `https://<hostname>` to this server, and Cloudflare Access
 * asks for a login in front of it. This is everything the server does with that program: find it, install it (Homebrew),
 * log in to Cloudflare, make the tunnel and point the hostname at it, run it, tell what it is doing, keep it running and
 * stop it with the server.
 *
 * What takes a moment and ends is a command bounded by a limit (`run`); what goes on (the login that waits for the
 * browser, the install, the tunnel itself) is a process the server reads line by line, also with a limit where it can
 * have one. Nothing here is started that the server does not also stop.
 */

/** A step that cannot be done, with what the page shows and the HTTP status the API answers it with. */
export class TunnelError extends Error {
	constructor(
		message: string,
		readonly status = 400,
	) {
		super(message);
	}
}

/** How long each thing may take, and how the tunnel is brought back; the specs shorten them. */
export interface TunnelTimings {
	/** `cloudflared tunnel create` and `route dns`: a call to Cloudflare. */
	quickMs: number;
	/** `brew install cloudflared`. */
	installMs: number;
	/** How long `cloudflared tunnel login` has to print the URL. */
	loginUrlMs: number;
	/** How long the login waits for the person to finish in the browser. */
	loginMs: number;
	/** How long a tunnel has to end after the polite signal before it is killed. */
	stopGraceMs: number;
	/** The waits before a tunnel that ended is started again: each one longer, the last one repeated. */
	backoffMs: number[];
	/** A tunnel that ran this long before it ended starts the waits over. */
	stableMs: number;
}

export const DEFAULT_TIMINGS: TunnelTimings = {
	quickMs: 60_000,
	installMs: 15 * 60_000,
	loginUrlMs: 30_000,
	loginMs: 10 * 60_000,
	stopGraceMs: 5_000,
	backoffMs: [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000],
	stableMs: 30_000,
};

type Env = Record<string, string | undefined>;

export interface TunnelOptions {
	dataDir: string;
	/** The port the server listens on, which the tunnel carries requests to. */
	port: () => number;
	/** The address the server listens on (`OMP_WEBUI_HOST`); loopback when it is not given. */
	host?: string;
	store: RemoteStore;
	/** The environment programs are found in and run with (`PATH`, `OMP_WEBUI_CLOUDFLARED`, `OMP_WEBUI_BREW`). */
	env?: Env;
	/** Where `~/.cloudflared` is. */
	home?: string;
	/** Where Homebrew puts what it installs, searched after `PATH`: a Finder launch has little of it. */
	extraDirs?: string[];
	/** Told whenever what the page shows of the tunnel changes. */
	onStatus?: (status: RemoteStatus) => void;
	timings?: Partial<TunnelTimings>;
}

/** What a process that is read line by line came to. */
interface Outcome {
	/** Null when a signal ended it. */
	code: number | null;
	timedOut: boolean;
}

/** A process the server reads line by line. It is in a process group of its own, which is what a signal goes to. */
interface Streamed {
	proc: Bun.Subprocess;
	done: Promise<Outcome>;
	/** The last lines it printed, joined: what it said when it failed. */
	tail(): string;
}

/** A line after the browser-less login URL appears: cloudflared prints it on a line of its own. */
const URL_PATTERN = /https?:\/\/[^\s"'<>]+/;
/** What `cloudflared tunnel create` says: `Created tunnel <name> with id <uuid>`. */
const CREATED_ID = /with id (\S+)/;
/** One of cloudflared's own log lines at the level that tells something went wrong. */
const ERROR_LINE = /^\S+\s+(?:ERR|FTL)\s+(.*)$/;
const REGISTERED = /Registered tunnel connection\b.*?\bconnIndex=(\d+)/;
const UNREGISTERED = /Unregistered tunnel connection\b.*?\bconnIndex=(\d+)/;
/** A line of what a program said is cut to this, for a page's status line. */
const MESSAGE_MAX = 300;
/** The status line is updated at most this often while a command prints (brew prints many lines a second). */
const NOTE_PUSH_MS = 250;
/** Where Homebrew installs, which a program started from Finder has no `PATH` for. */
const HOMEBREW_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

/** `signal` to the process group `proc` leads (it was started `detached`), or to the process when it is not one. */
function signalGroup(proc: Bun.Subprocess, signal: NodeJS.Signals): void {
	try {
		process.kill(-proc.pid, signal);
	} catch {
		try {
			proc.kill(signal);
		} catch {
			// already gone
		}
	}
}

/** The lines of a text, split on every kind of line end (a progress bar redraws with `\r`). */
const LINE_END = /\r\n|\n|\r/;

/**
 * Start `argv` and read what it prints, line by line, as it prints it. With `timeoutMs` it is killed (with what it
 * started) at the limit. Resolves when it has ended and what it printed has been read.
 */
function spawnStreamed(
	argv: string[],
	opts: { env: Env; timeoutMs?: number; onLine: (line: string) => void },
): Streamed {
	let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
	try {
		proc = Bun.spawn(argv, {
			env: opts.env,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			detached: true,
		});
	} catch (e) {
		throw new TunnelError(`${argv[0]} could not be run: ${(e as Error).message}`, 502);
	}
	const tail: string[] = [];
	const pump = async (stream: ReadableStream<Uint8Array>): Promise<void> => {
		const decoder = new TextDecoder();
		let pending = "";
		const take = (line: string) => {
			const text = Bun.stripANSI(line).trim();
			if (!text) return;
			tail.push(text);
			if (tail.length > 8) tail.shift();
			opts.onLine(text);
		};
		for await (const chunk of stream) {
			pending += decoder.decode(chunk, { stream: true });
			const lines = pending.split(LINE_END);
			pending = lines.pop() ?? "";
			for (const line of lines) take(line);
		}
		take(pending + decoder.decode());
	};
	const pumps = Promise.all([pump(proc.stdout), pump(proc.stderr)]);
	// After the process has ended what it printed is read to its end, but a grandchild that kept the pipes open must not hold this.
	pumps.catch(() => {});
	let timedOut = false;
	const timer =
		opts.timeoutMs === undefined
			? undefined
			: setTimeout(() => {
					timedOut = true;
					signalGroup(proc, "SIGKILL");
				}, opts.timeoutMs);
	const done = (async (): Promise<Outcome> => {
		await proc.exited;
		clearTimeout(timer);
		await Promise.race([pumps.catch(() => {}), Bun.sleep(300)]);
		return { code: proc.signalCode === null ? proc.exitCode : null, timedOut };
	})();
	return { proc, done, tail: () => tail.slice(-3).join(" ") };
}

/** `text` for a status line: one line, cut. */
const brief = (text: string): string => (text.length > MESSAGE_MAX ? `${text.slice(0, MESSAGE_MAX - 1)}…` : text);

/** The address the tunnel reaches this server at, from the address the server listens on. */
function originAddress(host: string | undefined): string {
	if (!host || host === "0.0.0.0") return "127.0.0.1";
	if (host === "::") return "[::1]";
	return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

const seconds = (ms: number): string => (ms < 1000 ? `${ms} ms` : `${Math.round(ms / 1000)} s`);

export class Tunnel {
	private readonly store: RemoteStore;
	private readonly env: Env;
	private readonly home: string;
	private readonly dirs: string[];
	private readonly timings: TunnelTimings;
	private readonly pidFile: string;
	private readonly configFile: string;

	/** What the tunnel is doing, and what it said; `note` is what a command in progress says, which goes in front. */
	private state: RemoteState = "off";
	private message: string | undefined;
	private note: string | null = null;
	private announced = JSON.stringify({ state: "off" } satisfies RemoteStatus);
	private notePushedAt = 0;
	private noteTimer: NodeJS.Timeout | undefined;

	/** The name of the step that is running: one at a time. */
	private busy: string | null = null;
	/** The login that waits for the browser, and the answer to whoever asked for it (its URL). */
	private loginAsk: Promise<string> | null = null;
	/** The URL of the login that waits for the browser, until it ends (see `loginPending`). */
	private loginUrl: string | null = null;
	/** Every process the server started for a step, to end with the server. */
	private readonly streams = new Set<Streamed>();

	/** The tunnel is wanted running: a tunnel that ends is started again. Cleared by `stop`. */
	private wanted = false;
	private child: Streamed | null = null;
	/** Counts the runs: what a run that was stopped says afterwards is not about the one that replaced it. */
	private generation = 0;
	private connections = new Set<number>();
	private lastError: string | undefined;
	private startedAt = 0;
	private attempt = 0;
	private restartTimer: NodeJS.Timeout | undefined;
	private closing = false;

	constructor(private readonly opts: TunnelOptions) {
		this.store = opts.store;
		this.env = opts.env ?? process.env;
		this.home = opts.home ?? homedir();
		this.dirs = [...(this.env.PATH ?? "").split(delimiter).filter(Boolean), ...(opts.extraDirs ?? HOMEBREW_DIRS)];
		this.timings = { ...DEFAULT_TIMINGS, ...opts.timings };
		this.pidFile = join(opts.dataDir, "cloudflared.pid");
		this.configFile = join(opts.dataDir, "cloudflared.yml");
	}

	// ------------------------------------------------------------------ what there is

	/**
	 * The program: `OMP_WEBUI_CLOUDFLARED` when it is set (and then only that one: a spec must not find whatever the
	 * machine has), else the first on `PATH` or where Homebrew puts it. Looked for at each ask: `brew install` puts it there.
	 */
	private find(): string | null {
		const override = this.env.OMP_WEBUI_CLOUDFLARED;
		if (override) return isExecutableFile(override) ? override : null;
		return which("cloudflared", this.dirs);
	}

	private findBrew(): string | null {
		const override = this.env.OMP_WEBUI_BREW;
		if (override) return isExecutableFile(override) ? override : null;
		return which("brew", [...this.dirs, "/home/linuxbrew/.linuxbrew/bin"]);
	}

	installed(): boolean {
		return this.find() !== null;
	}

	/** Whether cloudflared has a certificate for this account: what `cloudflared tunnel login` leaves. */
	loggedIn(): boolean {
		return existsSync(join(this.home, ".cloudflared", "cert.pem"));
	}

	/**
	 * The URL the browser has to visit to finish the login that is under way, or null. The URL carries a one-time
	 * authorisation: it is shown to the person on the card, and never put into the words of an AI that helps them.
	 */
	loginPending(): string | null {
		return this.loginUrl;
	}

	private requireProgram(): string {
		const program = this.find();
		if (!program) throw new TunnelError("cloudflared is not installed: install it first", 400);
		return program;
	}

	/** What the program is run with: this server's environment without its own settings, and the home it looks for `.cloudflared` in. */
	private programEnv(): Env {
		return childEnv({ HOME: this.home }, this.env);
	}

	// ------------------------------------------------------------------ what the page is told

	status(): RemoteStatus {
		const message = this.note ?? this.message;
		return message === undefined ? { state: this.state } : { state: this.state, message };
	}

	/** Tell the page, if what it shows has changed. */
	private announce(): void {
		clearTimeout(this.noteTimer);
		this.noteTimer = undefined;
		const status = this.status();
		const key = JSON.stringify(status);
		if (key === this.announced) return;
		this.announced = key;
		this.notePushedAt = Date.now();
		try {
			this.opts.onStatus?.(status);
		} catch (e) {
			console.warn(`omp-webui: the remote status could not be sent: ${(e as Error).message}`);
		}
	}

	private setState(state: RemoteState, message: string | undefined): void {
		this.state = state;
		this.message = message === undefined ? undefined : brief(message);
		this.announce();
	}

	/** What a command in progress says (`null`: it is over). A command that prints many lines a second is not pushed as often as that. */
	private setNote(note: string | null): void {
		this.note = note === null ? null : brief(note);
		if (note === null || Date.now() - this.notePushedAt >= NOTE_PUSH_MS) {
			this.announce();
			return;
		}
		this.noteTimer ??= setTimeout(() => this.announce(), NOTE_PUSH_MS - (Date.now() - this.notePushedAt));
	}

	// ------------------------------------------------------------------ steps

	/** Run `work` as the one step in progress; a second one asked for meanwhile is refused. */
	private async exclusive<T>(name: string, work: () => Promise<T>): Promise<T> {
		if (this.busy) throw new TunnelError(`${this.busy} is still running: wait for it to end`, 409);
		this.busy = name;
		try {
			return await work();
		} finally {
			this.busy = null;
		}
	}

	private track(stream: Streamed): Streamed {
		this.streams.add(stream);
		void stream.done.then(() => this.streams.delete(stream));
		return stream;
	}

	/** `brew install cloudflared`, with what brew prints going to the page while it runs. */
	async install(): Promise<void> {
		if (this.installed()) return;
		const brew = this.findBrew();
		if (!brew) {
			throw new TunnelError(
				"Homebrew was not found: install cloudflared another way (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) and come back",
				400,
			);
		}
		await this.exclusive("The install", async () => {
			this.setNote("Installing cloudflared with Homebrew…");
			try {
				const install = this.track(
					spawnStreamed([brew, "install", "cloudflared"], {
						env: childEnv({}, this.env),
						timeoutMs: this.timings.installMs,
						onLine: (line) => this.setNote(`Installing cloudflared: ${line}`),
					}),
				);
				const outcome = await install.done;
				if (outcome.timedOut)
					throw new TunnelError(
						`brew install cloudflared did not finish within ${seconds(this.timings.installMs)}`,
						504,
					);
				if (outcome.code !== 0) {
					const said = install.tail();
					throw new TunnelError(
						`brew install cloudflared failed (${outcome.code === null ? "stopped" : `code ${outcome.code}`})${said ? `: ${said}` : ""}`,
						502,
					);
				}
				if (!this.installed()) throw new TunnelError("brew finished, but cloudflared was not found afterwards", 502);
			} finally {
				this.setNote(null);
			}
		});
	}

	/**
	 * `cloudflared tunnel login`: the URL it prints, which the person opens to log in. The process goes on waiting for the
	 * browser (and writes the certificate when it is done): a second ask meanwhile gets the same URL.
	 */
	async login(): Promise<string> {
		const program = this.requireProgram();
		this.loginAsk ??= this.startLogin(program);
		const ask = this.loginAsk;
		// An ask that failed is not the one a later ask gets.
		ask.catch(() => {
			if (this.loginAsk === ask) this.loginAsk = null;
		});
		return ask;
	}

	private startLogin(program: string): Promise<string> {
		const { promise, resolve, reject } = Promise.withResolvers<string>();
		let settled = false;
		const fail = (error: TunnelError) => {
			if (settled) return;
			settled = true;
			clearTimeout(urlTimer);
			reject(error);
		};
		const login = this.track(
			spawnStreamed([program, "tunnel", "login"], {
				env: this.programEnv(),
				timeoutMs: this.timings.loginMs,
				onLine: (line) => {
					const url = URL_PATTERN.exec(line)?.[0];
					if (!url || settled) return;
					settled = true;
					clearTimeout(urlTimer);
					this.loginUrl = url;
					this.setNote("Waiting for you to log in to Cloudflare in the browser");
					resolve(url);
				},
			}),
		);
		const urlTimer = setTimeout(() => {
			fail(new TunnelError(`cloudflared printed no login URL within ${seconds(this.timings.loginUrlMs)}`, 504));
			signalGroup(login.proc, "SIGKILL");
		}, this.timings.loginUrlMs);
		void login.done.then((outcome) => {
			if (this.loginAsk === promise) this.loginAsk = null;
			if (this.loginUrl !== null && this.loginAsk === null) this.loginUrl = null;
			// What the login printed holds the sign-in link (a one-time authorisation: the card has it as `loginUrl`), and
			// the note and the error are read by whoever helps with the set-up: no link in them.
			const said = withoutLinks(login.tail());
			fail(new TunnelError(`cloudflared could not start the login${said ? `: ${said}` : ""}`, 502));
			if (this.closing) return;
			// The person finished (or did not) in the browser: the page is told, though the tunnel's state did not change.
			if (this.loggedIn()) this.setNote(null);
			else if (outcome.timedOut) this.setNote(`Cloudflare login timed out after ${seconds(this.timings.loginMs)}`);
			else this.setNote(`Cloudflare login failed${said ? `: ${said}` : ""}`);
		});
		return promise;
	}

	/** A `cloudflared` command that takes a moment and ends: what it printed, or why it failed. */
	private async command(program: string, args: string[], stdoutOnly = false): Promise<string> {
		const what = args.slice(0, 3).join(" ");
		let ran: Ran;
		try {
			ran = await run([program, ...args], {
				timeoutMs: this.timings.quickMs,
				env: { HOME: this.home },
				base: this.env,
			});
		} catch (e) {
			if (e instanceof RunTimeout) throw new TunnelError(e.message, 504);
			throw new TunnelError(`cloudflared ${what} could not be run: ${(e as Error).message}`, 502);
		}
		if (ran.code !== 0) {
			const said = `${ran.stdout}\n${ran.stderr}`
				.split(LINE_END)
				.map((l) => Bun.stripANSI(l).trim())
				.filter(Boolean)
				.slice(-3)
				.join(" ");
			throw new TunnelError(`cloudflared ${what} failed${said ? `: ${brief(said)}` : ""}`, 502);
		}
		return stdoutOnly ? ran.stdout : `${ran.stdout}\n${ran.stderr}`;
	}

	/**
	 * Make a tunnel called `name` and keep its id. A tunnel of that name that the account already has (settings that lost
	 * its id) is taken over when this Mac has its credentials, not made again.
	 */
	async create(name: string): Promise<string> {
		const program = this.requireProgram();
		if (!isTunnelName(name)) throw new TunnelError(`${name} is not a name a tunnel can have`, 400);
		let output: string;
		try {
			output = await this.command(program, ["tunnel", "create", name]);
		} catch (e) {
			if (e instanceof TunnelError && /already exists/i.test(e.message)) return this.adopt(program, name, e);
			throw e;
		}
		const id = CREATED_ID.exec(output)?.[1]?.toLowerCase();
		if (!id || !isTunnelId(id)) throw new TunnelError("cloudflared did not say the id of the tunnel it made", 502);
		this.store.patch({ tunnelId: id, tunnelName: name });
		return id;
	}

	/** The account's own tunnel `name`, kept as this one, when its credentials are here; else `refusal`, or what to do. */
	private async adopt(program: string, name: string, refusal: TunnelError): Promise<string> {
		const listing = await this.command(program, ["tunnel", "list", "--name", name, "--output", "json"], true);
		let listed: unknown;
		try {
			listed = JSON.parse(listing);
		} catch {
			throw refusal;
		}
		const found = Array.isArray(listed)
			? listed.find(
					(t): t is { id: string; name: string } => isRecord(t) && t.name === name && typeof t.id === "string",
				)
			: undefined;
		const id = found?.id.toLowerCase();
		if (!id || !isTunnelId(id)) throw refusal;
		if (!existsSync(join(this.home, ".cloudflared", `${id}.json`)))
			throw new TunnelError(
				`A tunnel named ${name} already exists in your Cloudflare account, but this Mac does not have its credentials (~/.cloudflared/${id}.json): delete that tunnel (\`cloudflared tunnel delete ${name}\`, or in the Zero Trust dashboard under Networks › Tunnels) and set up again`,
				409,
			);
		this.store.patch({ tunnelId: id, tunnelName: name });
		return id;
	}

	/** Point `hostname` (a DNS record in the Cloudflare zone) at the tunnel. */
	async route(hostname: string): Promise<void> {
		const program = this.requireProgram();
		const id = this.store.read().tunnelId;
		if (!id) throw new TunnelError("Set up the tunnel first", 400);
		try {
			await this.command(program, ["tunnel", "route", "dns", id, hostname]);
		} catch (e) {
			if (e instanceof TunnelError && /already exists/i.test(e.message))
				throw new TunnelError(
					`${hostname} already has a DNS record in your Cloudflare zone: delete it in the dashboard (DNS), or choose another hostname`,
					409,
				);
			throw e;
		}
	}

	/**
	 * Everything the tunnel needs before it can run: the tunnel itself (made once), the DNS record for the hostname (made
	 * once for each hostname) and the configuration `cloudflared` runs with. Run again it changes nothing that is there.
	 */
	async setup(): Promise<void> {
		await this.exclusive("The setup", async () => {
			this.requireProgram();
			if (!this.loggedIn()) throw new TunnelError("You are not logged in to Cloudflare yet: log in first", 400);
			const { hostname } = this.store.read();
			if (hostname === "") throw new TunnelError("Set a hostname first", 400);
			let id = this.store.read().tunnelId;
			// One name for the tunnel of each hostname: the account's tunnels are told apart by it.
			id ??= await this.create(`omp-webui-${hostname.replaceAll(".", "-")}`.slice(0, 63));
			// The configuration of an earlier setup says that this hostname was pointed at this tunnel then.
			if (this.routedBefore()?.hostname !== hostname || this.routedBefore()?.tunnel !== id) await this.route(hostname);
			this.writeConfig(id, hostname);
		});
	}

	/** The tunnel and hostname the configuration file says were set up, or null. */
	private routedBefore(): { tunnel: string; hostname: string } | null {
		try {
			const text = readFileSync(this.configFile, "utf8");
			const tunnel = /^tunnel: "([^"\n]+)"/m.exec(text)?.[1];
			const hostname = /^ {2}- hostname: "([^"\n]+)"/m.exec(text)?.[1];
			return tunnel && hostname ? { tunnel, hostname } : null;
		} catch {
			return null;
		}
	}

	/** `<data dir>/cloudflared.yml`: the hostname carried to this server, everything else answered 404. */
	private writeConfig(id: string, hostname: string): void {
		const credentials = join(this.home, ".cloudflared", `${id}.json`);
		if (!existsSync(credentials))
			throw new TunnelError(`The tunnel's credentials file is gone (${credentials}): set the tunnel up again`, 400);
		const service = `http://${originAddress(this.opts.host)}:${this.opts.port()}`;
		const text = [
			`tunnel: ${JSON.stringify(id)}`,
			`credentials-file: ${JSON.stringify(credentials)}`,
			"ingress:",
			`  - hostname: ${JSON.stringify(hostname)}`,
			`    service: ${JSON.stringify(service)}`,
			"  - service: http_status:404",
			"",
		].join("\n");
		mkdirSync(this.opts.dataDir, { recursive: true, mode: 0o700 });
		const temporary = `${this.configFile}.tmp`;
		writeFileSync(temporary, text, { mode: 0o600 });
		renameSync(temporary, this.configFile);
	}

	// ------------------------------------------------------------------ the tunnel

	/**
	 * Run the tunnel, and keep it running: remote access is wanted from now on (the settings say so), and a tunnel that ends
	 * is started again after a wait that grows. Refuses what cannot work, in words that say what to do.
	 */
	async start(): Promise<void> {
		const program = this.requireProgram();
		const config = this.store.read();
		if (!config.tunnelId) throw new TunnelError("Set up the tunnel first", 400);
		const missing = missingRemoteSettings(config);
		if (missing.length > 0)
			throw new TunnelError(`Remote access needs these settings first: ${missing.join(", ")}`, 400);
		const routed = this.routedBefore();
		if (!routed || routed.tunnel !== config.tunnelId || routed.hostname !== config.hostname)
			throw new TunnelError("The hostname was changed since the tunnel was set up: set up the tunnel again", 400);
		// The port may be another than the one it was set up with.
		this.writeConfig(config.tunnelId, config.hostname);
		this.store.patch({ enabled: true });
		this.wanted = true;
		this.closing = false;
		if (this.child || this.restartTimer) return;
		await this.reapLeftover();
		// Stopped while the leftover was being ended.
		if (!this.wanted || this.child) return;
		this.launch(program, config.tunnelId);
	}

	private launch(program: string, id: string): void {
		const generation = ++this.generation;
		this.startedAt = Date.now();
		this.connections.clear();
		this.lastError = undefined;
		let first = true;
		const child = spawnStreamed([program, "tunnel", "--no-autoupdate", "--config", this.configFile, "run", id], {
			env: this.programEnv(),
			onLine: (line) => {
				if (first) {
					first = false;
					this.recordProcess(child.proc.pid);
				}
				this.read(generation, line);
			},
		});
		this.child = child;
		this.setState("starting", undefined);
		void child.done.then((outcome) => this.ended(generation, outcome));
	}

	/** What the tunnel printed says what it is doing. */
	private read(generation: number, line: string): void {
		if (generation !== this.generation) return;
		const registered = REGISTERED.exec(line)?.[1];
		if (registered !== undefined) {
			this.connections.add(Number(registered));
			this.lastError = undefined;
			this.setState("connected", undefined);
			return;
		}
		const unregistered = UNREGISTERED.exec(line)?.[1];
		if (unregistered !== undefined) {
			this.connections.delete(Number(unregistered));
			if (this.connections.size === 0 && this.state === "connected")
				this.setState("starting", "Reconnecting to Cloudflare…");
			return;
		}
		const error = ERROR_LINE.exec(line)?.[1];
		if (error === undefined) return;
		this.lastError = brief(error);
		// cloudflared retries what failed by itself: while it is connected an error line is not an outage.
		if (this.connections.size === 0) this.setState("error", error);
	}

	/** The tunnel's process ended. */
	private ended(generation: number, outcome: Outcome): void {
		if (generation !== this.generation) return;
		this.child = null;
		this.connections.clear();
		rmSync(this.pidFile, { force: true });
		if (!this.wanted) return;
		if (Date.now() - this.startedAt >= this.timings.stableMs) this.attempt = 0;
		const how = outcome.code === null ? "was ended by a signal" : `exited with code ${outcome.code}`;
		this.scheduleRestart(`cloudflared ${how}${this.lastError ? `: ${this.lastError}` : ""}`);
	}

	/** The state says why the tunnel is down and when it is started again; the wait grows with each failure in a row. */
	private scheduleRestart(reason: string): void {
		const waits = this.timings.backoffMs;
		const wait = waits[Math.min(this.attempt, waits.length - 1)] ?? 1000;
		this.attempt++;
		this.setState("error", `${reason}; starting it again in ${seconds(wait)}`);
		this.restartTimer = setTimeout(() => {
			this.restartTimer = undefined;
			if (!this.wanted) return;
			try {
				const id = this.store.read().tunnelId;
				if (!id) throw new TunnelError("The settings no longer name a tunnel", 400);
				this.launch(this.requireProgram(), id);
			} catch (e) {
				// The program was removed, or the settings were changed: it is tried again after the next wait.
				this.scheduleRestart((e as Error).message);
			}
		}, wait);
	}

	/** Stop the tunnel, and do not start it again. The process is asked to end, and killed if it does not. */
	async stop(): Promise<void> {
		this.wanted = false;
		clearTimeout(this.restartTimer);
		this.restartTimer = undefined;
		this.attempt = 0;
		const child = this.child;
		this.child = null;
		// What the run says from now on is not told.
		this.generation++;
		// Nothing of this server's own runs: what a server that crashed left may still carry the hostname.
		if (child) {
			await this.end(child);
			rmSync(this.pidFile, { force: true });
		} else await this.reapLeftover();
		this.connections.clear();
		this.lastError = undefined;
		this.setState("off", undefined);
	}

	/** The server is going away: the tunnel, and whatever else this started, ends with it. */
	async close(): Promise<void> {
		this.closing = true;
		clearTimeout(this.noteTimer);
		const others = [...this.streams];
		for (const s of others) signalGroup(s.proc, "SIGTERM");
		await this.stop();
		await Promise.all(others.map((s) => s.done));
	}

	/** SIGTERM to the process and what it started; SIGKILL when it has not ended within the grace. */
	private async end(child: Streamed): Promise<void> {
		signalGroup(child.proc, "SIGTERM");
		const grace = Symbol("grace");
		const ended = await Promise.race([child.done, Bun.sleep(this.timings.stopGraceMs).then(() => grace)]);
		if (ended === grace) {
			signalGroup(child.proc, "SIGKILL");
			await child.done;
		}
	}

	// ------------------------------------------------------------------ one a crashed server left

	/** Record the tunnel's process so that a later server can tell it from another program with the same pid. */
	private recordProcess(pid: number): void {
		const command = commandOf(pid);
		if (!command) return;
		try {
			writeFileSync(this.pidFile, JSON.stringify({ pid, command, owner: process.pid }), { mode: 0o600 });
		} catch (e) {
			console.warn(`omp-webui: could not record the tunnel's process: ${(e as Error).message}`);
		}
	}

	/**
	 * A tunnel that an earlier server started and did not stop (it was killed, it crashed) still carries the hostname to
	 * the port that server had, and would take its share of the requests to a place where nothing listens. It is ended
	 * before a new one starts, and when the person stops remote access, and when a server comes up: only when its pid
	 * still runs the command that was recorded (the pid may have been reused), and only when the server that started it
	 * is gone (another copy of the app on the same data dir has a tunnel that is its own).
	 */
	async reapLeftover(): Promise<void> {
		const record = this.recordedProcess();
		if (record?.owner !== undefined && record.owner !== process.pid && isAlive(record.owner)) return;
		if (record && commandOf(record.pid) === record.command) {
			const running = () => commandOf(record.pid) === record.command;
			for (const signal of ["SIGTERM", "SIGKILL"] as const) {
				for (const target of [-record.pid, record.pid]) {
					try {
						process.kill(target, signal);
					} catch {
						// gone
					}
				}
				const until = Date.now() + (signal === "SIGTERM" ? this.timings.stopGraceMs : 1000);
				while (running() && Date.now() < until) await Bun.sleep(20);
				if (!running()) break;
			}
		}
		rmSync(this.pidFile, { force: true });
	}

	/** What the pid file says of the tunnel an earlier server started; null when there is none, or it is not a record. */
	private recordedProcess(): { pid: number; command: string; owner?: number } | null {
		try {
			const parsed: unknown = JSON.parse(readFileSync(this.pidFile, "utf8"));
			if (!isRecord(parsed)) return null;
			const { pid, command, owner } = parsed;
			if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1 || typeof command !== "string") return null;
			return { pid, command, owner: typeof owner === "number" ? owner : undefined };
		} catch {
			return null;
		}
	}
}

/** Whether a process with this id exists (one that is not ours may answer EPERM: it is there). */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}
