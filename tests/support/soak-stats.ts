/**
 * What the soak harness (scripts/soak.ts) measures with and reports from: process tables, file descriptors, the
 * growth fit of a series and the markdown report. Pure functions of text and numbers, so they can be checked without
 * a server, a browser or a model.
 */

// ------------------------------------------------------------------ processes

export interface ProcRow {
	pid: number;
	ppid: number;
	stat: string;
	rssKb: number;
	/** CPU seconds used so far (user + system). */
	cpuSec: number;
	command: string;
}

/** `ps` TIME as seconds: `M:SS.hh` (macOS), `[[dd-]hh:]mm:ss` (Linux). */
export function cpuSeconds(text: string): number {
	let rest = text.trim();
	let days = 0;
	const dash = rest.indexOf("-");
	if (dash >= 0) {
		days = Number(rest.slice(0, dash));
		rest = rest.slice(dash + 1);
	}
	const parts = rest.split(":").map(Number);
	let seconds = 0;
	for (const part of parts) seconds = seconds * 60 + (Number.isFinite(part) ? part : 0);
	return days * 86400 + seconds;
}

/** The output of `ps -A -ww -o pid=,ppid=,stat=,rss=,time=,command=`. */
export function parsePs(out: string): ProcRow[] {
	const rows: ProcRow[] = [];
	for (const line of out.split("\n")) {
		const m = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line);
		if (!m) continue;
		rows.push({
			pid: Number(m[1]),
			ppid: Number(m[2]),
			stat: m[3],
			rssKb: Number(m[4]),
			cpuSec: cpuSeconds(m[5]),
			command: m[6],
		});
	}
	return rows;
}

/** Every process below `root` (children, their children, …), `root` itself not included. */
export function descendants(rows: ProcRow[], root: number): ProcRow[] {
	const kids = new Map<number, ProcRow[]>();
	for (const r of rows) {
		const list = kids.get(r.ppid);
		if (list) list.push(r);
		else kids.set(r.ppid, [r]);
	}
	const out: ProcRow[] = [];
	const seen = new Set<number>([root]);
	const queue = [root];
	while (queue.length) {
		for (const child of kids.get(queue.shift() as number) ?? []) {
			if (seen.has(child.pid)) continue;
			seen.add(child.pid);
			out.push(child);
			queue.push(child.pid);
		}
	}
	return out;
}

export type ProcKind = "relay" | "omp" | "other";

/**
 * What a process below the server is: a relay (`--ompw-relay`, which carries omp's command line as its own arguments,
 * so it is told first), an omp conversation (the binary itself, started with `--mode rpc…`), or anything else (a tool's
 * shell, a language server, a short-lived `omp stats`).
 */
export function kindOf(command: string): ProcKind {
	if (command.includes("--ompw-relay")) return "relay";
	if (/^(\S*\/)?omp\s.*--mode\s+rpc/.test(command)) return "omp";
	return "other";
}

/** A zombie: ended, and its parent has not collected it. */
export const isZombie = (r: ProcRow): boolean => r.stat.startsWith("Z");

// ------------------------------------------------------------------ file descriptors

export interface Fds {
	total: number;
	sockets: number;
	pipes: number;
	files: number;
	/** TCP connections in state ESTABLISHED (the page's WebSocket and its HTTP connections). */
	established: number;
}

/**
 * The descriptors in `lsof -nP -p <pid>`: only numbered ones (`cwd`, `txt` and the mapped libraries are no
 * descriptors), told apart by TYPE.
 */
export function parseLsof(out: string): Fds {
	const fds: Fds = { total: 0, sockets: 0, pipes: 0, files: 0, established: 0 };
	for (const line of out.split("\n").slice(1)) {
		const cols = line.trim().split(/\s+/);
		if (cols.length < 5 || !/^\d+[a-zA-Z]?$/.test(cols[3])) continue;
		fds.total++;
		const type = cols[4];
		if (type === "IPv4" || type === "IPv6" || type === "unix" || type === "sock") fds.sockets++;
		else if (type === "PIPE" || type === "FIFO") fds.pipes++;
		else fds.files++;
		if (line.includes("(ESTABLISHED)")) fds.established++;
	}
	return fds;
}

