/**
 * Benchmark of the web UI against an isolated server (`bun scripts/bench.ts --help`): the numbers a performance change
 * has to move, on the same data, under the same conditions, every time. No model is called.
 *
 * What runs: a server of its own (an isolated HOME and agent directory, a fake omp that streams on a script), a library
 * generated from a fixed seed (tests/support/bench-fixtures.ts: one conversation of thousands of messages, eight of a
 * moderate size, one to stream into, 500 small ones), the built `dist/web`, and headless Chromium at 1400x900.
 *
 *   load    cold and warm navigation to the home page, until the conversation list is painted; the list's own cost
 *   switch  click a conversation in the sidebar until its last message is painted
 *   long    open a conversation of thousands of messages, scroll it, reveal all of it
 *   stream  a fake omp streams text and tool output for ~30 s; what the main thread and the paint make of it
 *   server  the server process's CPU and memory idle, listing, streaming
 *
 * One round runs every scenario once, on a freshly restarted server and a fresh browser each; rounds are repeated, so a
 * slow stretch of the machine falls on every metric alike (interleaved), and a metric's value is the median of its
 * rounds. The first round is a warm-up (indexes built, files cached) and is dropped.
 *
 *   bun scripts/bench.ts --label v0.11.7 [--runs 5] [--warmup 1] [--out docs/perf] [--only load,switch] [--shards 5]
 *   bun scripts/bench.ts --compare a.json b.json [--threshold 5]     markdown table; exit 1 if a metric got worse
 *
 * Server memory is recorded twice: `*.footprint*_mb` (macOS `footprint -p <pid>`, Linux `smaps_rollup` Pss) is the memory
 * gate; `*.rss*_mb` (`ps` RSS) is informational, because macOS keeps pages the process already freed in its RSS until
 * the kernel wants them back (it moves with memory pressure and with what ran before, not with the code).
 *
 * Build first (`bun run build`): the server serves this checkout's `dist/web`. Run it from the checkout under test.
 */
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type Browser, type BrowserContext, type CDPSession, chromium, type Page } from "playwright";
import { PREFS_SYNC_KEY } from "../shared/prefs.ts";
import {
	BENCH_SHAPE,
	type BenchConversation,
	type BenchWorld,
	seedBenchWorld,
	writeBenchOmp,
	writeStreamSession,
} from "../tests/support/bench-fixtures.ts";
import { benchRecorder, LIST_MIN_ROWS, type ScrollResult } from "../tests/support/bench-page.ts";
import {
	compare,
	comparisonTable,
	footprintCoverage,
	gatedWorse,
	type MetricDef,
	parseFootprintBytes,
	parseSmapsRollupPssKb,
	quantile,
	type Report,
	summarize,
} from "../tests/support/bench-stats.ts";
import { startTestServer, type TestServer } from "../tests/support/server.ts";

// ------------------------------------------------------------------ options
const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
};
const root = resolve(import.meta.dir, "..");

if (args.includes("--help") || args.includes("-h")) {
	console.log(
		[
			"bun scripts/bench.ts --label <name> [--runs 5] [--warmup 1] [--out docs/perf] [--only load,switch,long,stream,server] [--shards N] [--allow-load]",
			"bun scripts/bench.ts --compare <a.json> <b.json> [--threshold 5]",
			"",
			"Run `bun run build` first. Writes <out>/bench-<label>.json. --compare prints a markdown table and exits 1 when a gated metric is worse.",
			"Server memory: `server.*.footprint*_mb` (macOS `footprint -p <pid>`, Linux smaps_rollup Pss) is the memory gate; `server.*.rss*_mb` (`ps` RSS) is informational and never fails a comparison (macOS keeps freed pages in RSS). A report from before the footprint metrics is compared without them, and the comparison says the memory gate was not applied.",
			"Refuses to start when the 1-minute load average is above 3: pass --allow-load to measure anyway (the report is then marked provisional). For a comparison of two trees use `bun scripts/bench-gate.ts` (waits for a quiet machine, interleaves A/B/A').",
			"--shards N splits the rounds over N benchmark processes that run at once (each its own server, omp and browser): several cores, a fraction of the time. Compare only reports taken with the same --shards.",
		].join("\n"),
	);
	process.exit(0);
}

// ------------------------------------------------------------------ conditions: the same on every run
const VIEWPORT = { width: 1400, height: 900 };
/** One frame at 60 Hz. */
const FRAME_MS = 1000 / 60;
/** The streamed turn: 19 steps of 1.6 s with thinking, text, a tool call and its output (12 KB, streamed in 6 parts). */
const STREAM_SCRIPT = { steps: 18, stepMs: 1600, toolBytes: 12_000, toolUpdates: 6 };
/** Scrolling: px/s, and how far at most (the top of the sidebar's list or a transcript, 5 s of it). */
const SCROLL_SPEED = 4000;
const SCROLL_DISTANCE = 20_000;
const IDLE_MS = 8000;
const SETTLE_MS = 1000;
const LIST_REQUESTS = 300;
/** The order the switching scenario returns to its conversations in: a permutation of 0..7 that starts and ends elsewhere than where the first pass ended (7). */
const WARM_ORDER = [2, 5, 0, 6, 3, 7, 1, 4];
/** Above this 1-minute load average at the start (other work on the machine, before the benchmark adds its own) the numbers are not a baseline. */
const LOAD_LIMIT = 3;
/** A run is provisional when the fixed CPU calibration (a few ms of arithmetic taken between scenarios) varies more than this many percent across it. */
const CALIBRATION_SPREAD_LIMIT = 30;

