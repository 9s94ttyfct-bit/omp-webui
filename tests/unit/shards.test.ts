import { describe, expect, test } from "bun:test";
import { type ListSuite, listedTests, readTimings, runsApart, units } from "../../scripts/e2e-shard.ts";
import { reportTimings } from "../../scripts/e2e-timings.ts";
import { assignShards, parseShard, weigh } from "../../scripts/lib/shards.ts";

/** CI's suites split between runners by how long their parts take (`scripts/e2e-shard.ts`, `scripts/test-shard.ts`). */

describe("a split by weight", () => {
	const parts = [
		{ key: "a", weight: 600 },
		{ key: "b", weight: 300 },
		{ key: "c", weight: 300 },
		{ key: "d", weight: 200 },
		{ key: "e", weight: 100 },
		{ key: "f", weight: 100 },
	];

	test("every part runs on exactly one runner", () => {
		for (const total of [1, 2, 3, 4, 8]) {
			const shares = assignShards(parts, total);
			expect(shares).toHaveLength(total);
			expect(shares.flat().sort()).toEqual(parts.map((p) => p.key));
		}
	});

	test("the heaviest goes first, each to the runner with least so far: the shares are as even as the parts allow", () => {
		const shares = assignShards(parts, 2);
		const weight = (keys: string[]) => keys.reduce((s, k) => s + (parts.find((p) => p.key === k)?.weight ?? 0), 0);
		expect(shares.map(weight)).toEqual([800, 800]);
		// One part heavier than an even share is a share of its own.
		expect(assignShards(parts, 3)[0]).toEqual(["a"]);
	});

	test("every runner works out the same split, whatever order the parts came in; a share keeps the input's order", () => {
		const reversed = [...parts].reverse();
		expect(assignShards(reversed, 3).map((s) => [...s].sort())).toEqual(
			assignShards(parts, 3).map((s) => [...s].sort()),
		);
		expect(assignShards(parts, 1)[0]).toEqual(["a", "b", "c", "d", "e", "f"]);
	});

	test("a part listed twice, or a split into no shares, is an error", () => {
		expect(() => assignShards([...parts, { key: "a", weight: 1 }], 2)).toThrow("twice");
		expect(() => assignShards(parts, 0)).toThrow();
	});

	test("a part with no timing weighs as the median one, not as nothing", () => {
		expect(weigh(["x", "y", "z", "new"], { x: 1, y: 5, z: 9 })).toEqual([
			{ key: "x", weight: 1 },
			{ key: "y", weight: 5 },
			{ key: "z", weight: 9 },
			{ key: "new", weight: 5 },
		]);
	});

	test("--shard is 1-based, as Playwright's", () => {
		expect(parseShard("3/16")).toEqual({ index: 3, total: 16 });
		for (const bad of [undefined, "0/4", "5/4", "3", "a/b"]) expect(() => parseShard(bad)).toThrow("--shard");
	});
});

describe("the end-to-end tests", () => {
	const report: ListSuite[] = [
		{
			title: "follow.spec.ts",
			file: "follow.spec.ts",
			specs: [
				{ title: "one", tests: [{ results: [{ duration: 30_040 }] }] },
				{ title: "two", tests: [{ results: [{ duration: 1000 }, { duration: 2_000 }] }] },
			],
		},
		{
			title: "page.spec.ts",
			file: "page.spec.ts",
			specs: [{ title: "top", tests: [{ results: [] }] }],
			suites: [{ title: "on a phone", file: "page.spec.ts", specs: [{ title: "fits", tests: [] }] }],
		},
	];

	test("a test is named as a test list names it: its file, its describes and its title", () => {
		expect(listedTests(report).map((t) => t.key)).toEqual([
			"follow.spec.ts › one",
			"follow.spec.ts › two",
			"page.spec.ts › top",
			"page.spec.ts › on a phone › fits",
		]);
	});

	test("a file whose tests run apart is split test by test; any other runs whole, weighing what its tests do", () => {
		const timings = { "follow.spec.ts › one": 30, "follow.spec.ts › two": 2, "page.spec.ts › top": 4 };
		expect(units(listedTests(report), (f) => f === "follow.spec.ts", timings)).toEqual([
			{ key: "follow.spec.ts › one", weight: 30 },
			{ key: "follow.spec.ts › two", weight: 2 },
			// "fits" has no timing: it weighs the median (4).
			{ key: "page.spec.ts", weight: 8 },
		]);
	});

	test("a file runs apart when it says so at its top level, and only then", () => {
		expect(runsApart('import x;\ntest.describe.configure({ mode: "parallel" });\n')).toBe(true);
		expect(runsApart('test.describe.configure({ mode: "serial" });\n')).toBe(false);
		expect(runsApart('\ttest.describe.configure({ mode: "parallel" });\n')).toBe(false);
	});

	test("the timings of a run are its tests' last results, in seconds to a tenth; a test without a result has none", () => {
		const text = JSON.stringify({ config: { rootDir: "/r/tests/e2e" }, suites: report });
		expect(reportTimings(text)).toEqual({ "follow.spec.ts › one": 30, "follow.spec.ts › two": 2 });
		expect(readTimings(JSON.stringify({ version: 1, tests: { a: 1, b: "no" } }))).toEqual({ a: 1 });
	});
});
