import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdtempSync,
	openSync,
	readdirSync,
	realpathSync,
	renameSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import type {
	AppRelease,
	AppUpdateState,
	CheckFailure,
	InstallBlock,
	UpdateFailure,
	UpdateJob,
	UpdateOutcome,
	UpdatePhase,
	UpdateRefusal,
	UpdateSnapshot,
} from "../../shared/update.ts";
import {
	ensureUpdateDir,
	type Handover,
	readHandover,
	readJson,
	readOutcome,
	removeFiles,
	rotateLog,
	type UpdatePaths,
	writeJson,
} from "./files.ts";
import helperScript from "./helper.sh" with { type: "text" };
import {
	DEFAULT_API,
	type Fetched,
	fetchLatest,
	type Installer,
	isNewer,
	type ParsedRelease,
	parseRelease,
} from "./release.ts";
import { attach, detach, download, freeSpace, stage, UpdateCancelled, UpdateError, writable } from "./steps.ts";
import { designatedRequirementOf, leafOf, refusalOf } from "./verify.ts";

/**
 * The app's own updates (#571), as the server runs them: it looks for a newer release (at start and every six hours,
 * cheaply), and on a click downloads the installer, checks it, copies the new app next to the installed one and hands over
 * to a helper that swaps them once the app has quit (`helper.sh`). Created on first use (`server/main.ts` loads this module
 * lazily): a server that is never asked and has no timer due never loads it.
 */

/** What the pool of conversations holds, as the page's confirmation needs it (`UpdateRefusal` `replying`). */
export interface Conversations {
	working: number;
	asking: number;
	paused: number;
	waiting: number;
}

export interface UpdaterOptions {
	dataDir: string;
	/** The version running now. */
	installed: string;
	/** The app bundle this server belongs to (`OMP_WEBUI_APP_BUNDLE`, set by the macOS shell), null when it is none. */
	bundle: string | null;
	/** The macOS shell that started this server, which is asked to quit for the update. */
	parentPid: number | null;
	/** `OMP_WEBUI_APP_UPDATE_API`: another server that answers like GitHub's API (tests). */
	api?: string;
	/** The timers run: at start and every `intervalMs`, when `autoChecks()` says the user wants them. */
	automatic: boolean;
	autoChecks(): boolean;
	conversations(): Conversations;
	/** Every change, for the pages (local ones only). */
	broadcast(state: AppUpdateState): void;
	/** How long after `start` the first look is made; 0: at once (the server starts the updater itself some time after it starts). */
	firstCheckMs?: number;
	intervalMs?: number;
	/** How long the helper waits for the app to quit, and for the new one to say it is up. */
	quitSecs?: number;
	startSecs?: number;
	/** For tests. */
	fetch?: typeof fetch;
	now?: () => number;
	/** Quit the shell for the update (`SIGUSR1`). */
	signalParent?: (pid: number) => void;
	/** The environment the relaunched app is given what it was started with from (see `RELAUNCH_ENV`). */
	env?: Record<string, string | undefined>;
	/** How many bytes of this volume hold: free space in a directory, null where the file system cannot say. For tests. */
	freeBytes?: (dir: string) => number | null;
	/** The command that starts the app (`open` with the forwarded environment by default); a test's stand-in for it. */
	relaunch?: string[];
}

/** An install that was asked for and will not start: the 409 the page words (`UpdateRefusal`). */
export interface InstallRefusal {
	code: UpdateRefusal;
	params: Record<string, string | number>;
	error: string;
}

const INTERVAL_MS = 6 * 60 * 60_000;
/** The app in the installer (scripts/dmg.ts puts it at the image's root under this name). */
const APP_NAME = "omp-webui.app";
/** The room an install needs, in installer sizes: the image, the copy of the app, and the old app kept beside the new one. */
const ROOM_FACTOR = 3;
/** A second look is not a second request within this: a double click, a page and a timer at once. */
const MIN_GAP_MS = 10_000;
const PROGRESS_MS = 250;

/**
 * What the relaunched app takes from the environment of this one, besides what its shell sets itself (the token, the
 * parent, the dist folder…): where its data and omp are, and the settings of a test or a developer. `open` starts an app
 * with none of the caller's environment, and a copy started with another data dir or home would come back with the real one.
 */
