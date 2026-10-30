#!/usr/bin/env bun
/**
 * A long run of the web UI's server under the load a heavy user puts on it, with everything measured over time.
 *
 *   bun scripts/freeze/run.ts --real <a big session file> [--artifacts <its directory of subagent transcripts>]
 *        [--minutes 20] [--port 7611] [--label before] [--out <dir>] [--cpu-prof] [--keep]
 *
 * It builds an isolated agent directory in a temp dir (nothing of the real ~/.omp is touched: the session is copied, and
 * the copy is removed at the end), starts the server against it with a fake omp that streams and writes the way a busy
 * one does (omp.ts), attaches a few tabs (probe.ts), and for the whole run records, once a second:
 * the server's event-loop lag, memory and indexing work (server.ts), and what the tabs wait for: a trivial request, a
 * prompt, an abort, the session list. The result is a table, one row per minute, and the raw samples (`--out`).
 *
 * The session grows during the run (the fake omp appends to it, lines taken from the real one so their sizes are
 * real), so every size-dependent cost grows with it: that is what a long run adds over a short one.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import {
	constants,
	copyFileSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { hostEnv } from "../../tests/support/omp-env.ts";
import { removeRelayDir } from "../../tests/support/relay-dirs.ts";

const arg = (name: string, fallback?: string): string | undefined => {
	const at = process.argv.indexOf(`--${name}`);
	return at >= 0 ? process.argv[at + 1] : fallback;
};
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const realSession = arg("real");
if (!realSession)
	throw new Error(
		"usage: run.ts --real <session file> [--artifacts <dir>] [--minutes N] [--port P] [--label L] [--out DIR] [--cpu-prof] [--keep]",
	);
const artifacts = arg("artifacts");
const minutes = Number(arg("minutes", "20"));
const port = Number(arg("port", "7611"));
const label = arg("label", "run") as string;
const tabsCount = Number(arg("tabs", "2"));
const bigSubagents = Number(arg("big-subagents", "4"));
const library = Number(arg("library", "318"));
const here = import.meta.dir;
const out = arg("out") ?? join(tmpdir(), `ompw-freeze-${label}-${Date.now()}`);
mkdirSync(out, { recursive: true });

const root = mkdtempSync(join(tmpdir(), "ompw-freeze-"));
const home = join(root, "home");
const agentDir = join(home, ".omp", "agent");
const dataDir = join(root, "data");
const bucket = join(agentDir, "sessions", "-omp");
mkdirSync(bucket, { recursive: true });
mkdirSync(join(root, "bin"), { recursive: true });
const pids: number[] = [];

// ------------------------------------------------------------------ the library

let seed = 0x2545f491;
const random = (): number => {
	seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
	return seed / 2 ** 32;
};

/** `src` copied to `dst`, as a clone where the file system can (the real session is tens of MB). */
const clone = (src: string, dst: string) => copyFileSync(src, dst, constants.COPYFILE_FICLONE);

const big = join(bucket, basename(realSession));
clone(realSession, big);

// Lines of the real session that finished messages are written from, by size as they were.
const pool: string[] = [];
for (const line of readFileSync(big, "utf8").split("\n").slice(-2500)) {
	if (!line || line.length > 120_000) continue;
	if (line.includes('"role":"assistant"') || line.includes('"role":"toolResult"')) pool.push(line);
}
const poolFile = join(root, "pool.jsonl");
writeFileSync(poolFile, `${pool.slice(-400).join("\n")}\n`);

let entryCounter = 0;
/** A pool line with an id of its own, chained to `parent`. */
function entry(parent: string | null): { id: string; line: string } {
	const base = JSON.parse(pool[Math.floor(random() * pool.length)] as string) as Record<string, unknown>;
	const id = `s${(entryCounter++).toString(36)}`;
	return { id, line: JSON.stringify({ ...base, id, parentId: parent, timestamp: new Date().toISOString() }) };
}