// ------------------------------------------------------------------ metrics: what is measured, and which way is better
const lower = (unit: string, floor: number): MetricDef => ({ unit, better: "lower", floor });
const METRICS: Record<string, MetricDef> = {
	"load.cold.listReady_ms": lower("ms", 15),
	"load.cold.fcp_ms": lower("ms", 15),
	"load.cold.lcp_ms": lower("ms", 15),
	"load.cold.jsTransfer_kb": lower("KB", 5),
	"load.cold.jsFiles": lower("files", 1),
	"load.cold.longTask_ms": lower("ms", 20),
	"load.cold.longTaskCount": lower("tasks", 1),
	"load.cold.mainThread_ms": lower("ms", 20),
	"load.cold.script_ms": lower("ms", 20),
	"load.warm.listReady_ms": lower("ms", 15),
	"load.warm.mainThread_ms": lower("ms", 20),
	"list.api.cold_ms": lower("ms", 5),
	"list.api.full_ms": lower("ms", 2),
	"list.api.incremental_ms": lower("ms", 1),
	"list.page.transfer_kb": lower("KB", 2),
	"list.page.fetch_ms": lower("ms", 5),
	"list.page.render_ms": lower("ms", 5),
	"list.scroll.frame_p50_ms": lower("ms", 0.5),
	"list.scroll.frame_p95_ms": lower("ms", 1),
	"list.scroll.dropped_pct": lower("%", 0.5),
	"list.scroll.longTask_ms": lower("ms", 20),
	"switch.cold.median_ms": lower("ms", 5),
	"switch.cold.p90_ms": lower("ms", 5),
	"switch.cold.work_ms": lower("ms", 5),
	"switch.cold.longTask_ms": lower("ms", 10),
	"switch.warm.median_ms": lower("ms", 5),
	"switch.warm.p90_ms": lower("ms", 5),
	"switch.warm.work_ms": lower("ms", 5),
	"switch.warm.longTask_ms": lower("ms", 10),
	"long.open.total_ms": lower("ms", 10),
	"long.open.fetch_ms": lower("ms", 5),
	"long.open.transfer_kb": lower("KB", 5),
	"long.open.work_ms": lower("ms", 10),
	"long.open.longTask_ms": lower("ms", 10),
	"long.open.domNodes": lower("nodes", 50),
	"long.open.heap_mb": lower("MB", 1),
	"long.scroll.frame_p50_ms": lower("ms", 0.5),
	"long.scroll.frame_p95_ms": lower("ms", 1),
	"long.scroll.dropped_pct": lower("%", 0.5),
	"long.scroll.longTaskCount": lower("tasks", 1),
	"long.scroll.longTask_ms": lower("ms", 20),
	"long.reveal.total_ms": lower("ms", 100),
	"long.reveal.lastClick_ms": lower("ms", 10),
	"long.reveal.clicks": lower("clicks", 1),
	"long.reveal.domNodes": lower("nodes", 500),
	"long.scrollAll.frame_p50_ms": lower("ms", 0.5),
	"long.scrollAll.frame_p95_ms": lower("ms", 1),
	"long.scrollAll.dropped_pct": lower("%", 0.5),
	"long.scrollAll.longTask_ms": lower("ms", 20),
	"long.heap_mb": lower("MB", 2),
	"stream.busy_pct": lower("%", 0.5),
	"stream.script_pct": lower("%", 0.5),
	"stream.layoutStyle_pct": lower("%", 0.5),
	"stream.frame_p50_ms": lower("ms", 0.5),
	"stream.frame_p95_ms": lower("ms", 1),
	"stream.dropped_pct": lower("%", 0.5),
	"stream.longTaskCount": lower("tasks", 1),
	"stream.longTask_ms": lower("ms", 20),
	"stream.queue_p95_ms": lower("ms", 1),
	"stream.toPaint_p50_ms": lower("ms", 1),
	"stream.toPaint_p95_ms": lower("ms", 2),
	"stream.heap_mb": lower("MB", 2),
	"stream.domNodes": lower("nodes", 50),
	"idle.page.busy_pct": lower("%", 0.2),
	"server.idle.cpu_pct": lower("%", 0.3),
	"server.idle.rss_mb": lower("MB", 2),
	"server.idle.footprint_mb": lower("MB", 2),
	"server.idleConnected.cpu_pct": lower("%", 0.3),
	"server.list.cpuPerReq_ms": lower("ms", 0.5),
	"server.list.rss_mb": lower("MB", 2),
	"server.list.footprint_mb": lower("MB", 2),
	"server.long.footprint_mb": lower("MB", 2),
	"server.stream.cpu_pct": lower("%", 0.5),
	"server.stream.relayCpu_pct": lower("%", 0.5),
	"server.stream.rssPeak_mb": lower("MB", 2),
	"server.stream.footprintPeak_mb": lower("MB", 2),
};

type Samples = Record<string, number>;

// ------------------------------------------------------------------ helpers
const log = (m: string) => console.error(`[${((performance.now() - t0) / 1000).toFixed(0).padStart(5)}s] ${m}`);
const t0 = performance.now();
const median = (xs: number[]) => quantile(xs, 0.5);
const kb = (bytes: number) => bytes / 1024;
const mb = (bytes: number) => bytes / 1048576;

/** A fixed amount of CPU work, timed: how fast this machine is right now. Slower than usual means something else is using it. */
function calibrate(): number {
	const start = performance.now();
	let x = 1;
	for (let i = 0; i < 30_000_000; i++) x = (Math.imul(x, 1664525) + i) | 0;
	if (x === 42) console.error("");
	return performance.now() - start;
}

interface Proc {
	pid: number;
	ppid: number;
	rssKb: number;
	cpuSec: number;
	cmd: string;
}

const cpuSeconds = (t: string) =>
	t
		.split(":")
		.map(Number)
		.reduce((acc, p) => acc * 60 + p, 0);

function processes(): Proc[] {
	const out = execFileSync("ps", ["-axo", "pid=,ppid=,rss=,time=,command="], { encoding: "utf8", maxBuffer: 64 << 20 });
	const procs: Proc[] = [];
	for (const line of out.split("\n")) {
		const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d:.]+)\s+(.*)$/.exec(line);
		if (m) procs.push({ pid: +m[1], ppid: +m[2], rssKb: +m[3], cpuSec: cpuSeconds(m[4]), cmd: m[5] });
	}
	return procs;
}

/** The server process and what it started (the relay that hosts omp, omp): CPU seconds used so far, and the server's resident memory. */
interface ServerSample {
	at: number;
	cpuSec: number;
	rssKb: number;
	/** The server's footprint (macOS) or Pss (Linux) in kB; NaN when it was not asked for or cannot be read. */
	footprintKb: number;
	relayCpuSec: number;
}

/** Why the footprint could not be read (once each): the report says so in its caveats instead of silently lacking the metrics. */
const footprintProblems = new Set<string>();

/**
 * The server's memory the way the system charges it: macOS `footprint` (about 0.3 s a call; `--format bytes` keeps the
 * precision `formatted` rounds away), Linux `smaps_rollup` Pss. `ps` RSS is not that: it keeps pages the process freed.
 */
function readFootprintKb(pid: number): number {
	try {
		if (process.platform === "linux") {
			const pss = parseSmapsRollupPssKb(readFileSync(`/proc/${pid}/smaps_rollup`, "utf8"));
			if (pss === null) throw new Error("no Pss line in smaps_rollup");
			return pss;
		}
		const out = execFileSync("footprint", ["-p", String(pid), "--noCategories", "--format", "bytes"], {
			encoding: "utf8",
			timeout: 20_000,
			stdio: ["ignore", "pipe", "pipe"],
		});
		const bytes = parseFootprintBytes(out);
		if (bytes === null) throw new Error(`no total in the output of footprint: ${out.slice(0, 120)}`);
		return bytes / 1024;
	} catch (e) {
		footprintProblems.add(e instanceof Error ? e.message.split("\n")[0] : String(e));
		return Number.NaN;
	}
}

/** CPU and RSS from one `ps` call; with `footprint`, the server's footprint right after it (so `at` and the CPU seconds still belong together). */
function sampleServer(pid: number, { footprint = false } = {}): ServerSample {
	const at = performance.now();
	const procs = processes();
	const server = procs.find((p) => p.pid === pid);
	if (!server) throw new Error(`the server (pid ${pid}) is gone`);
	const family = new Map<number, Proc>([[pid, server]]);
	for (let grew = true; grew; ) {
		grew = false;
		for (const p of procs) {
			if (!family.has(p.pid) && family.has(p.ppid)) {
				family.set(p.pid, p);
				grew = true;
			}
		}
	}
	const relayCpuSec = [...family.values()]
		.filter((p) => p.cmd.includes("relay-main.ts"))
		.reduce((s, p) => s + p.cpuSec, 0);
	return {
		at,
		cpuSec: server.cpuSec,
		rssKb: server.rssKb,
		footprintKb: footprint ? readFootprintKb(pid) : Number.NaN,
		relayCpuSec,
	};
}

