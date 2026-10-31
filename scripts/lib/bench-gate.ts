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
 * The server's memory, held to where v0.13.0 left it. The A / B comparison fails a step of more than its threshold
 * between two trees; a creep of less than that at each release passes it every time (#9: +22 % idle, +43 % listing
 * over five releases). So B's footprint has a budget of its own: v0.13.0's median plus 5 % (`FOOTPRINT_HEADROOM`).
 *
 * A baseline holds for the scenarios it was measured with (the report's `conditions.scenarios`): what ran before is part
 * of what a footprint reads (the idle server after a round of every scenario holds 7–13 MB more than after `server` and
 * `list` alone). Each is the highest median of the runs of v0.13.0 named, on an Apple M4 Pro, macOS 27.2, Bun 1.4.4,
 * 2026-10-31 (A-029). That machine was busy (load 3.7–12 at the starts, so every run is provisional) and A and A′ of
 * one gate differ by up to 5 %: the highest median keeps that noise from failing B. Measured again on a quiet machine,
 * they can be tightened. The numbers are macOS `footprint`: Linux Pss is another measure, and is not held to them.
 */
export const FOOTPRINT_BASELINE_MB: Readonly<Record<string, Readonly<Record<string, number>>>> = {
	// Three runs of `bench.ts --only server,list` (5 rounds) and A and A′ of `bench-gate.ts --only server,list` (12 rounds,
	// 6 shards): idle 48.6, 49.5, 48.5, 48.3, 48.1; listing 74.2, 67.9, 66.6, 74.2, 66.7.
	"server,list": { "server.idle.footprint_mb": 49.52, "server.list.footprint_mb": 74.21 },
	// A and A′ of `bench-gate.ts` with its defaults (every scenario, 12 rounds, 6 shards): idle 58.6, 61.1; listing 76.5, 73.0.
	"server,load,list,switch,long,stream": { "server.idle.footprint_mb": 61.06, "server.list.footprint_mb": 76.52 },
};
/** How far over its baseline a footprint may go. */
export const FOOTPRINT_HEADROOM = 1.05;

export interface OverBudget {
	metric: string;
	medianMb: number;
	budgetMb: number;
}

/**
 * The footprint metrics of `report` whose median is over its budget (its scenarios' `FOOTPRINT_BASELINE_MB` ×
 * `FOOTPRINT_HEADROOM`), or why the budgets do not apply: not macOS, or no baseline for those scenarios. A metric the
 * report does not have is not over: `labelsWithoutFootprint` says so.
 */
export function overFootprintBudget(
	report: Pick<Report, "metrics" | "conditions">,
	platform: string,
): { over: OverBudget[] } | { notApplied: string } {
	if (platform !== "darwin") return { notApplied: `the budgets are macOS \`footprint\` numbers (this is ${platform})` };
	const scenarios = String(report.conditions.scenarios ?? "");
	const baseline = FOOTPRINT_BASELINE_MB[scenarios];
	if (!baseline) {
		const known = Object.keys(FOOTPRINT_BASELINE_MB).map((s) => `\`${s}\``);
		return {
			notApplied: `v0.13.0 was measured with the scenarios ${known.join(" and ")}, not with \`${scenarios || "(not recorded)"}\``,
		};
	}
	return {
		over: Object.entries(baseline)
			.map(([metric, mb]) => ({
				metric,
				medianMb: report.metrics[metric]?.median ?? 0,
				budgetMb: mb * FOOTPRINT_HEADROOM,
			}))
			.filter((o) => o.medianMb > o.budgetMb),
	};
}

/**
 * Unusable reports first (no verdict at all), then a regression (B worse than A or A′, or over its footprint budget),
 * then a drifting baseline. Else a pass only when the runs were not provisional and every report carries the footprint
 * (`memoryGated`): a comparison that did not gate on memory, or a run made on a machine that was not quiet, is
 * `provisionalPass`, not evidence.
 */
export function gateExitCode(
	c: GateComparisons,
	{ provisionalRuns, memoryGated, overBudget }: { provisionalRuns: boolean; memoryGated: boolean; overBudget: boolean },
): number {
	if ([c.ab, c.aa2, c.a2b].some((x) => x >= 3)) return GATE_EXIT.unusable;
	if (c.ab === 1 || c.a2b === 1 || overBudget) return GATE_EXIT.regression;
	if (c.aa2 === 1) return GATE_EXIT.drift;
	return provisionalRuns || !memoryGated ? GATE_EXIT.provisionalPass : GATE_EXIT.pass;
}
