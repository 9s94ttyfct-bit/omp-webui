import type { Subprocess } from "bun";
import { factsOf, working } from "../shared/attention.ts";
import { isRecord } from "../shared/guards.ts";
import type { LiveInfo, OmpFrame } from "../shared/protocol.ts";
import type { SleepThen } from "../shared/sleep.ts";

/**
 * What `awakeWorking` reads of a process: the work facts `workCounts` counts by, and the usage-limit wait that makes the
 * difference between them.
 */
export interface AwakeFacts
	extends Pick<LiveInfo, "exited" | "pausedAt" | "streaming" | "asking" | "continuing" | "retry" | "quotaHold"> {}

/**
 * The conversations that hold the Mac from idle sleep, and that a sleep interrupted — which is not the same as what the
 * menu bar calls working (#647).
 *
 * `workCounts` counts a conversation that waits out a provider's usage limit as working, because its turn is still open and
 * its own timer will retry it; omp reports `isStreaming` true for the whole backoff (`refreshState`). That wait is hours and
 * often all night, and holding the Mac awake for it would be the opposite of what this is for — as would a sleep note
 * saying a wait that nothing of was running was cut. A short backoff (a 5xx, a dropped stream) is a different thing: the
 * turn is coming back in seconds, and the Mac is held for it.
 *
 * A goal conversation `continuing` between two turns is working in the same sense (the run goes on by itself), unless that
 * is the usage-limit wait it is between.
 *
 * Server-only: the page counts what it lists with `workCounts` and never needs the ids.
 */
export function awakeWorking(info: AwakeFacts): boolean {
	if (info.exited || info.pausedAt !== null) return false;
	const facts = factsOf(info);
	if (facts.needsInput) return false;
	if (!working(facts)) return false;
	// The long wait: a usage limit, not yet retried. Its own timer keeps it; nothing of it is running to protect.
	const r = info.retry;
	if (r?.usageLimit === true && !r.resumed) return false;
	// The other long wait: held at the quota floor (#652), until the window resets, which is hours. Nothing runs meanwhile either:
	// omp waits in a dialog. (A conversation that only reached the floor and has a request in flight is not held yet: it is working.)
	return info.quotaHold?.state !== "held";
}

/**
 * The conversations `awakeWorking` holds the Mac awake for, by their live id: what the sleep interrupted, and what keeps it
 * away.
 */
export function workingIds(infos: Iterable<AwakeFacts & Pick<LiveInfo, "liveId">>): string[] {
	const ids: string[] = [];
	for (const info of infos) if (awakeWorking(info)) ids.push(info.liveId);
	return ids;
}

/** What a clock says now: the wall clock (`Date.now`), and one that does not advance while the machine sleeps. */
export interface ClockReading {
	/** The wall clock, `Date.now()`: it goes on through a sleep, and jumps when someone changes the time. */
	wall: number;
	/**
	 * A monotonic clock that does **not** advance while the machine is asleep (`performance.now`, see `sleepBetween`): a gap
	 * between two readings that it did not count is either a sleep or a wall clock that was moved forward.
	 */
	mono: number;
	/**
	 * A monotonic clock that **does** advance through a sleep (`process.hrtime`, `mach_continuous_time` on darwin): it is
	 * what tells a sleep from a wall clock that was moved, because only a sleep moves both clocks on together.
	 */
	continuous: number;
}

/**
 * The shortest gap between two ticks of the server's clock that is taken for a sleep. The timer fires every second; a gap
 * of half a minute is not a slow tick (a machine under load, a long garbage collection) but the machine being away, and it
 * keeps a wall-clock correction of a second or two from reading as one.
 */
export const SLEEP_MIN_MS = 30_000;

/** How often the server looks at its clocks. */
export const SLEEP_TICK_MS = 1000;

/** How long what followed a sleep is waited for in a conversation, before the note stands as it is. */
export const SLEEP_FOLLOW_MS = 60_000;

/**
 * The sleep between two readings of the clocks, or null when there was none: the wall clock went on for at least
 * `SLEEP_MIN_MS` that the monotonic clock did not count.
 *
 * **Why the monotonic clock is `performance.now`.** On macOS the clock the page and Bun's `performance.now` use does not
 * advance while the machine is asleep (`clock_gettime(3)`: `CLOCK_UPTIME_RAW` "does not increment while the system is
 * asleep", which is `mach_absolute_time`); Bun's `performance.now` is elapsed time of a Rust `std::time::Instant`
 * (`VirtualMachine.origin_timer`), and Rust's `Instant` on Apple platforms reads `CLOCK_UPTIME_RAW`. `process.hrtime`
 * and `Bun.nanoseconds` are libuv's `uv_hrtime`, which on darwin reads `mach_continuous_time` — a clock that *does* keep
 * counting through a sleep, and so cannot see one.
 */
