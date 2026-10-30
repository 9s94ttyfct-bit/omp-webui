import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
	busiestFromTop,
	GATE_EXIT,
	gateExitCode,
	harnessFiles,
	labelsWithoutFootprint,
	waitForQuiet,
} from "../../scripts/lib/bench-gate.ts";
import { summarize } from "../../tests/support/bench-stats.ts";

/** The A / B / A′ gate's decisions (#601): when the machine counts as quiet, and what the three comparisons add up to. */

/** A fake clock and a load that follows a script, one reading per call. */
function world(loads: number[]) {
	let t = 0;
	let i = 0;
	const sleeps: number[] = [];
	return {
		sleeps,
		readings: () => i,
		opts: {
			readLoad: () => loads[Math.min(i++, loads.length - 1)],
			sleep: async (ms: number) => {
				sleeps.push(ms);
				t += ms;
			},
			now: () => t,
		},
	};
}

describe("waitForQuiet", () => {
	test("a quiet machine goes at once, without sleeping", async () => {
		const w = world([1.2]);
		const r = await waitForQuiet({ ...w.opts, maxLoad: 2.5, maxWaitMs: 60_000, pollMs: 1000 });
		expect(r).toEqual({ quiet: true, load: 1.2, waitedMs: 0 });
		expect(w.sleeps).toEqual([]);
	});

	test("the limit itself is quiet", async () => {
		const w = world([2.5]);
		expect((await waitForQuiet({ ...w.opts, maxLoad: 2.5, maxWaitMs: 1000, pollMs: 100 })).quiet).toBe(true);
	});

	test("waits, poll by poll, until the load falls", async () => {
		const w = world([9, 6, 3.1, 2.4]);
		const seen: number[] = [];
		const r = await waitForQuiet({
			...w.opts,
			maxLoad: 2.5,
			maxWaitMs: 60_000,
			pollMs: 1000,
			onWait: (load) => seen.push(load),
		});
		expect(r).toEqual({ quiet: true, load: 2.4, waitedMs: 3000 });
		expect(w.sleeps).toEqual([1000, 1000, 1000]);
		expect(seen).toEqual([9, 6, 3.1]);
	});

	test("gives up at the maximum wait with the last reading, quiet false", async () => {
		const w = world([8]);
		const r = await waitForQuiet({ ...w.opts, maxLoad: 2.5, maxWaitMs: 2500, pollMs: 1000 });
		expect(r).toEqual({ quiet: false, load: 8, waitedMs: 2500 });
		// The last sleep is cut to what is left of the wait, so the wait never overshoots.
		expect(w.sleeps).toEqual([1000, 1000, 500]);
	});

	test("a zero wait reads once and gives up", async () => {
		const w = world([8]);
		const r = await waitForQuiet({ ...w.opts, maxLoad: 2.5, maxWaitMs: 0, pollMs: 1000 });
		expect(r.quiet).toBe(false);
		expect(w.sleeps).toEqual([]);
		expect(w.readings()).toBe(1);
	});
});

describe("busiestFromTop", () => {
	const sample = (rows: string) =>
		`Processes: 523 total\nLoad Avg: 3.36, 3.90, 4.39\n\nPID    COMMAND          %CPU\n${rows}\n`;
	test("reads top's last sample (the first has no interval), keeps names with spaces, leaves out top and idle rows (#666)", () => {
		const out =
			sample("1826   Google Drive     0.0\n428    WindowServer     0.0\n99001  top              0.0") +
			sample(
				"428    WindowServer     35.9\n99001  top              12.0\n1826   Google Drive     109.8\n751    fileproviderd    8.4\n1  launchd 0.0",
			);
		expect(busiestFromTop(out)).toEqual([
			{ command: "Google Drive", cpu: 109.8 },
			{ command: "WindowServer", cpu: 35.9 },
			{ command: "fileproviderd", cpu: 8.4 },
		]);
		expect(busiestFromTop(out, 1)).toEqual([{ command: "Google Drive", cpu: 109.8 }]);
	});
	test("output without a process table names nothing", () => {
		expect(busiestFromTop("top: failed\n")).toEqual([]);
	});
});