const cpuPct = (a: ServerSample, b: ServerSample, key: "cpuSec" | "relayCpuSec" = "cpuSec") =>
	((b[key] - a[key]) / ((b.at - a.at) / 1000)) * 100;

function listeningPid(port: number): number {
	const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
	const pid = Number(out.split("\n")[0]);
	if (!pid) throw new Error(`nothing listens on ${port}`);
	return pid;
}

/** Wait until the server uses under 3% of a core for two samples in a row (its index is built, its caches filled). */
async function waitQuiet(pid: number, maxMs = 60_000): Promise<number> {
	const start = performance.now();
	let quiet = 0;
	let prev = sampleServer(pid);
	while (performance.now() - start < maxMs && quiet < 2) {
		await sleep(1500);
		const cur = sampleServer(pid);
		quiet = cpuPct(prev, cur) < 3 ? quiet + 1 : 0;
		prev = cur;
	}
	return Math.round(performance.now() - start);
}

function frameStats(gaps: number[]): { p50: number; p95: number; droppedPct: number } {
	if (gaps.length === 0) return { p50: 0, p95: 0, droppedPct: 0 };
	// A gap of two frames' time is one frame the page did not show in time (or more).
	const dropped = gaps.reduce((s, g) => s + Math.max(0, Math.round(g / FRAME_MS) - 1), 0);
	return { p50: quantile(gaps, 0.5), p95: quantile(gaps, 0.95), droppedPct: (dropped / (dropped + gaps.length)) * 100 };
}

function longTasksIn(lt: { start: number; dur: number }[], from: number, to: number): { count: number; ms: number } {
	const inside = lt.filter((t) => t.start >= from && t.start <= to);
	return { count: inside.length, ms: inside.reduce((s, t) => s + t.dur, 0) };
}

// ------------------------------------------------------------------ the world
interface Ctx {
	server: TestServer;
	world: BenchWorld;
	/** The pid of the server process now listening (it changes at every restart). */
	pid: number;
	/** What the page keeps its preferences' sync marker as, so a first load does not wait for or upload preferences. */
	syncMarker: string;
	notes: string[];
	/** The same fixed arithmetic as `calibrate()`, timed inside each scenario's browser: how fast its main thread was in this scenario. */
	browserCalMs: number[];
}

const apiGet = (ctx: Ctx, path: string, headers: Record<string, string> = {}) =>
	fetch(`${ctx.server.url}${path}`, { headers: { "x-omp-webui-token": ctx.server.accessToken, ...headers } });

interface Tab {
	browser: Browser;
	context: BrowserContext;
	page: Page;
	cdp: CDPSession;
	close(): Promise<void>;
}

/** A browser of its own (so nothing is cached or compiled from an earlier scenario) on the pinned viewport, with the recorder installed. */
async function openTab(ctx: Ctx): Promise<Tab> {
	const browser = await chromium.launch({
		channel: "chromium",
		headless: true,
		args: [
			"--disable-renderer-backgrounding",
			"--disable-background-timer-throttling",
			"--disable-backgrounding-occluded-windows",
		],
	});
	const context = await browser.newContext({
		viewport: VIEWPORT,
		deviceScaleFactor: 1,
		locale: "en-US",
		timezoneId: "UTC",
		colorScheme: "dark",
	});
	await context.addCookies([
		{
			name: "ompw_token",
			value: ctx.server.accessToken,
			domain: "127.0.0.1",
			path: "/",
			httpOnly: true,
			secure: false,
			sameSite: "Strict",
		},
	]);
	await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [PREFS_SYNC_KEY, ctx.syncMarker]);
	await context.addInitScript(benchRecorder, LIST_MIN_ROWS);
	const { page, cdp } = await pageIn(context, ctx);
	const cal = await page.evaluate(() => {
		const start = performance.now();
		let x = 1;
		for (let i = 0; i < 30_000_000; i++) x = (Math.imul(x, 1664525) + i) | 0;
		return performance.now() - start + (x === 42 ? 1 : 0);
	});
	ctx.browserCalMs.push(Math.round(cal * 10) / 10);
	return { browser, context, page, cdp, close: () => browser.close().catch(() => {}) };
}

/** A page in `context` (the browser's cache is shared with its other pages), with counters of its own. */
async function pageIn(context: BrowserContext, ctx: Ctx): Promise<{ page: Page; cdp: CDPSession }> {
	const page = await context.newPage();
	page.on("pageerror", (e) => ctx.notes.push(`pageerror: ${e.message.slice(0, 200)}`));
	const cdp = await context.newCDPSession(page);
	await cdp.send("Performance.enable");
	return { page, cdp };
}

async function cdpMetrics(cdp: CDPSession): Promise<Record<string, number>> {
	const { metrics } = await cdp.send("Performance.getMetrics");
	return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
}

/** Collect garbage, then the JS heap in use: what the page keeps, not what it has not yet let go of. */
async function heapUsedMb(cdp: CDPSession): Promise<number> {
	await cdp.send("HeapProfiler.collectGarbage");
	await cdp.send("HeapProfiler.collectGarbage");
	return mb((await cdp.send("Runtime.getHeapUsage")).usedSize);
}

const domNodes = (page: Page) => page.evaluate(() => document.getElementsByTagName("*").length);

async function waitListReady(page: Page): Promise<void> {
	await page.waitForFunction(() => window.__bench.listReadyAt !== null, null, { timeout: 60_000, polling: 50 });
}

// ------------------------------------------------------------------ scenarios
/** Restart the server on the same data (the stream conversation rewritten: a run adds to it), time the first listing, wait until quiet, measure idle. */
async function scenarioServer(ctx: Ctx): Promise<Samples> {
	const out: Samples = {};
	writeStreamSession(ctx.server.agentDir, realpathSync(ctx.server.work), Math.floor(Date.now() / 1000));
	await ctx.server.restart();
	ctx.pid = listeningPid(Number(new URL(ctx.server.url).port));
	const start = performance.now();
	const first = await apiGet(ctx, "/api/sessions");
	await first.arrayBuffer();
	out["list.api.cold_ms"] = performance.now() - start;
	const quietAfter = await waitQuiet(ctx.pid);
	ctx.notes.push(`quiet after ${quietAfter} ms`);
	const a = sampleServer(ctx.pid);
	await sleep(IDLE_MS);
	const b = sampleServer(ctx.pid, { footprint: true });
	out["server.idle.cpu_pct"] = cpuPct(a, b);
	out["server.idle.rss_mb"] = b.rssKb / 1024;
	out["server.idle.footprint_mb"] = b.footprintKb / 1024;
	return out;
}

interface LoadRead {
	listReadyAt: number | null;
	fcp: number | null;
	lcp: number | null;
	jsTransfer: number;
	jsFiles: number;
	lt: { start: number; dur: number }[];
	sessions: { start: number; end: number; transfer: number } | null;
}

const readLoad = (page: Page): Promise<LoadRead> =>
	page.evaluate(() => {
		const entries = performance.getEntriesByType("resource") as PerformanceResourceTiming[];
		const js = entries.filter((e) => /\.js(\?|$)/.test(e.name));
		const sessions = entries.find((e) => /\/api\/sessions(\?|$)/.test(e.name));
		return {
			listReadyAt: window.__bench.listReadyAt,
			fcp: performance.getEntriesByName("first-contentful-paint")[0]?.startTime ?? null,
			lcp: window.__bench.lcp,
			jsTransfer: js.reduce((s, e) => s + e.transferSize, 0),
			jsFiles: js.length,
			lt: window.__bench.lt,
			sessions: sessions
				? { start: sessions.startTime, end: sessions.responseEnd, transfer: sessions.transferSize }
				: null,
		};
	});

