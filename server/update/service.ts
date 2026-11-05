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
import { basename, dirname, join } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import type { PlatformId } from "../../shared/platform.ts";
import type {
	AppRelease,
	AppUpdateState,
	CheckFailure,
	Conversations,
	InstallBlock,
	UpdateFailure,
	UpdateJob,
	UpdateOutcome,
	UpdatePhase,
	UpdateRefusal,
	UpdateSnapshot,
} from "../../shared/update.ts";
import { platform } from "../platform/index.ts";
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
import helperWindowsScript from "./helper.ps1" with { type: "text" };
import helperScript from "./helper.sh" with { type: "text" };
import {
	DEFAULT_API,
	type Fetched,
	fetchLatest,
	type Installer,
	type InstallerPlatform,
	installerPlatformOf,
	isNewer,
	type ParsedRelease,
	parseRelease,
	windowsArchOf,
} from "./release.ts";
import { attach, detach, download, freeSpace, stage, UpdateCancelled, UpdateError, writable } from "./steps.ts";
import { designatedRequirementOf, leafOf, refusalOf } from "./verify.ts";
import { canWriteIn, powershellCommand, stageWindows, startHidden, WINDOWS_EXE, type WindowsArch } from "./windows.ts";

/**
 * The app's own updates (#571), as the server runs them: it looks for a newer release (at start and every six hours,
 * cheaply), and on a click (or by itself, `autoInstall`) downloads the installer, checks it, puts the new version next to
 * the installed one and hands over to a helper that swaps them once the app has quit. Two installs: the macOS app's (a
 * signed disk image, `helper.sh`)
 * and the Windows launcher's (a zip, `windows.ts` and `helper.ps1`), by the `InstallTarget` the server was started as.
 * Created on first use (`server/main.ts` loads this module lazily): a server that is never asked and has no timer due
 * never loads it.
 */

/**
 * What an install replaces: the macOS app bundle (`OMP_WEBUI_APP_BUNDLE`, set by the macOS shell), or the folder of the
 * Windows launcher (`OMP_WEBUI_APP_FOLDER`, set by `omp-webui.exe`: the folder it is in, holding it and `web/`).
 */
export type InstallTarget = { kind: "mac"; bundle: string } | { kind: "windows"; folder: string };

/** The path an install replaces: the bundle, or the folder. */
const pathOf = (target: InstallTarget): string => (target.kind === "mac" ? target.bundle : target.folder);

export interface UpdaterOptions {
	dataDir: string;
	/** The version running now. */
	installed: string;
	/** What an install replaces (see `InstallTarget`); null when this server is neither the macOS app nor the Windows launcher. */
	target: InstallTarget | null;
	/** The macOS shell that started this server, which is asked to quit for the update (the macOS app only). */
	parentPid: number | null;
	/** `OMP_WEBUI_APP_UPDATE_API`: another server that answers like GitHub's API (tests). */
	api?: string;
	/** The timers run: at start and every `intervalMs`, when `autoChecks()` says the user wants them. */
	automatic: boolean;
	autoChecks(): boolean;
	/**
	 * Install a newer release by itself (`ompw.appAutoUpdate`, read at each look): once it is known with an installer for
	 * this system and no conversation is working, asking, paused or waiting. A release whose automatic install failed, was
	 * cancelled or was rolled back is not tried again by itself.
	 */
	autoInstall(): boolean;
	conversations(): Conversations;
	/** Every change, for the pages (local ones only). */
	broadcast(state: AppUpdateState): void;
	/** How long after `start` the first look is made; 0: at once (the server starts the updater itself some time after it starts). */
	firstCheckMs?: number;
	intervalMs?: number;
	/** How often an automatic install looks whether it may start (`AUTO_MS`); a test's shorter one. */
	autoMs?: number;
	/** How long the helper waits for the app to quit, and for the new one to say it is up. */
	quitSecs?: number;
	startSecs?: number;
	/** For tests. */
	fetch?: typeof fetch;
	now?: () => number;
	/**
	 * For tests: the system and processor this server runs on (this one's by default): whose installer a server that is no
	 * app shows, and which processor's zip the Windows launcher takes.
	 */
	system?: { id: PlatformId; arch: string };
	/** Quit the shell for the update (`SIGUSR1`; the macOS app). */
	signalParent?: (pid: number) => void;
	/**
	 * End this server for the update (the Windows launcher, which is the server: there is no shell to ask). The server's own
	 * shutdown by default (`server/main.ts`); `process.exit` when none is given.
	 */
	quit?: () => void;
	/** The environment the relaunched app is given what it was started with from (see `RELAUNCH_ENV`). */
	env?: Record<string, string | undefined>;
	/** How many bytes of this volume hold: free space in a directory, null where the file system cannot say. For tests. */
	freeBytes?: (dir: string) => number | null;
	/** The command that starts the app (`open` with the forwarded environment by default); a test's stand-in for it. */
	relaunch?: string[];
	/** How `helper.ps1` is started, given its arguments to Windows PowerShell; its pid (`startHidden`). A test's stand-in. */
	startHelper?: (args: string[]) => Promise<number>;
	/** How long the Windows launcher waits for `helper.ps1` to say it runs (`HELPER_START_MS`); a test's shorter one. */
	helperStartMs?: number;
	/** How long past the helper's time for the app to quit this server looks whether it gave up (`HANDOVER_SLACK_SECS`); a test's shorter one. */
	handoverSlackSecs?: number;
}