/** A transcript of about `bytes` bytes: a header and entries from the pool. */
function transcript(file: string, bytes: number, header: boolean): void {
	const lines: string[] = [];
	let size = 0;
	let parent: string | null = null;
	if (header) {
		const id = basename(file).replace(/\.jsonl$/, "");
		const first = JSON.stringify({
			type: "session",
			version: 3,
			id,
			timestamp: new Date().toISOString(),
			cwd: "/tmp/ompw-freeze",
		});
		lines.push(first);
		size += first.length + 1;
	}
	while (size < bytes) {
		const e = entry(parent);
		parent = e.id;
		lines.push(e.line);
		size += e.line.length + 1;
	}
	writeFileSync(file, `${lines.join("\n")}\n`);
}

/** The subagents each live conversation runs, by session file name. */
const running: Record<string, string[]> = {};

// The conversation of the big session: its own subagent transcripts as the real one has them, when given.
const bigDir = big.replace(/\.jsonl$/, "");
if (artifacts && existsSync(artifacts)) {
	cloneTree(artifacts, bigDir);
	// The largest transcripts are the ones still running: a long-lived subagent is the one that has written the most.
	const sizes = readdirSync(bigDir)
		.filter((n) => n.endsWith(".jsonl") && !n.startsWith("__"))
		.map((n) => [n, statSync(join(bigDir, n)).size] as const)
		.sort((a, b) => b[1] - a[1]);
	running[basename(big)] = sizes.slice(0, bigSubagents).map(([n]) => n.replace(/\.jsonl$/, ""));
} else {
	mkdirSync(bigDir, { recursive: true });
	running[basename(big)] = Array.from({ length: bigSubagents }, (_, i) => `Worker${i}`);
	for (const id of running[basename(big)] as string[]) transcript(join(bigDir, `${id}.jsonl`), 4_000_000, true);
}

function cloneTree(from: string, to: string): void {
	mkdirSync(to, { recursive: true });
	for (const item of readdirSync(from, { withFileTypes: true })) {
		const src = join(from, item.name);
		const dst = join(to, item.name);
		if (item.isDirectory()) cloneTree(src, dst);
		else if (item.isFile() && item.name.endsWith(".jsonl")) clone(src, dst);
	}
}

// The other live conversations: mid-sized, each with two subagents of its own.
const lives = [big];
for (const [n, mb] of [14, 8, 6].entries()) {
	const file = join(bucket, `2026-10-1${n}T00-00-00-000Z_01a1000${n}-0000-7000-8000-00000000000${n}.jsonl`);
	transcript(file, mb * 1_000_000, true);
	const dir = file.replace(/\.jsonl$/, "");
	mkdirSync(dir, { recursive: true });
	running[basename(file)] = ["Reviewer", "Builder"];
	for (const id of running[basename(file)] as string[]) transcript(join(dir, `${id}.jsonl`), 1_500_000, true);
	lives.push(file);
}
// The rest of the library: small conversations, as most of a user's are.
for (let i = 0; i < library; i++) {
	const file = join(
		bucket,
		`2026-09-${String(1 + (i % 28)).padStart(2, "0")}T${String(i % 24).padStart(2, "0")}-00-00-000Z_01a2${i.toString(16).padStart(4, "0")}-0000-7000-8000-000000000000.jsonl`,
	);
	transcript(file, 20_000 + Math.floor(random() * 280_000), true);
	const at = Date.now() / 1000 - (i + 1) * 3600;
	utimesSync(file, at, at);
}

// ------------------------------------------------------------------ omp, the server, the pages