async function scenarioLoad(ctx: Ctx): Promise<Samples> {
	const out: Samples = {};
	const tab = await openTab(ctx);
	try {
		// Cold: this browser has fetched nothing from this server.
		await tab.page.goto(ctx.server.url, { waitUntil: "load" });
		await waitListReady(tab.page);
		await sleep(SETTLE_MS);
		const cold = await readLoad(tab.page);
		const m1 = await cdpMetrics(tab.cdp);
		const ready = cold.listReadyAt ?? Number.NaN;
		const inLoad = longTasksIn(cold.lt, 0, ready + SETTLE_MS);
		out["load.cold.listReady_ms"] = ready;
		out["load.cold.fcp_ms"] = cold.fcp ?? Number.NaN;
		out["load.cold.lcp_ms"] = cold.lcp ?? Number.NaN;
		out["load.cold.jsTransfer_kb"] = kb(cold.jsTransfer);
		out["load.cold.jsFiles"] = cold.jsFiles;
		out["load.cold.longTask_ms"] = inLoad.ms;
		out["load.cold.longTaskCount"] = inLoad.count;
		out["load.cold.mainThread_ms"] = m1.TaskDuration * 1000;
		out["load.cold.script_ms"] = m1.ScriptDuration * 1000;

		// Warm: a second page of the same browser, assets from its cache: what is left is the page's own work and the list.
		await tab.page.close();
		const { page, cdp } = await pageIn(tab.context, ctx);
		await page.goto(ctx.server.url, { waitUntil: "load" });
		await waitListReady(page);
		await sleep(SETTLE_MS);
		const warm = await readLoad(page);
		const m2 = await cdpMetrics(cdp);
		out["load.warm.listReady_ms"] = warm.listReadyAt ?? Number.NaN;
		out["load.warm.mainThread_ms"] = m2.TaskDuration * 1000;
		if (warm.sessions && warm.listReadyAt !== null) {
			out["list.page.fetch_ms"] = warm.sessions.end - warm.sessions.start;
			out["list.page.render_ms"] = warm.listReadyAt - warm.sessions.end;
			out["list.page.transfer_kb"] = kb(warm.sessions.transfer);
		}

		// Connected and idle: the server's and the page's own cost of waiting.
		const s0 = sampleServer(ctx.pid);
		const p0 = await cdpMetrics(cdp);
		await sleep(IDLE_MS);
		const s1 = sampleServer(ctx.pid);
		const p1 = await cdpMetrics(cdp);
		out["server.idleConnected.cpu_pct"] = cpuPct(s0, s1);
		out["idle.page.busy_pct"] = ((p1.TaskDuration - p0.TaskDuration) / (p1.Timestamp - p0.Timestamp)) * 100;

		// The sidebar's list scrolled through.
		const scroll = await page.evaluate(
			([sel, speed]) => window.__bench.scroll(sel as string, speed as number, 1e9, 30_000),
			['[data-testid="session-list"]', SCROLL_SPEED],
		);
		const frames = frameStats(scroll.gaps);
		const lt = await page.evaluate(() => window.__bench.lt);
		const inScroll = longTasksIn(lt, scroll.startAt, scroll.endAt);
		out["list.scroll.frame_p50_ms"] = frames.p50;
		out["list.scroll.frame_p95_ms"] = frames.p95;
		out["list.scroll.dropped_pct"] = frames.droppedPct;
		out["list.scroll.longTask_ms"] = inScroll.ms;
	} finally {
		await tab.close();
	}
	return out;
}

async function scenarioListApi(ctx: Ctx): Promise<Samples> {
	const out: Samples = {};
	const full: number[] = [];
	let cursor = "";
	const s0 = sampleServer(ctx.pid);
	for (let i = 0; i < LIST_REQUESTS; i++) {
		const start = performance.now();
		const res = await apiGet(ctx, "/api/sessions");
		await res.arrayBuffer();
		full.push(performance.now() - start);
		cursor = res.headers.get("x-sessions-cursor") ?? cursor;
	}
	const s1 = sampleServer(ctx.pid, { footprint: true });
	const incremental: number[] = [];
	for (let i = 0; i < LIST_REQUESTS; i++) {
		const start = performance.now();
		const res = await apiGet(ctx, "/api/sessions", { "x-sessions-since": cursor });
		await res.arrayBuffer();
		incremental.push(performance.now() - start);
	}
	out["list.api.full_ms"] = median(full);
	out["list.api.incremental_ms"] = median(incremental);
	out["server.list.cpuPerReq_ms"] = ((s1.cpuSec - s0.cpuSec) * 1000) / LIST_REQUESTS;
	out["server.list.rss_mb"] = s1.rssKb / 1024;
	out["server.list.footprint_mb"] = s1.footprintKb / 1024;
	return out;
}

interface Visit {
	ms: number;
	work: number;
	longMs: number;
}

/** Click a conversation in the sidebar; time it to its last message painted, and the main thread's work for a second after. */
async function visit(tab: Tab, c: BenchConversation): Promise<Visit & { t0: number; painted: number }> {
	const { page, cdp } = tab;
	await page.evaluate(
		([sel, ms]) => window.__bench.arm(sel as string, ms as number),
		[`[data-entry-id="${c.lastId}"]`, 20_000],
	);
	const before = await cdpMetrics(cdp);
	await page.locator('[data-testid="session-item"]', { hasText: c.title }).first().click();
	const armed = await page.evaluate(() => window.__bench.armed);
	if (armed?.painted == null) throw new Error(`"${c.title}" did not show its last message`);
	await sleep(SETTLE_MS);
	const after = await cdpMetrics(cdp);
	const lt = await page.evaluate(() => window.__bench.lt);
	return {
		ms: armed.painted - armed.t0,
		work: (after.TaskDuration - before.TaskDuration) * 1000,
		longMs: longTasksIn(lt, armed.t0, armed.painted).ms,
		t0: armed.t0,
		painted: armed.painted,
	};
}

async function scenarioSwitch(ctx: Ctx): Promise<Samples> {
	const out: Samples = {};
	const tab = await openTab(ctx);
	try {
		await tab.page.goto(ctx.server.url, { waitUntil: "load" });
		await waitListReady(tab.page);
		await sleep(SETTLE_MS);
		const cold: Visit[] = [];
		for (const c of ctx.world.switches) cold.push(await visit(tab, c));
		// Back through them in another order (never the one that is open: clicking it changes nothing); the page has each one's data now.
		const warm: Visit[] = [];
		for (const i of WARM_ORDER) warm.push(await visit(tab, ctx.world.switches[i]));
		ctx.notes.push(
			`switch visits (ms): cold ${cold.map((v) => v.ms.toFixed(0)).join(" ")}; warm ${warm.map((v) => v.ms.toFixed(0)).join(" ")}`,
		);
		for (const [kind, visits] of [
			["cold", cold],
			["warm", warm],
		] as const) {
			out[`switch.${kind}.median_ms`] = median(visits.map((v) => v.ms));
			out[`switch.${kind}.p90_ms`] = quantile(
				visits.map((v) => v.ms),
				0.9,
			);
			out[`switch.${kind}.work_ms`] = median(visits.map((v) => v.work));
			out[`switch.${kind}.longTask_ms`] = median(visits.map((v) => v.longMs));
		}
	} finally {
		await tab.close();
	}
	return out;
}

