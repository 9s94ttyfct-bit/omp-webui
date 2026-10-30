import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	renameSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import pkg from "../../package.json";
import type { ErrorCode, ErrorInfo } from "../../shared/error-info.ts";
import { isRecord } from "../../shared/guards.ts";
import {
	compareVersions,
	compatOf,
	type Holds,
	OMP_COMPAT_RANGE,
	type OmpInstall,
	type OmpJob,
	type OmpRelease,
	type OmpSnapshot,
	type OmpState,
} from "../../shared/omp-install.ts";
import type { ServerMessage } from "../../shared/protocol.ts";
import type { Config } from "../config.ts";
import { detectInstall, findOmp, installCommand, installOptions, jobEnv, probeOmp, searchDirs } from "./install.ts";
import { PS_MS, RunTimeout, run } from "./run.ts";
import { configuredUpdateChannel, latestRelease } from "./update.ts";

type Env = Record<string, string | undefined>;
type Fetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/** What the lifecycle needs from the server around it. */
export interface OmpHost {
	/** The conversations that are busy, by what they are doing (an update waits until none is, or none is working). */
	busy(): Holds;
	/** Point everything that holds omp's location at `bin` (an install put it there, an update changed it). */
	activate(bin: string): Promise<string>;
	broadcast(msg: ServerMessage): void;
}

export interface LifecycleOptions {
	/** The environment omp is looked for in, and installs and updates run in; the process's own by default. */
	env?: Env;
	home?: string;
	fetch?: Fetch;
	/** Look for a newer release by itself (on a start and every `checkIntervalMs`); a click on "Check" always looks. */
	checkEnabled?: boolean;
	checkIntervalMs?: number;
	/** How often a waiting update, and "Update omp automatically", look at whether the conversations have finished. */
	tickMs?: number;
	/**
	 * Read the environment omp is looked for in again, so that a change the user made since the server started (a
	 * line in `.zshrc` that puts omp on `PATH`) counts. Called by `recheck`, which then changes `env` as it likes.
	 */
	refreshEnv?: () => Promise<void>;
}

/** What is kept between runs (`<data dir>/omp.json`). */
interface Settings {
	autoUpdate: boolean;
	/** The first-time setup is still to be done: an install just finished and nobody has gone through it. */
	onboarding: boolean;
}

interface JobRun {
	job: OmpJob;
	argv: string[];
	env: Record<string, string | undefined>;
	log: string;
	/** The job's process, when this server started it. */
	proc: Bun.Subprocess | null;
	/** The process group the job runs in (its leader's pid): what a cancel signals. Null once it has ended. */
	pid: number | null;
	/** That process as it was started, to tell it from another with the same id when a later server takes the job over. */
	ref: JobProcess | null;
	cancelled: boolean;
	/** The version omp had when the job started: an update must change it. */
	before: string | null;
	/** `follow` is on it. */
	following: boolean;
	/** A `ps` for the job's start time is being asked: another is not started while it is. */
	askingStart: boolean;
	/** Since when the job's process could not be told from a stranger (#543). */
	unconfirmedSince: number;
	/**
	 * Whether the job's process is the job's, as the command line says: null while that has not been asked yet, and
	 * after a `ps` that could not answer (#543). A process seen to carry the marker is looked at again every time
	 * (`ownsPid`): it may have gone since.
	 */
	confirmed: boolean | null;
	/** Where in the job's output file `follow` starts. */
	offset: number;
}

/** A job's process as it was started: the id alone is not enough, the system reuses ids, but not an id with a start time. */
interface JobProcess {
	pid: number;
	/**
	 * When the process started, as `ps` said it. Empty when the server that started the job could not be told (a `ps`
	 * that gave no answer in time): the job's own status file is then what tells the process from a stranger.
	 */
	started: string;
	/**
	 * The job's status file, whose path is in the command line of the job's process: what tells it from a stranger
	 * that the system has given the same id to (#543). Empty when the record was written by a server that did not
	 * know it (an older record).
	 */
	marker: string;
}

/**
 * When the process `pid` started, as `ps` says it; null when there is no such process. Only the start time:
 * the command line is not what it is until the process has been `exec`ed, so it would differ from one look to the next.
 * Awaited, not waited for (`run`): a job taken over is looked at every `JOB_POLL_MS` for as long as it runs, and the
 * server's single thread serves everyone else meanwhile (#460). Rejects when `ps` gives no answer in time (`RunTimeout`).
 */
async function startOf(pid: number): Promise<string | null> {
	// A later server may run in another locale or zone.
	const r = await run(["ps", "-o", "lstart=", "-p", String(pid)], {
		timeoutMs: PS_MS,
		env: { LC_ALL: "C", TZ: "UTC" },
	});
	return r.code === 0 ? r.stdout.trim() || null : null;
}

/**
 * The command line of the process `pid`, as `ps` says it; null when there is no such process (`ps` ran and found
 * none). Rejects when `ps` could not answer (`RunTimeout`, or a `ps` that cannot be started or failed otherwise): that
 * says nothing about the process, and must not be read as "it is gone" (#561).
 * The job's own status file is in the command line of the job's process (see `JOB_WRAPPER`), and that is what tells
 * it from a stranger the system has given the same id to (#543).
 */
async function commandOf(pid: number, timeoutMs = PS_MS): Promise<string | null> {
	const r = await run(["ps", "-o", "command=", "-p", String(pid)], {
		timeoutMs,
		env: { LC_ALL: "C", TZ: "UTC" },
	});
	const command = r.stdout.trim();
	if (r.code === 0 && command) return command;
	// `ps -p` exits 1 and prints nothing for an id no process has; any other failure is a `ps` that could not say.
	if (r.code === 1 && !command) return null;
	throw new Error(`ps gave no answer for process ${pid}: exit ${r.code}`);
}