/** An install that was asked for and will not start: the 409 the page words (`UpdateRefusal`). */
export interface InstallRefusal {
	code: UpdateRefusal;
	params: Record<string, string | number>;
	error: string;
}

const INTERVAL_MS = 6 * 60 * 60_000;
/** How often an automatic install looks whether it may start (the conversations it waits for may have finished). */
const AUTO_MS = 60_000;
/** The app in the installer (scripts/dmg.ts puts it at the image's root under this name). */
const APP_NAME = "omp-webui.app";
/** The room an install needs, in installer sizes: the image, the copy of the app, and the old app kept beside the new one. */
const ROOM_FACTOR = 3;
/** A second look is not a second request within this: a double click, a page and a timer at once. */
const MIN_GAP_MS = 10_000;
const PROGRESS_MS = 250;
/** How long the Windows launcher waits after the handover before it exits: the pages are told the phase first. */
const QUIT_DELAY_MS = 1000;
/** How long `helper.ps1` has to say it runs (it does so first thing; PowerShell starts in a second or two). */
const HELPER_START_MS = 10_000;
/** How long past `quitSecs` a server that is still here looks whether the helper gave up: it has ended and written why by then. */
const HANDOVER_SLACK_SECS = 20;

/** What either helper is started with, besides the install's paths. */
interface HelperRun {
	id: string;
	staged: string;
	backup: string;
	quitSecs: number;
	startSecs: number;
	/** The version installed. */
	version: string;
}

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
	/** The conversations an automatic install waits for (`AppUpdateState.autoHeld`). */
	private autoHeld: Conversations | null = null;
	/** The release the running install was started for by itself, not on a click; null otherwise. */
	private autoTag: string | null = null;
	/** The running app has a signature to compare a download with; null until looked at (the macOS app). */
	private signed: boolean | null = null;
	/** This user can make and rename things beside the install folder; null until looked at (the Windows launcher). */
	private folderWritable: boolean | null = null;
	private timers: NodeJS.Timeout[] = [];
	private lastProgressAt = 0;
	/** Which of a release's installers is this one's (`installerPlatformOf`); null: none (a processor no zip or package is built for). */
	private readonly platform: InstallerPlatform | null;

	constructor(private readonly opts: UpdaterOptions) {
		this.api = opts.api ?? DEFAULT_API;
		this.now = opts.now ?? Date.now;
		this.paths = ensureUpdateDir(opts.dataDir);
		this.platform = installerPlatformOf(
			opts.target?.kind ?? null,
			opts.system?.id ?? platform.id,
			opts.system?.arch ?? process.arch,
		);
		const cached = readJson(this.paths.check);
		if (isRecord(cached) && typeof cached.checkedAt === "number") {
			this.parsed = parseRelease(cached.body, this.api, this.platform);
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
			autoHeld: this.autoHeld,
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
		const { target, parentPid } = this.opts;
		if (target === null) return "notApp";
		if (target.kind === "windows") {
			// The launcher is the server: it hands over and exits itself, with no shell to ask.
			if (this.folderWritable === false) return "notWritable";
			return null;
		}
		// Without a shell to ask to quit there is nobody to hand the swap to.
		if (parentPid === null) return "notApp";
		if (target.bundle.includes("/AppTranslocation/")) return "translocated";
		if (!writable(dirname(target.bundle))) return "notWritable";
		if (this.signed === false) return "adHoc";
		return null;
	}

	// ------------------------------------------------------------------ start-up

	private async init(): Promise<void> {
		const { target } = this.opts;
		if (target?.kind === "mac") {
			const requirement = await designatedRequirementOf(target.bundle).catch(() => null);
			this.signed = requirement !== null && leafOf(requirement) !== null;
		} else if (target?.kind === "windows") {
			this.folderWritable = canWriteIn(dirname(target.folder));
		}
		await this.sweep();
		this.outcome = readOutcome(this.paths);
		// An update that was rolled back is not tried again by itself (it would restart the app at every start).
		if (this.outcome?.ok === false) this.skipAuto(this.outcome.to);
		this.acknowledge();
		this.clearLeftovers();
		if (this.worthShowing()) this.emit();
	}

	/**
	 * What an install that was cut short left: it is not stopped by the app quitting or the server dying (`hdiutil` and `ditto`
	 * run on, detached), so an image can stay mounted at `mount-*`, a download at `*.dmg`, `*.zip` or `*.part`, a partial
	 * copy at `<app>.updating` and a half-unpacked zip at `<folder>.updating.unzip-*`. Nothing runs an install at this point
	 * (an install waits for `ready`), so all of it is stale — except the staged copy of an update whose helper is alive and
	 * waiting to swap it in, which is that helper's.
	 */
	private async sweep(): Promise<void> {
		const handover = readHandover(this.paths);
		const owned = handover !== null && alive(handover.helperPid) ? handover.staged : null;
		for (const name of readdirSync(this.paths.dir)) {
			const path = join(this.paths.dir, name);
			if (name.startsWith("mount-")) await removeMount(path);
			else if (name.endsWith(".dmg") || name.endsWith(".zip") || name.endsWith(".part")) rmSync(path, { force: true });
			// A Windows helper's word that it ran, from an install that ended before the server read it.
			else if (name.startsWith("helper-started-")) rmSync(path, { force: true });
		}
		if (this.opts.target === null) return;
		const installed = pathOf(this.opts.target);
		const staged = `${installed}.updating`;
		if (staged !== owned) rmSync(staged, { recursive: true, force: true });
		// What a helper that died in the middle of a rollback left aside (see helper.sh, helper.ps1).
		if (owned === null) rmSync(`${installed}.failed`, { recursive: true, force: true });
		if (this.opts.target.kind === "windows") {
			const unzipping = `${basename(staged)}.unzip-`;
			try {
				for (const name of readdirSync(dirname(installed))) {
					if (name.startsWith(unzipping)) rmSync(join(dirname(installed), name), { recursive: true, force: true });
				}
			} catch {
				// the folder beside it cannot be read: nothing of ours can be in it either
			}
		}
	}

	/**
	 * An update was handed to the helper and this server is what started after it: when it is the version the helper
	 * installed, say so (the helper waits for it, and removes the old app once it has), and keep how it ended for the page.
	 */
	private acknowledge(): void {
		const handover = readHandover(this.paths);
		if (!handover) return;
		const { target, installed } = this.opts;
		let same = false;
		try {
			same = target !== null && realpathSync(pathOf(target)) === realpathSync(handover.installed);
		} catch {
			// a bundle or folder that cannot be resolved is not the installed one
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

	/**
	 * Look soon after start and then every six hours, while the user wants it (`autoChecks`, read at each look); and, every
	 * minute, whether an automatic install may start (`autoTry`).
	 */
	start(): void {
		if (!this.opts.automatic || this.timers.length > 0) return;
		const look = () => {
			if (this.opts.autoChecks()) void this.check().then(() => this.autoTry());
		};
		const first = setTimeout(look, this.opts.firstCheckMs ?? 0);
		const every = setInterval(look, this.opts.intervalMs ?? INTERVAL_MS);
		const auto = setInterval(() => void this.autoTry(), this.opts.autoMs ?? AUTO_MS);
		for (const t of [first, every, auto]) t.unref();
		this.timers.push(first, every, auto);
	}

	/** The release an automatic install will not try again, as its version (`auto-skip.json`); null when none. */
	private skippedAuto(): string | null {
		const skip = readJson(this.paths.autoSkip);
		return isRecord(skip) && typeof skip.version === "string" ? skip.version : null;
	}

	private skipAuto(version: string): void {
		writeJson(this.paths.autoSkip, { version });
	}

	/**
	 * Install the newer release by itself when the user wants that (`autoInstall`), this copy can, a release with an
	 * installer is known and was not given up on, and nothing would be stopped or left waiting: no conversation working,
	 * asking, paused or waiting. Otherwise says what it waits for, when it is the conversations.
	 */
	async autoTry(): Promise<void> {
		await this.ready;
		const release = this.parsed?.release;
		const wanted =
			this.opts.autoInstall() &&
			this.job === null &&
			this.installBlock() === null &&
			release !== undefined &&
			this.parsed?.installer != null &&
			isNewer(release, this.opts.installed) &&
			this.skippedAuto() !== release.version;
		const held = wanted ? this.opts.conversations() : null;
		const waits = held !== null && held.working + held.asking + held.paused + held.waiting > 0;
		const autoHeld = waits ? held : null;
		if (JSON.stringify(autoHeld) !== JSON.stringify(this.autoHeld)) {
			this.autoHeld = autoHeld;
			this.emit();
		}
		if (!wanted || waits || !release) return;
		this.autoTag = release.tag;
		const started = await this.install(release.tag, false);
		if (!("state" in started)) {
			this.autoTag = null;
			console.warn(`omp-webui: the automatic update to ${release.tag} did not start: ${started.error}`);
		}
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
			const parsed = parseRelease(answer.body, this.api, this.platform);
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
		// Looked at again now: the folder may have been moved or its permissions changed since the server started.
		const target = this.opts.target;
		if (target?.kind === "windows") this.folderWritable = canWriteIn(dirname(target.folder));
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
		const target = this.opts.target as InstallTarget;
		const installed = pathOf(target);
		const file = join(this.paths.dir, `${release.tag}.${target.kind === "mac" ? "dmg" : "zip"}`);
		const part = `${file}.part`;
		const staged = `${installed}.updating`;
		let handedOver = false;
		let failure: UpdateFailure | null = null;
		const checkCancelled = () => {
			if (signal.aborted) throw new UpdateCancelled();
		};
		try {
			// Before the first byte: the installer, the new version out of it and the room the swap needs are all on disk at once.
			this.ensureRoom(release.asset?.size ?? 0, installed);
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
			renameOver(part, file);
			checkCancelled();

			this.phase(job, "verifying");
			if (target.kind === "mac") {
				await this.stageMac(job, release, target.bundle, file, staged, checkCancelled);
			} else {
				// The zip's members are looked at before anything is unpacked; what was unpacked is looked at again. Its top
				// folder is the processor's: a Windows target has an installer only as the zip of its processor.
				await stageWindows(file, staged, release.version, windowsArchOf(this.platform) as WindowsArch, {
					freeBytes: this.opts.freeBytes ?? freeSpace,
					onUnpack: () => {
						checkCancelled();
						this.phase(job, "staging");
					},
				});
				removeFiles(file);
				checkCancelled();
			}

			await this.handOver(job, release, target, staged);
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
		if (!handedOver) {
			rmSync(staged, { recursive: true, force: true });
			removeFiles(part, file);
			this.job = null;
			// An automatic install that failed or was cancelled is not started again by itself: the card offers it.
			if (this.autoTag === job.tag) this.skipAuto(release.version);
		}
		if (this.autoTag === job.tag) this.autoTag = null;
		this.failed = failure;
		this.cancel = null;
		this.emit();
	}

	/**
	 * The macOS app out of the disk image at `dmg`, copied to `staged`: the image's app is looked at before anything is
	 * copied, and the copy is looked at again, since that is what is installed. The image is detached whatever happens.
	 */
	private async stageMac(
		job: UpdateJob,
		release: AppRelease,
		bundle: string,
		dmg: string,
		staged: string,
		checkCancelled: () => void,
	): Promise<void> {
		const expected = { running: bundle, version: release.version, installed: this.opts.installed };
		const mount = mkdtempSync(join(this.paths.dir, "mount-"));
		try {
			await attach(dmg, mount);
			checkCancelled();
			if (!existsSync(join(mount, APP_NAME, "Contents", "Info.plist")))
				throw new UpdateError("noApp", { name: APP_NAME });
			const inImage = await refusalOf(join(mount, APP_NAME), expected);
			if (inImage) throw new UpdateError(inImage.code, inImage.params);
			checkCancelled();

			this.phase(job, "staging");
			await stage(mount, APP_NAME, staged);
		} finally {
			await removeMount(mount);
		}
		removeFiles(dmg);
		checkCancelled();
		const inStaged = await refusalOf(staged, expected);
		if (inStaged) throw new UpdateError(inStaged.code, inStaged.params);
		checkCancelled();
	}

	/**
	 * Refuse, before anything is downloaded, an install that the disk cannot hold: three times the installer's size must be free
	 * on the volume the download is kept on (this server's data folder) and on the volume of the installed app, where the
	 * new version is put next to the old one and the old one is kept until the new one is up.
	 */
	private ensureRoom(installerBytes: number, installed: string): void {
		const needed = installerBytes * ROOM_FACTOR;
		const free = this.opts.freeBytes ?? freeSpace;
		for (const dir of [this.paths.dir, dirname(installed)]) {
			const available = free(dir);
			if (available !== null && available < needed) throw new UpdateError("space", { needed, free: available });
		}
	}

	/**
	 * Everything is staged and checked: start the helper that waits for the app to quit and swaps, then end the app — the
	 * macOS shell is asked to quit, which stops this server; the Windows launcher is this server, which exits itself once the
	 * helper has said it runs — and wait for the end. What happens next is the helper's; a helper that cannot do its part
	 * has written why before this server is asked again.
	 */
	private async handOver(job: UpdateJob, release: AppRelease, target: InstallTarget, staged: string): Promise<void> {
		const installed = pathOf(target);
		const id = randomUUID();
		const backup = `${installed}.previous`;
		const quitSecs = this.opts.quitSecs ?? 90;
		const startSecs = this.opts.startSecs ?? 60;
		removeFiles(this.paths.ack, this.paths.result);
		rotateLog(this.paths.helperLog);
		const helper = { id, staged, backup, quitSecs, startSecs, version: release.version };
		let pid: number;
		if (target.kind === "mac") {
			const log = openSync(this.paths.helperLog, "a", 0o600);
			try {
				pid = this.spawnMacHelper(target.bundle, helper, log);
			} finally {
				closeSync(log);
			}
		} else {
			pid = await this.spawnWindowsHelper(target.folder, helper);
			await this.helperStarted(id, pid);
		}
		const handover: Handover = {
			id,
			from: this.opts.installed,
			to: release.version,
			installed,
			staged,
			backup,
			helperPid: pid,
		};
		// Before the app is ended: the shell quits only for an update it can see, and the next server looks for it.
		writeJson(this.paths.handover, handover);
		this.phase(job, "handover");
		if (target.kind === "mac") {
			const parent = this.opts.parentPid as number;
			(this.opts.signalParent ?? ((p) => process.kill(p, "SIGUSR1")))(parent);
		} else {
			// A moment for the pages to be told the phase, then the server exits and its console window closes with it.
			const quit = setTimeout(this.opts.quit ?? (() => process.exit(0)), QUIT_DELAY_MS);
			this.timers.push(quit);
		}
		// Normally the app quits and this server with it. A helper that gave up (the app did not quit in time) has written
		// why and put nothing in place: this server is still here to say so.
		const slack = this.opts.handoverSlackSecs ?? HANDOVER_SLACK_SECS;
		const waiting = setTimeout(() => this.handoverEnded(handover), (quitSecs + slack) * 1000);
		waiting.unref();
		this.timers.push(waiting);
	}

	/**
	 * Wait until `helper.ps1` says it runs (its first line writes `helper-started-<id>`): only then may the launcher exit.
	 * PowerShell can start and never run the script (a machine policy that allows only signed scripts, security software
	 * that stops hidden PowerShell); a server that exited then would close the app and leave nothing to swap it or start it
	 * again. One that does not say so in time is ended, and the install fails with nothing changed.
	 */
	private async helperStarted(id: string, pid: number): Promise<void> {
		const marker = join(this.paths.dir, `helper-started-${id}`);
		const waitMs = this.opts.helperStartMs ?? HELPER_START_MS;
		const deadline = Date.now() + waitMs;
		// Until it says so, ends or runs out of time; then one last look (it may have said so just before it ended).
		while (!existsSync(marker) && Date.now() < deadline && alive(pid)) await Bun.sleep(100);
		const started = existsSync(marker);
		removeFiles(marker);
		if (started) return;
		const ended = !alive(pid);
		console.warn(
			`omp-webui: the update helper ${pid} did not say it runs (${ended ? "it ended" : `not within ${waitMs} ms`}): the update is not installed`,
		);
		try {
			process.kill(pid);
		} catch {
			// it has ended already
		}
		throw new UpdateError("helper");
	}

	/** `helper.sh`, started in a session of its own with its output to `log` (open for appending); its pid. */
	private spawnMacHelper(bundle: string, h: HelperRun, log: number): number {
		writeFileSync(this.paths.helper, helperScript, { mode: 0o700 });
		const proc = Bun.spawn(
			[
				"/bin/sh",
				this.paths.helper,
				h.id,
				String(this.opts.parentPid as number),
				bundle,
				h.staged,
				h.backup,
				this.paths.dir,
				String(h.quitSecs),
				String(h.startSecs),
				this.opts.installed,
				h.version,
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
		return proc.pid;
	}

	/**
	 * `helper.ps1`, started by Windows PowerShell, hidden (it must outlive this server, whose console closes when it exits);
	 * its pid. It runs from the update folder, never from inside the folder it renames, and with this server's environment:
	 * the new program it starts is started as this one was (its data folder, a test's settings). It writes its log itself.
	 */
	private async spawnWindowsHelper(folder: string, h: HelperRun): Promise<number> {
		writeFileSync(this.paths.helperWindows, helperWindowsScript, { mode: 0o700 });
		const args = [
			"-NoProfile",
			"-ExecutionPolicy",
			"Bypass",
			"-WindowStyle",
			"Hidden",
			"-File",
			this.paths.helperWindows,
			"-Id",
			h.id,
			"-AppPid",
			String(process.pid),
			"-Installed",
			folder,
			"-Staged",
			h.staged,
			"-Backup",
			h.backup,
			"-StateDir",
			this.paths.dir,
			"-QuitSecs",
			String(h.quitSecs),
			"-StartSecs",
			String(h.startSecs),
			"-From",
			this.opts.installed,
			"-To",
			h.version,
			"-Exe",
			join(folder, WINDOWS_EXE),
		];
		const start =
			this.opts.startHelper ??
			((a: string[]) =>
				startHidden(powershellCommand(), a, { cwd: this.paths.dir, env: this.opts.env ?? process.env }));
		try {
			return await start(args);
		} catch (e) {
			console.warn(`omp-webui: the update helper could not be started: ${(e as Error).message}`);
			throw new UpdateError("helper");
		}
	}

	/**
	 * The app did not quit and the helper ended (or died): how it ended is on the page, and what was staged is gone. A helper
	 * that gave up removed the handover record after it wrote why; only another handover's record is not this one's to end.
	 */
	private handoverEnded(handover: Handover): void {
		const record = readHandover(this.paths);
		if (record !== null && record.id !== handover.id) return;
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
		if (this.outcome?.ok === false) this.skipAuto(handover.to);
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
				// A newer release it found may be installed by itself at once (`autoInstall`), not a minute later.
				await this.autoTry();
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