async function scrollMetrics(tab: Tab, prefix: string, out: Samples, countTasks = false): Promise<ScrollResult> {
	const scroll = await tab.page.evaluate(
		([sel, speed, max]) => window.__bench.scroll(sel as string, speed as number, max as number, 30_000),
		['[data-testid="transcript"]', SCROLL_SPEED, SCROLL_DISTANCE],
	);
	const frames = frameStats(scroll.gaps);
	const lt = longTasksIn(await tab.page.evaluate(() => window.__bench.lt), scroll.startAt, scroll.endAt);
	out[`${prefix}.frame_p50_ms`] = frames.p50;
	out[`${prefix}.frame_p95_ms`] = frames.p95;
	out[`${prefix}.dropped_pct`] = frames.droppedPct;
	out[`${prefix}.longTask_ms`] = lt.ms;
	if (countTasks) out[`${prefix}.longTaskCount`] = lt.count;
	return scroll;
}

async function scenarioLong(ctx: Ctx): Promise<Samples> {
	const out: Samples = {};
	const tab = await openTab(ctx);
	const { page, cdp } = tab;
	try {
		await page.goto(ctx.server.url, { waitUntil: "load" });
		await waitListReady(page);
		await sleep(SETTLE_MS);
		const v = await visit(tab, ctx.world.long);
		const requests = await page.evaluate(
			(from) =>
				(performance.getEntriesByType("resource") as PerformanceResourceTiming[])
					.filter((e) => e.startTime >= from - 5 && /\/api\/(family|session)\?/.test(e.name))
					.map((e) => ({ end: e.responseEnd, transfer: e.transferSize })),
			v.t0,
		);
		out["long.open.total_ms"] = v.ms;
		out["long.open.fetch_ms"] = Math.max(0, ...requests.map((r) => r.end - v.t0));
		out["long.open.transfer_kb"] = kb(requests.reduce((s, r) => s + r.transfer, 0));
		out["long.open.work_ms"] = v.work;
		out["long.open.longTask_ms"] = v.longMs;
		out["long.open.domNodes"] = await domNodes(page);
		out["long.open.heap_mb"] = await heapUsedMb(cdp);

		// Scroll what is on screen after opening, from its top.
		await scrollMetrics(tab, "long.scroll", out, true);

		// Then the way to the first message: "Show earlier messages" until it is gone. A page that brings its history in on
		// demand has a button that is busy while a page of history is on its way: that is waited for, not clicked (see `reveal`
		// in `tests/support/bench-page.ts`), so the clicks are those a reader makes, whatever the server's speed.
		const reveal = await page.evaluate(
			([button, scroller]) => window.__bench.reveal(button, scroller, 400, 120_000),
			['[data-testid="show-earlier"]', '[data-testid="transcript"]'],
		);
		const last = reveal.clicks.slice(-5);
		out["long.reveal.total_ms"] = reveal.endAt - reveal.startAt;
		out["long.reveal.lastClick_ms"] = last.length ? median(last) : Number.NaN;
		out["long.reveal.clicks"] = reveal.clicks.length;
		out["long.reveal.domNodes"] = await domNodes(page);
		ctx.notes.push(`reveal: ${reveal.clicks.length} clicks, ${reveal.waits} frames waited for a page of history`);
		await sleep(SETTLE_MS);

		// And the same scroll, through everything that is in the page now.
		await scrollMetrics(tab, "long.scrollAll", out);
		out["long.heap_mb"] = await heapUsedMb(cdp);
		// What the server holds after serving the long conversation (what the family worker leaves behind shows here).
		if (ctx.pid) out["server.long.footprint_mb"] = readFootprintKb(ctx.pid) / 1024;
	} finally {
		await tab.close();
	}
	return out;
}

async function scenarioStream(ctx: Ctx): Promise<Samples> {
	const out: Samples = {};
	const tab = await openTab(ctx);
	const { page, cdp } = tab;
	try {
		await page.goto(ctx.server.url, { waitUntil: "load" });
		await waitListReady(page);
		await sleep(SETTLE_MS);
		const c = ctx.world.stream;
		await page.locator('[data-testid="session-item"]', { hasText: c.title }).first().click();
		await page.waitForSelector(`[data-entry-id="${c.lastId}"]`, { timeout: 45_000 });
		await sleep(SETTLE_MS);

		const composer = page.getByTestId("composer");
		await composer.fill(`@@fake ${JSON.stringify(STREAM_SCRIPT)}`);
		await composer.press("Enter");
		await page.waitForFunction(() => window.__bench.ws.firstDeltaAt !== null, null, { timeout: 90_000, polling: 25 });
		const s0 = sampleServer(ctx.pid);
		const p0 = await cdpMetrics(cdp);
		let rssPeak = s0.rssKb;
		// The footprint is read after the page's metrics are taken: a read takes ~0.3 s that the page's window must not include.
		let footprintPeak = readFootprintKb(ctx.pid);
		let finished = false;
		const ended = page
			.waitForFunction(() => window.__bench.ws.agentEndAt !== null, null, { timeout: 180_000, polling: 100 })
			.then(() => {
				finished = true;
			});
		while (!finished) {
			await Promise.race([sleep(2000), ended]);
			if (!finished) {
				rssPeak = Math.max(rssPeak, sampleServer(ctx.pid).rssKb);
				footprintPeak = Math.max(footprintPeak, readFootprintKb(ctx.pid));
			}
		}
		await ended;
		const s1 = sampleServer(ctx.pid);
		const p1 = await cdpMetrics(cdp);
		footprintPeak = Math.max(footprintPeak, readFootprintKb(ctx.pid));
		await sleep(SETTLE_MS);

		const wall = p1.Timestamp - p0.Timestamp;
		const busy = (key: string) => ((p1[key] - p0[key]) / wall) * 100;
		const rec = await page.evaluate(() => ({ ws: window.__bench.ws, lt: window.__bench.lt }));
		const frames = frameStats(rec.ws.gaps);
		const lt = longTasksIn(rec.lt, rec.ws.firstDeltaAt ?? 0, rec.ws.agentEndAt ?? 0);
		out["stream.busy_pct"] = busy("TaskDuration");
		out["stream.script_pct"] = busy("ScriptDuration");
		out["stream.layoutStyle_pct"] =
			((p1.LayoutDuration + p1.RecalcStyleDuration - p0.LayoutDuration - p0.RecalcStyleDuration) / wall) * 100;
		out["stream.frame_p50_ms"] = frames.p50;
		out["stream.frame_p95_ms"] = frames.p95;
		out["stream.dropped_pct"] = frames.droppedPct;
		out["stream.longTaskCount"] = lt.count;
		out["stream.longTask_ms"] = lt.ms;
		out["stream.queue_p95_ms"] = quantile(rec.ws.queue, 0.95);
		out["stream.toPaint_p50_ms"] = quantile(rec.ws.toPaint, 0.5);
		out["stream.toPaint_p95_ms"] = quantile(rec.ws.toPaint, 0.95);
		out["stream.heap_mb"] = await heapUsedMb(cdp);
		out["stream.domNodes"] = await domNodes(page);
		out["server.stream.cpu_pct"] = cpuPct(s0, s1);
		out["server.stream.relayCpu_pct"] = cpuPct(s0, s1, "relayCpuSec");
		out["server.stream.rssPeak_mb"] = Math.max(rssPeak, s1.rssKb) / 1024;
		out["server.stream.footprintPeak_mb"] = footprintPeak / 1024;
		ctx.notes.push(
			`stream: ${rec.ws.deltas} deltas in ${(((rec.ws.agentEndAt ?? 0) - (rec.ws.firstDeltaAt ?? 0)) / 1000).toFixed(1)} s, ${rec.ws.frames} frames`,
		);
	} finally {
		await tab.close();
	}
	return out;
}

