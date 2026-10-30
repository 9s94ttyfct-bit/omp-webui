/**
 * What `scripts/bench.ts` does with its numbers: summaries of the runs of a metric, and the comparison of two reports.
 * Pure functions, no I/O.
 */

export interface MetricDef {
	unit: string;
	/** Which way is an improvement. */
	better: "lower" | "higher";
	/** The smallest change in the median that counts, in `unit`: below it a percentage of a tiny number is not a finding. */
	floor: number;
}

export interface MetricSummary extends MetricDef {
	/** One value per measured round, in order. */
	values: number[];
	n: number;
	median: number;
	p90: number;
	min: number;
	max: number;
	/** Interquartile range over the median, in percent: how far the runs of this metric spread. */
	iqrPct: number;
	/** (max - min) over the median, in percent. */
	rangePct: number;
}

export interface Report {
	schema: 1;
	label: string;
	createdAt: string;
	version: string;
	commit: string;
	rounds: number;
	warmup: number;
	machine: Record<string, unknown>;
	/** Sleep/wake events of the power log inside the run, and how the Mac was kept awake. */
	power: { caffeinate: string; events: { at: string; event: string; detail: string }[] };
	/** False when the machine slept or woke inside the run: the numbers are not comparable. */
	valid: boolean;
	/** True when something was off (a loaded machine, battery power, a CPU shared with other work): not a baseline. */
	provisional: boolean;
	caveats: string[];
	/** The slowest fixed-CPU-work calibration of the run over the fastest, in percent: how much other work shared the CPU. */
	calibrationSpreadPct: number;
	conditions: Record<string, unknown>;
	fixtures: Record<string, unknown>;
	/** Per round: load average and a calibration of CPU speed taken around it, and what failed in it. */
	roundInfo: Record<string, unknown>[];
	runtimeSeconds: number;
	metrics: Record<string, MetricSummary>;
}

/** The `q` quantile (0..1) of `values`, interpolated between neighbours. */
export function quantile(values: readonly number[], q: number): number {
	if (values.length === 0) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	const at = (sorted.length - 1) * q;
	const lo = Math.floor(at);
	const hi = Math.ceil(at);
	return sorted[lo] + (sorted[hi] - sorted[lo]) * (at - lo);
}

export function summarize(def: MetricDef, values: number[]): MetricSummary {
	const median = quantile(values, 0.5);
	const pct = (x: number) => (median === 0 ? 0 : (x / Math.abs(median)) * 100);
	const min = Math.min(...values);
	const max = Math.max(...values);
	return {
		...def,
		values,
		n: values.length,
		median,
		p90: quantile(values, 0.9),
		min,
		max,
		iqrPct: pct(quantile(values, 0.75) - quantile(values, 0.25)),
		rangePct: pct(max - min),
	};
}

/**
 * The server's memory the way the system charges it, in bytes, from `footprint -p <pid> --noCategories --format bytes`
 * (macOS): the "Footprint:" total (`phys_footprint`: dirty, swapped and compressed pages, without what the kernel keeps
 * for the process after it freed it). `ps` RSS counts those freed-but-unreclaimed pages (`MADV_FREE_REUSABLE`) and so
 * moves with memory pressure and with what ran before. Also reads the default (formatted) output ("887 MB"). Null when
 * the text has no total.
 */
export function parseFootprintBytes(text: string): number | null {
	const m = /Footprint:\s*([\d.]+)\s*(B|KB|MB|GB|TB)\b/.exec(text);
	if (!m) return null;
	const unit = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[m[2] as "B"];
	const bytes = Number(m[1]) * unit;
	return Number.isFinite(bytes) ? Math.round(bytes) : null;
}

/** The proportional set size in kB from `/proc/<pid>/smaps_rollup` (Linux: shared pages divided among their users). Null when there is no "Pss:" line. */
export function parseSmapsRollupPssKb(text: string): number | null {
	const m = /^Pss:\s+(\d+)\s+kB$/m.exec(text);
	return m ? Number(m[1]) : null;
}

/** The metrics that are the memory gate: the server's footprint (not its `ps` RSS). */
export const isFootprintMetric = (name: string): boolean => /^server\.\w+\.footprint(Peak)?_mb$/.test(name);

/** The server's `ps` RSS: shown in a comparison, never counted as worse (it keeps freed pages on macOS). */
export const isInformationalMetric = (name: string): boolean => /^server\.\w+\.rss(Peak)?_mb$/.test(name);

/** Which of the two reports carry footprint metrics: without them in both, the memory gate cannot be applied. */
export function footprintCoverage(a: Report, b: Report): { a: boolean; b: boolean } {
	const has = (r: Report) => Object.keys(r.metrics).some(isFootprintMetric);
	return { a: has(a), b: has(b) };
}

export type Verdict = "worse" | "better" | "same" | "noise" | "missing";

/**
 * A change has to be this many times the larger interquartile range of the metric's rounds to count. The medians of two
 * runs of five rounds each differ by about 0.6 of the interquartile range by chance alone (1 s.d.), so 1.5 is about
 * 2.7 s.d.: a handful of noisy metrics among seventy do not give a false alarm in every comparison of identical code.
 */