const RELAUNCH_ENV =
	/^(OMP_WEBUI_(?!TOKEN$|PARENT_PID$|DIST$|AUTO_PORT$|LOGIN_SHELL$|APP_BUNDLE$)\w+|HOME|PI_CODING_AGENT_DIR|OMP_BIN)$/;

/** The command that starts the app at `bundle` the way a person's click would, with what it must be started with (`RELAUNCH_ENV`). */
export function relaunchCommand(bundle: string, env: Record<string, string | undefined>): string[] {
	const forwarded = Object.entries(env).flatMap(([k, v]) =>
		v !== undefined && RELAUNCH_ENV.test(k) ? ["--env", `${k}=${v}`] : [],
	);
	return ["/usr/bin/open", ...forwarded, bundle];
}

export class AppUpdater {
	private readonly paths: UpdatePaths;
	private readonly api: string;
	private readonly boot = randomUUID();
	private rev = 0;
	private readonly now: () => number;
	private readonly ready: Promise<void>;

	private checking: Promise<void> | null = null;
	private checkedAt: number | null = null;
	private etag: string | null = null;
	private lastBody: unknown = null;
	private parsed: ParsedRelease | null = null;
	private failure: CheckFailure | null = null;
	private blockedUntil: number | null = null;
	private lastRequestAt = 0;

	private job: UpdateJob | null = null;
	private cancel: AbortController | null = null;
	private failed: UpdateFailure | null = null;
	private outcome: UpdateOutcome | null = null;
	/** The running app has a signature to compare a download with; null until looked at. */
	private signed: boolean | null = null;
	private timers: NodeJS.Timeout[] = [];
	private lastProgressAt = 0;

	constructor(private readonly opts: UpdaterOptions) {
		this.api = opts.api ?? DEFAULT_API;
		this.now = opts.now ?? Date.now;
		this.paths = ensureUpdateDir(opts.dataDir);
		const cached = readJson(this.paths.check);
		if (isRecord(cached) && typeof cached.checkedAt === "number") {
			this.parsed = parseRelease(cached.body, this.api);
			if (this.parsed) {
				this.etag = typeof cached.etag === "string" ? cached.etag : null;
				this.lastBody = cached.body;
				this.checkedAt = cached.checkedAt;
			}
		}
		this.ready = this.init();
	}

	// ------------------------------------------------------------------ state

	state(): AppUpdateState {
		const latest = this.parsed?.release ?? null;
		return {
			boot: this.boot,
			rev: this.rev,
			installed: this.opts.installed,
			install: this.installState(),
			checking: this.checking !== null,
			checkedAt: this.checkedAt,
			latest,
			newer: latest !== null && isNewer(latest, this.opts.installed),
			failure: this.failure,
			job: this.job ? { ...this.job } : null,
			failed: this.failed,
			outcome: this.outcome,
		};
	}

	/** Whether the page has anything to show of this state before it asks: a newer release, an install, how one ended. */
	worthShowing(): boolean {
		const s = this.state();
		return s.newer || s.job !== null || s.failed !== null || s.outcome !== null;
	}

	snapshot(): UpdateSnapshot {
		return { state: this.state() };
	}

	private emit(): void {
		this.rev++;
		this.opts.broadcast(this.state());
	}

	private installState(): AppUpdateState["install"] {
		const reason = this.installBlock();
		return reason === null ? { allowed: true } : { allowed: false, reason };
	}

	private installBlock(): InstallBlock | null {
		const { bundle, parentPid } = this.opts;
		// Without a shell to ask to quit there is nobody to hand the swap to.
		if (bundle === null || parentPid === null) return "notApp";
		if (bundle.includes("/AppTranslocation/")) return "translocated";
		if (!writable(dirname(bundle))) return "notWritable";
		if (this.signed === false) return "adHoc";
		return null;
	}

	// ------------------------------------------------------------------ start-up

	private async init(): Promise<void> {
		const { bundle } = this.opts;
		if (bundle !== null) {
			const requirement = await designatedRequirementOf(bundle).catch(() => null);
			this.signed = requirement !== null && leafOf(requirement) !== null;
		}
		await this.sweep();
		this.outcome = readOutcome(this.paths);
		this.acknowledge();
		this.clearLeftovers();
		if (this.worthShowing()) this.emit();
	}

