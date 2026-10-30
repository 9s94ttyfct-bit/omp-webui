import { afterEach, beforeEach, expect, jest, test } from "bun:test";
import type { FamilyStats } from "../../shared/protocol.ts";
import { STATS_RETRY_MS, StatsAsks, type StatsWanted } from "../../web/src/lib/history.ts";

/**
 * The asks for the figures of a whole file (#711) while a run keeps changing what the page holds: the next ask is due a
 * delay after the last one went out, not after the last change, and an ask on its way is not given up for a change.
 */

beforeEach(() => {
	jest.useFakeTimers();
});
afterEach(() => jest.useRealTimers());

const STATS = { through: "e1" } as FamilyStats;
const wanted = (n: number, file = "a.jsonl"): StatsWanted => ({ key: `${file} k${n}`, stretch: `${file} s`, file });
/** Lets the promises that timers settled run their callbacks. */
const settle = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

/** An asker whose requests take `ms`, each answered by `answers` in turn ("fail" rejects), with what it asked and landed. */
function asker(ms: number, answers: ("ok" | "fail")[]) {
	const asked: number[] = [];
	const landed: string[] = [];
	let n = 0;
	const asks = new StatsAsks(
		() => {
			asked.push(Date.now());
			const answer = answers[n++] ?? "ok";
			// Under fake timers: the request takes `ms` of the test's clock.
			const { promise, resolve, reject } = Promise.withResolvers<FamilyStats>();
			setTimeout(() => (answer === "ok" ? resolve(STATS) : reject(new Error("boom"))), ms);
			return promise;
		},
		(file) => {
			landed.push(file);
			return true;
		},
	);
	return { asks, asked, landed };
}

test("after a failure the next ask goes out a second after the last, while what the page holds changes several times a second", async () => {
	const start = Date.now();
	const { asks, asked, landed } = asker(0, ["fail", "ok"]);
	asks.want(wanted(0));
	await settle();
	expect(asked).toEqual([start]);
	// A busy run: the page's question changes every 300 ms.
	for (let i = 1; i <= 10; i++) {
		jest.advanceTimersByTime(300);
		await settle();
		asks.want(wanted(i));
		await settle();
	}
	jest.advanceTimersByTime(0);
	await settle();
	// The retry goes out a second after the failed ask; while the question keeps changing, one ask a second, no more.
	expect(asked.map((at) => at - start)).toEqual([0, 1, 2, 3].map((i) => i * STATS_RETRY_MS));
	expect(landed).toEqual(["a.jsonl", "a.jsonl", "a.jsonl"]);
	asks.stop();
});

test("an ask on its way is not given up when what the page holds changes: its answer is used, and the page is asked about again", async () => {
	const start = Date.now();
	const { asks, asked, landed } = asker(500, ["ok", "ok"]);
	asks.want(wanted(0));
	for (let i = 1; i <= 4; i++) {
		jest.advanceTimersByTime(100);
		asks.want(wanted(i));
		await settle();
	}
	// One request while the first is on its way.
	expect(asked).toHaveLength(1);
	jest.advanceTimersByTime(100);
	await settle();
	expect(landed).toEqual(["a.jsonl"]);
	// The question changed meanwhile: it is asked about once the last ask is a second old.
	jest.advanceTimersByTime(STATS_RETRY_MS);
	await settle();
	expect(asked).toEqual([start, start + STATS_RETRY_MS]);
	asks.stop();
});

test("the figures of a file that is no longer on screen are not put into the page", async () => {
	const { asks, landed } = asker(500, ["ok", "ok"]);
	asks.want(wanted(0, "a.jsonl"));
	jest.advanceTimersByTime(100);
	asks.want(wanted(0, "b.jsonl"));
	jest.advanceTimersByTime(400);
	await settle();
	expect(landed).toEqual([]);
	jest.advanceTimersByTime(STATS_RETRY_MS);
	await settle();
	jest.advanceTimersByTime(500);
	await settle();
	expect(landed).toEqual(["b.jsonl"]);
	asks.stop();
});

test("an answer the page cannot use waits for a new question; nothing is asked once the page is gone", async () => {
	const asked: string[] = [];
	const asks = new StatsAsks(
		(file) => {
			asked.push(file);
			return Promise.resolve(STATS);
		},
		() => false,
	);
	asks.want(wanted(0));
	await settle();
	jest.advanceTimersByTime(60_000);
	await settle();
	expect(asked).toHaveLength(1);
	asks.want(wanted(1));
	jest.advanceTimersByTime(60_000);
	await settle();
	expect(asked).toHaveLength(2);
	asks.stop();
	asks.want(wanted(2));
	jest.advanceTimersByTime(60_000);
	await settle();
	expect(asked).toHaveLength(2);
});
