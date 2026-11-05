import type { BrowserAutoCheck } from "../../shared/browser.ts";

/**
 * Automatic updates of the built-in browser's Chrome for Testing (Settings › Browser › "Update the built-in browser
 * automatically", `ompw.browserAutoUpdate`, on by default). While it is on, the browser is on and a version is installed, the
 * server looks for a newer one a minute after it starts and every 24 hours from then, where Update looks
 * (`BrowserInstaller.autoUpdate`), and downloads and checks a newer one in the background as Update does. The Mac app's CEF
 * is not updated here: it comes with the app, and its version updates with the app.
 *
 * Chrome for Testing is switched to the new version only when no conversation uses the browser (`switchNow`): the engine
 * does not run, or no conversation's CDP connection is open, no Browser tab shows one of its pages, and nothing used it for
 * the last five minutes. Until then the look comes back every minute. The switch stops the engine, starts it again if it
 * ran, and removes the old version's folder.
 *
 * A failed look or download is logged once, shown in Settings (`BrowserState.autoCheck`), never as an error toast, and
 * tried again at the next look. The decisions are the pure functions below, so that they are tested apart from timers.
 */

/** How long after the server starts the first look is (never in the way of the start). */
export const FIRST_CHECK_MS = 60_000;
/** How often a newer version is looked for. */
export const CHECK_EVERY_MS = 24 * 60 * 60_000;
/** How often a downloaded version that waits for the browser to be free looks again. */
export const IDLE_POLL_MS = 60_000;
/** How long nothing may have used the browser before its engine is switched under it. */
export const QUIET_MS = 5 * 60_000;
/** How soon after the switch, or the browser, was turned on the look comes. */
const WAKE_MS = 5_000;

/**
 * Orders two Chrome for Testing versions, dotted numbers (`131.0.6778.85`). Negative when `a` is older, 0 when the same,
 * positive when newer.
 */
export function compareVersions(a: string, b: string): number {
	return compare(numbers(a), numbers(b));
}

/** Whether `candidate` is newer than `installed`. */
export function isNewer(candidate: string, installed: string): boolean {
	return compareVersions(candidate, installed) > 0;
}

function numbers(dotted: string): number[] {
	return dotted === "" ? [] : dotted.split(".").map((n) => (/^\d+$/.test(n) ? Number(n) : 0));
}

function compare(a: number[], b: number[]): number {
	for (let i = 0; i < Math.max(a.length, b.length); i++) {
		const d = (a[i] ?? 0) - (b[i] ?? 0);
		if (d !== 0) return d;
	}
	return 0;
}

/** Whether a newer version is to be looked for now: never yet since the server started, or the last look is 24 hours old. */
export function checkDue(lastCheckAt: number | null, now: number): boolean {
	return lastCheckAt === null || now - lastCheckAt >= CHECK_EVERY_MS;
}

/** What uses the browser now, as far as the server knows it. */
export interface BrowserUse {
	/** The engine runs, or is starting. */
	engine: boolean;
	/** Conversations' CDP connections open now (`CdpProxy`). */
	connections: number;
	/** Browser tabs that show one of its pages now (`ScreenHub`). */
	watchers: number;
	/** When a conversation or a Browser tab last started or stopped using it (ms since the epoch; 0: never). */
	lastUse: number;
}

/**
 * Whether Chrome for Testing may be switched to a downloaded version now: an engine that does not run disturbs nobody; a
 * running one only when no conversation is connected, no Browser tab shows one of its pages, and none did in the last
 * `QUIET_MS` (an agent between two calls of its browser tool is still using it).
 */
export function switchNow(use: BrowserUse, now: number): boolean {
	if (!use.engine) return true;
	return use.connections === 0 && use.watchers === 0 && now - use.lastUse >= QUIET_MS;
}

/**
 * How long until the next look: a minute while a downloaded version waits for the browser to be free (but never past a
 * due check), else until the next check is due; a day when none is due any more (it was skipped: the switch or the browser
 * was off, or nothing was installed).
 */