writeFileSync(
	join(root, "omp.json"),
	JSON.stringify({
		recvLog: join(out, "recv.jsonl"),
		pool: poolFile,
		deltaMs: Number(arg("delta-ms", "10")),
		entryMs: Number(arg("entry-ms", "1500")),
		turnMs: Number(arg("turn-ms", "120000")),
		subagents: running,
		subagentDeltaMs: Number(arg("subagent-delta-ms", "20")),
		subagentEntryMs: Number(arg("subagent-entry-ms", "2500")),
		subagentSnapshotBytes: Number(arg("snapshot-bytes", "0")),
		autostart: false,
		entriesPaced: flag("paced"),
	}),
);
const wrapper = join(root, "bin", "omp");
writeFileSync(wrapper, `#!/bin/sh\nFREEZE_OMP=${join(root, "omp.json")} exec bun ${join(here, "omp.ts")} "$@"\n`);
spawnSync("chmod", ["+x", wrapper]);

const token = "freeze-token";
const monitor = join(out, "monitor.jsonl");
const probeFile = join(out, "probe.jsonl");
const serverArgs = [
	...(flag("cpu-prof") ? ["--cpu-prof", "--cpu-prof-dir", out, "--cpu-prof-name", `${label}.cpuprofile`] : []),
	join(here, "server.ts"),
];
const server = spawn("bun", serverArgs, {
	env: {
		...hostEnv(),
		HOME: home,
		PI_CODING_AGENT_DIR: agentDir,
		PI_NO_TITLE: "1",
		OMP_BIN: wrapper,
		OMP_WEBUI_DATA_DIR: dataDir,
		OMP_WEBUI_PORT: String(port),
		OMP_WEBUI_TOKEN: token,
		OMP_WEBUI_UPDATE_CHECK: "off",
		FREEZE_MONITOR: monitor,
	},
	stdio: ["ignore", "inherit", "inherit"],
});
pids.push(server.pid as number);

const deadline = Date.now() + 60_000;
for (;;) {
	try {
		if ((await fetch(`http://127.0.0.1:${port}/api/meta`, { headers: { "x-omp-webui-token": token } })).ok) break;
	} catch {
		// not up yet
	}
	if (Date.now() > deadline) throw new Error("the server did not start");
	await Bun.sleep(200);
}

writeFileSync(
	join(root, "probe.json"),
	JSON.stringify({
		port,
		token,
		lives,
		tabs: tabsCount,
		seconds: minutes * 60,
		out: probeFile,
		metaMs: 250,
		promptMs: 1000,
		abortMs: 20_000,
		stateMs: 2000,
		searchMs: 30_000,
		familyMs: 120_000,
		hydrateMs: Number(arg("hydrate-s", "120")) * 1000,
	}),
);
const startedAt = Date.now();
const probe = spawn("bun", [join(here, "probe.ts")], {
	env: { ...hostEnv(), FREEZE_PROBE: join(root, "probe.json") },
	stdio: ["ignore", "inherit", "inherit"],
});
pids.push(probe.pid as number);

// `--stall <from s>:<for s>`: one more tab that is stopped (SIGSTOP) from `from` seconds into the run for `for` seconds, as a page that does not read.
const stallSpec = arg("stall");
let stallTab: ChildProcess | undefined;
if (stallSpec) {
	const [from, length] = stallSpec.split(":").map(Number) as [number, number];
	const tab = spawn("bun", [join(here, "stall.ts")], {
		env: { ...hostEnv(), FREEZE_PROBE: join(root, "probe.json") },
		stdio: ["ignore", "inherit", "inherit"],
	});
	stallTab = tab;
	pids.push(tab.pid as number);
	setTimeout(() => tab.kill("SIGSTOP"), from * 1000);
	setTimeout(() => tab.kill("SIGCONT"), (from + length) * 1000);
}

// `--dense`: a process that times a trivial request and an abort every 10 ms for the whole run (see dense.ts), for the attach windows.
let denseProbe: ChildProcess | undefined;
if (flag("dense")) {
	denseProbe = spawn("bun", [join(here, "dense.ts")], {
		env: { ...hostEnv(), FREEZE_PROBE: join(root, "probe.json") },
		stdio: ["ignore", "inherit", "inherit"],
	});
	pids.push(denseProbe.pid as number);
}

