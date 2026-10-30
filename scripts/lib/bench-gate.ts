/**
 * What `scripts/bench-gate.ts` decides, apart from running anything: when the machine is quiet enough to measure, which
 * files are the measuring harness (so B's can be laid over A's), and what the three comparisons of an A / B / A′ run
 * add up to. The clock and the load are passed in.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, sep } from "node:path";
import { isFootprintMetric, type Report } from "../../tests/support/bench-stats.ts";

/** What `bench.ts` starts without importing it (the fake omp is run by path). */
const HARNESS_EXTRA_ENTRIES = ["tests/support/long-fake-omp.ts"];

/**
 * The files that make up the measuring harness of the checkout at `root`: `scripts/bench.ts` and every file under
 * `scripts/` or `tests/` that it imports, transitively (relative imports, `import()` too), plus the fake omp it spawns.
 * App code (`shared/`, `server/`, `web/`) is not the harness: what is imported from there is what is being measured.
 * Paths relative to `root`, sorted.
 */
export function harnessFiles(root: string, entry = "scripts/bench.ts"): string[] {
	const found = new Set<string>();
	const queue = [entry, ...HARNESS_EXTRA_ENTRIES];
	for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
		const rel = normalize(file).split(sep).join("/");
		if (found.has(rel) || !/^(scripts|tests)\//.test(rel) || !existsSync(join(root, rel))) continue;
		found.add(rel);
		const text = readFileSync(join(root, rel), "utf8");
		for (const m of text.matchAll(/(?:from|import)\s*\(?\s*["'](\.{1,2}\/[^"']+)["']/g)) {
			queue.push(relative(root, join(root, dirname(rel), m[1])));
		}
	}
	return [...found].sort();
}

export interface QuietOptions {
	/** The 1-minute load average now. */
	readLoad: () => number;
	/** Wait this many ms. */
	sleep: (ms: number) => Promise<void>;
	/** Milliseconds on a monotonic clock. */
	now: () => number;
	/** Quiet means the load average is at or below this. */
	maxLoad: number;
	/** Give up after this long. */
	maxWaitMs: number;
	pollMs: number;
	/** Called with each reading that is not quiet, for the log. */
	onWait?: (load: number, waitedMs: number) => void;
}

export interface QuietResult {
	quiet: boolean;
	/** The last reading. */
	load: number;
	waitedMs: number;
}

/** Wait until the load average is at or below `maxLoad` (the first reading counts), or `maxWaitMs` has passed. */
export async function waitForQuiet(o: QuietOptions): Promise<QuietResult> {
	const start = o.now();
	for (;;) {
		const load = o.readLoad();
		const waitedMs = o.now() - start;
		if (load <= o.maxLoad) return { quiet: true, load, waitedMs };
		if (waitedMs >= o.maxWaitMs) return { quiet: false, load, waitedMs };
		o.onWait?.(load, waitedMs);
		await o.sleep(Math.min(o.pollMs, Math.max(1, o.maxWaitMs - waitedMs)));
	}
}

/**
 * The busiest processes in macOS `top -l 2 -o cpu -stats pid,command,cpu` output, busiest first, from its LAST sample:
 * the first has no interval to measure over and reads near 0 for everything (`ps` %CPU, a decaying average, misses a
 * sync that has just started the same way: #666). `top` itself and idle rows are left out.
 */
export function busiestFromTop(out: string, n = 5): { command: string; cpu: number }[] {
	const lines = out.split("\n");
	let header = -1;
	for (let i = 0; i < lines.length; i++) if (/^\s*PID\s+COMMAND\s+%CPU\b/.test(lines[i])) header = i;
	if (header < 0) return [];
	const rows: { command: string; cpu: number }[] = [];
	for (const line of lines.slice(header + 1)) {
		const m = /^\s*\d+\s+(.+?)\s+(\d+(?:\.\d+)?)\s*$/.exec(line);
		if (!m || m[1] === "top") continue;
		const cpu = Number(m[2]);
		if (cpu > 0) rows.push({ command: m[1], cpu });
	}
	return rows.sort((a, b) => b.cpu - a.cpu).slice(0, n);
}

/** The exit codes of `bench.ts --compare`: 0 nothing worse, 1 a gated metric worse, 3 invalid report, 4 not comparable (anything above 2 is unusable). */
export interface GateComparisons {
	/** A against B. */
	ab: number;
	/** A against A′: the same code twice. */
	aa2: number;
	/** A′ against B. */
	a2b: number;
}

export const GATE_EXIT = {
	pass: 0,
	/** B is worse than A or A′ on a gated metric. */
	regression: 1,
	/** Not run: the machine never became quiet, a build or a run failed. */
	refused: 2,
	/** A report is invalid or the reports are not comparable. */
	unusable: 3,
	/** A differs from A′ on a gated metric: the baseline drifted, so A against B proves nothing. */
	drift: 5,
	/** Nothing worse, but a run was made on a machine that was not quiet (or otherwise off), or memory was not gated (a report without footprint): not evidence. */
	provisionalPass: 6,
} as const;

/**
 * The labels of the reports that carry no footprint metric: for them the memory gate cannot be applied. A comparison
 * that involves one of them says nothing about memory and must not read as a pass.
 */
export function labelsWithoutFootprint(reports: readonly Pick<Report, "label" | "metrics">[]): string[] {
	return reports.filter((r) => !Object.keys(r.metrics).some(isFootprintMetric)).map((r) => r.label);
}

/**
 * Unusable reports first (no verdict at all), then a regression, then a drifting baseline. Else a pass only when the
 * runs were not provisional and every report carries the footprint (`memoryGated`): a comparison that did not gate on
 * memory, or a run made on a machine that was not quiet, is `provisionalPass`, not evidence.
 */
export function gateExitCode(
	c: GateComparisons,
	{ provisionalRuns, memoryGated }: { provisionalRuns: boolean; memoryGated: boolean },
): number {
	if ([c.ab, c.aa2, c.a2b].some((x) => x >= 3)) return GATE_EXIT.unusable;
	if (c.ab === 1 || c.a2b === 1) return GATE_EXIT.regression;
	if (c.aa2 === 1) return GATE_EXIT.drift;
	return provisionalRuns || !memoryGated ? GATE_EXIT.provisionalPass : GATE_EXIT.pass;
}