/** What `<data dir>/omp-job/job.json` says of a running job, for the server that takes it over (`resume`). */
interface JobRecord {
	version: 1;
	kind: OmpJob["kind"];
	method: string;
	command: string;
	auto: boolean;
	startedAt: number;
	before: string | null;
	process: JobProcess | null;
}

/** A request the lifecycle refuses; `code` lets the page tell the cases apart. */
export class LifecycleError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code: string,
	) {
		super(message);
	}
}

const LOG_LIMIT = 256 * 1024;
const DEFAULT_CHECK_MS = 6 * 60 * 60_000;
const FIRST_CHECK_DELAY_MS = 1500;
/** How often the output of a running job is looked for (`follow`). */
const JOB_POLL_MS = 120;
/**
 * How long the process of a job taken over from an earlier server may go on not being told from a stranger before the
 * job is settled from its status file: a job that can never be confirmed would otherwise never settle, and the page
 * would show an install running that is not (#543).
 */
const UNCONFIRMED_MS = 60_000;
/**
 * How long the command line of a job's process may be waited for: a `ps` that cannot answer in a moment cannot
 * answer at all on that machine, and the job's own loop must not stand still for it (#460).
 */
const COMMAND_MS = 2000;

/**
 * What every job runs as, with its command as the arguments after the status file's path: the command, then its exit
 * status written to that file, so that a server that did not start the job — or was not there when it ended — can
 * tell how it ended. The status is written after the command is over and before this shell is.
 */
const JOB_WRAPPER = 'status=$1; shift; "$@"; code=$?; printf %s "$code" > "$status"; exit "$code"';

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

/** The message, with the output's last lines when there are any: what an install says when it fails is its last words. */
function lastLines(log: string, n = 6): string {
	return log
		.split("\n")
		.map((l) => l.split("\r").pop()?.trim() ?? "")
		.filter(Boolean)
		.slice(-n)
		.join("\n");
}

const noHolds = (): Holds => ({ working: 0, asking: 0, paused: 0 });

const sameHolds = (a: Holds, b: Holds): boolean =>
	a.working === b.working && a.asking === b.asking && a.paused === b.paused;

/** How many of `held` an update waits for: every one of them, or with `anyway` only those that are working. */
const blocking = (held: Holds, anyway: boolean): number =>
	anyway ? held.working : held.working + held.asking + held.paused;

/**
 * omp as a thing the web UI can be without, install, and keep up to date.
 *
 * - **Finding it** (`init`): `OMP_BIN`, else `omp` on `PATH`, else where omp's installers put it. Without one the
 *   server still runs and the page shows the first-run screen; with one that does not run (`broken`), the same.
 * - **Installing it**: one of the commands of `install.ts`, run by the server with its output streamed to the
 *   page. When it ends omp is looked for again, adopted (`OmpHost.activate`), and the first-time setup begins.
 * - **Keeping it up to date**: the latest release is looked up now and then (`update.ts`); the page says when
 *   there is a newer one. Updating runs omp's own `omp update`, which updates the install the way it was made
 *   (Homebrew, bun, npm, its installer, mise); it starts only once no conversation is working, and with
 *   "Update omp automatically" on, the server starts it by itself at such a moment — but never into a major
 *   version the web UI has not been made for.
 */
export class OmpLifecycle {
	private status: OmpState["status"] = "missing";
	private version: string | null = null;
	private error: string | null = null;
	private install: OmpInstall | null = null;
	private release: Pick<OmpRelease, "latest" | "changelogUrl" | "source" | "checkedAt"> | null = null;
	private releaseError: string | null = null;
	private checking = false;
	private run: JobRun | null = null;
	private settings: Settings;
	/** The release an automatic update failed to install: not tried again until there is another. */
	private autoFailed: string | null = null;
	/** What an automatic update that is due waits for (`tick`); null when it waits for nothing. */
	private autoWaiting: Holds | null = null;
	/** Names this run of the server in every state it sends (`OmpState.boot`). */
	private readonly boot = randomUUID();
	private rev = 0;
	private seq = 0;
	private timers: NodeJS.Timeout[] = [];
	private readonly env: Env;
	private readonly home: string;
	private readonly fetchImpl: Fetch;
	private readonly settingsFile: string;
	private readonly checkEnabled: boolean;
	private readonly checkIntervalMs: number;
	private readonly tickMs: number;
	private readonly refreshEnv: (() => Promise<void>) | undefined;
	/** Where the running job's output, exit status and record are (`execute`). */
	private readonly jobDir: string;
	/** `init` is running: nothing holds omp's location yet (`adopt`). */
	private initializing = false;
	/** The server is going away (`stop`): jobs are no longer followed, and not stopped either. */
	private stopped = false;

	constructor(
		private readonly cfg: Config,
		private readonly host: OmpHost,
		opts: LifecycleOptions = {},
	) {
		this.env = opts.env ?? process.env;
		this.home = opts.home ?? homedir();
		this.fetchImpl = opts.fetch ?? fetch;
		this.checkEnabled = opts.checkEnabled ?? true;
		this.checkIntervalMs = opts.checkIntervalMs ?? DEFAULT_CHECK_MS;
		this.tickMs = opts.tickMs ?? 1000;
		this.refreshEnv = opts.refreshEnv;
		this.settingsFile = join(cfg.dataDir, "omp.json");
		this.jobDir = join(cfg.dataDir, "omp-job");
		this.settings = this.readSettings();
	}

	// ------------------------------------------------------------------ settings

	private readSettings(): Settings {
		try {
			const v: unknown = JSON.parse(readFileSync(this.settingsFile, "utf8"));
			const o = isRecord(v) ? v : {};
			return { autoUpdate: o.autoUpdate === true, onboarding: o.onboarding === true };
		} catch {
			return { autoUpdate: false, onboarding: false };
		}
	}