const SCENARIOS: Record<string, (ctx: Ctx) => Promise<Samples>> = {
	// `server` restarts the server: it comes first, and every other scenario runs on what it left.
	server: scenarioServer,
	load: scenarioLoad,
	list: scenarioListApi,
	switch: scenarioSwitch,
	long: scenarioLong,
	stream: scenarioStream,
};

// ------------------------------------------------------------------ rounds and the report
interface RoundInfo {
	round: number;
	warmup: boolean;
	seconds: number;
	load: { before: number; after: number };
	calibrationMs: number[];
	errors: string[];
	notes: string[];
	browserCalibrationMs: number[];
}

async function runRound(
	ctx: Ctx,
	round: number,
	warmup: boolean,
	only: string[],
): Promise<{ info: RoundInfo; samples: Samples }> {
	const started = performance.now();
	const info: RoundInfo = {
		round,
		warmup,
		seconds: 0,
		load: { before: os.loadavg()[0], after: 0 },
		calibrationMs: [],
		errors: [],
		notes: ctx.notes,
		browserCalibrationMs: [],
	};
	ctx.notes.length = 0;
	ctx.browserCalMs.length = 0;
	const samples: Samples = {};
	for (const name of only) {
		info.calibrationMs.push(Math.round(calibrate() * 10) / 10);
		const scenarioStart = performance.now();
		try {
			Object.assign(samples, await SCENARIOS[name](ctx));
			log(
				`round ${round}${warmup ? " (warm-up)" : ""}: ${name} ${((performance.now() - scenarioStart) / 1000).toFixed(1)} s`,
			);
		} catch (e) {
			info.errors.push(`${name}: ${(e as Error).message}`);
			log(`round ${round}: ${name} FAILED: ${(e as Error).message}`);
		}
	}
	info.calibrationMs.push(Math.round(calibrate() * 10) / 10);
	info.load.after = os.loadavg()[0];
	info.seconds = (performance.now() - started) / 1000;
	info.notes = [...ctx.notes];
	info.browserCalibrationMs = [...ctx.browserCalMs];
	return { info, samples };
}

function git(...a: string[]): string {
	try {
		return execFileSync("git", a, { cwd: root, encoding: "utf8" }).trim();
	} catch {
		return "";
	}
}

/** Keep the Mac awake for as long as this process lives (`caffeinate -w <pid>` exits with it): a run that spans a sleep is not valid. */
function keepAwake(): boolean {
	if (process.platform !== "darwin") return false;
	const child = spawn("caffeinate", ["-dimsu", "-w", String(process.pid)], { stdio: "ignore" });
	child.on("error", () => {});
	child.unref();
	return true;
}

/** "AC Power" or "Battery Power": a laptop on battery throttles. */
function powerSource(): string {
	if (process.platform !== "darwin") return "unknown";
	try {
		return (
			/Now drawing from '([^']+)'/.exec(execFileSync("pmset", ["-g", "batt"], { encoding: "utf8" }))?.[1] ?? "unknown"
		);
	} catch {
		return "unknown";
	}
}

interface PowerEvent {
	at: string;
	event: string;
	detail: string;
}

