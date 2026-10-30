import { describe, expect, test } from "bun:test";
import {
	holdFileText,
	parseHoldFile,
	parseWarmVerdict,
	ttlFromDelayMs,
	WARM_CAP_IDLE_MS,
	WARM_CAP_STREAMING_MS,
	WARM_SAVINGS_MIN,
	type WarmingInput,
	warmingPlan,
	warmVerdictOf,
	warmVerdictText,
} from "../../shared/quota-hold.ts";

/**
 * The cost check of the prompt cache while a conversation is held at the quota floor (#652): keep it warm only while keeping it
 * until the reset costs less than rebuilding it once after it. The numbers are omp's (`session/cache-warmer.ts` of omp 18.12): a
 * refresh at 90 % of the entry's lifetime, a stop one hour after the request that made the entry while the agent works and half an
 * hour while it is idle, a saving of at least $0.05.
 */

const MIN = 60_000;
const NOW = 1_700_000_000_000;
/** A 5-minute cache: omp refreshes it every 270 s. */
const DELAY = 270_000;

function input(over: Partial<WarmingInput> = {}): WarmingInput {
	return {
		now: NOW,
		resumeAt: NOW + 30 * MIN,
		// The request that made the entry began a refresh interval ago.
		startedAt: NOW - DELAY,
		delayMs: DELAY,
		streaming: true,
		warmCost: 0.03,
		missCost: 1.7,
		...over,
	};
}

describe("ttlFromDelayMs: the entry's lifetime, from the interval omp refreshes it at", () => {
	test("it is the inverse of omp's own delay", () => {
		// omp: delay = max(1, floor(min(0.9 × ttl, ttl − 10 s))).
		const delay = (ttl: number) => Math.max(1, Math.floor(Math.min(ttl * 0.9, ttl - 10_000)));
		for (const ttl of [60_000, 95_000, 100_000, 300_000, 3_600_000])
			expect(ttlFromDelayMs(delay(ttl))).toBeCloseTo(ttl, -1);
		expect(ttlFromDelayMs(270_000)).toBe(300_000);
		expect(ttlFromDelayMs(3_240_000)).toBeCloseTo(3_600_000);
		expect(ttlFromDelayMs(50_000)).toBe(60_000);
	});
});

describe("warmingPlan: keep the cache warm until the reset, or let it lapse", () => {
	test("a reset soon: a handful of refreshes cost far less than the rebuild, so it is kept warm", () => {
		const plan = warmingPlan(input());
		// 30 minutes at one refresh every 270 s: this one and six more.
		expect(plan).toEqual({ state: "on", pings: 7, warmCost: 7 * 0.03, rebuildCost: 1.7 });
	});

	test("a refresh that costs as much as a rebuild is not worth making: it lapses, with the cost it avoided", () => {
		const plan = warmingPlan(input({ warmCost: 0.6 }));
		expect(plan).toMatchObject({ state: "lapse", why: "cost", pings: 7, rebuildCost: 1.7 });
		expect(plan.warmCost).toBeCloseTo(4.2);
	});

	test("the line is the saving: keep it warm while rebuilding costs at least $0.05 more than the refreshes until the reset", () => {
		// Seven refreshes at $0.10 are $0.70.
		expect(warmingPlan(input({ warmCost: 0.1, missCost: 0.76 })).state).toBe("on");
		expect(warmingPlan(input({ warmCost: 0.1, missCost: 0.74 }))).toMatchObject({ state: "lapse", why: "cost" });
		expect(WARM_SAVINGS_MIN).toBe(0.05);
	});

	test("the cost is of the refreshes still to come: the nearer the reset, the less it costs", () => {
		const far = warmingPlan(input({ warmCost: 0.25, resumeAt: NOW + 30 * MIN }));
		const near = warmingPlan(input({ warmCost: 0.25, resumeAt: NOW + 10 * MIN }));
		expect(far.state).toBe("lapse");
		// 10 minutes: this one and two more, $0.75 against $1.70.
		expect(near).toMatchObject({ state: "on", pings: 3 });
	});

	test("a reset omp's refreshing cannot reach keeps nothing warm, so the cache lapses at once instead of paying until the limit", () => {
		// Five hours away: omp stops refreshing a working turn's entry an hour after the request that made it.
		const plan = warmingPlan(input({ resumeAt: NOW + 5 * 60 * MIN }));
		expect(plan).toMatchObject({ state: "lapse", why: "limit" });
		expect(plan.pings).toBeGreaterThan(60);
		// Just inside the hour it can: the refresh before the limit is the last one, and it is enough to reach the reset.
		const inside = warmingPlan(input({ resumeAt: NOW + 50 * MIN }));
		expect(inside.state).toBe("on");
		// The limit counts from the request that made the entry, not from now: a request long ago leaves less of the hour.
		const old = warmingPlan(input({ startedAt: NOW - 50 * MIN, resumeAt: NOW + 30 * MIN }));
		expect(old).toMatchObject({ state: "lapse", why: "limit" });
		expect(WARM_CAP_STREAMING_MS).toBe(60 * MIN);
	});

	test("an idle conversation's limit is half an hour (omp's idle mode)", () => {
		expect(warmingPlan(input({ streaming: false, resumeAt: NOW + 20 * MIN })).state).toBe("on");
		expect(warmingPlan(input({ streaming: false, resumeAt: NOW + 40 * MIN }))).toMatchObject({
			state: "lapse",
			why: "limit",
		});
		expect(WARM_CAP_IDLE_MS).toBe(30 * MIN);
	});

	test("a hold with no reset time lapses it: nothing says when the refreshes would stop being needed", () => {
		expect(warmingPlan(input({ resumeAt: null }))).toMatchObject({ state: "lapse", why: "reset", pings: 0 });
	});

	test("an entry that lasts until the reset costs nothing: it is left alone", () => {
		// The entry was touched one interval ago and lives 300 s from then: 30 s more.
		expect(warmingPlan(input({ resumeAt: NOW + 20_000 }))).toEqual({
			state: "none",
			pings: 0,
			warmCost: 0,
			rebuildCost: 1.7,
		});
		expect(warmingPlan(input({ resumeAt: NOW + 30_000 })).state).toBe("none");
		expect(warmingPlan(input({ resumeAt: NOW + 30_001 })).state).toBe("on");
	});

	test("a provider that prices a cache read like a miss has nothing to save", () => {
		expect(warmingPlan(input({ missCost: 0 }))).toMatchObject({ state: "lapse", why: "small" });
	});

	test("an interval that cannot be measured is not guessed", () => {
		expect(warmingPlan(input({ delayMs: 0 }))).toMatchObject({ state: "lapse", why: "limit" });
		expect(warmingPlan(input({ delayMs: -5 }))).toMatchObject({ state: "lapse", why: "limit" });
	});

	test("a long-lived cache (one hour) is refreshed rarely: three hours away it still cannot be reached", () => {
		const plan = warmingPlan(
			input({
				delayMs: 3_240_000,
				startedAt: NOW - 3_240_000,
				resumeAt: NOW + 3 * 60 * MIN,
				warmCost: 0.1,
				missCost: 3,
			}),
		);
		expect(plan).toMatchObject({ state: "lapse", why: "limit" });
		// A reset five minutes away: the entry (an hour from its last touch, 54 minutes ago) lasts six minutes more.
		expect(warmingPlan(input({ delayMs: 3_240_000, startedAt: NOW - 3_240_000, resumeAt: NOW + 5 * MIN })).state).toBe(
			"none",
		);
	});
});