export function sleepBetween(before: ClockReading, after: ClockReading): { from: number; to: number } | null {
	const wall = after.wall - before.wall;
	const mono = after.mono - before.mono;
	// `hrtime` counts a sleep; `performance.now` does not. So a forward jump of the wall clock with nothing asleep moves
	// `hrtime` by nothing (or by a tick, from the look itself) and `performance.now` by nothing, while a real sleep moves
	// `hrtime` by as much as the wall clock moved.
	const continuous = after.continuous - before.continuous;
	if (!(wall >= SLEEP_MIN_MS)) return null;
	// A monotonic clock that went backwards (a bug, a different clock) counts as none of the wall time.
	const still = wall - Math.max(0, mono);
	// The machine was asleep for as long as the wall clock went on without the monotonic one. Half is the line: a timer
	// that merely fired late counted nearly all of the gap itself, while a sleep counts almost none of it.
	if (still < wall / 2) return null;
	// And the clock that counts sleeps has to have counted this one: without that, this is the wall clock being moved.
	return continuous >= wall / 2 ? { from: before.wall, to: after.wall } : null;
}

/**
 * The Mac is kept from going to *idle* sleep while a conversation works (#647), so that a turn is not cut in half by a
 * machine that decided it was idle: the server runs `/usr/bin/caffeinate -i -w <its own pid>` for as long as the working
 * count is above zero, and lets it go when the count returns to zero.
 *
 * What this does not do, on purpose: the display still sleeps (`-i` is idle sleep only, and the display is the person's),
 * and a closed lid still sleeps the machine (macOS's own rule, short of clamshell mode on power with a display). The
 * setting is "Keep the Mac awake while a conversation works" in Settings; a machine that is not a Mac has no
 * `caffeinate`, and the server says so rather than pretend.
 *
 * One child at a time, and never a shell: `caffeinate` is started from an argument list, ended with SIGTERM (and SIGKILL
 * after a moment if it does not go), and reaped. `-w <pid>` makes it `caffeinate`'s own business to end when this server
 * does, even one that is killed outright and gets no chance to stop it.
 */

/** What the server hands to `caffeinate`, and what it must not do (a test supplies its own). */
export interface AwakeDeps {
	/** The platform the server runs on: `caffeinate` is macOS's. */
	platform: NodeJS.Platform;
	/** The program to run; `/usr/bin/caffeinate` unless the server was told another (`OMP_WEBUI_CAFFEINATE`, a test's stub). */
	bin: string;
	/** Start `argv` (never through a shell) and return a handle that can end it; null when it could not be started. */
	spawn(argv: string[]): AwakeChild | null;
	/** This server's pid, which `caffeinate -w` outlives it by watching. */
	pid(): number;
	/** Something went wrong with `caffeinate`; the conversation's work is not to be held up by it. */
	report(message: string): void;
}

/** A started `caffeinate`: told to go, and told again more firmly if it does not. */
export interface AwakeChild {
	readonly pid: number | null;
	/** End it: SIGTERM now, SIGKILL if it has not gone. */
	stop(): void;
	/**
	 * Told when this child is gone, however it went — ended, or dead on its own (someone's `killall caffeinate`, a crash of
	 * it, the server it watched going away). The keeper starts another while anything still works (#647).
	 */
	onExit(fn: () => void): void;
}

/** The binary, from an argument list: never a shell, never a string with the pid interpolated into it. */
export const CAFFEINATE = "/usr/bin/caffeinate";

/** The `caffeinate` this server runs: the platform's own, unless `OMP_WEBUI_CAFFEINATE` names another (a test's stand-in). */
export const caffeinateBin = (env: Record<string, string | undefined> = process.env): string =>
	env.OMP_WEBUI_CAFFEINATE || CAFFEINATE;

/** How long `caffeinate` is given to go after SIGTERM before it is killed. */
const STOP_GRACE_MS = 2000;

/** The command line that holds idle sleep off for as long as `pid` lives. */
export const caffeinateArgv = (bin: string, pid: number): string[] => [bin, "-i", "-w", String(pid)];