/** The Sleep / Wake / DarkWake entries of the macOS power log inside [from, to] (ms): any of them in a run's window invalidates the run. */
function sleepWakeEvents(from: number, to: number): PowerEvent[] {
	if (process.platform !== "darwin") return [];
	const text = execFileSync("pmset", ["-g", "log"], { encoding: "utf8", maxBuffer: 512 << 20 });
	const events: PowerEvent[] = [];
	for (const line of text.split("\n")) {
		// "2026-10-20 11:03:30 -0500 Wake    <spaces>DarkWake to FullWake ..." (a "Wake Requests" line has one space and is something else).
		const m = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d) (Sleep|Wake|DarkWake)\s{2,}(.*)$/.exec(line);
		if (!m) continue;
		const at = Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`);
		if (at >= from - 2000 && at <= to + 2000)
			events.push({ at: new Date(at).toISOString(), event: m[5], detail: m[6].trim().slice(0, 160) });
	}
	return events;
}

async function runBench(): Promise<void> {
	const label = opt("label", "");
	if (!label) throw new Error("--label <name> is required");
	const runs = Number(opt("runs", "5"));
	const warmup = Number(opt("warmup", "1"));
	const out = resolve(root, opt("out", "docs/perf"));
	const only = opt("only", Object.keys(SCENARIOS).join(",")).split(",");
	if (only[0] !== "server" && only.includes("server")) throw new Error("`server` has to run first");
	for (const name of only) if (!SCENARIOS[name]) throw new Error(`unknown scenario ${name}`);
	const shards = Number(opt("shards", "1"));
	if (!(shards >= 1 && shards <= runs)) throw new Error("--shards must be between 1 and --runs");
	const isShard = process.env.OMPW_BENCH_SHARD === "1";

	// Conditions first: a loaded machine is refused (before the benchmark adds its own load to the average), and a Mac that may sleep is kept awake.
	const runStart = Date.now();
	const loadAtStart = os.loadavg();
	const caveats: string[] = [];
	if (!isShard && loadAtStart[0] > LOAD_LIMIT) {
		const why = `the 1-minute load average is ${loadAtStart[0].toFixed(1)} (limit ${LOAD_LIMIT}): other work on this machine is in the numbers`;
		if (!args.includes("--allow-load")) {
			throw new Error(
				`Refusing to measure: ${why}. Wait for the machine to quiet down, or pass --allow-load (the report is then marked provisional).`,
			);
		}
		console.error(`\n!!! ${why}. Measuring anyway (--allow-load): the report will be marked PROVISIONAL.\n`);
		caveats.push(
			`1-minute load average ${loadAtStart[0].toFixed(1)} at the start (limit ${LOAD_LIMIT}), run with --allow-load`,
		);
	}
	const powerAtStart = powerSource();
	if (powerAtStart.startsWith("Battery")) {
		console.error("\n!!! The Mac is on battery power: it throttles. The report will be marked PROVISIONAL.\n");
		caveats.push("on battery power at the start");
	}
	if (shards > 1 && !isShard)
		return runSharded({ label, runs, warmup, out, only, shards, runStart, loadAtStart, caveats });
	const awake = keepAwake();

	const binDir = mkdtempSync(join(os.tmpdir(), "ompw-bench-"));
	const server = await startTestServer(0, { OMP_BIN: writeBenchOmp(binDir) }, { login: false });
	const startedAt = new Date(runStart);
	/** Stop the server and whatever it started (the relay and omp carry the world's own directory in their command line); remove the world. */
	const cleanup = async () => {
		await server.stop();
		for (const p of processes()) {
			if (p.pid !== process.pid && p.cmd.includes(server.root)) process.kill(p.pid, "SIGTERM");
		}
		rmSync(binDir, { recursive: true, force: true });
	};
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => void cleanup().finally(() => process.exit(130)));
	}
	const roundInfo: RoundInfo[] = [];
	const values: Record<string, number[]> = {};
	let machine: Record<string, unknown> = {};
	try {
		const work = realpathSync(server.work);
		const world = seedBenchWorld(server.agentDir, work);
		const prefs = (await (
			await fetch(`${server.url}/api/prefs`, { headers: { "x-omp-webui-token": server.accessToken } })
		).json()) as { id: string };
		const ctx: Ctx = {
			server,
			world,
			pid: 0,
			syncMarker: `${prefs.id}:${Number.MAX_SAFE_INTEGER}`,
			notes: [],
			browserCalMs: [],
		};
		log(
			`library: long ${world.long.entries} entries ${mb(world.long.bytes).toFixed(1)} MB; ${world.switches.length} to switch between (${world.switches[0].entries} entries); stream base ${world.stream.entries} entries; ${world.bulk} small`,
		);
		const probe = await chromium.launch({ channel: "chromium", headless: true });
		machine = {
			cpu: os.cpus()[0]?.model,
			cores: os.cpus().length,
			memoryGB: Math.round(os.totalmem() / 2 ** 30),
			os: `${os.type()} ${os.release()}`,
			macOS:
				process.platform === "darwin"
					? execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim()
					: undefined,
			bun: Bun.version,
			chromium: probe.version(),
			loadAvgAtStart: loadAtStart,
			powerSourceAtStart: powerAtStart,
		};
		await probe.close();

		for (let round = 0; round < warmup + runs; round++) {
			const isWarmup = round < warmup;
			const { info, samples } = await runRound(ctx, round + 1, isWarmup, only);
			roundInfo.push(info);
			if (isWarmup) continue;
			for (const [name, v] of Object.entries(samples)) {
				if (!METRICS[name]) throw new Error(`metric ${name} is not in METRICS`);
				if (Number.isFinite(v)) values[name] = [...(values[name] ?? []), v];
			}
		}
		const metrics = Object.fromEntries(
			Object.keys(METRICS)
				.filter((name) => values[name]?.length)
				.map((name) => [name, summarize(METRICS[name], values[name])]),
		);
		const endedAt = Date.now();
		const powerEvents = sleepWakeEvents(runStart, endedAt);
		const calibrations = roundInfo.flatMap((r) => r.calibrationMs);
		const calibrationSpreadPct = (Math.max(...calibrations) / Math.min(...calibrations) - 1) * 100;
		if (calibrationSpreadPct > CALIBRATION_SPREAD_LIMIT) {
			caveats.push(
				`the CPU calibration varied by ${calibrationSpreadPct.toFixed(0)}% inside the run (limit ${CALIBRATION_SPREAD_LIMIT}%): something else used the CPU`,
			);
		}
		if (footprintProblems.size) {
			caveats.push(
				`the server's footprint could not be read (${[...footprintProblems].join("; ")}): the footprint metrics are missing or partial, so a comparison cannot gate on memory`,
			);
		}
		const report: Report = {
			schema: 1,
			label,
			createdAt: startedAt.toISOString(),
			version: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version,
			commit: git("rev-parse", "--short", "HEAD"),
			rounds: runs,
			warmup,
			machine: { ...machine, loadAvgAtEnd: os.loadavg(), powerSourceAtEnd: powerSource() },
			power: {
				caffeinate: awake ? "caffeinate -dimsu -w <pid>, held for the whole run" : "not available on this OS",
				events: powerEvents,
			},
			valid: powerEvents.length === 0,
			provisional: caveats.length > 0,
			caveats,
			calibrationSpreadPct,
			conditions: {
				shards: 1,
				viewport: `${VIEWPORT.width}x${VIEWPORT.height}`,
				browser: "Playwright Chromium, headless, new context per scenario, timezone UTC, dark",
				scrollPxPerSecond: SCROLL_SPEED,
				scrollMaxDistancePx: SCROLL_DISTANCE,
				streamScript: STREAM_SCRIPT,
				idleWindowMs: IDLE_MS,
				listRequests: LIST_REQUESTS,
				sourceDirty: git("status", "--porcelain", "--", "server", "web", "shared", "macos") !== "",
			},
			fixtures: {
				shape: BENCH_SHAPE,
				longEntries: world.long.entries,
				longMB: Math.round(mb(world.long.bytes) * 10) / 10,
				switchEntries: world.switches.map((s) => s.entries),
				streamEntries: world.stream.entries,
				sessionsOnDisk: world.bulk + world.switches.length + 2 + 5,
			},
			roundInfo: roundInfo as unknown as Record<string, unknown>[],
			runtimeSeconds: Math.round((endedAt - runStart) / 1000),
			metrics,
		};
		mkdirSync(out, { recursive: true });
		const file = join(out, `bench-${label}.json`);
		writeFileSync(file, `${JSON.stringify(report, null, "\t")}\n`);
		printSummary(report);
		log(`wrote ${file} (${report.runtimeSeconds} s)`);
		if (report.provisional) console.error(`\nPROVISIONAL: ${caveats.join("; ")}.`);
		if (!report.valid) {
			console.error(
				`\nINVALID: the machine slept or woke inside this run (${powerEvents.map((e) => `${e.at} ${e.event}`).join(", ")}).`,
			);
			process.exitCode = 3;
		}
		const failed = roundInfo.flatMap((r) => r.errors);
		if (failed.length) {
			console.error(`\n${failed.length} scenario run(s) failed:\n${failed.join("\n")}`);
			process.exitCode ||= 2;
		}
	} finally {
		await cleanup();
	}
}

/**
 * `--shards N`: the rounds split over N copies of this benchmark started at once, each with its own server, omp, world
 * and browser (a free port each), then one report from all their rounds. N processes share the machine's cores, so a
 * sharded report is comparable only with another taken with the same N (`conditions.shards`).
 */