describe("gateExitCode", () => {
	const ok = { ab: 0, aa2: 0, a2b: 0 };
	const clean = { provisionalRuns: false, memoryGated: true };

	test("all clean and memory gated: pass", () => {
		expect(gateExitCode(ok, clean)).toBe(GATE_EXIT.pass);
	});

	test("provisional runs: not a pass", () => {
		expect(gateExitCode(ok, { ...clean, provisionalRuns: true })).toBe(GATE_EXIT.provisionalPass);
	});

	test("memory not gated (a report without footprint): provisional, never a pass (the blind spot of #599)", () => {
		expect(gateExitCode(ok, { ...clean, memoryGated: false })).toBe(GATE_EXIT.provisionalPass);
		expect(gateExitCode(ok, { provisionalRuns: true, memoryGated: false })).toBe(GATE_EXIT.provisionalPass);
	});

	test("B worse than A or than A′ is a regression, provisional or not", () => {
		expect(gateExitCode({ ...ok, ab: 1 }, clean)).toBe(GATE_EXIT.regression);
		expect(gateExitCode({ ...ok, a2b: 1 }, { provisionalRuns: true, memoryGated: false })).toBe(GATE_EXIT.regression);
	});

	test("A worse than A′ alone is a drifting baseline", () => {
		expect(gateExitCode({ ...ok, aa2: 1 }, clean)).toBe(GATE_EXIT.drift);
	});

	test("a regression is reported before the drift that accompanies it", () => {
		expect(gateExitCode({ ab: 1, aa2: 1, a2b: 0 }, clean)).toBe(GATE_EXIT.regression);
	});

	test("an invalid or not-comparable report, or a crashed comparison, has no verdict", () => {
		for (const bad of [3, 4, 99]) {
			expect(gateExitCode({ ...ok, ab: bad }, clean)).toBe(GATE_EXIT.unusable);
			expect(gateExitCode({ ab: 1, aa2: bad, a2b: 1 }, clean)).toBe(GATE_EXIT.unusable);
		}
	});
});

describe("labelsWithoutFootprint", () => {
	const def = { unit: "MB", better: "lower", floor: 2 } as const;
	const report = (label: string, names: string[]) => ({
		label,
		metrics: Object.fromEntries(names.map((n) => [n, summarize(def, [1, 2, 3])])),
	});

	test("names the reports with no footprint metric, not those with one", () => {
		const reports = [
			report("A", ["server.idle.rss_mb", "stream.heap_mb"]),
			report("B", ["server.idle.rss_mb", "server.idle.footprint_mb"]),
			report("A2", []),
		];
		expect(labelsWithoutFootprint(reports)).toEqual(["A", "A2"]);
		expect(labelsWithoutFootprint([reports[1]])).toEqual([]);
	});
});

describe("harnessFiles", () => {
	function tree(files: Record<string, string>): string {
		const root = mkdtempSync(join(tmpdir(), "ompw-harness-"));
		for (const [rel, text] of Object.entries(files)) {
			mkdirSync(dirname(join(root, rel)), { recursive: true });
			writeFileSync(join(root, rel), text);
		}
		return root;
	}

	test("bench.ts and what it imports from scripts/ and tests/, transitively; not app code", () => {
		const root = tree({
			"scripts/bench.ts":
				'import { a } from "../tests/support/a.ts";\nimport { s } from "../shared/prefs.ts";\nimport { b } from "./lib/b.ts";',
			"tests/support/a.ts": 'import { c } from "./c.ts";\nexport const lazy = () => import("../../server/main.ts");',
			"tests/support/c.ts": "export const c = 1;",
			"tests/support/long-fake-omp.ts": 'import { c } from "./c.ts";',
			"tests/support/unrelated.ts": "export {};",
			"scripts/lib/b.ts": "export const b = 1;",
			"shared/prefs.ts": "export const s = 1;",
			"server/main.ts": "export {};",
		});
		try {
			expect(harnessFiles(root)).toEqual([
				"scripts/bench.ts",
				"scripts/lib/b.ts",
				"tests/support/a.ts",
				"tests/support/c.ts",
				"tests/support/long-fake-omp.ts",
			]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("an import cycle and a missing file do not loop or throw", () => {
		const root = tree({
			"scripts/bench.ts": 'import "../tests/support/x.ts";\nimport "../tests/support/gone.ts";',
			"tests/support/x.ts": 'import "./y.ts";',
			"tests/support/y.ts": 'import "./x.ts";',
		});
		try {
			expect(harnessFiles(root)).toEqual(["scripts/bench.ts", "tests/support/x.ts", "tests/support/y.ts"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("this checkout: the stats, the fixtures, the page recorder, the test server, the fake omp", () => {
		const files = harnessFiles(join(import.meta.dir, "../.."));
		for (const f of [
			"scripts/bench.ts",
			"tests/support/bench-stats.ts",
			"tests/support/bench-fixtures.ts",
			"tests/support/bench-page.ts",
			"tests/support/server.ts",
			"tests/support/long-fake-omp.ts",
		]) {
			expect(files).toContain(f);
		}
		expect(files.some((f) => /^(shared|server|web)\//.test(f))).toBe(false);
	});
});