	/**
	 * What an install that was cut short left: it is not stopped by the app quitting or the server dying (`hdiutil` and `ditto`
	 * run on, detached), so an image can stay mounted at `mount-*`, a download at `*.dmg` or `*.part`, and a partial copy at
	 * `<app>.updating`. Nothing runs an install at this point (an install waits for `ready`), so all of it is stale — except
	 * the staged copy of an update whose helper is alive and waiting to swap it in, which is that helper's.
	 */
	private async sweep(): Promise<void> {
		const handover = readHandover(this.paths);
		const owned = handover !== null && alive(handover.helperPid) ? handover.staged : null;
		for (const name of readdirSync(this.paths.dir)) {
			const path = join(this.paths.dir, name);
			if (name.startsWith("mount-")) await removeMount(path);
			else if (name.endsWith(".dmg") || name.endsWith(".part")) rmSync(path, { force: true });
		}
		const staged = this.opts.bundle === null ? null : `${this.opts.bundle}.updating`;
		if (staged !== null && staged !== owned) rmSync(staged, { recursive: true, force: true });
		// What a helper that died in the middle of a rollback left aside (see helper.sh).
		if (this.opts.bundle !== null && owned === null)
			rmSync(`${this.opts.bundle}.failed`, { recursive: true, force: true });
	}

	/**
	 * An update was handed to the helper and this server is what started after it: when it is the version the helper
	 * installed, say so (the helper waits for it, and removes the old app once it has), and keep how it ended for the page.
	 */
	private acknowledge(): void {
		const handover = readHandover(this.paths);
		if (!handover) return;
		const { bundle, installed } = this.opts;
		let same = false;
		try {
			same = bundle !== null && realpathSync(bundle) === realpathSync(handover.installed);
		} catch {
			// a bundle that cannot be resolved is not the installed one
		}
		if (!same || installed !== handover.to) return;
		writeJson(this.paths.ack, { id: handover.id, version: installed, pid: process.pid });
		const outcome: UpdateOutcome = { ok: true, from: handover.from, to: handover.to, at: this.now() };
		writeJson(this.paths.result, outcome);
		this.outcome = outcome;
	}

	/**
	 * What a helper that died left: a staged copy and the record that it was handed over. Only when no helper runs and the
	 * record is none that this server just answered.
	 */
	private clearLeftovers(): void {
		const handover = readHandover(this.paths);
		if (handover && this.opts.installed !== handover.to && !alive(handover.helperPid)) {
			rmSync(handover.staged, { recursive: true, force: true });
			removeFiles(this.paths.handover);
		}
	}

	/** Look soon after start and then every six hours, while the user wants it (`autoChecks`, read at each look). */
	start(): void {
		if (!this.opts.automatic || this.timers.length > 0) return;
		const look = () => {
			if (this.opts.autoChecks()) void this.check();
		};
		const first = setTimeout(look, this.opts.firstCheckMs ?? 0);
		const every = setInterval(look, this.opts.intervalMs ?? INTERVAL_MS);
		first.unref();
		every.unref();
		this.timers.push(first, every);
	}

	/** The server is going away: a download stops and is removed; an update that was handed over goes on without it. */
	stop(): void {
		for (const t of this.timers.splice(0)) clearTimeout(t);
		if (this.job && this.job.phase !== "handover") this.cancel?.abort();
	}

	// ------------------------------------------------------------------ looking for a release

	/** One look at GitHub, shared by whoever asks while it is under way. */
	check(): Promise<void> {
		this.checking ??= this.look().finally(() => {
			this.checking = null;
			this.emit();
		});
		this.emit();
		return this.checking;
	}

	private async look(): Promise<void> {
		await this.ready;
		const now = this.now();
		if (this.blockedUntil !== null && now < this.blockedUntil) {
			this.failure = { code: "rateLimited", retryAt: this.blockedUntil };
			return;
		}
		if (now - this.lastRequestAt < MIN_GAP_MS) return;
		this.lastRequestAt = now;
		const answer = await fetchLatest({
			api: this.api,
			etag: this.etag,
			userAgent: `omp-webui/${this.opts.installed}`,
			fetch: this.opts.fetch,
			now: this.now,
		});
		this.take(answer);
	}

