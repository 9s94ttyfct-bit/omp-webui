import { describe, expect, test } from "bun:test";
import {
	DEFAULT_TIMINGS,
	nextHold,
	nextLookMs,
	type QuotaHold,
	type QuotaTimings,
	readFloor,
	resumeAtOf,
	STALE_AFTER_RESET_MS,
} from "../../server/omp/quota-floor/decide.ts";
import type { UsageLimit, UsageReport } from "../../shared/protocol.ts";

/**
 * The quota floor's decisions (#652), pure: which usage reports are at the floor, when the provider frees up, what a look does to a
 * conversation's hold, and when the next look is. The reports are what `omp usage --json` says (see `shared/quota.ts`).
 */

const HOUR = 3_600_000;
const NOW = 1_700_000_000_000;

function limit(left: number | null, resetsAt?: number, extra: Partial<UsageLimit> = {}): UsageLimit {
	return {
		id: `w${Math.random()}`,
		label: "5 hour",
		window: { label: "5 hour", ...(resetsAt === undefined ? {} : { resetsAt }) },
		amount: left === null ? {} : { remainingFraction: left },
		...extra,
	};
}
const report = (limits: UsageLimit[], provider = "anthropic", email?: string): UsageReport => ({
	provider,
	limits,
	...(email ? { metadata: { email } } : {}),
});

describe("readFloor: is the provider at the floor the person set", () => {
	test("above the floor it is not, at it and below it is", () => {
		expect(readFloor([report([limit(0.5, NOW + HOUR)])], "anthropic", null, 20)).toMatchObject({
			low: false,
			remaining: 0.5,
		});
		expect(readFloor([report([limit(0.21, NOW + HOUR)])], "anthropic", null, 20)?.low).toBe(false);
		// "20 % or less is left" holds at exactly 20 % (and the float that says 0.2 is 0.2).
		expect(readFloor([report([limit(0.2, NOW + HOUR)])], "anthropic", null, 20)?.low).toBe(true);
		expect(readFloor([report([limit(0.05, NOW + HOUR)])], "anthropic", null, 20)?.low).toBe(true);
		expect(readFloor([report([limit(0, NOW + HOUR)])], "anthropic", null, 1)?.low).toBe(true);
	});

	test("the window that decides is the one with the least left, and its reset time and label say when and which", () => {
		const reading = readFloor(
			[
				report([
					limit(0.9, NOW + 5 * HOUR, { label: "5 hour" }),
					limit(0.1, NOW + 70 * HOUR, { window: { label: "7 day", resetsAt: NOW + 70 * HOUR } }),
				]),
			],
			"anthropic",
			null,
			20,
		);
		expect(reading).toMatchObject({ low: true, remaining: 0.1, resetsAt: NOW + 70 * HOUR, window: "7 day" });
	});

	test("two windows at the floor free up when the last of them resets", () => {
		const reading = readFloor(
			[
				report([
					limit(0.05, NOW + HOUR),
					limit(0.1, NOW + 4 * HOUR, { window: { label: "7 day", resetsAt: NOW + 4 * HOUR } }),
				]),
			],
			"anthropic",
			null,
			20,
		);
		expect(reading).toMatchObject({ low: true, resetsAt: NOW + 4 * HOUR, window: "7 day" });
	});

	test("the provider is at the floor only when every account is: omp goes on to the account that has some left", () => {
		const reports = [
			report([limit(0.05, NOW + HOUR)], "anthropic", "a@x"),
			report([limit(0.6, NOW + HOUR)], "anthropic", "b@x"),
		];
		expect(readFloor(reports, "anthropic", null, 20)).toMatchObject({ low: false, remaining: 0.6 });
		// Both low: it frees up when the first of them does.
		const both = [
			report([limit(0.05, NOW + 3 * HOUR)], "anthropic", "a@x"),
			report([limit(0.1, NOW + HOUR)], "anthropic", "b@x"),
		];
		expect(readFloor(both, "anthropic", null, 20)).toMatchObject({ low: true, remaining: 0.1, resetsAt: NOW + HOUR });
	});

	test("an account that reports nothing usable says nothing: it is not taken for one that is low, or for one that has some left", () => {
		const reports = [report([limit(0.05, NOW + HOUR)]), report([limit(null)])];
		expect(readFloor(reports, "anthropic", null, 20)?.low).toBe(false);
		// And no report with a window at all is no reading.
		expect(readFloor([report([])], "anthropic", null, 20)).toBeNull();
		expect(readFloor([report([limit(0.05)], "openai-codex")], "anthropic", null, 20)).toBeNull();
		expect(readFloor([], "anthropic", null, 20)).toBeNull();
	});

	test("a window omp reports as used up is at the floor whatever its share says, and without a reset time the provider says no time", () => {
		const reading = readFloor([report([limit(null, undefined, { status: "exhausted" })])], "anthropic", null, 20);
		expect(reading).toMatchObject({ low: true, resetsAt: null, remaining: 0 });
	});

	test("a window scoped to other models does not hold this one: an Opus-only cap does not stop a Sonnet request", () => {
		const reports = [
			report([
				limit(0.9, NOW + HOUR, { scope: { shared: true } }),
				limit(0.02, NOW + 70 * HOUR, { scope: { tier: "opus" } }),
			]),
		];
		expect(readFloor(reports, "anthropic", "claude-sonnet-5-5", 20)?.low).toBe(false);
		expect(readFloor(reports, "anthropic", "claude-opus-5", 20)).toMatchObject({
			low: true,
			resetsAt: NOW + 70 * HOUR,
		});
	});
});