/**
 * Starts and ends `caffeinate` as the working count crosses zero. Nothing is started while the setting is off, or on a
 * machine that has no `caffeinate`: `available()` says which of the two it is, for the page to say it.
 */
export class KeepAwake {
	private child: AwakeChild | null = null;
	/** Whether the setting is on (`ompw.keepAwake`, on unless turned off). */
	private enabled = true;
	/** Whether a conversation was working at the last look: what a change of the setting is applied to. */
	private working = false;
	/** Whether the setting, or the platform, means nothing can be started: said once, not every second. */
	private refused = false;
	/** The server is ending: nothing starts again, whatever the working count does next. */
	private stopped = false;

	constructor(private readonly deps: AwakeDeps) {}

	/**
	 * Whether this machine can hold sleep off at all. A machine that is not a Mac has no `caffeinate`; the Settings card
	 * says it is not available there rather than showing a switch that does nothing.
	 */
	get available(): boolean {
		return this.deps.platform === "darwin";
	}

	/** Whether `caffeinate` is running now (for the server's own log, and for tests). */
	get holding(): boolean {
		return this.child !== null;
	}

	/**
	 * Whether anything holds the Mac awake now: one conversation `awakeWorking` is enough (the count is `workingIds`'s, not
	 * the menu bar's, which counts a usage-limit wait).
	 */
	setCount(working: boolean): void {
		this.apply(working);
	}

	/** The setting was read (at start, and whenever the preferences change): applied to what is working now. */
	setEnabled(on: boolean): void {
		this.enabled = on;
		this.apply(this.working);
	}

	/** The server is ending: `caffeinate` goes with it, at once, and nothing starts again after. */
	stop(): void {
		this.stopped = true;
		this.working = false;
		this.end();
	}

	private apply(working: boolean): void {
		this.working = working;
		if (this.stopped || !this.enabled || !this.available) {
			this.end();
			return;
		}
		if (working) this.begin();
		else this.end();
	}

	private begin(): void {
		if (this.child) return;
		const argv = caffeinateArgv(this.deps.bin, this.deps.pid());
		const child = this.deps.spawn(argv);
		if (!child) {
			if (!this.refused)
				this.deps.report(`could not start ${this.deps.bin}: the Mac may sleep while a conversation works`);
			this.refused = true;
			return;
		}
		this.refused = false;
		this.child = child;
		// A child that ends without being asked to (a `killall caffeinate`, a crash of it) is started again at the next look
		// while something still works; one this keeper ended is not (`this.child` is another by then).
		child.onExit(() => {
			if (this.child !== child) return;
			this.child = null;
			if (this.working) this.begin();
		});
	}

	private end(): void {
		const child = this.child;
		if (!child) return;
		this.child = null;
		try {
			child.stop();
		} catch (e) {
			this.deps.report(`could not end ${this.deps.bin}: ${(e as Error).message}`);
		}
	}
}

/**
 * `AwakeDeps.spawn` over `Bun.spawn`: an argument list, no shell, its output dropped (it prints nothing of interest), and
 * SIGTERM when it is ended, with SIGKILL after `STOP_GRACE_MS` so that a wedged child cannot hold the machine awake by
 * itself. The kill is armed by `stop()`, not when it starts: `caffeinate` is meant to live for as long as something works.
 */