	private take(answer: Fetched): void {
		this.blockedUntil = answer.rate.blockedUntil;
		const at = this.now();
		if (answer.kind === "failure") {
			this.failure = answer.failure;
			// Nothing is reachable at this address now: what an earlier look found is not either, and its ETag is of no use. It is
			// an answer all the same (the state of every app while the repository is private), so the look is dated.
			if (answer.failure.code === "noRelease") {
				this.checkedAt = at;
				this.parsed = null;
				this.etag = null;
				this.lastBody = null;
				removeFiles(this.paths.check);
			}
			return;
		}
		if (answer.kind === "release") {
			const parsed = parseRelease(answer.body, this.api);
			if (!parsed) {
				this.failure = { code: "badAnswer" };
				return;
			}
			this.parsed = parsed;
			this.etag = answer.etag;
			this.lastBody = answer.body;
		}
		// 304: what is held is still the latest.
		this.failure = null;
		this.checkedAt = at;
		if (this.parsed) writeJson(this.paths.check, { etag: this.etag, checkedAt: at, body: this.lastBody });
	}

	// ------------------------------------------------------------------ installing

	/** The refusal of an install that was asked for, or null when it may start. */
	private refusal(tag: string, anyway: boolean): InstallRefusal | null {
		const block = this.installBlock();
		if (block !== null) {
			return {
				code: "blocked",
				params: { reason: block },
				error: `This copy of the app cannot replace itself (${block}).`,
			};
		}
		if (this.job) return { code: "busy", params: {}, error: "An update is already being installed." };
		const release = this.parsed?.release;
		if (!release || !this.parsed?.installer || release.tag !== tag || !isNewer(release, this.opts.installed)) {
			return { code: "nothingToInstall", params: {}, error: "There is no newer release with an installer to install." };
		}
		const held = this.opts.conversations();
		if (!anyway && held.working + held.asking > 0) {
			return {
				code: "replying",
				params: { ...held },
				error: "Conversations are still working; installing the update stops them.",
			};
		}
		return null;
	}

	/**
	 * Start installing `tag` (the release the user was shown). Resolves once it has started, or answers why it will not;
	 * the install itself goes on in the background and reports through `broadcast`.
	 */
	async install(tag: string, anyway: boolean): Promise<UpdateSnapshot | InstallRefusal> {
		await this.ready;
		const refused = this.refusal(tag, anyway);
		if (refused) return refused;
		const parsed = this.parsed as ParsedRelease;
		const job: UpdateJob = {
			id: randomUUID(),
			tag,
			phase: "downloading",
			received: 0,
			total: parsed.release.asset?.size ?? 0,
			startedAt: this.now(),
		};
		this.job = job;
		this.failed = null;
		this.outcome = null;
		removeFiles(this.paths.result);
		this.cancel = new AbortController();
		this.emit();
		void this.run(job, parsed.release, parsed.installer as Installer, this.cancel.signal);
		return this.snapshot();
	}

	/** Stop a download or the checks that follow it; what was staged is removed. Nothing after the handover can be stopped. */
	cancelInstall(): UpdateSnapshot {
		if (this.job && this.job.phase !== "handover") this.cancel?.abort();
		return this.snapshot();
	}

	dismiss(): UpdateSnapshot {
		this.failed = null;
		this.outcome = null;
		removeFiles(this.paths.result);
		this.emit();
		return this.snapshot();
	}

	private phase(job: UpdateJob, phase: UpdatePhase): void {
		job.phase = phase;
		this.emit();
	}