	/** Keep `next` and then, only once it is on disk, hold it: a change that could not be saved must not act (`tick` follows what is held). */
	private saveSettings(next: Settings): void {
		writeFileSync(`${this.settingsFile}.tmp`, JSON.stringify(next), { mode: 0o600 });
		renameSync(`${this.settingsFile}.tmp`, this.settingsFile);
		this.settings = next;
	}

	// ------------------------------------------------------------------ finding omp

	/** Look for omp and ask it for its version. Call before anything uses `cfg.ompBin`; it is the path found afterwards. */
	async init(): Promise<void> {
		this.initializing = true;
		try {
			const bin = findOmp(this.env, this.cfg.ompBin, this.home);
			if (bin) {
				this.cfg.ompBin = bin;
				await this.probe(bin);
			} else {
				this.status = "missing";
			}
			// A job an earlier server started is settled here (`resume`). However that goes, it must not be what stops
			// the server: a failure leaves the job's files behind, and every later start would meet them again (#310).
			await this.resume().catch((e: unknown) => this.abandon(e));
		} finally {
			this.initializing = false;
		}
	}

	get ready(): boolean {
		return this.status === "ready";
	}

	/** What `omp --version` reported, when omp runs. */
	get ompVersion(): string | null {
		return this.version;
	}

	private async probe(bin: string): Promise<void> {
		const r = await probeOmp(bin, this.env);
		this.install = detectInstall(bin);
		if (r.ok) {
			this.status = "ready";
			this.version = r.version;
			this.error = null;
		} else {
			this.status = "broken";
			this.version = null;
			this.error = r.error;
		}
	}

	/** Make `bin` the omp: remember where it is, put its directory on `PATH` (a bun-installed omp needs bun's), probe it. */
	private async adopt(bin: string): Promise<boolean> {
		this.cfg.ompBin = bin;
		const dirs = (this.env.PATH ?? "").split(delimiter).filter(Boolean);
		if (!dirs.includes(dirname(bin))) this.env.PATH = [dirname(bin), ...dirs].join(delimiter);
		await this.probe(bin);
		if (this.status !== "ready") return false;
		// Within `init` nothing holds omp's location yet: it is set up from `cfg.ompBin` once `init` is over.
		if (!this.initializing) await this.host.activate(bin);
		return true;
	}

	// ------------------------------------------------------------------ state

	/** What is known of the latest release, against the omp that is installed. */
	private releaseState(): OmpState["release"] {
		return this.release && this.version
			? {
					...this.release,
					newer: compareVersions(this.release.latest, this.version) > 0,
					compat: compatOf(this.release.latest),
				}
			: null;
	}

	/** The state as of now, stamped: each call is later than every one before it (`OmpState.rev`). */
	state(): OmpState {
		const missing = this.status === "missing";
		return {
			boot: this.boot,
			rev: ++this.rev,
			status: this.status,
			bin: missing ? null : this.cfg.ompBin,
			version: this.version,
			error: this.error,
			searched: missing ? searchDirs(this.env, this.home) : [],
			install: this.install,
			options: this.status === "ready" ? [] : installOptions(this.env, this.home),
			compat: { range: OMP_COMPAT_RANGE, verdict: compatOf(this.version) },
			release: this.releaseState(),
			releaseError: this.releaseError,
			checking: this.checking,
			autoUpdate: this.settings.autoUpdate,
			autoWaitingFor: this.autoWaiting,
			onboarding: this.settings.onboarding,
			job: this.run ? { ...this.run.job } : null,
		};
	}

	snapshot(): OmpSnapshot {
		return { state: this.state(), log: this.run?.log ?? "" };
	}

	private emit(): void {
		this.host.broadcast({ t: "omp", state: this.state() });
	}

	// ------------------------------------------------------------------ looking for a release

