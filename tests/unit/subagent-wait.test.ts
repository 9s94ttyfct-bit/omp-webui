import { expect, test } from "bun:test";
import { RETRY_OVERDUE_MS } from "../../shared/retry.ts";
import type { RetryWait } from "../../web/src/lib/retry-wait.ts";
import { noteServerTime } from "../../web/src/lib/server-clock.ts";
import { canContinue, subagentWait } from "../../web/src/lib/subagent-wait.ts";
import { initialLive, withInfo } from "../../web/src/store/live.ts";

/**
 * What the Agents tab says of a subagent's retry wait, at each moment of it (#594): the countdown with the time omp
 * retries at, that the time is up, that the conversation is paused, and that omp has not retried: the stage that
 * used to read "Retrying…" for good.
 */

const START = 1_000_000;
const HOUR = 3_600_000;
const wait = (extra: Partial<RetryWait> = {}): RetryWait => ({
	phase: "waiting",
	attempt: 1,
	maxAttempts: 10,
	delayMs: 90 * 60_000,
	startedAt: START,
	usageLimit: true,
	resumed: false,
	...extra,
});
const DUE = START + 90 * 60_000;

test("counting: what is left, and the time omp retries at when the wait is long enough to be a quota's reset", () => {
	expect(subagentWait(wait(), START + 60_000, false, 0)).toEqual({
		phase: "counting",
		usageLimit: true,
		attempt: 1,
		max: 10,
		left: 89 * 60_000,
		at: DUE,
	});
	// A backoff of seconds has no clock time worth saying; the usage flag is the wait's own.
	expect(subagentWait(wait({ delayMs: 8000, usageLimit: false }), START, false, 0)).toMatchObject({
		phase: "counting",
		usageLimit: false,
		at: null,
	});
	// A wait the page learned of late has no flag (omp's progress record does not carry it): still a reset by its length.
	expect(subagentWait(wait({ usageLimit: false }), START, false, 0)).toMatchObject({ usageLimit: false, at: DUE });
});

test("the time is up: omp is on it for half a minute, then the page says it has not retried, and how late it is", () => {
	expect(subagentWait(wait(), DUE + 1, false, 0)).toEqual({ phase: "due" });
	expect(subagentWait(wait(), DUE + RETRY_OVERDUE_MS, false, 0)).toEqual({ phase: "due" });
	expect(subagentWait(wait(), DUE + RETRY_OVERDUE_MS + 1000, false, 0)).toEqual({
		phase: "overdue",
		late: RETRY_OVERDUE_MS + 1000,
	});
	// Hours late is still overdue, never "Retrying…".
	expect(subagentWait(wait(), DUE + 3 * HOUR, false, 0)).toEqual({ phase: "overdue", late: 3 * HOUR });
	// The retried turn started: nothing is late.
	expect(subagentWait(wait({ resumed: true }), DUE + 3 * HOUR, false, 0)).toEqual({ phase: "running" });
});

test("a paused conversation says so instead of late; the countdown before the time goes on", () => {
	expect(subagentWait(wait(), DUE + 3 * HOUR, true, 0)).toEqual({ phase: "paused" });
	expect(subagentWait(wait(), START + 60_000, true, 0)).toMatchObject({ phase: "counting" });
});

test("a resume gives omp half a minute from when it ran again, whatever came due meanwhile", () => {
	const thawed = DUE + 3 * HOUR;
	expect(subagentWait(wait(), thawed + 1000, false, thawed)).toEqual({ phase: "due" });
	expect(subagentWait(wait(), thawed + RETRY_OVERDUE_MS + 1000, false, thawed)).toMatchObject({ phase: "overdue" });
});