export function nextLookIn(lastCheckAt: number | null, now: number, waiting: boolean): number {
	const left = lastCheckAt === null ? CHECK_EVERY_MS : lastCheckAt + CHECK_EVERY_MS - now;
	const untilDue = left > 0 ? left : CHECK_EVERY_MS;
	return waiting ? Math.min(IDLE_POLL_MS, untilDue) : untilDue;
}

/** The installer as the automatic update uses it (`BrowserInstaller`). */
export interface AutoInstaller {
	/** Looks for a newer version and downloads it; null when it did not look (a job of the person's runs). */
	autoUpdate(): Promise<BrowserAutoCheck | null>;
	/** The downloaded version that waits for the browser to be free; null when none does. */
	readonly waiting: string | null;
	/** Switches to the waiting version; null when there was nothing to switch to, or a job runs. */
	switchToNext(): Promise<BrowserAutoCheck | null>;
}

export interface Clock {
	now(): number;
	set(fn: () => void, ms: number): unknown;
	clear(timer: unknown): void;
}

const systemClock: Clock = {
	now: () => Date.now(),
	set: (fn, ms) => {
		const timer = setTimeout(fn, ms);
		// The server's exit never waits for a look.
		timer.unref?.();
		return timer;
	},
	clear: (timer) => clearTimeout(timer as ReturnType<typeof setTimeout>),
};

export interface AutoUpdaterOptions {
	/** Whether the person wants automatic updates now: the switch is on and the browser is not turned off. */
	wanted(): boolean;
	/** The installer when a version is installed; null when none is (nothing of the browser is loaded for that). */
	installer(): Promise<AutoInstaller | null>;
	use(): BrowserUse;
	/** A failure, once (the server's log). */
	log(line: string): void;
	clock?: Clock;
}

export class BrowserAutoUpdater {
	private readonly clock: Clock;
	private timer: unknown = null;
	private lastCheckAt: number | null = null;
	private waiting = false;
	private looking: Promise<void> | null = null;
	private stopped = true;

	constructor(private readonly opts: AutoUpdaterOptions) {
		this.clock = opts.clock ?? systemClock;
	}

	/** The first look comes `delay` from now, the others as `nextLookIn` says. */
	start(delay = FIRST_CHECK_MS): void {
		this.stopped = false;
		this.schedule(delay);
	}

	/** The switch or the browser was turned on or off: a look soon, which checks only when a check is due. */
	wake(): void {
		if (!this.stopped && !this.looking) this.schedule(WAKE_MS);
	}

	stop(): void {
		this.stopped = true;
		if (this.timer !== null) this.clock.clear(this.timer);
		this.timer = null;
	}

	/** One look (the timer's; tests call it). Settles when it is done; a look under way is joined. */
	look(): Promise<void> {
		this.looking ??= this.once().finally(() => {
			this.looking = null;
			if (!this.stopped) this.schedule(nextLookIn(this.lastCheckAt, this.clock.now(), this.waiting));
		});
		return this.looking;
	}

	private schedule(ms: number): void {
		if (this.timer !== null) this.clock.clear(this.timer);
		this.timer = this.clock.set(() => {
			this.timer = null;
			void this.look();
		}, ms);
	}

	private async once(): Promise<void> {
		this.waiting = false;
		if (!this.opts.wanted()) return;
		let inst: AutoInstaller | null;
		try {
			inst = await this.opts.installer();
		} catch (e) {
			this.opts.log(`omp-webui: browser: automatic update: ${e instanceof Error ? e.message : String(e)}`);
			return;
		}
		if (!inst) return;
		const now = this.clock.now();
		if (checkDue(this.lastCheckAt, now)) {
			this.lastCheckAt = now;
			this.report(await inst.autoUpdate());
		}
		if (inst.waiting !== null && switchNow(this.opts.use(), this.clock.now())) this.report(await inst.switchToNext());
		this.waiting = inst.waiting !== null;
	}

	private report(check: BrowserAutoCheck | null): void {
		if (check?.result === "failed") this.opts.log(`omp-webui: browser: automatic update failed: ${check.error}`);
	}
}