	private async run(job: UpdateJob, release: AppRelease, installer: Installer, signal: AbortSignal): Promise<void> {
		const bundle = this.opts.bundle as string;
		const dmg = join(this.paths.dir, `${release.tag}.dmg`);
		const part = `${dmg}.part`;
		const staged = `${bundle}.updating`;
		let mount: string | null = null;
		let handedOver = false;
		let failure: UpdateFailure | null = null;
		const expected = { running: bundle, version: release.version, installed: this.opts.installed };
		const checkCancelled = () => {
			if (signal.aborted) throw new UpdateCancelled();
		};
		try {
			// Before the first byte: the image, the copy of the app out of it and the room the swap needs are all on disk at once.
			this.ensureRoom(release.asset?.size ?? 0, bundle);
			await download({
				url: installer.url,
				dest: part,
				size: release.asset?.size ?? 0,
				sha256: installer.sha256,
				signal,
				fetch: this.opts.fetch,
				onProgress: (received) => {
					job.received = received;
					const now = this.now();
					if (now - this.lastProgressAt >= PROGRESS_MS) {
						this.lastProgressAt = now;
						this.emit();
					}
				},
			});
			renameOver(part, dmg);
			checkCancelled();

			// The image's app is looked at before anything is copied; the copy is looked at again, since that is what is installed.
			this.phase(job, "verifying");
			mount = mkdtempSync(join(this.paths.dir, "mount-"));
			await attach(dmg, mount);
			checkCancelled();
			if (!existsSync(join(mount, APP_NAME, "Contents", "Info.plist")))
				throw new UpdateError("noApp", { name: APP_NAME });
			const inImage = await refusalOf(join(mount, APP_NAME), expected);
			if (inImage) throw new UpdateError(inImage.code, inImage.params);
			checkCancelled();

			this.phase(job, "staging");
			await stage(mount, APP_NAME, staged);
			await removeMount(mount);
			mount = null;
			removeFiles(dmg);
			checkCancelled();
			const inStaged = await refusalOf(staged, expected);
			if (inStaged) throw new UpdateError(inStaged.code, inStaged.params);
			checkCancelled();

			this.handOver(job, release, bundle, staged);
			handedOver = true;
		} catch (e) {
			if (!(e instanceof UpdateCancelled)) {
				const error =
					e instanceof UpdateError ? e : new UpdateError("stage", { detail: (e as Error).message.slice(0, 300) });
				if (!(e instanceof UpdateError)) console.error("omp-webui: the update failed:", e);
				failure = { code: error.code, tag: release.tag, params: error.params };
			}
		}
		// What was made is removed before the page is told it is over: it never sees a failure with its files still there.
		if (mount !== null) {
			await removeMount(mount);
		}
		if (!handedOver) {
			rmSync(staged, { recursive: true, force: true });
			removeFiles(part, dmg);
			this.job = null;
		}
		this.failed = failure;
		this.cancel = null;
		this.emit();
	}

	/**
	 * Refuse, before anything is downloaded, an install that the disk cannot hold: three times the installer's size must be free
	 * on the volume the download is kept on (this server's data folder) and on the volume of the installed app, where the
	 * new app is copied next to the old one and the old one is kept until the new one is up.
	 */
	private ensureRoom(installerBytes: number, bundle: string): void {
		const needed = installerBytes * ROOM_FACTOR;
		const free = this.opts.freeBytes ?? freeSpace;
		for (const dir of [this.paths.dir, dirname(bundle)]) {
			const available = free(dir);
			if (available !== null && available < needed) throw new UpdateError("space", { needed, free: available });
		}
	}