const hold = (over: Partial<QuotaHold> = {}): QuotaHold => ({
	provider: "anthropic",
	floor: 20,
	remaining: 0.1,
	window: "5 hour",
	resetsAt: NOW + HOUR,
	since: NOW,
	...over,
});

describe("nextHold: what a look does to a conversation's hold", () => {
	const reading = (over: object = {}) => ({
		provider: "anthropic",
		floor: 20,
		remaining: 0.1,
		low: true,
		resetsAt: NOW + HOUR,
		window: "5 hour",
		...over,
	});

	test("a look that finds the floor reached begins a hold; the next one that does keeps its start and moves its figures", () => {
		const began = nextHold(null, reading(), NOW);
		expect(began).toEqual(hold());
		const later = nextHold(began, reading({ remaining: 0.08, resetsAt: NOW + 2 * HOUR }), NOW + 60_000);
		expect(later).toMatchObject({ since: NOW, remaining: 0.08, resetsAt: NOW + 2 * HOUR });
	});

	test("a look that finds the provider above the floor ends it: this is the release after the reset", () => {
		expect(
			nextHold(hold(), reading({ low: false, remaining: 0.9, resetsAt: null, window: null }), NOW + HOUR),
		).toBeNull();
		expect(nextHold(null, reading({ low: false }), NOW)).toBeNull();
	});

	test("a look that could not be made changes nothing, until the window should have reset long ago", () => {
		expect(nextHold(hold(), null, NOW + 60_000)).toEqual(hold());
		expect(nextHold(null, null, NOW)).toBeNull();
		// The reset passed a quarter of an hour ago and omp does not answer: the hold the floor cannot be checked for is let go.
		expect(nextHold(hold(), null, NOW + HOUR + STALE_AFTER_RESET_MS - 1)).toEqual(hold());
		expect(nextHold(hold(), null, NOW + HOUR + STALE_AFTER_RESET_MS)).toBeNull();
		// A hold with no reset time is never let go for want of an answer: nothing says the window is over.
		expect(nextHold(hold({ resetsAt: null }), null, NOW + 100 * HOUR)).toEqual(hold({ resetsAt: null }));
	});
});

describe("the reset and the looks", () => {
	const timings: QuotaTimings = { graceMs: 60_000, workingLookMs: 30_000, heldLookMs: 120_000 };

	test("the hold is let go a grace after the window's reset; with no reset time there is no such time", () => {
		expect(resumeAtOf(hold(), timings)).toBe(NOW + HOUR + 60_000);
		expect(resumeAtOf(hold({ resetsAt: null }), timings)).toBeNull();
		expect(DEFAULT_TIMINGS).toEqual({ graceMs: 60_000, workingLookMs: 30_000, heldLookMs: 120_000 });
	});

	const look = (over: Partial<Parameters<typeof nextLookMs>[0]>) =>
		nextLookMs({ working: true, held: false, resumeAt: null, now: NOW, last: NOW, timings, ...over });

	test("nothing is looked at for a conversation that does not work and is not held", () => {
		expect(look({ working: false })).toBeNull();
	});

	test("a conversation that works looks at the working interval: it spends quota", () => {
		expect(look({})).toBe(30_000);
		expect(look({ now: NOW + 12_000 })).toBe(18_000);
		expect(look({ now: NOW + 99_000 })).toBe(0);
	});

	test("a held one rarely, and once at the reset, which is what ends it", () => {
		const resumeAt = NOW + 50_000;
		expect(look({ held: true, working: true })).toBe(120_000);
		// The reset comes before the slow look would: the look is at the reset, not after it.
		expect(look({ held: true, resumeAt })).toBe(50_000);
		expect(look({ held: true, resumeAt, now: NOW + 20_000 })).toBe(30_000);
		// A pause (not working) is held and looked at still: the look itself refuses while nothing runs.
		expect(look({ held: true, working: false, resumeAt: null })).toBe(120_000);
	});

	test("past the reset and still low (the figures lag) it is looked at at the working interval, not the slow one", () => {
		const resumeAt = NOW - 5_000;
		expect(look({ held: true, resumeAt, last: NOW })).toBe(30_000);
	});
});