async function runSharded(o: {
	label: string;
	runs: number;
	warmup: number;
	out: string;
	only: string[];
	shards: number;
	runStart: number;
	loadAtStart: number[];
	caveats: string[];
}): Promise<void> {
	const tmp = mkdtempSync(join(os.tmpdir(), "ompw-bench-shards-"));
	const children: ReturnType<typeof spawn>[] = [];
	const stop = () => {
		for (const c of children) c.kill("SIGTERM");
	};
	for (const signal of ["SIGINT", "SIGTERM"] as const) {
		process.once(signal, () => {
			stop();
			rmSync(tmp, { recursive: true, force: true });
			process.exit(130);
		});
	}
	try {
		const runsOf = (i: number) => Math.floor(o.runs / o.shards) + (i < o.runs % o.shards ? 1 : 0);
		const codes = await Promise.all(
			Array.from({ length: o.shards }, (_, i) => {
				const child = spawn(
					process.execPath,
					[
						import.meta.path,
						"--label",
						`shard${i}`,
						"--runs",
						String(runsOf(i)),
						"--warmup",
						String(o.warmup),
						"--out",
						tmp,
						"--only",
						o.only.join(","),
					],
					{ cwd: root, env: { ...process.env, OMPW_BENCH_SHARD: "1" }, stdio: ["ignore", "ignore", "pipe"] },
				);
				children.push(child);
				child.stderr?.on("data", (d: Buffer) => {
					for (const line of d.toString().split("\n")) if (line.trim()) console.error(`[shard ${i}] ${line}`);
				});
				return new Promise<number>((done) => child.on("exit", (code) => done(code ?? 1)));
			}),
		);
		const parts = Array.from(
			{ length: o.shards },
			(_, i) => JSON.parse(readFileSync(join(tmp, `bench-shard${i}.json`), "utf8")) as Report,
		);
		const values: Record<string, number[]> = {};
		for (const p of parts) {
			for (const [name, m] of Object.entries(p.metrics)) values[name] = [...(values[name] ?? []), ...m.values];
		}
		const endedAt = Date.now();
		const caveats = [...o.caveats, ...new Set(parts.flatMap((p) => p.caveats.map((c) => `shard: ${c}`)))];
		const report: Report = {
			...parts[0],
			label: o.label,
			createdAt: new Date(o.runStart).toISOString(),
			rounds: o.runs,
			machine: { ...parts[0].machine, loadAvgAtStart: o.loadAtStart, loadAvgAtEnd: os.loadavg() },
			power: { caffeinate: parts[0].power.caffeinate, events: parts.flatMap((p) => p.power.events) },
			valid: parts.every((p) => p.valid),
			provisional: caveats.length > 0,
			caveats,
			calibrationSpreadPct: Math.max(...parts.map((p) => p.calibrationSpreadPct)),
			conditions: { ...parts[0].conditions, shards: o.shards },
			roundInfo: parts.flatMap((p, shard) => p.roundInfo.map((r) => ({ ...r, shard }))),
			runtimeSeconds: Math.round((endedAt - o.runStart) / 1000),
			metrics: Object.fromEntries(
				Object.keys(METRICS)
					.filter((name) => values[name]?.length)
					.map((name) => [name, summarize(METRICS[name], values[name])]),
			),
		};
		mkdirSync(o.out, { recursive: true });
		const file = join(o.out, `bench-${o.label}.json`);
		writeFileSync(file, `${JSON.stringify(report, null, "\t")}\n`);
		printSummary(report);
		log(`wrote ${file} (${report.runtimeSeconds} s, ${o.shards} shards)`);
		if (report.provisional) console.error(`\nPROVISIONAL: ${caveats.join("; ")}.`);
		process.exitCode = codes.find((c) => c !== 0) ?? 0;
	} finally {
		stop();
		rmSync(tmp, { recursive: true, force: true });
	}
}

function printSummary(report: Report): void {
	const rows = Object.entries(report.metrics).map(
		([name, m]) =>
			`| ${name} | ${m.unit} | ${m.median.toFixed(2)} | ${m.p90.toFixed(2)} | ${m.min.toFixed(2)}–${m.max.toFixed(2)} | ${m.iqrPct.toFixed(1)}% | ${m.n} |`,
	);
	console.log(
		[
			"| metric | unit | median | p90 | min–max | IQR | n |",
			"| --- | --- | ---: | ---: | --- | ---: | ---: |",
			...rows,
		].join("\n"),
	);
}

function runCompare(): number {
	const at = args.indexOf("--compare");
	const [pa, pb] = [args[at + 1], args[at + 2]];
	if (!pa || !pb) throw new Error("--compare <a.json> <b.json>");
	const a = JSON.parse(readFileSync(pa, "utf8")) as Report;
	const b = JSON.parse(readFileSync(pb, "utf8")) as Report;
	const rows = compare(a, b, Number(opt("threshold", "5")));
	console.log(`A = ${a.label} (${a.commit}, ${a.rounds} rounds), B = ${b.label} (${b.commit}, ${b.rounds} rounds)\n`);
	const shardsOf = (r: Report) => Number((r.conditions as { shards?: number }).shards ?? 1);
	if (shardsOf(a) !== shardsOf(b)) {
		console.log(
			`**NOT COMPARABLE**: ${a.label} ran with --shards ${shardsOf(a)}, ${b.label} with --shards ${shardsOf(b)}; processes sharing the cores change the numbers.`,
		);
		return 4;
	}
	for (const r of [a, b]) {
		if (r.provisional)
			console.log(
				`> **${r.label} is PROVISIONAL**: ${r.caveats.join("; ")}. Do not read a small change as a finding.\n`,
			);
	}
	const slept = [a, b].filter((r) => r.valid === false);
	if (slept.length) {
		console.log(
			`**INVALID**: ${slept.map((r) => r.label).join(", ")} spans a sleep or wake of the machine; its numbers cannot be compared.`,
		);
		return 3;
	}
	console.log(comparisonTable(rows, a.label, b.label));
	const have = footprintCoverage(a, b);
	if (!have.a || !have.b) {
		const without = [a, b].filter((_, i) => !(i === 0 ? have.a : have.b)).map((r) => r.label);
		console.log(
			`\n**Memory gate not applied**: no footprint metrics in ${without.join(" and ")} (a report from before they were recorded, or the footprint could not be read), so those rows are "missing" and not compared. \`ps\` RSS is informational only and does not fail this comparison; measure ${without.join(" and ")} again to gate on memory.`,
		);
	}
	// The same fixed work timed in each run: if the machine or the browser ran at a different speed, the CPU-bound metrics moved with it.
	type Cal = { warmup: boolean; calibrationMs: number[]; browserCalibrationMs?: number[] };
	const speed = (r: Report, key: "calibrationMs" | "browserCalibrationMs") =>
		median((r.roundInfo as unknown as Cal[]).filter((i) => !i.warmup).flatMap((i) => i[key] ?? []));
	for (const [key, what] of [
		["calibrationMs", "the process running the benchmark"],
		["browserCalibrationMs", "the browser's main thread"],
	] as const) {
		const [sa, sb] = [speed(a, key), speed(b, key)];
		if (!Number.isFinite(sa) || !Number.isFinite(sb)) continue;
		const shift = (sb / sa - 1) * 100;
		console.log(
			`\nSpeed of ${what}: ${sa.toFixed(1)} ms -> ${sb.toFixed(1)} ms for the same fixed work (${shift > 0 ? "+" : ""}${shift.toFixed(1)}%).${Math.abs(shift) > 10 ? " **The machine ran at a different speed: CPU-bound metrics moved with it; measure again back to back.**" : ""}`,
		);
	}
	const worse = gatedWorse(rows);
	const rssWorse = rows.filter((r) => r.verdict === "worse" && r.informational);
	const noise = rows.filter((r) => r.verdict === "noise");
	if (noise.length) {
		console.log(
			`\n${noise.length} metric(s) moved beyond the threshold but inside their own spread (not counted): ${noise.map((r) => r.name).join(", ")}`,
		);
	}
	if (rssWorse.length) {
		console.log(
			`\nInformational, not counted: ${rssWorse.map((r) => r.name).join(", ")} (\`ps\` RSS is worse; the footprint is the memory gate).`,
		);
	}
	console.log(
		`\n${worse.length ? `${worse.length} metric(s) worse: ${worse.map((r) => r.name).join(", ")}` : "No metric is worse."}`,
	);
	return worse.length ? 1 : 0;
}

if (args.includes("--compare")) process.exit(runCompare());
await runBench();
process.exit(process.exitCode ?? 0);
