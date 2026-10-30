import { describe, expect, test } from "bun:test";
import { HeldState } from "../../server/omp/held.ts";
import { bashEnded } from "../../shared/held-state.ts";
import { bashTookOf, type Run, readRuns, runMs, withRun } from "../../web/src/lib/bash-times.ts";

/**
 * How long a user's `!command` ran (#657): the server says it on `bash_ended`, the page keeps it and matches it to the saved
 * `bashExecution` message (which has the time it was written and no start) by its command line and that time.
 */

describe("the end the server announces", () => {
	test("says what ran, when it ended and for how long, on the server's clock", () => {
		const frame = bashEnded("bash-1", { id: "bash-1", command: "sleep 2", startedAt: 1_000 }, 3_400);
		expect(frame).toEqual({ type: "bash_ended", id: "bash-1", command: "sleep 2", endedAt: 3_400, durationMs: 2_400 });
		expect(bashTookOf(frame)).toEqual({ command: "sleep 2", endedAt: 3_400, durationMs: 2_400 });
	});

	test("a bare end (no run) says only which one, and is no length", () => {
		expect(bashEnded("bash-2")).toEqual({ type: "bash_ended", id: "bash-2" });
		expect(bashTookOf(bashEnded("bash-2"))).toBeNull();
	});

	test("the server's record of a run ends with its length, once", () => {
		const held = new HeldState();
		const started = held.startBash("echo hi");
		const id = String(started.id);
		const ended = held.endBash(id);
		expect(ended).toMatchObject({ type: "bash_ended", id, command: "echo hi" });
		expect(bashTookOf(ended ?? { type: "none" })?.durationMs).toBeGreaterThanOrEqual(0);
		// A run that is no longer held (its process ended first) has no end to tell.
		expect(held.endBash(id)).toBeNull();
	});
});

describe("matching a saved message to a run", () => {
	const runs: Run[] = [
		["ls", 10_000, 40],
		["sleep 2", 20_000, 2_010],
		["sleep 2", 30_000, 2_050],
	];

	test("finds the run of the same command that ended nearest the message's time", () => {
		expect(runMs(runs, "sleep 2", 20_300)).toBe(2_010);
		expect(runMs(runs, "sleep 2", 29_900)).toBe(2_050);
		expect(runMs(runs, "ls", 10_001)).toBe(40);
	});

	test("finds none for another command, or the same one run at another time", () => {
		expect(runMs(runs, "pwd", 10_000)).toBeUndefined();
		expect(runMs(runs, "sleep 2", 45_000)).toBeUndefined();
		expect(runMs([], "ls", 10_000)).toBeUndefined();
	});

	test("compares a long command line cut the same way on both sides", () => {
		const long = `echo ${"x".repeat(500)}`;
		const kept = withRun([], long, 5_000, 70);
		expect(runMs(kept, long, 5_100)).toBe(70);
		expect(kept[0][0].length).toBe(200);
	});
});

describe("what is kept", () => {
	const storage = (initial?: string) => {
		const map = new Map<string, string>(initial === undefined ? [] : [["ompw.bashTimes", initial]]);
		return { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
	};

	test("keeps the newest 200", () => {
		let kept: Run[] = [];
		for (let i = 0; i < 230; i++) kept = withRun(kept, `cmd ${i}`, i, i);
		expect(kept).toHaveLength(200);
		expect(kept[0][0]).toBe("cmd 30");
		expect(kept.at(-1)?.[0]).toBe("cmd 229");
	});

	test("reads back what was written, and drops what is not a run", () => {
		const good: Run[] = [["ls", 1, 2]];
		expect(readRuns(storage(JSON.stringify(good)))).toEqual(good);
		expect(readRuns(storage())).toEqual([]);
		expect(readRuns(storage("not json"))).toEqual([]);
		expect(readRuns(storage('{"a":1}'))).toEqual([]);
		expect(
			readRuns(storage(JSON.stringify([["ls", 1, 2], ["ls", "1", 2], ["ls", 1, -2], ["ls", 1], 5, null]))).length,
		).toBe(1);
	});
});