	/**
	 * Everything is staged and checked: start the helper that waits for the app to quit and swaps, ask the shell to quit, and
	 * wait for the end. The app's own quit stops this server, so what happens next is the helper's; a helper that cannot do
	 * its part has written why before this server is asked again.
	 */
	private handOver(job: UpdateJob, release: AppRelease, bundle: string, staged: string): void {
		const parent = this.opts.parentPid as number;
		const id = randomUUID();
		const backup = `${bundle}.previous`;
		const quitSecs = this.opts.quitSecs ?? 90;
		const startSecs = this.opts.startSecs ?? 60;
		removeFiles(this.paths.ack, this.paths.result);
		writeFileSync(this.paths.helper, helperScript, { mode: 0o700 });
		rotateLog(this.paths.helperLog);
		const log = openSync(this.paths.helperLog, "a", 0o600);
		let pid: number;
		try {
			const proc = Bun.spawn(
				[
					"/bin/sh",
					this.paths.helper,
					id,
					String(parent),
					bundle,
					staged,
					backup,
					this.paths.dir,
					String(quitSecs),
					String(startSecs),
					this.opts.installed,
					release.version,
					"--",
					...(this.opts.relaunch ?? relaunchCommand(bundle, this.opts.env ?? process.env)),
				],
				{
					cwd: "/",
					env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" },
					stdin: "ignore",
					stdout: log,
					stderr: log,
					// Its own session: it must outlive the app, which ends the process group this server is in.
					detached: true,
				},
			);
			proc.unref();
			pid = proc.pid;
		} finally {
			closeSync(log);
		}
		const handover: Handover = {
			id,
			from: this.opts.installed,
			to: release.version,
			installed: bundle,
			staged,
			backup,
			helperPid: pid,
		};
		// Before the shell is asked: it quits only for an update it can see.
		writeJson(this.paths.handover, handover);
		this.phase(job, "handover");
		(this.opts.signalParent ?? ((p) => process.kill(p, "SIGUSR1")))(parent);
		// Normally the app quits and this server with it. A helper that gave up (the app did not quit in time) has written
		// why and put nothing in place: this server is still here to say so.
		const waiting = setTimeout(() => this.handoverEnded(handover), (quitSecs + 20) * 1000);
		waiting.unref();
		this.timers.push(waiting);
	}

	/** The app did not quit and the helper ended (or died): how it ended is on the page, and what was staged is gone. */
	private handoverEnded(handover: Handover): void {
		if (readHandover(this.paths)?.id !== handover.id) return;
		const written = readOutcome(this.paths);
		if (!alive(handover.helperPid)) {
			this.outcome = written ?? {
				ok: false,
				from: handover.from,
				to: handover.to,
				at: this.now(),
				problem: "quitTimeout",
			};
			removeFiles(this.paths.handover);
			rmSync(handover.staged, { recursive: true, force: true });
		} else {
			try {
				process.kill(handover.helperPid, "SIGTERM");
			} catch {
				// gone already
			}
			rmSync(handover.staged, { recursive: true, force: true });
			removeFiles(this.paths.handover);
			this.outcome = { ok: false, from: handover.from, to: handover.to, at: this.now(), problem: "quitTimeout" };
		}
		this.job = null;
		this.emit();
	}

	// ------------------------------------------------------------------ HTTP

	/** `/api/update`, `/api/update/check`, `/install`, `/cancel`, `/dismiss`. */
	async handle(req: Request, url: URL): Promise<Response> {
		const json = (data: unknown, status = 200) =>
			new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
		await this.ready;
		const post = req.method === "POST";
		switch (url.pathname) {
			case "/api/update":
				return req.method === "GET" ? json(this.snapshot()) : json({ error: "GET required" }, 405);
			case "/api/update/check":
				if (!post) return json({ error: "POST required" }, 405);
				await this.check();
				return json(this.snapshot());
			case "/api/update/install": {
				if (!post) return json({ error: "POST required" }, 405);
				const body: unknown = await req.json().catch(() => null);
				if (!isRecord(body) || typeof body.tag !== "string") return json({ error: "tag required" }, 400);
				const answer = await this.install(body.tag, body.anyway === true);
				return "state" in answer ? json(answer) : json(answer, 409);
			}
			case "/api/update/cancel":
				return post ? json(this.cancelInstall()) : json({ error: "POST required" }, 405);
			case "/api/update/dismiss":
				return post ? json(this.dismiss()) : json({ error: "POST required" }, 405);
			default:
				return json({ error: "Not found" }, 404);
		}
	}
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/** `from` moved over `to` (an earlier download of the same release is replaced): one rename in one folder. */
function renameOver(from: string, to: string): void {
	rmSync(to, { force: true });
	renameSync(from, to);
}

/**
 * An image's mount point detached and its folder removed. Never throws: an image that will not detach is left (it is mounted
 * read-only, so removing the folder cannot touch it), and the install that wanted it gone still ends the way it was ending.
 */
async function removeMount(path: string): Promise<void> {
	await detach(path);
	try {
		rmSync(path, { recursive: true, force: true });
	} catch (e) {
		console.warn(`omp-webui: updates: ${path} could not be removed: ${(e as Error).message}`);
	}
}