describe("the words the server and the extension share", () => {
	test("a hold file reads back as it was written, and anything else is no hold", () => {
		const text = holdFileText({
			provider: "anthropic",
			resetsAt: NOW,
			resumeAt: NOW + 60_000,
			expiresAt: NOW + 360_000,
			since: NOW - 5,
		});
		expect(parseHoldFile(text)).toEqual({
			v: 1,
			hold: true,
			provider: "anthropic",
			resetsAt: NOW,
			resumeAt: NOW + 60_000,
			expiresAt: NOW + 360_000,
			since: NOW - 5,
		});
		expect(
			parseHoldFile(holdFileText({ provider: "p", resetsAt: null, resumeAt: null, expiresAt: null, since: 1 })),
		).toMatchObject({
			resetsAt: null,
			expiresAt: null,
		});
		for (const bad of [
			"",
			"{",
			"[]",
			"null",
			'{"v":2,"hold":true,"provider":"p","since":1}',
			'{"v":1,"hold":false,"provider":"p","since":1}',
			'{"v":1,"hold":true,"since":1}',
			'{"v":1,"hold":true,"provider":"p"}',
		]) {
			expect(parseHoldFile(bad)).toBeNull();
		}
	});

	test("a verdict reads back as it was told, nothing else is one, and an unknown reason is dropped, not believed", () => {
		const text = warmVerdictText({ at: NOW, state: "lapse", why: "cost", pings: 66, warmCost: 9.9, rebuildCost: 1.7 });
		expect(parseWarmVerdict(text)).toEqual({
			v: 1,
			at: NOW,
			state: "lapse",
			why: "cost",
			pings: 66,
			warmCost: 9.9,
			rebuildCost: 1.7,
		});
		expect(parseWarmVerdict(warmVerdictText({ at: NOW, state: "on" }))).toEqual({ v: 1, at: NOW, state: "on" });
		expect(parseWarmVerdict(JSON.stringify({ v: 1, at: NOW, state: "lapse", why: "because" }))).toEqual({
			v: 1,
			at: NOW,
			state: "lapse",
		});
		for (const bad of [
			undefined,
			"",
			"x",
			"[]",
			JSON.stringify({ v: 2, at: NOW, state: "on" }),
			JSON.stringify({ v: 1, at: NOW, state: "off" }),
			JSON.stringify({ v: 1, state: "on" }),
		]) {
			expect(parseWarmVerdict(bad)).toBeNull();
		}
		expect(warmVerdictOf(null)).toBeNull();
		expect(warmVerdictOf({ v: 1, at: NOW, state: "none" })).toEqual({ v: 1, at: NOW, state: "none" });
	});
});