test("the page notes the moment a paused process runs again, and only that", () => {
	const info = (pausedAt: number | null) => ({
		liveId: "L1",
		pid: 1,
		cwd: "/w",
		sessionFile: null,
		sessionId: null,
		args: [],
		startedAt: 0,
		streaming: false,
		exited: false,
		subscribers: 0,
		pausedAt,
		mode: "full" as const,
	});
	const paused = initialLive(info(5));
	expect(paused.resumedAt).toBe(0);
	// Still paused, or never paused: no resume.
	expect(withInfo(paused, info(5), 900).resumedAt).toBe(0);
	expect(withInfo(initialLive(info(null)), info(null), 900).resumedAt).toBe(0);
	// Paused, then not: the page's clock at that moment.
	const resumed = withInfo(paused, info(null), 900);
	expect(resumed.resumedAt).toBe(900);
	expect(resumed.info.pausedAt).toBeNull();
	// A later announce of the running process leaves it.
	expect(withInfo(resumed, info(null), 1200).resumedAt).toBe(900);
});

test("a page that attaches after another tab resumed gets when from the server, on its own clock (#602)", () => {
	const info = (pausedAt: number | null, resumedAt?: number) => ({
		liveId: "L1",
		pid: 1,
		cwd: "/w",
		sessionFile: null,
		sessionId: null,
		args: [],
		startedAt: 0,
		streaming: false,
		exited: false,
		subscribers: 0,
		pausedAt,
		...(resumedAt === undefined ? {} : { resumedAt }),
		mode: "full" as const,
	});
	noteServerTime(10_000, 4_000); // the server's clock is 6 s ahead
	try {
		// Attached after the resume: nothing was paused here, and the wait is not late until half a minute after it ran.
		const fresh = initialLive(info(null, 8_000));
		expect(fresh.resumedAt).toBe(2_000);
		// A resume this page saw is when it saw it, on its own clock; still paused, no stamp counts.
		expect(withInfo(initialLive(info(5)), info(null, 9_000), 900).resumedAt).toBe(900);
		expect(initialLive(info(5, 8_000)).resumedAt).toBe(0);
		// A page that was attached keeps the later of the two for an announce it hears again.
		expect(withInfo(initialLive(info(null)), info(null, 8_000), 900).resumedAt).toBe(2_000);
		expect(withInfo(fresh, info(null, 8_000), 900).resumedAt).toBe(2_000);
	} finally {
		noteServerTime(0, 0);
	}
});

test("the tab offers to retry a wait now when it is a usage limit's or omp let it pass, and not otherwise", () => {
	const can = (w: RetryWait, now: number) => canContinue(subagentWait(w, now, false, 0), false);
	// A usage limit counting down, or one the page learned of late that is long enough to be a reset.
	expect(can(wait(), START)).toBe(true);
	expect(can(wait({ usageLimit: false }), START)).toBe(true);
	// omp is late: whatever the wait was.
	expect(can(wait({ delayMs: 8000, usageLimit: false }), START + 60_000)).toBe(true);
	// A backoff of seconds is omp's; the time is up and omp is on it; the retried turn runs.
	expect(can(wait({ delayMs: 8000, usageLimit: false }), START)).toBe(false);
	expect(can(wait(), DUE + 1)).toBe(false);
	expect(can(wait({ resumed: true }), DUE + 3 * HOUR)).toBe(false);
});

test("a paused conversation is never offered it: not once the time is over (`paused`), and not while the countdown still runs", () => {
	const can = (w: RetryWait, now: number) => canContinue(subagentWait(w, now, true, 0), true);
	// Over while frozen: the view is `paused`.
	expect(subagentWait(wait(), DUE + 3 * HOUR, true, 0).phase).toBe("paused");
	expect(can(wait(), DUE + 3 * HOUR)).toBe(false);
	// Still counting while frozen: the view is the countdown, which unpaused is offered; frozen, the main agent could
	// not bring the subagent back after Stop (what this once led to).
	expect(subagentWait(wait(), START + 60_000, true, 0).phase).toBe("counting");
	expect(canContinue(subagentWait(wait(), START + 60_000, false, 0), false)).toBe(true);
	expect(can(wait(), START + 60_000)).toBe(false);
});