// ------------------------------------------------------------------ growth

export interface Fit {
	n: number;
	/** y per x. */
	slope: number;
	/** Standard error of the slope (0 for fewer than three points). */
	se: number;
}

/** An ordinary least-squares line through (x, y). */
export function linearFit(xs: number[], ys: number[]): Fit {
	const n = xs.length;
	if (n < 2) return { n, slope: 0, se: 0 };
	const mx = xs.reduce((a, b) => a + b, 0) / n;
	const my = ys.reduce((a, b) => a + b, 0) / n;
	let sxx = 0;
	let sxy = 0;
	for (let i = 0; i < n; i++) {
		sxx += (xs[i] - mx) ** 2;
		sxy += (xs[i] - mx) * (ys[i] - my);
	}
	if (sxx === 0) return { n, slope: 0, se: 0 };
	const slope = sxy / sxx;
	let rss = 0;
	for (let i = 0; i < n; i++) rss += (ys[i] - (my + slope * (xs[i] - mx))) ** 2;
	return { n, slope, se: n > 2 ? Math.sqrt(rss / (n - 2) / sxx) : 0 };
}

export const percentile = (xs: number[], p: number): number => {
	if (!xs.length) return 0;
	const sorted = [...xs].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

export interface MetricSpec {
	key: string;
	label: string;
	unit: string;
	/**
	 * What growth per hour is tolerated, as the larger of an absolute amount and a share of the metric's mean over the
	 * window. Absent: reported, not graded (a counter, or a load figure that says nothing about leaks).
	 */
	tol?: { abs: number; rel: number };
	/** A cumulative count: shown by its last value, and any increase is an event worth reading, not a slope. */
	counter?: boolean;
	digits?: number;
	/**
	 * The noise only goes one way (a view that was just left stays referenced until the next one is left, so a sample
	 * can read high but never low): the line is fitted to the smallest of every three consecutive samples.
	 */
	floor?: boolean;
}

export const METRICS: MetricSpec[] = [
	{ key: "serverRssMb", label: "Server RSS", unit: "MB", tol: { abs: 8, rel: 0.02 }, digits: 1 },
	{ key: "serverCpuPct", label: "Server CPU", unit: "%", digits: 1 },
	{ key: "serverFds", label: "Server open file descriptors", unit: "", tol: { abs: 3, rel: 0.02 } },
	{ key: "serverSockets", label: "Server sockets (descriptors)", unit: "", tol: { abs: 3, rel: 0.02 } },
	{ key: "serverPipes", label: "Server pipes (descriptors)", unit: "", tol: { abs: 3, rel: 0.02 } },
	{ key: "serverFiles", label: "Server regular files (descriptors)", unit: "", tol: { abs: 3, rel: 0.02 } },
	{ key: "serverEstablished", label: "Server TCP connections (ESTABLISHED)", unit: "", tol: { abs: 2, rel: 0.1 } },
	{ key: "ompProcs", label: "omp conversation processes", unit: "", tol: { abs: 0.5, rel: 0.1 } },
	{ key: "relayProcs", label: "Relay processes", unit: "", tol: { abs: 0.5, rel: 0.1 } },
	{ key: "otherProcs", label: "Other descendants (tool shells, helpers)", unit: "", tol: { abs: 1, rel: 0.2 } },
	{ key: "zombies", label: "Zombie descendants", unit: "", tol: { abs: 0.5, rel: 0 } },
	{ key: "strays", label: "Strays (the run's processes outside the server's tree)", unit: "", tol: { abs: 0, rel: 0 } },
	{ key: "treeRssMb", label: "RSS of all descendants", unit: "MB", tol: { abs: 40, rel: 0.05 }, digits: 1 },
	{ key: "treeCpuPct", label: "CPU of all descendants", unit: "%", digits: 1 },
	{ key: "livesOpen", label: "Live conversations the server counts", unit: "", tol: { abs: 0.5, rel: 0.1 } },
	{ key: "apiMs", label: "Server answer time (/api/meta)", unit: "ms", tol: { abs: 10, rel: 0.25 }, digits: 1 },
	{
		key: "heapMb",
		label: "Page JS heap (after GC, on the Settings page)",
		unit: "MB",
		tol: { abs: 10, rel: 0.05 },
		digits: 1,
	},
	{ key: "domNodes", label: "Page DOM elements (on the Settings page)", unit: "", tol: { abs: 500, rel: 0.05 } },
	{
		key: "cdpNodes",
		label: "Page DOM nodes (all kinds, after GC)",
		unit: "",
		tol: { abs: 500, rel: 0.05 },
		floor: true,
	},
	{
		key: "detachedNodes",
		label: "Page DOM nodes kept alive while detached",
		unit: "",
		tol: { abs: 200, rel: 0.1 },
		floor: true,
	},
	{ key: "listeners", label: "Page event listeners", unit: "", tol: { abs: 100, rel: 0.05 }, floor: true },
	{ key: "domShown", label: "Page DOM elements (as the user left the view)", unit: "" },
	{ key: "load1", label: "Host load average (1 min)", unit: "", digits: 2 },
	{
		key: "wsMb",
		label: "WebSocket data received by the page (cumulative; compare with the heap)",
		unit: "MB",
		digits: 2,
	},
	{ key: "evalMs", label: "Page round trip (page.evaluate)", unit: "ms", tol: { abs: 20, rel: 0.25 }, digits: 1 },
	{ key: "clickMs", label: "UI click until the DOM shows it", unit: "ms", tol: { abs: 20, rel: 0.25 }, digits: 1 },
	{ key: "longTasks", label: "Long tasks (>50 ms) in the interval", unit: "" },
	{ key: "longTaskMaxMs", label: "Longest task in the interval", unit: "ms" },
	{ key: "wsPending", label: "WebSocket requests unanswered for >10 s", unit: "", tol: { abs: 0.5, rel: 0 } },
	{ key: "wsReconnects", label: "WebSocket reconnects", unit: "", counter: true },
	{ key: "pageErrors", label: "Page errors (uncaught)", unit: "", counter: true },
	{ key: "consoleErrors", label: "Page console errors", unit: "", counter: true },
	{ key: "serverErrors", label: "Server error lines (stderr)", unit: "", counter: true },
	{ key: "uiFailures", label: "Harness UI actions that failed", unit: "", counter: true },
];

export interface Sample {
	/** Seconds since the load started. */
	t: number;
	iso?: string;
	[key: string]: number | string | null | undefined;
}

export type Status = "no sustained growth" | "GROWTH" | "growth? (noisy)" | "n/a";

export interface Graded {
	spec: MetricSpec;
	start: number | null;
	end: number | null;
	max: number | null;
	mean: number | null;
	/** Per hour, over the window; null when there are too few samples. */
	slope: number | null;
	se: number | null;
	tol: number | null;
	status: Status;
}

/** The slope window: the last hour, or the last third of a run shorter than three hours. */
export const windowSeconds = (runSeconds: number): number => Math.min(3600, runSeconds / 3);

/** Each value replaced by the smallest of itself and the `width - 1` before it. */
const rollingMin = (xs: number[], width: number): number[] =>
	xs.map((_, i) => Math.min(...xs.slice(Math.max(0, i - width + 1), i + 1)));

export function grade(spec: MetricSpec, samples: Sample[], runSeconds: number): Graded {
	const valued = samples.filter((s) => typeof s[spec.key] === "number" && Number.isFinite(s[spec.key] as number));
	const values = valued.map((s) => s[spec.key] as number);
	const base: Graded = {
		spec,
		start: values[0] ?? null,
		end: values.at(-1) ?? null,
		max: values.length ? Math.max(...values) : null,
		mean: null,
		slope: null,
		se: null,
		tol: null,
		status: "n/a",
	};
	if (spec.counter || !values.length) return base;
	const smooth = spec.floor ? rollingMin(values, 3) : values;
	const pts = valued.map((s, i) => ({ t: s.t, y: smooth[i] }));
	const from = (pts.at(-1)?.t ?? 0) - windowSeconds(runSeconds);
	const inWindow = pts.filter((p) => p.t >= from);
	if (inWindow.length < 4) return base;
	const ys = inWindow.map((p) => p.y);
	const fit = linearFit(
		inWindow.map((p) => p.t / 3600),
		ys,
	);
	const mean = ys.reduce((a, b) => a + b, 0) / ys.length;
	base.mean = mean;
	base.slope = fit.slope;
	base.se = fit.se;
	if (!spec.tol) return base;
	const tol = Math.max(spec.tol.abs, spec.tol.rel * Math.abs(mean));
	base.tol = tol;
	// Within a window shorter than an hour, a count that rose by less than two whole units has not risen: one more
	// descriptor or connection at one sample is not a trend, however steep the line through it looks per hour.
	const spanH = ((inWindow.at(-1)?.t ?? 0) - inWindow[0].t) / 3600;
	if (spanH < 1 && ys.every(Number.isInteger) && fit.slope * spanH < 2) {
		base.status = "no sustained growth";
		return base;
	}
	if (fit.slope <= tol) base.status = "no sustained growth";
	else base.status = fit.slope - 2 * fit.se > tol ? "GROWTH" : "growth? (noisy)";
	return base;
}

// ------------------------------------------------------------------ series files

/** The columns of series.csv: the time, every graded metric, then what the harness adds (`extraKeys`). */
export function toCsv(samples: Sample[], extraKeys: string[]): string {
	const keys = ["t", "iso", ...METRICS.map((m) => m.key), ...extraKeys];
	const rows = [keys.join(",")];
	for (const s of samples) rows.push(keys.map((k) => csvCell(s[k])).join(","));
	return `${rows.join("\n")}\n`;
}

function csvCell(v: unknown): string {
	if (v === null || v === undefined) return "";
	if (typeof v === "number") return Number.isInteger(v) ? String(v) : v.toFixed(2);
	const s = String(v);
	return /[",\n]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

// ------------------------------------------------------------------ report

export type EventKind = "crash" | "hang" | "error" | "warn" | "info";

export interface SoakEvent {
	/** Seconds since the run started. */
	t: number;
	kind: EventKind;
	message: string;
}

export interface Latency {
	name: string;
	/** What it measures, for the report. */
	what: string;
	points: { t: number; ms: number }[];
}

export interface PowerEvent {
	at: string;
	kind: "Sleep" | "Wake" | "DarkWake";
	text: string;
}

export interface PowerCheck {
	from: string;
	to: string;
	/** Whether the harness held the machine awake (`caffeinate -dimsu`) and for how long it did. */
	caffeinate: string;
	events: PowerEvent[];
	/** Why the log could not tell (then sleep is not ruled out). */
	error?: string;
}

const PMSET_LINE = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-])(\d{2})(\d{2})\s+(.*)$/;
/** The event type is a column padded to a tab: `Wake Requests` (a schedule) and `WakeTime` are other types. */
const POWER_EVENT = /^(Sleep|Wake|DarkWake) *\t(.*)$/;

/**
 * The Sleep, Wake and DarkWake lines of `pmset -g log` that fall between `from` and `to` (epoch ms); `lines` counts
 * every line of the log that has a time, so that an empty answer can be told from a log that said nothing.
 */
export function parsePmsetLog(out: string, from: number, to: number): { events: PowerEvent[]; lines: number } {
	const events: PowerEvent[] = [];
	let lines = 0;
	for (const line of out.split("\n")) {
		const m = PMSET_LINE.exec(line);
		if (!m) continue;
		lines++;
		const e = POWER_EVENT.exec(m[6]);
		if (!e) continue;
		const ms = Date.parse(`${m[1]}T${m[2]}${m[3]}${m[4]}:${m[5]}`);
		if (!Number.isFinite(ms) || ms < from || ms > to) continue;
		events.push({
			at: new Date(ms).toISOString(),
			kind: e[1] as PowerEvent["kind"],
			text: e[2].replace(/\s+/g, " ").trim().slice(0, 160),
		});
	}
	return { events, lines };
}

export interface ReportInput {
	label: string;
	params: Record<string, string | number | boolean>;
	versions: Record<string, string>;
	startedAt: string;
	/** Seconds the load actually ran (the last sample's t). */
	runSeconds: number;
	plannedSeconds: number;
	endReason: string;
	samples: Sample[];
	events: SoakEvent[];
	latencies: Latency[];
	activity: Record<string, number | string>;
	cleanup: string[];
	inProgress: boolean;
	/** Distinct messages with their counts from the page and the server, for the findings. */
	errorSummary: { source: string; message: string; count: number }[];
	/** What `pmset -g log` says of sleep during the run; null while the run is in progress. */
	power: PowerCheck | null;
}

const fmt = (v: number | null, digits = 0): string =>
	v === null ? "–" : Math.abs(v) >= 1000 && digits === 0 ? Math.round(v).toLocaleString("en-US") : v.toFixed(digits);

const signed = (v: number | null, digits: number): string =>
	v === null ? "–" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)}`;

const minutes = (s: number): string => `${(s / 60).toFixed(1)} min`;

export interface Verdict {
	line: string;
	failures: string[];
	growth: string[];
	noisy: string[];
	graded: Graded[];
	/** The machine slept while the run was going: its timings and its slopes mean nothing. */
	invalid: boolean;
	/** Under an hour: the slope window is minutes, so the slopes are extrapolations and say nothing about growth. */
	short: boolean;
}

export function verdictOf(input: ReportInput): Verdict {
	const graded = METRICS.map((m) => grade(m, input.samples, input.runSeconds));
	const failures = input.events.filter((e) => e.kind === "crash" || e.kind === "hang").map((e) => e.message);
	const growth = graded.filter((g) => g.status === "GROWTH").map((g) => g.spec.label.trim());
	const noisy = graded.filter((g) => g.status === "growth? (noisy)").map((g) => g.spec.label.trim());
	const invalid = (input.power?.events.length ?? 0) > 0;
	const short = input.runSeconds < 3600;
	const rising = [...growth, ...noisy];
	let line: string;
	if (failures.length)
		line = `FAIL — ${failures.length} crash/hang event(s)${rising.length ? `, rising in ${rising.join("; ")}` : ""}`;
	else if (short)
		line = `no verdict on growth from a short run (${minutes(input.runSeconds)}; its slope window is ${minutes(windowSeconds(input.runSeconds))}, extrapolated to an hour) — ${rising.length ? `rising beyond tolerance in that window: ${rising.join("; ")}` : "nothing rose beyond tolerance in that window"}; no crash, no hang`;
	else if (growth.length) line = `GROWTH — ${growth.join("; ")}`;
	else if (noisy.length) line = `inconclusive — possible growth (noisy): ${noisy.join("; ")}`;
	else line = "no sustained growth";
	if (invalid) line = `INVALID RUN (the machine slept during it) — ${line}`;
	return { line, failures, growth, noisy, graded, invalid, short };
}

export function renderReport(input: ReportInput): string {
	const v = verdictOf(input);
	const window = windowSeconds(input.runSeconds);
	const out: string[] = [];
	out.push(`# Soak report: ${input.label}${input.inProgress ? " (run in progress)" : ""}`, "");
	out.push(`**Verdict: ${v.line}**`, "");
	out.push(
		`Ran ${minutes(input.runSeconds)} of ${minutes(input.plannedSeconds)} planned (${input.endReason}); started ${input.startedAt}. ` +
			`Slopes are over the last ${minutes(window)} (the last hour, or the last third of a run shorter than three hours).`,
		"",
	);
	out.push("## Run", "");
	out.push("| | |", "|---|---|");
	for (const [k, val] of Object.entries(input.versions)) out.push(`| ${k} | ${val} |`);
	for (const [k, val] of Object.entries(input.params)) out.push(`| ${k} | ${val} |`);
	out.push("");
	out.push("## Metrics", "");
	out.push(
		"| Metric | Start | End | Max | Slope /h (window) | Tolerance /h | Verdict |",
		"|---|---:|---:|---:|---:|---:|---|",
	);
	for (const g of v.graded) {
		const d = g.spec.digits ?? 0;
		const unit = g.spec.unit ? ` ${g.spec.unit}` : "";
		if (g.spec.counter) {
			out.push(
				`| ${g.spec.label} | ${fmt(g.start, d)} | ${fmt(g.end, d)}${unit} | ${fmt(g.max, d)} | – | – | ${g.end ? "see Events" : "none"} |`,
			);
			continue;
		}
		out.push(
			`| ${g.spec.label} | ${fmt(g.start, d)}${unit} | ${fmt(g.end, d)}${unit} | ${fmt(g.max, d)}${unit} | ${signed(g.slope, Math.max(d, 1))}${g.se !== null && g.slope !== null ? ` ±${(2 * g.se).toFixed(Math.max(d, 1))}` : ""} | ${g.tol === null ? "–" : `${g.tol.toFixed(Math.max(d, 1))}`} | ${g.spec.tol ? g.status : "not graded"} |`,
		);
	}
	out.push("");
	out.push(
		"Tolerance = the larger of an absolute amount and a share of the window's mean, per hour; `±` is twice the slope's standard error. " +
			"**no sustained growth**: slope within tolerance. **GROWTH**: slope above tolerance and the excess is more than twice its standard error. " +
			"**growth? (noisy)**: above tolerance, but not clearly. The page figures are taken on the Settings page after a garbage collection, so what the user happened to be looking at does not move them; they still include what the page keeps for the conversations it has opened, so growth there that follows the conversations opened is content, not a leak (detached nodes and event listeners are not content). Descendant RSS follows the omp processes alive at the time.",
		"",
	);
	out.push("## Activity", "");
	out.push("| | |", "|---|---|");
	for (const [k, val] of Object.entries(input.activity)) out.push(`| ${k} | ${val} |`);
	out.push("");
	if (input.latencies.some((l) => l.points.length)) {
		out.push("## Latencies (host ms)", "");
		out.push(
			"| Action | n | median | p95 | max | median, first third | median, last third |",
			"|---|---:|---:|---:|---:|---:|---:|",
		);
		for (const l of input.latencies) {
			if (!l.points.length) continue;
			const all = l.points.map((p) => p.ms);
			const cut1 = input.runSeconds / 3;
			const cut2 = (2 * input.runSeconds) / 3;
			const first = l.points.filter((p) => p.t < cut1).map((p) => p.ms);
			const last = l.points.filter((p) => p.t >= cut2).map((p) => p.ms);
			out.push(
				`| ${l.what} | ${all.length} | ${Math.round(percentile(all, 50))} | ${Math.round(percentile(all, 95))} | ${Math.round(Math.max(...all))} | ${first.length ? Math.round(percentile(first, 50)) : "–"} | ${last.length ? Math.round(percentile(last, 50)) : "–"} |`,
			);
		}
		out.push("");
	}
	if (input.power) {
		const p = input.power;
		out.push("## Power", "");
		out.push(`- keep-awake: ${p.caffeinate}`);
		if (p.error) out.push(`- **sleep could not be ruled out**: ${p.error}`);
		else if (!p.events.length)
			out.push(
				`- no Sleep, Wake or DarkWake event in \`pmset -g log\` between ${p.from} and ${p.to}: the run did not span a sleep`,
			);
		else {
			out.push(`- **the run spans a sleep, so it is invalid** (\`pmset -g log\` between ${p.from} and ${p.to}):`);
			for (const e of p.events) out.push(`  - ${e.at} ${e.kind}: ${e.text}`);
		}
		out.push("");
	}
	out.push("## Events", "");
	const notable = input.events.filter((e) => e.kind !== "info");
	if (!notable.length) out.push("No crash, hang, error or warning.", "");
	else {
		out.push("| t | kind | what |", "|---:|---|---|");
		for (const e of notable.slice(0, 120))
			out.push(`| ${minutes(e.t)} | ${e.kind} | ${e.message.replaceAll("|", "\\|").replaceAll("\n", " ")} |`);
		if (notable.length > 120) out.push(`| | | … and ${notable.length - 120} more (series.json) |`);
		out.push("");
	}
	if (input.errorSummary.length) {
		out.push("### Distinct errors", "", "| Source | Count | Message |", "|---|---:|---|");
		for (const e of input.errorSummary.slice(0, 30))
			out.push(
				`| ${e.source} | ${e.count} | ${e.message.slice(0, 300).replaceAll("|", "\\|").replaceAll("\n", " ")} |`,
			);
		out.push("");
	}
	if (input.cleanup.length) {
		out.push("## Cleanup", "");
		for (const c of input.cleanup) out.push(`- ${c}`);
		out.push("");
	}
	return `${out.join("\n")}\n`;
}