// The size of the big session at each minute: what the run made it grow to.
const sizes: number[] = [];
const sizer = setInterval(() => sizes.push(statSync(big).size), 60_000);
await once(probe, "exit");
clearInterval(sizer);
sizes.push(statSync(big).size);
stallTab?.kill("SIGCONT");

// ------------------------------------------------------------------ stop, and the table

server.kill("SIGTERM");
await Promise.race([once(server, "exit"), Bun.sleep(20_000)]);
if (server.exitCode === null) server.kill("SIGKILL");
// What the server started for this temp dir and left running (a relay that outlives it is for paused conversations only).
const left = spawnSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8" })
	.stdout.split("\n")
	.filter((l) => l.includes(root));
for (const l of left) {
	const pid = Number(l.trim().split(/\s+/)[0]);
	if (pid && pid !== process.pid) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// gone
		}
	}
}

interface Row {
	kind: string;
	at: number;
	ms?: number;
	began?: number;
	probe?: number | null;
	[key: string]: unknown;
}
const lines = <T>(file: string): T[] =>
	existsSync(file)
		? readFileSync(file, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((l) => JSON.parse(l) as T)
		: [];
const probeRows = lines<Row>(probeFile);
type MonitorRow = Record<string, number | string | Record<string, Record<string, number>>>;
const allMonitor = lines<MonitorRow>(monitor);
const monitorRows = allMonitor.filter((r) => r.kind !== "gc");
const gcRows = allMonitor.filter((r) => r.kind === "gc");
const received = new Map(
	lines<{ probe: number | null; at: number }>(join(out, "recv.jsonl"))
		.filter((r) => r.probe !== null)
		.map((r) => [r.probe as number, r.at]),
);

const minuteOf = (t: number) => Math.floor((t - startedAt) / 60_000);
const quant = (values: number[], q: number) => {
	if (!values.length) return Number.NaN;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] as number;
};
const fmt = (n: number, digits = 0) => (Number.isFinite(n) ? n.toFixed(digits) : "-");
const rows: Record<string, string | number>[] = [];
for (let m = 0; m < minutes; m++) {
	const mon = monitorRows.filter((r) => minuteOf(r.t as number) === m);
	const pr = (kind: string) => probeRows.filter((r) => r.kind === kind && minuteOf(r.at) === m && r.ms !== undefined);
	const ms = (kind: string) => pr(kind).map((r) => r.ms as number);
	const toOmp = (kind: string) =>
		pr(kind).flatMap((r) =>
			typeof r.probe === "number" && received.has(r.probe)
				? [(received.get(r.probe) as number) - (r.began as number)]
				: [],
		);
	const lag = mon.map((r) => r.lagMax as number);
	const last = mon.at(-1) ?? {};
	const work = (last.work ?? {}) as Record<string, Record<string, number>>;
	const prev = monitorRows.filter((r) => minuteOf(r.t as number) === m - 1).at(-1)?.work as
		| Record<string, Record<string, number>>
		| undefined;
	const delta = (name: string, field: string) => (work[name]?.[field] ?? 0) - (prev?.[name]?.[field] ?? 0);
	rows.push({
		min: m + 1,
		"lag max ms": fmt(Math.max(...lag, 0)),
		"lag p99 ms": fmt(
			quant(
				mon.map((r) => r.lagP99 as number),
				0.5,
			),
			1,
		),
		"secs>100ms": lag.filter((l) => l > 100).length,
		"rss MB": fmt(((last.rss as number) ?? 0) / 1e6),
		"heap MB": fmt(((last.heapUsed as number) ?? 0) / 1e6),
		"live heap MB": fmt(
			((gcRows.filter((r) => minuteOf(r.t as number) === m).at(-1)?.heapUsed as number) ?? Number.NaN) / 1e6,
		),
		"live funcs": fmt(gcRows.filter((r) => minuteOf(r.t as number) === m).at(-1)?.functions as number),
		"meta p50/max": `${fmt(quant(ms("meta"), 0.5))}/${fmt(Math.max(...ms("meta"), 0))}`,
		"prompt reply p50/max": `${fmt(quant(ms("prompt"), 0.5))}/${fmt(Math.max(...ms("prompt"), 0))}`,
		"prompt->omp p50/max": `${fmt(quant(toOmp("prompt"), 0.5))}/${fmt(Math.max(...toOmp("prompt"), 0))}`,
		"abort->omp max": fmt(quant(toOmp("abort"), 1)),
		"sessions p50/max": `${fmt(quant(ms("sessions"), 0.5))}/${fmt(Math.max(...ms("sessions"), 0))}`,
		"frames/s": fmt(
			probeRows.filter((r) => r.kind === "rx" && minuteOf(r.at) === m).reduce((n, r) => n + (r.frames as number), 0) /
				60,
		),
		scans: delta("scan", "calls"),
		"scan s": fmt(delta("scan", "ms") / 1000, 1),
		"summ MB": fmt(delta("summarizeFile", "bytes") / 1e6, 1),
		"sub parses": delta("parse", "calls"),
		// What the index read: from where each transcript had been read to (`bytesRead`), else the whole of each, which is what a server without it reads.
		"sub MB": fmt(
			(typeof last.subBytesRead === "number"
				? last.subBytesRead -
					((monitorRows.filter((r) => minuteOf(r.t as number) === m - 1).at(-1)?.subBytesRead as number | undefined) ??
						0)
				: delta("parse", "bytes")) / 1e6,
			1,
		),
		"ws dropped": delta("wsDropped", "calls"),
		"cpu %": fmt(
			(((last.cpu as number) ?? 0) -
				((monitorRows.filter((r) => minuteOf(r.t as number) === m - 1).at(-1)?.cpu as number | undefined) ?? 0)) /
				600_000,
		),
		"ws held MB": fmt((work.wsBuffered?.bytes ?? 0) / 1e6, 1),
		"big MB": fmt((sizes[m] ?? sizes.at(-1) ?? 0) / 1e6, 1),
	});
}
const headers = Object.keys(rows[0] ?? {});
const table = [
	`| ${headers.join(" | ")} |`,
	`|${headers.map(() => "---").join("|")}|`,
	...rows.map((r) => `| ${headers.map((h) => r[h]).join(" | ")} |`),
].join("\n");
const summary = (kind: string) => {
	const v = probeRows.filter((r) => r.kind === kind && typeof r.ms === "number").map((r) => r.ms as number);
	return `${kind.padEnd(10)} n=${v.length} p50=${fmt(quant(v, 0.5), 1)} p99=${fmt(quant(v, 0.99), 1)} max=${fmt(Math.max(...v, 0), 1)} ms`;
};