export function spawnCaffeinate(argv: string[], report: (message: string) => void): AwakeChild | null {
	let proc: Subprocess;
	try {
		proc = Bun.spawn(argv, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	} catch (e) {
		report(`could not start ${argv[0]}: ${(e as Error).message}`);
		return null;
	}
	let grace: ReturnType<typeof setTimeout> | undefined;
	const gone = Promise.withResolvers<void>();
	// Where it goes by itself (the server it watches ended, someone's `kill`), nothing is left armed.
	void proc.exited
		.then(() => {
			clearTimeout(grace);
			gone.resolve();
		})
		.catch(() => {
			clearTimeout(grace);
			gone.resolve();
		});
	return {
		pid: proc.pid ?? null,
		onExit(fn) {
			void gone.promise.then(fn);
		},
		stop() {
			// `caffeinate` ends when this server does (`-w`): one that already went is not an error.
			try {
				proc.kill("SIGTERM");
			} catch {
				// already gone
			}
			grace ??= setTimeout(() => {
				try {
					proc.kill("SIGKILL");
				} catch {
					// already gone
				}
			}, STOP_GRACE_MS);
			grace.unref?.();
		},
	};
}

/**
 * What a frame says of what came of a conversation the Mac's sleep interrupted, or null when it says nothing of it: omp
 * retried the turn by itself (a provider's stream that failed on the way back up, a usage limit that came due), the turn
 * ended with an error (the page offers Retry for it), or a tool that ran out of time on the way back.
 *
 * Only what omp itself did: nothing is resent on the person's behalf, so a conversation that came back cleanly is left
 * with the note of the sleep alone.
 */
export function sleepAftermath(frame: OmpFrame): SleepThen | null {
	if (frame.type === "auto_retry_start") return "retried";
	if (frame.type === "message_end") {
		const message = frame.message;
		return isRecord(message) && message.stopReason === "error" ? "error" : null;
	}
	if (frame.type === "tool_execution_end" && frame.isError === true) {
		const result = frame.result;
		if (TIMED_OUT.test(resultText(result))) return "toolTimeout";
	}
	return null;
}

/** The words a tool's result holds, however omp shaped it: a string, or the text blocks of a result. */
function resultText(v: unknown): string {
	if (typeof v === "string") return v;
	if (!isRecord(v)) return "";
	const { content, text, message, output } = v;
	if (typeof text === "string") return text;
	if (typeof message === "string") return message;
	if (typeof output === "string") return output;
	if (!Array.isArray(content)) return "";
	return content
		.map((b) => (typeof b === "string" ? b : isRecord(b) && typeof b.text === "string" ? b.text : ""))
		.join(" ");
}

/** What a tool that ran out of time says, in the ways omp and the tools under it put it. */
const TIMED_OUT = /timed out|timeout|time out|deadline exceeded/i;

/**
 * The Mac's sleeps, noticed from the server's own clocks (#647): once a second it reads the wall clock and a monotonic one
 * (`sleepBetween` below says why `performance.now` and not `hrtime`), and a tick that spans far more of the former than the
 * latter is a sleep window, with its start and its end.
 *
 * Each window is handed to `woke` together with the conversations that were working when the last tick before it came:
 * those are the ones the sleep interrupted, and the ones whose transcripts get a line. The detector knows nothing of the
 * conversations themselves: which ones are still around, and what came of them, is `LivePool.noteSleep`'s and `Live`'s.
 *
 * **A wall clock that was moved forward is not a sleep.** `Date.now()` can jump half a minute by itself — a manual change of
 * the time, an NTP correction, a virtual machine resumed from a snapshot — while nothing was asleep. `hrtime` is what tells
 * the two apart: it counts through a sleep (`mach_continuous_time`) and does not move when the time is changed, so a real
 * sleep moves it by as much as the wall clock, and a jump moves it by nothing (`sleepBetween`).
 */
export class SleepDetector {
	private last: ClockReading;
	private timer: ReturnType<typeof setInterval> | undefined;
	/**
	 * The live ids that were working at the last tick before the machine went away. Filled on every tick, so that it is as
	 * near the sleep as the server can make it: a conversation that started a turn after the tick before the sleep is
	 * still counted (it was working when the machine stopped), and one that had stopped is not.
	 */
	private workingAtLastTick: string[] = [];
	constructor(
		private readonly deps: {
			/** The clocks now. */
			read(): ClockReading;
			/** The conversations that are working now, by their live id: `Shared/attention.ts`'s `working`, as the menu bar counts. */
			working(): Iterable<string>;
			/** The machine was away from `from` to `to`, with what was working when it went. */
			woke(note: { from: number; to: number; working: string[] }): void;
			tickMs?: number;
		},
	) {
		this.last = deps.read();
	}

	start(): void {
		if (this.timer) return;
		this.timer = setInterval(() => this.tick(), this.deps.tickMs ?? SLEEP_TICK_MS);
		this.timer.unref?.();
	}

	stop(): void {
		clearInterval(this.timer);
		this.timer = undefined;
	}

	/**
	 * One look at the clocks: what the timer runs, and what a test calls to make a sleep without waiting for one.
	 */
	tick(): void {
		const now = this.deps.read();
		const before = this.last;
		this.last = now;
		const slept = sleepBetween(before, now);
		if (slept) this.deps.woke({ ...slept, working: this.workingAtLastTick });
		// Taken after the gap is looked at: a conversation that was working when the machine went away is in this list as
		// it was, and one that ended during the sleep is gone by the next tick, which is later than any wake.
		this.workingAtLastTick = [...this.deps.working()];
	}
}