export const SPREAD_MARGIN = 1.5;

export interface CompareRow {
	name: string;
	unit: string;
	a: MetricSummary | null;
	b: MetricSummary | null;
	/** Change of the median, percent of A's. */
	changePct: number | null;
	/** What the change had to exceed to count (percent), before the spread of the runs is looked at. */
	thresholdPct: number;
	/** What a change had to exceed to count as more than noise (percent): `SPREAD_MARGIN` times the larger interquartile range of this metric in the two reports. */
	spreadPct: number;
	verdict: Verdict;
	/** The metric is shown but never gated (the server's `ps` RSS): a "worse" row of it does not fail the comparison. */
	informational: boolean;
}

/**
 * Compare the medians of every metric in two reports. A change counts when it is above `thresholdPct` of A's median
 * and above the metric's `floor` in its unit, and also above `SPREAD_MARGIN` times the spread of the metric's own
 * rounds (the larger interquartile range of the two reports, in percent of the median): a metric measured to be noisy
 * needs a bigger change to count, and its row says "noise" instead of marking it. "worse" is a count that moved the
 * wrong way.
 */
export function compare(a: Report, b: Report, thresholdPct = 5): CompareRow[] {
	const names = [...new Set([...Object.keys(a.metrics), ...Object.keys(b.metrics)])];
	return names.map((name) => {
		const ma = a.metrics[name] ?? null;
		const mb = b.metrics[name] ?? null;
		const def = mb ?? ma;
		const spreadPct = Math.max(ma?.iqrPct ?? 0, mb?.iqrPct ?? 0) * SPREAD_MARGIN;
		if (!ma || !mb || !def) {
			return {
				name,
				unit: def?.unit ?? "",
				a: ma,
				b: mb,
				changePct: null,
				thresholdPct,
				spreadPct,
				verdict: "missing",
				informational: isInformationalMetric(name),
			};
		}
		const delta = mb.median - ma.median;
		const changePct =
			ma.median === 0
				? delta === 0
					? 0
					: Number.POSITIVE_INFINITY * Math.sign(delta)
				: (delta / Math.abs(ma.median)) * 100;
		const beyondThreshold = Math.abs(changePct) > thresholdPct && Math.abs(delta) >= def.floor;
		const worse = def.better === "lower" ? delta > 0 : delta < 0;
		const verdict: Verdict = !beyondThreshold
			? "same"
			: Math.abs(changePct) <= spreadPct
				? "noise"
				: worse
					? "worse"
					: "better";
		return {
			name,
			unit: def.unit,
			a: ma,
			b: mb,
			changePct,
			thresholdPct,
			spreadPct,
			verdict,
			informational: isInformationalMetric(name),
		};
	});
}

export function formatNumber(x: number): string {
	if (!Number.isFinite(x)) return "n/a";
	const abs = Math.abs(x);
	return abs >= 1000 ? x.toFixed(0) : abs >= 10 ? x.toFixed(1) : x.toFixed(2);
}

/** The rows that fail a comparison: worse, beyond the noise, and not informational. */
export function gatedWorse(rows: readonly CompareRow[]): CompareRow[] {
	return rows.filter((r) => r.verdict === "worse" && !r.informational);
}

function verdictText(r: CompareRow): string {
	if (r.verdict === "worse" && r.informational)
		return `worse (> ${r.thresholdPct}%, noise bar ${r.spreadPct.toFixed(0)}%), informational: \`ps\` RSS keeps freed pages, the gate is the footprint`;
	if (r.verdict === "worse") return `**WORSE** (> ${r.thresholdPct}%, noise bar ${r.spreadPct.toFixed(0)}%)`;
	if (r.verdict === "better") return "better";
	if (r.verdict === "missing") return "missing";
	if (r.verdict === "noise")
		return `beyond ${r.thresholdPct}% but inside the noise bar (${r.spreadPct.toFixed(0)}% = ${SPREAD_MARGIN} x the runs' spread): noise`;
	return "";
}

/** The comparison as a markdown table, grouped by the first part of the metric's name; worse metrics are marked. */
export function comparisonTable(rows: CompareRow[], labelA: string, labelB: string): string {
	const out = [
		`| metric | unit | ${labelA} | ${labelB} | change | spread A / B | verdict |`,
		"| --- | --- | ---: | ---: | ---: | ---: | --- |",
	];
	let group = "";
	for (const r of rows) {
		const g = r.name.split(".")[0];
		if (g !== group) {
			group = g;
			out.push(`| **${g}** | | | | | | |`);
		}
		const change =
			r.changePct === null
				? ""
				: `${r.changePct > 0 ? "+" : ""}${Number.isFinite(r.changePct) ? r.changePct.toFixed(1) : "inf"}%`;
		const spread = r.a && r.b ? `${r.a.iqrPct.toFixed(0)}% / ${r.b.iqrPct.toFixed(0)}%` : "";
		out.push(
			`| ${r.name} | ${r.unit} | ${r.a ? formatNumber(r.a.median) : ""} | ${r.b ? formatNumber(r.b.median) : ""} | ${change} | ${spread} | ${verdictText(r)} |`,
		);
	}
	return out.join("\n");
}