/**
 * What the attaches did to everyone else (`--dense`): the dense probes (dense.ts) that began while a `get_entries` of the whole
 * conversation was out, against those that began at least 300 ms away from every attach; the server's loop lag and peak memory in
 * the seconds the attaches took, against the other seconds.
 */
function attachReport(): string[] {
	const dense = lines<Row>(join(out, "dense.jsonl"));
	const windows = probeRows
		.filter((r) => r.kind === "hydrate" && typeof r.ms === "number" && typeof r.began === "number")
		.map((r) => [r.began as number, (r.began as number) + (r.ms as number)] as const);
	if (!dense.length || !windows.length) return [];
	const during = (t: number) => windows.some(([a, b]) => t >= a && t <= b);
	const away = (t: number) => windows.every(([a, b]) => t < a - 300 || t > b + 300);
	const stats = (v: number[]) =>
		`n=${v.length} p50=${fmt(quant(v, 0.5), 1)} p99=${fmt(quant(v, 0.99), 1)} max=${fmt(quant(v, 1), 1)} ms`;
	const pick = (kind: string, inside: (t: number) => boolean) =>
		dense.filter(
			(r) => r.kind === kind && typeof r.ms === "number" && typeof r.began === "number" && inside(r.began as number),
		);
	const toOmp = (rows: Row[]) =>
		rows.flatMap((r) =>
			typeof r.probe === "number" && received.has(r.probe)
				? [(received.get(r.probe) as number) - (r.began as number)]
				: [],
		);
	const lines2: string[] = [
		`attach windows: ${windows.length} attaches of ${fmt(statSize(), 1)} MB, ${fmt(
			quant(
				windows.map(([a, b]) => b - a),
				0.5,
			),
		)} ms each (median)`,
	];
	for (const [label, rows] of [
		[
			"meta (trivial HTTP request)",
			(inside: (t: number) => boolean) => pick("meta", inside).map((r) => r.ms as number),
		],
		["abort, until its reply", (inside: (t: number) => boolean) => pick("abort", inside).map((r) => r.ms as number)],
		["abort, until omp read it", (inside: (t: number) => boolean) => toOmp(pick("abort", inside))],
	] as const) {
		lines2.push(`${`  ${label}`.padEnd(34)}during: ${stats(rows(during))}`);
		lines2.push(`${"".padEnd(34)}away:   ${stats(rows(away))}`);
	}
	const spanned = (r: MonitorRow) => windows.some(([a, b]) => (r.t as number) >= a && (r.t as number) - 1000 <= b);
	const hot = monitorRows.filter(spanned);
	const rest = monitorRows.filter((r) => !spanned(r));
	const max = (rs: MonitorRow[], key: string) => Math.max(...rs.map((r) => (r[key] as number) ?? 0), 0);
	lines2.push(
		`  server loop lag max: ${fmt(max(hot, "lagMax"))} ms in the ${hot.length} seconds with an attach, ${fmt(max(rest, "lagMax"))} ms in the other ${rest.length}`,
		`  server peak heap: ${fmt(max(hot, "peakHeap") / 1e6)} MB with an attach, ${fmt(max(rest, "peakHeap") / 1e6)} MB without; peak rss ${fmt(max(hot, "peakRss") / 1e6)} / ${fmt(max(rest, "peakRss") / 1e6)} MB`,
	);
	return lines2;
}
function statSize(): number {
	const sizesOfAttach = probeRows
		.filter((r) => r.kind === "hydrate" && typeof r.bytes === "number")
		.map((r) => r.bytes as number);
	return quant(sizesOfAttach, 0.5) / 1e6;
}
const text = [
	`# ${label}: ${minutes} min, ${lives.length} live conversations, ${tabsCount} tabs, ${library + 4} sessions (big: ${fmt(statSync(realSession).size / 1e6, 1)} MB at start)`,
	"",
	table,
	"",
	...["meta", "prompt", "abort", "state", "sessions", "subagents", "search", "family"].map(summary),
	"",
	...probeRows
		.filter((r) => r.kind === "hydrate")
		.map(
			(r, i) =>
				`hydrate #${i + 1} (minute ${minuteOf(r.at) + 1}): get_entries ${r.ms === null ? "NEVER ANSWERED" : `${fmt(r.ms as number)} ms (${fmt((r.bytes as number) / 1e6, 1)} MB)`}; small commands sent with it: ${r.answered} of ${r.asked} answered`,
		),
	...(stallSpec && existsSync(join(out, "stall.json"))
		? [
				`stalled tab (${stallSpec}): ${(({ frames, gaps, lostFrames, closed }) => `${frames} frames received, ${gaps} gaps (${lostFrames} frames lost), connection closed: ${closed}`)(JSON.parse(readFileSync(join(out, "stall.json"), "utf8")))}`,
			]
		: []),
	...attachReport(),
].join("\n");
writeFileSync(join(out, "report.md"), `${text}\n`);
console.log(text);
console.log(`\nraw samples: ${out}`);
stallTab?.kill("SIGTERM");
denseProbe?.kill("SIGTERM");

if (!flag("keep")) {
	removeRelayDir(dataDir);
	rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