	start(): void {
		if (this.timers.length) return;
		const tick = setInterval(() => void this.tick(), this.tickMs);
		tick.unref();
		this.timers.push(tick);
		// A job an earlier server started and that is still running (`resume`) is followed from here on.
		if (this.run?.job.state === "running") this.background(this.follow(this.run));
		if (!this.checkEnabled) return;
		const first = setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS);
		const every = setInterval(() => void this.check(), this.checkIntervalMs);
		first.unref();
		every.unref();
		this.timers.push(first, every);
	}

	/**
	 * The server is going away. A job that runs is left running: it does not depend on this server (`execute`), and the
	 * next one takes it over (`resume`).
	 */
	stop(): void {
		this.stopped = true;
		for (const t of this.timers.splice(0)) clearTimeout(t);
	}

	/** The install or update that is running now, if any. */
	runningJob(): Pick<OmpJob, "kind" | "command"> | null {
		return this.run?.job.state === "running" ? { kind: this.run.job.kind, command: this.run.job.command } : null;
	}

	/** Look up the latest release now. A failure is kept for Settings to show; it never gets in the way of anything else. */
	async check(): Promise<void> {
		if (this.status !== "ready" || this.checking) return;
		this.checking = true;
		this.emit();
		try {
			const found = await latestRelease({
				method: this.install?.method ?? null,
				env: this.env,
				home: this.home,
				fetch: this.fetchImpl,
				userAgent: `omp-webui/${pkg.version}`,
				// The job runs `omp update` in the home directory (`execute`), and omp reads the setting where it runs.
				channel: await configuredUpdateChannel(this.cfg.ompBin, this.home, this.env),
			});
			this.release = { ...found, checkedAt: Date.now() };
			this.releaseError = null;
		} catch (e) {
			this.releaseError = (e as Error).message;
		} finally {
			this.checking = false;
			this.emit();
		}
	}

	// ------------------------------------------------------------------ jobs

	private active(): JobRun | null {
		return this.run && (this.run.job.state === "waiting" || this.run.job.state === "running") ? this.run : null;
	}

	private newJob(
		kind: OmpJob["kind"],
		method: string,
		command: string,
		argv: string[],
		env: Env,
		auto: boolean,
	): JobRun {
		const job: OmpJob = {
			id: `J${++this.seq}`,
			kind,
			method,
			command,
			state: "running",
			exitCode: null,
			error: null,
			startedAt: Date.now(),
			endedAt: null,
			auto,
			waiting: noHolds(),
			anyway: false,
			version: null,
		};
		this.run = {
			job,
			argv,
			env,
			log: "",
			proc: null,
			pid: null,
			ref: null,
			cancelled: false,
			before: this.version,
			following: false,
			askingStart: false,
			unconfirmedSince: 0,
			confirmed: null,
			offset: 0,
		};
		return this.run;
	}

	/** Install omp with one of `installOptions`. */
	startInstall(method: string): void {
		if (this.status === "ready") throw new LifecycleError("omp is already installed", 409, "installed");
		if (this.active()) throw new LifecycleError("An install or update is already running", 409, "busy");
		const command = installCommand(method, this.env, this.home);
		if ("error" in command) throw new LifecycleError(command.error, 400, "unavailable");
		const run = this.newJob("install", method, command.command, command.argv, jobEnv(this.env, this.home), false);
		this.background(this.execute(run));
	}

	/**
	 * Update omp to the latest release: now when no conversation is working, else once none is (the job waits).
	 * A release outside the range the web UI supports needs `acknowledgeCompat`: the page asked first.
	 */
	startUpdate(acknowledgeCompat: boolean, auto = false, anyway = false): void {
		const release = this.releaseState();
		if (this.status !== "ready" || !this.install) throw new LifecycleError("omp is not installed", 409, "not_ready");
		if (!this.install.updatable) {
			throw new LifecycleError("This omp is updated elsewhere, not by the web UI", 409, "not_updatable");
		}
		const active = this.active();
		if (active) {
			// "Update anyway" on the update that is waiting: it stops waiting for the conversations that need the user.
			if (anyway && active.job.kind === "update" && active.job.state === "waiting") {
				active.job.anyway = true;
				if (blocking(this.host.busy(), true) === 0) this.background(this.execute(active));
				else this.emit();
				return;
			}
			throw new LifecycleError("An install or update is already running", 409, "busy");
		}
		if (!release?.newer) throw new LifecycleError("omp is up to date", 409, "up_to_date");
		if (release.compat !== "supported" && !acknowledgeCompat) {
			throw new LifecycleError(
				`omp ${release.latest} is outside the versions this web UI supports (${OMP_COMPAT_RANGE})`,
				409,
				"outside_compat",
			);
		}
		// `omp update` finds the install to update from `PATH`: put this omp's directory first, so it is the one it finds.
		const env = jobEnv(this.env, this.home);
		env.PATH = [dirname(this.cfg.ompBin), env.PATH].filter(Boolean).join(delimiter);
		const run = this.newJob("update", this.install.method, "omp update", [this.cfg.ompBin, "update"], env, auto);
		run.job.anyway = anyway;
		const held = this.host.busy();
		if (blocking(held, anyway) > 0) {
			run.job.state = "waiting";
			run.job.waiting = held;
			this.emit();
			return;
		}
		this.background(this.execute(run));
	}

	/**
	 * Stop an update that is still waiting, stop an install, or dismiss a job that has ended. A job taken over from an
	 * earlier server is stopped once its process has been looked at (`stopTakenOver`), which is not waited for here.
	 */
	cancel(): void {
		const run = this.run;
		if (!run) return;
		if (run.job.state === "running") {
			if (run.job.kind === "update") throw new LifecycleError("An update cannot be stopped half way", 409, "running");
			run.cancelled = true;
			// A job this server started is the server's own: its handle is the process itself. Its own process group
			// (`detached`) is signalled, so that the shell's pipeline dies with it.
			if (run.proc !== null && run.pid !== null) {
				try {
					process.kill(-run.pid, "SIGTERM");
				} catch {
					run.proc.kill();
				}
				return;
			}
			// The process is gone or unknown: the job is settled, and what it started is not signalled.
			if (run.pid === null) this.background(this.settle(run, null));
			else this.background(this.stopTakenOver(run, run.pid));
			return;
		}
		this.run = null;
		this.emit();
	}

	/**
	 * Stop the process group of a job taken over from an earlier server, when its command line says it is the job's:
	 * a pid the system gave to a stranger is not signalled, nor is a process that cannot be confirmed — signalling it
	 * would end a program the server does not own (#543). Asked, not waited for, and for no longer than `COMMAND_MS`: a
	 * `ps` that is slow must not stand the server still (#560).
	 */
	private async stopTakenOver(run: JobRun, pid: number): Promise<void> {
		const marker = run.ref?.marker;
		const command = marker ? await commandOf(pid, COMMAND_MS).catch(() => null) : null;
		// The job ended while `ps` was asked: there is nothing to stop, and it is settled already.
		if (this.run !== run || run.job.state !== "running" || run.pid !== pid) return;
		if (!marker || !command?.includes(marker)) return this.settle(run, null);
		try {
			process.kill(-pid, "SIGTERM");
		} catch {
			// Gone since: `follow` settles the job.
		}
	}

	setAutoUpdate(on: boolean): void {
		this.saveSettings({ ...this.settings, autoUpdate: on });
		this.emit();
		void this.tick();
	}

	setOnboarding(pending: boolean): void {
		this.saveSettings({ ...this.settings, onboarding: pending });
		// The install that led here is over; the next job should not find it still on show.
		if (!pending && this.run?.job.kind === "install" && !this.active()) this.run = null;
		this.emit();
	}

	/** The user installed or repaired omp on their own: look for it again, in the environment as it is now (`refreshEnv`). */
	async recheck(): Promise<void> {
		if (this.status === "ready") return;
		if (this.active()) throw new LifecycleError("An install or update is already running", 409, "busy");
		await this.refreshEnv?.();
		const bin = findOmp(this.env, undefined, this.home);
		if (bin) await this.adopt(bin);
		this.emit();
	}

	/**
	 * A waiting update starts when the conversations have finished (`anyway`: when none is working any more); so does an
	 * automatic one, when it is due. One that is due but held back says by what (`OmpState.autoWaitingFor`) instead of
	 * waiting in silence. The timer `start` sets up calls this every second; it is public for the tests, which drive it
	 * themselves.
	 */
	async tick(): Promise<void> {
		const run = this.run;
		if (run?.job.state === "waiting") {
			this.noteAutoWaiting(null);
			const held = this.host.busy();
			if (blocking(held, run.job.anyway) === 0) this.background(this.execute(run));
			else if (!sameHolds(held, run.job.waiting)) {
				run.job.waiting = held;
				this.emit();
			}
			return;
		}
		if (this.run && this.active()) return this.noteAutoWaiting(null);
		if (!this.settings.autoUpdate || this.status !== "ready" || !this.install?.updatable) {
			return this.noteAutoWaiting(null);
		}
		const release = this.releaseState();
		if (!release?.newer || release.compat !== "supported" || release.latest === this.autoFailed) {
			return this.noteAutoWaiting(null);
		}
		const held = this.host.busy();
		if (blocking(held, false) > 0) return this.noteAutoWaiting(held);
		this.noteAutoWaiting(null);
		try {
			this.startUpdate(false, true);
		} catch {
			// What it needed changed since the check above (another job started, the release moved): the next tick looks again.
		}
	}

	/** What holds an automatic update back changed (or nothing does any more): the page is told when it did. */
	private noteAutoWaiting(held: Holds | null): void {
		const was = this.autoWaiting;
		if (held === null ? was === null : was !== null && sameHolds(held, was)) return;
		this.autoWaiting = held;
		this.emit();
	}

	private append(run: JobRun, text: string): void {
		const clean = Bun.stripANSI(text);
		if (!clean) return;
		run.log = (run.log + clean).slice(-LOG_LIMIT);
		this.host.broadcast({ t: "omp_log", job: run.job.id, text: clean });
	}

	// ------------------------------------------------------------------ a job's files

	private jobFile(name: "output.log" | "exit" | "job.json"): string {
		return join(this.jobDir, name);
	}

	private saveRecord(run: JobRun): void {
		const { kind, method, command, auto, startedAt } = run.job;
		const record: JobRecord = {
			version: 1,
			kind,
			method,
			command,
			auto,
			startedAt,
			before: run.before,
			process: run.ref,
		};
		writeFileSync(this.jobFile("job.json"), JSON.stringify(record), { mode: 0o600 });
	}

	/** The record of a job an earlier server started; null when there is none, or it is not one this server understands. */
	private readRecord(): JobRecord | null {
		try {
			const v: unknown = JSON.parse(readFileSync(this.jobFile("job.json"), "utf8"));
			if (
				!isRecord(v) ||
				v.version !== 1 ||
				(v.kind !== "install" && v.kind !== "update") ||
				typeof v.method !== "string" ||
				typeof v.command !== "string" ||
				typeof v.auto !== "boolean" ||
				typeof v.startedAt !== "number" ||
				(v.before !== null && typeof v.before !== "string")
			)
				return null;
			const p = v.process;
			// A record without the marker (an older one) has a process whose identity cannot be confirmed: it is
			// taken as the job's, and the start time is what tells it from a stranger (#543).
			const pid = isRecord(p) ? p.pid : null;
			const process =
				typeof pid === "number" && Number.isInteger(pid) && isRecord(p) && typeof p.started === "string"
					? {
							pid,
							started: p.started,
							marker: typeof p.marker === "string" ? p.marker : this.jobFile("exit"),
						}
					: null;
			return {
				version: 1,
				kind: v.kind,
				method: v.method,
				command: v.command,
				auto: v.auto,
				startedAt: v.startedAt,
				before: v.before,
				process,
			};
		} catch {
			return null;
		}
	}

	/** The status the job's wrapper wrote when its command ended (see `JOB_WRAPPER`); null while there is none. */
	private exitStatus(): number | null {
		try {
			const text = readFileSync(this.jobFile("exit"), "utf8").trim();
			return /^\d+$/.test(text) ? Number(text) : null;
		} catch {
			return null;
		}
	}

	/**
	 * How a job ended, or null while it runs: by the status it wrote, else because its process is gone — killed, so
	 * it had no say (a cancelled install, a job that died with the machine). `code` is null when it left no status.
	 *
	 * A job whose process cannot be looked at is *not* over: the server that started it could not be told when the
	 * process began (a `ps` that gave no answer in time on a loaded machine), and "cannot tell" is not "it ended" —
	 * saying it ended would settle a running install as stopped (#507). Such a job is watched for its status file,
	 * which the job's own wrapper writes when the command is over.
	 */
	private async ended(run: JobRun): Promise<{ code: number | null } | null> {
		const status = this.exitStatus();
		if (status !== null) return { code: status };
		if (run.proc) {
			if (run.proc.exitCode === null && run.proc.signalCode === null) return null;
			return { code: this.exitStatus() ?? run.proc.exitCode };
		}
		if (!run.ref) return null;
		// The start time was never learned (the `ps` of the server that started the job gave no answer): the id alone
		// says nothing — the system reuses ids, and a stranger with that id is not the job (#543). What the job's own
		// process carries is the path of its status file, and that is what is looked for.
		// The status is read again once the process is seen to be gone: the job's wrapper writes it before its shell ends, so
		// a job that ended while `ps` was asked has said how, and "gone" alone would read as "killed" (#566).
		if (!run.ref.started) return (await this.ownsPid(run)) ? null : { code: this.exitStatus() };
		try {
			return (await startOf(run.ref.pid)) === run.ref.started ? null : { code: this.exitStatus() };
		} catch (e) {
			// A `ps` that gave no answer (a busy machine) does not say the job is gone: the next look asks again.
			if (e instanceof RunTimeout) return null;
			throw e;
		}
	}

	/**
	 * Whether the process the record names is still the job's. The job's own process carries the path of its status
	 * file in its command line, and that is what tells it from a stranger the system has given the same id to: a
	 * stranger is never signalled and never holds the job for ever (#543). A process that is not there at all is not
	 * the job's either, and settles the job at once: `ps` said so (#561).
	 *
	 * A `ps` that cannot answer says nothing, and nothing is not "it is a stranger": the job is then watched for its
	 * status file, which the job's own wrapper writes when the command is over, and for as long as that is not there
	 * the job is not settled either (a `ps` that cannot answer is what #507 is about).
	 */
	private async ownsPid(run: JobRun): Promise<boolean> {
		const marker = run.ref?.marker;
		if (!marker) return false;
		// A process that is not the job's never becomes it: that answer is kept. One that was seen to be the job's is
		// looked at again, since it may have gone since. The limit is short: a `ps` that cannot answer in a moment
		// cannot answer at all on that machine, and the job's own loop must not stand still for it (#460).
		if (run.confirmed === false) return false;
		let command: string | null;
		try {
			command = await commandOf(run.ref?.pid ?? 0, COMMAND_MS);
		} catch {
			// The `ps` could not say: the process is not said to be gone or a stranger, and the job keeps waiting.
			return true;
		}
		run.confirmed = command?.includes(marker) ?? false;
		return run.confirmed;
	}

	/**
	 * When the job's process began, as `ps` says it now, and the record is written with it. A `ps` that gives no
	 * answer (a loaded machine) is asked again later, and the job keeps its id until then (#536).
	 *
	 * The `ps` is not waited for: the job's own loop must not stand still for it (that is what #460 was about), and
	 * a `ps` that takes its whole limit would hold the job's settling back for as long.
	 */
	private learnStartTime(run: JobRun): void {
		if (!run.ref || run.ref.started || run.askingStart) return;
		const pid = run.ref.pid;
		const marker = run.ref.marker;
		run.askingStart = true;
		void startOf(pid)
			.then(async (started) => {
				if (!started || !run.ref || run.ref.pid !== pid || run.ref.started) return;
				// The start time is only the job's when the process is the job's: a stranger's start time would
				// confirm a stranger, and the job would then be held for ever by a process that is not it (#543).
				if (marker) {
					// A `ps` that cannot answer leaves the process unconfirmed: it is still the job's, as far as is known.
					const command = await commandOf(pid).catch(() => undefined);
					if (command && !command.includes(marker)) {
						run.confirmed = false;
						return;
					}
					run.confirmed = command ? true : null;
				}
				run.ref = { pid, started, marker };
				// The job's files are gone once it has been settled: there is no record to write then.
				if (!existsSync(this.jobDir)) return;
				this.saveRecord(run);
			})
			.catch(() => {
				// A `ps` that gave no answer: the next look asks again.
			})
			.finally(() => {
				run.askingStart = false;
			});
	}

	/**
	 * Follow a running job to its end: what it writes goes to the page as it is written, and when it has ended it is
	 * settled. The job's output is a file and its status another, so this need not be the server that started it, and
	 * a server that goes away leaves it running (`execute`, `resume`, `stop`).
	 */
	private async follow(run: JobRun): Promise<void> {
		if (run.following) return;
		run.following = true;
		const decoder = new TextDecoder();
		let fd: number | null = null;
		let offset = run.offset;
		const pull = (): void => {
			try {
				fd ??= openSync(this.jobFile("output.log"), "r");
				const size = statSync(this.jobFile("output.log")).size;
				while (offset < size) {
					const chunk = Buffer.allocUnsafe(Math.min(size - offset, 64 * 1024));
					const n = readSync(fd, chunk, 0, chunk.length, offset);
					if (n <= 0) break;
					offset += n;
					this.append(run, decoder.decode(chunk.subarray(0, n), { stream: true }));
				}
			} catch {
				// No file (the data directory was cleared under a running server): no output, and the job is still settled.
			}
		};
		let outcome: { code: number | null } | null;
		try {
			for (;;) {
				// A server that is going away leaves the job, whatever it has done meanwhile, to the next one. A job that
				// was settled elsewhere meanwhile (a cancel that found its process gone) is not followed any more.
				if (this.stopped || run.job.state !== "running") return;
				pull();
				// A job whose start time is not known yet asks for it now, and the record is written with it: the
				// process is then told from another with the same id, whoever takes the job over (#536).
				if (run.ref && !run.ref.started) this.learnStartTime(run);
				outcome = await this.ended(run);
				// Said while `ps` was asked: the server is going away, and the job is the next one's — or it was settled.
				if (this.stopped || run.job.state !== "running") return;
				// The process of a job taken over from an earlier server cannot be told from a stranger: how long that has
				// been the case is kept, so that a job that can never be confirmed is settled rather than held for ever
				// (#543). A job this server started is not: its handle is the process itself, and its end is what `ended`
				// sees — a `ps` that does not answer says nothing of it (#559). Nor is one whose process was seen to carry
				// the marker: it is the job's, and it is waited for.
				if (!outcome && run.ref && !run.ref.started && !run.proc && run.confirmed !== true) {
					if (run.unconfirmedSince === 0) run.unconfirmedSince = Date.now();
					else if (Date.now() - run.unconfirmedSince > UNCONFIRMED_MS) {
						outcome = { code: this.exitStatus() };
						break;
					}
				} else run.unconfirmedSince = 0;
				if (outcome) {
					pull();
					break;
				}
				await (run.proc ? Promise.race([run.proc.exited, Bun.sleep(JOB_POLL_MS)]) : Bun.sleep(JOB_POLL_MS));
			}
		} finally {
			if (fd !== null) closeSync(fd);
		}
		this.append(run, decoder.decode());
		await this.settle(run, outcome.code);
	}

	/** A job that has ended: what became of it is told, and its files go. */
	private async settle(run: JobRun, code: number | null): Promise<void> {
		run.proc = null;
		run.pid = null;
		run.job.exitCode = code;
		run.job.endedAt = Date.now();
		try {
			await this.finish(run, code);
		} catch (e) {
			this.fail(run, (e as Error).message);
		} finally {
			// However telling the page went: a job's files that outlive its settling are met again by every later start.
			rmSync(this.jobDir, { recursive: true, force: true });
		}
	}

	/** A job's work goes on with nobody awaiting it: what goes wrong in it is the job's failure, never an unhandled rejection that ends the server. */
	private background(work: Promise<void>): void {
		work.catch((e: unknown) => this.abandon(e));
	}

	/**
	 * A job that could not be followed to its end or settled (what it left cannot be read, or the page could not be
	 * told): its files are moved to `omp-job.failed` (the last one is kept for whoever looks, the one before it is
	 * replaced), so that no later start meets them again, and the job shows as failed with the reason, in the log and on
	 * the page. Nothing here may throw: it runs where the server is starting.
	 */
	private abandon(error: unknown): void {
		const reason = error instanceof Error ? error.message : String(error);
		const kept = `${this.jobDir}.failed`;
		let where = "removed";
		try {
			rmSync(kept, { recursive: true, force: true });
			renameSync(this.jobDir, kept);
			where = kept;
		} catch {
			try {
				rmSync(this.jobDir, { recursive: true, force: true });
			} catch {
				where = "left where it is";
			}
		}
		const run = this.run;
		const command = run?.job.command ?? "omp update";
		console.error(`omp-webui: could not settle the ${command} an earlier run started (${reason}); its files: ${where}`);
		if (!run || (run.job.state !== "running" && run.job.state !== "waiting")) return;
		run.proc = null;
		run.pid = null;
		run.job.state = "failed";
		run.job.endedAt = Date.now();
		run.job.error = `${command} ended while omp-webui was closed, but how it ended could not be read: ${reason}`;
		run.job.errorInfo = { code: "jobNotSettled", params: { command, reason } };
		if (this.initializing) return;
		try {
			this.emit();
		} catch {
			// the page's socket is what failed
		}
	}

	/**
	 * Run a job, and see it through. It is started so that it does not depend on this server: in a session of its own,
	 * writing to a file (`output.log`) instead of pipes — a pipe whose reader has gone makes the next write end the
	 * writer, which is what quitting the app did to an install half way — and its exit status goes to a file as well
	 * (`JOB_WRAPPER`). `job.json` says what runs, so that a server started later takes the job over (`resume`).
	 */
	private async execute(run: JobRun): Promise<void> {
		run.job.state = "running";
		run.job.waiting = noHolds();
		run.job.startedAt = Date.now();
		this.emit();
		try {
			rmSync(this.jobDir, { recursive: true, force: true });
			mkdirSync(this.jobDir, { recursive: true, mode: 0o700 });
			const out = openSync(this.jobFile("output.log"), "a", 0o600);
			try {
				const proc = Bun.spawn(["/bin/sh", "-c", JOB_WRAPPER, "sh", this.jobFile("exit"), ...run.argv], {
					cwd: this.home,
					env: run.env,
					stdin: "ignore",
					stdout: out,
					stderr: out,
					detached: true,
				});
				// A job still running must not keep this process from ending.
				proc.unref();
				run.proc = proc;
				run.pid = proc.pid;
			} finally {
				closeSync(out);
			}
			// The record is written at once, with the process's id: a server that takes the job over must find it
			// there, and a `ps` that cannot answer in time (a loaded machine) must not hold the record back (#536).
			// The status file's path is what the process carries, and what tells it from a stranger with the same id (#543).
			run.ref = run.pid === null ? null : { pid: run.pid, started: "", marker: this.jobFile("exit") };
			this.saveRecord(run);
		} catch (e) {
			run.job.endedAt = Date.now();
			return this.fail(run, `Could not run ${run.job.command}: ${(e as Error).message}`, {
				code: "jobCouldNotRun",
				params: { command: run.job.command, reason: (e as Error).message },
			});
		}
		// When the process began is what tells it from another with the same id. It is asked for now, and the record is
		// written again with it; a `ps` that cannot say leaves the job with its id alone, and the start time is asked
		// for again while the job runs (#536).
		this.learnStartTime(run);
		await this.follow(run);
	}

	/**
	 * A job an earlier server started: still running (it is followed again from `start`), or ended while no server was
	 * there to see it, and is settled now — an install that finished while the app was closed is adopted and the
	 * first-time setup begins, as if it had been watched.
	 */
	private async resume(): Promise<void> {
		const record = this.readRecord();
		if (!record) {
			rmSync(this.jobDir, { recursive: true, force: true });
			return;
		}
		const job: OmpJob = {
			id: `J${++this.seq}`,
			kind: record.kind,
			method: record.method,
			command: record.command,
			state: "running",
			exitCode: null,
			error: null,
			startedAt: record.startedAt,
			endedAt: null,
			auto: record.auto,
			waiting: noHolds(),
			anyway: false,
			version: null,
		};
		// What the job has written so far (its last part, as a page keeps no more) is there from the first request.
		let log = "";
		let offset = 0;
		try {
			const fd = openSync(this.jobFile("output.log"), "r");
			try {
				const size = statSync(this.jobFile("output.log")).size;
				const from = Math.max(0, size - LOG_LIMIT);
				const chunk = Buffer.allocUnsafe(size - from);
				const n = readSync(fd, chunk, 0, chunk.length, from);
				log = Bun.stripANSI(chunk.subarray(0, n).toString("utf8"));
				offset = from + n;
			} finally {
				closeSync(fd);
			}
		} catch {
			// No output was written.
		}
		const run: JobRun = {
			job,
			argv: [],
			env: {},
			log,
			proc: null,
			pid: record.process?.pid ?? null,
			ref: record.process,
			cancelled: false,
			before: record.before,
			following: false,
			askingStart: false,
			unconfirmedSince: 0,
			confirmed: null,
			offset,
		};
		this.run = run;
		// A job that has ended is settled at once; one that is running is followed from `start` (the server is not
		// watching a job it did not start, and the page is told of it in the meantime).
		if (await this.ended(run)) await this.follow(run);
	}

	private fail(run: JobRun, message: string, info?: ErrorInfo): void {
		run.job.state = "failed";
		run.job.error = message;
		run.job.errorInfo = info;
		run.job.endedAt = Date.now();
		if (run.job.auto && this.release) this.autoFailed = this.release.latest;
		this.emit();
	}

	private async finish(run: JobRun, code: number | null): Promise<void> {
		const job = run.job;
		if (run.cancelled) return this.fail(run, "Cancelled", { code: "jobCancelled" });
		if (code !== 0) {
			const said = lastLines(run.log);
			const how = code === null ? "was stopped before it finished" : `exited with code ${code}`;
			const message = `${job.command} ${how}${said ? `:\n${said}` : ""}`;
			// What the command printed is omp's own (or the installer's) and stays as it was.
			const params = { command: job.command, ...(code === null ? {} : { code }), ...(said ? { output: said } : {}) };
			const failure: ErrorCode =
				code === null ? (said ? "jobStoppedOutput" : "jobStopped") : said ? "jobExitedOutput" : "jobExited";
			return this.fail(run, message, { code: failure, params });
		}
		if (job.kind === "install") {
			// The installer may have put omp where `PATH` does not reach (`~/.local/bin`): look in all of `searchDirs`.
			const bin = findOmp(this.env, undefined, this.home);
			if (!bin) {
				const dirs = searchDirs(this.env, this.home).join(", ");
				return this.fail(run, `The installer finished, but omp was not found afterwards. Looked in: ${dirs}`, {
					code: "installNotFound",
					params: { dirs },
				});
			}
			if (!(await this.adopt(bin)))
				return this.fail(run, `omp was installed at ${bin} but does not run: ${this.error}`, {
					code: "installDoesNotRun",
					params: { bin, error: this.error ?? "" },
				});
			this.saveSettings({ ...this.settings, onboarding: true });
		} else {
			if (!(await this.adopt(this.cfg.ompBin)))
				return this.fail(run, `omp was updated but does not run: ${this.error}`, {
					code: "updateDoesNotRun",
					params: { error: this.error ?? "" },
				});
			if (run.before && this.version && compareVersions(this.version, run.before) <= 0) {
				return this.fail(run, `omp update finished, but omp still reports ${this.version}`, {
					code: "updateStillOld",
					params: { version: this.version },
				});
			}
			this.autoFailed = null;
		}
		job.state = "done";
		job.version = this.version;
		job.error = null;
		job.errorInfo = undefined;
		this.emit();
		// A fresh install has not looked yet; an update already knows (what is newer is worked out from the version).
		if (job.kind === "install" && this.checkEnabled) void this.check();
	}

	// ------------------------------------------------------------------ HTTP

	/** `GET /api/omp`, and the `POST /api/omp/<action>`s. */
	async handle(req: Request, url: URL): Promise<Response> {
		if (url.pathname === "/api/omp")
			return req.method === "GET" ? json(this.snapshot()) : json({ error: "GET required" }, 405);
		if (req.method !== "POST") return json({ error: "POST required" }, 405);
		const parsed: unknown = await req.json().catch(() => ({}));
		const body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
		try {
			switch (url.pathname) {
				case "/api/omp/install":
					this.startInstall(typeof body.method === "string" ? body.method : "");
					break;
				case "/api/omp/update":
					this.startUpdate(body.acknowledgeCompat === true, false, body.anyway === true);
					break;
				case "/api/omp/cancel":
					this.cancel();
					break;
				case "/api/omp/check":
					await this.check();
					break;
				case "/api/omp/recheck":
					await this.recheck();
					break;
				case "/api/omp/settings":
					if (typeof body.autoUpdate !== "boolean") return json({ error: "autoUpdate must be true or false" }, 400);
					this.setAutoUpdate(body.autoUpdate);
					break;
				case "/api/omp/onboarding":
					if (typeof body.pending !== "boolean") return json({ error: "pending must be true or false" }, 400);
					this.setOnboarding(body.pending);
					break;
				default:
					return json({ error: "Not found" }, 404);
			}
		} catch (e) {
			if (e instanceof LifecycleError) return json({ error: e.message, code: e.code }, e.status);
			throw e;
		}
		return json(this.snapshot());
	}
}
