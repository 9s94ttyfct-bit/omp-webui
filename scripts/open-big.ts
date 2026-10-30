/**
 * How long a very long conversation takes to show its latest messages (#590), against any checkout of omp-webui, so that
 * the same conversation can be opened by the code before a change and the code after it:
 *
 *   bun scripts/open-big.ts --checkout <dir> [--mb 50 | --session <file.jsonl>] [--runs 5] [--throttle 20:80] [--label name] [--out file.json]
 *
 * The checkout's own server is started (an isolated HOME and agent directory, no model, `bun run build` first: the server
 * serves that checkout's `dist/web`), a conversation is put into it, and headless Chromium at 1400x900 opens it two ways,
 * each in a browser of its own:
 *
 *   click  the page is up with its conversation list; the conversation is clicked: from the click to its last message painted
 *   link   a page that is not loaded yet is sent to the conversation's address: from the navigation to the last message painted
 *
 * The conversation is a synthetic one of about `--mb` megabytes (`writeBigSession`: alternating prompts and answers of
 * about 6 KB, a few thousand distinct words), or a real one: `--session` copies that file (and the directory of its
 * subagents' transcripts next to it, when there is one) into the server's agent directory with the file system's own clone
 * (`cp -c`, no bytes are copied), and the last message of its path is the one waited for. The original is only read.
 *
 * `--throttle <Mbps>:<ms>` puts the page behind a link of that downstream speed and round trip time (Chromium's own network
 * emulation, as a tunnel from another place is): everything the page loads then travels through it, the application too.
 *
 * Reported (median of the runs): the time to the last message painted, the time to the last byte of what the page asked
 * `/api/family` and `/api/session` for, how much of it travelled, the main thread's work and its longest task up to the
 * paint, the page's heap a second after, and what the server did for the open (its CPU time and its resident memory at the peak).
 * `--profile` adds the page's own CPU profile of the open: where the main thread's time went, by function.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { chromium } from "playwright";
import type { SessionSummary } from "../shared/protocol.ts";

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && i + 1 < args.length ? (args[i + 1] as string) : fallback;
};
const checkout = resolve(opt("checkout", resolve(import.meta.dir, "..")));
const megabytes = Number(opt("mb", "50"));
const realSession = opt("session", "");
const runs = Number(opt("runs", "5"));
const label = opt("label", checkout.split("/").pop() ?? "checkout");
const out = opt("out", "");
const throttle = opt("throttle", "");
const profile = args.includes("--profile");

// The checkout is chosen at run time: its own support code starts its own server, so the code under test is that checkout's.
const { startTestServer } = await import(join(checkout, "tests/support/server.ts"));

const TITLE = "Fixture big: a very long conversation";

/** The id of the last entry of a session file that the page shows as a message, read from the end of its path. */
function lastShownId(file: string): string {
	const lines = readFileSync(file, "utf8").trimEnd().split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		let entry: unknown;
		try {
			entry = JSON.parse(lines[i] as string);
		} catch {
			continue;
		}
		if (typeof entry !== "object" || entry === null) continue;
		const e = entry as { type?: string; id?: string; message?: { role?: string; content?: unknown } };
		if (e.type !== "message" || typeof e.id !== "string") continue;
		const role = e.message?.role;
		if (role !== "user" && role !== "assistant") continue;
		// An assistant message that is a tool call alone has text for nothing to show on its own: wait for one that has some.
		if (role === "assistant" && Array.isArray(e.message?.content)) {
			const text = e.message.content.some(
				(c: { type?: string; text?: string }) => c.type === "text" && (c.text ?? "").trim() !== "",
			);
			if (!text) continue;
		}
		return e.id;
	}
	throw new Error(`${file} has no message to wait for`);
}

/** The title of a session file: the last `title` slot's, or its header's. */
function titleOf(file: string): string {
	const head = readFileSync(file, { encoding: "utf8", flag: "r" }).slice(0, 4096).split("\n");
	for (const line of head) {
		try {
			const e = JSON.parse(line) as { type?: string; title?: string };
			if ((e.type === "title" || e.type === "session") && e.title) return e.title;
		} catch {}
	}
	throw new Error(`${file} has no title`);
}

interface Sample {
	ms: number;
	fetchMs: number;
	transferKb: number;
	workMs: number;
	scriptMs: number;
	layoutMs: number;
	styleMs: number;
	longestTaskMs: number;
	heapMb: number;
	domNodes: number;
	serverCpuMs: number;
	serverRssMb: number;
	requests: { path: string; status: number; kb: number; ttfbMs: number; totalMs: number }[];
	/** Everything the page loaded from the click (or the navigation) to the paint, in order: when each began and ended. */
	waterfall: { path: string; startMs: number; endMs: number; kb: number }[];
	topFunctions?: { name: string; ms: number }[];
}

const median = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length % 2
		? (s[(s.length - 1) / 2] as number)
		: ((s[s.length / 2 - 1] as number) + (s[s.length / 2] as number)) / 2;
};

interface OpenState {
	painted: number | null;
	clickAt: number | null;
	lt: { start: number; dur: number }[];
}

declare global {
	interface Window {
		__open?: OpenState;
	}
}

/** Marks when the last message is in the page and painted, and records long tasks: installed before the page's own scripts. */
function recorder(selector: string) {
	const state: OpenState = { painted: null, clickAt: null, lt: [] };
	window.__open = state;
	new PerformanceObserver((list) => {
		for (const e of list.getEntries()) state.lt.push({ start: e.startTime, dur: e.duration });
	}).observe({ type: "longtask", buffered: true });
	document.addEventListener(
		"click",
		(e) => {
			if (state.clickAt === null) state.clickAt = e.timeStamp;
		},
		true,
	);
	const check = () => {
		if (state.painted !== null || !document.querySelector(selector)) return;
		observer.disconnect();
		requestAnimationFrame(() => {
			const channel = new MessageChannel();
			channel.port1.onmessage = () => {
				state.painted = performance.now();
			};
			channel.port2.postMessage(0);
		});
	};
	const observer = new MutationObserver(check);
	observer.observe(document, { subtree: true, childList: true });
}

/** `M:SS.ss`, `H:MM:SS.ss` or `D-H:MM:SS` as `ps` prints a process's CPU time, in milliseconds. */
function cpuMs(text: string): number {
	const [days, rest] = text.includes("-") ? (text.split("-") as [string, string]) : ["0", text];
	const parts = rest.split(":").map(Number);
	let seconds = 0;
	for (const p of parts) seconds = seconds * 60 + p;
	return (Number(days) * 86400 + seconds) * 1000;
}

/** The server's process id: its command line names the checkout's `server/main.ts` and the test's directory. */
function serverPid(root: string): number {
	const table = execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	for (const line of table.split("\n")) {
		if (!line.includes("server/main.ts")) continue;
		const pid = Number(line.trim().split(/\s+/, 1)[0]);
		const env = spawnSync("ps", ["eww", "-p", String(pid)], { encoding: "utf8" }).stdout;
		if (env.includes(root)) return pid;
	}
	throw new Error("the server's process was not found");
}

function serverUse(pid: number): { cpuMs: number; rssMb: number } {
	const [cpu, rss] = execFileSync("ps", ["-o", "cputime=,rss=", "-p", String(pid)], { encoding: "utf8" })
		.trim()
		.split(/\s+/) as [string, string];
	return { cpuMs: cpuMs(cpu), rssMb: Number(rss) / 1024 };
}

/** Where a CPU profile's time went: the self time of each function, the largest first. */
function topFunctions(prof: {
	nodes: { id: number; callFrame: { functionName: string; url: string; lineNumber: number } }[];
	samples?: number[];
	timeDeltas?: number[];
}): { name: string; ms: number }[] {
	const byId = new Map(prof.nodes.map((n) => [n.id, n]));
	const total = new Map<string, number>();
	for (const [i, id] of (prof.samples ?? []).entries()) {
		const frame = byId.get(id)?.callFrame;
		if (!frame) continue;
		const name =
			`${frame.functionName || "(anonymous)"} ${frame.url ? basename(frame.url) : ""}:${frame.lineNumber}`.trim();
		total.set(name, (total.get(name) ?? 0) + ((prof.timeDeltas ?? [])[i] ?? 0) / 1000);
	}
	return [...total.entries()]
		.map(([name, ms]) => ({ name, ms }))
		.sort((a, b) => b.ms - a.ms)
		.slice(0, 15);
}

async function oneRun(mode: "click" | "link"): Promise<Sample> {
	const server = await startTestServer(0, {}, { login: false });
	const browser = await chromium.launch();
	try {
		let file: string;
		let title = TITLE;
		if (realSession) {
			const from = resolve(realSession);
			const bucket = join(server.agentDir, "sessions", basename(dirname(from)));
			spawnSync("mkdir", ["-p", bucket]);
			file = join(bucket, basename(from));
			// A clone (`cp -c`) shares the original's blocks: nothing is copied, and the original is never written to.
			execFileSync("cp", ["-c", from, file]);
			const sibling = from.replace(/\.jsonl$/, "");
			if (existsSync(sibling)) execFileSync("cp", ["-cR", sibling, file.replace(/\.jsonl$/, "")]);
			title = titleOf(file);
		} else {
			const { writeBigSession } = await import(join(checkout, "tests/support/big-session.ts"));
			file = writeBigSession(server.agentDir, megabytes * 1024 * 1024);
		}
		// The address names the file as the server does (a temp directory on macOS is behind a symlink): a page sent to another
		// spelling of it moves to the canonical one after its first answer, and asks for everything again.
		file = realpathSync(file);
		const lastId = lastShownId(file);
		// The server finds the file and its summary, and settles: what the page is timed against is the open, not the first look at a library.
		for (let i = 0; i < 240; i++) {
			const res = await fetch(`${server.url}/api/sessions`, { headers: { "x-omp-webui-token": server.accessToken } });
			const list: SessionSummary[] | { changed?: SessionSummary[] } = await res.json();
			const rows = Array.isArray(list) ? list : (list.changed ?? []);
			if (rows.some((r) => r.title === title)) break;
			await sleep(500);
		}
		await sleep(2000);
		const pid = serverPid(server.root);
		const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
		await context.addCookies([{ name: "ompw_token", value: server.accessToken, url: server.url }]);
		const page = await context.newPage();
		const cdp = await context.newCDPSession(page);
		await cdp.send("Performance.enable");
		await page.addInitScript(recorder, `[data-entry-id="${lastId}"]`);
		const metrics = async () => {
			const { metrics } = (await cdp.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] };
			return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
		};
		/** The link the page is behind: Mbps down (the same up) and a round trip of this many milliseconds. */
		const slow = async () => {
			if (!throttle) return;
			const [mbps, rtt] = throttle.split(":").map(Number) as [number, number];
			await cdp.send("Network.enable");
			await cdp.send("Network.emulateNetworkConditions", {
				offline: false,
				latency: rtt,
				downloadThroughput: (mbps * 1_000_000) / 8,
				uploadThroughput: (mbps * 1_000_000) / 8,
			});
		};
		if (mode === "click") {
			await page.goto(server.url, { waitUntil: "load" });
			await page.waitForSelector('[data-testid="session-item"]');
			await sleep(1500);
			await slow();
		} else await slow();
		const before = await metrics();
		const use0 = serverUse(pid);
		let peakRss = use0.rssMb;
		const poll = setInterval(() => {
			try {
				peakRss = Math.max(peakRss, serverUse(pid).rssMb);
			} catch {}
		}, 100);
		if (profile) {
			await cdp.send("Profiler.enable");
			await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
			await cdp.send("Profiler.start");
		}
		const began = await page.evaluate(() => performance.now());
		if (mode === "click") await page.locator('[data-testid="session-item"]', { hasText: title }).first().click();
		else await page.goto(`${server.url}/#/s/${encodeURIComponent(file)}`, { waitUntil: "commit" });
		await page.waitForFunction(() => window.__open?.painted != null, undefined, { timeout: 300_000 });
		const state = await page.evaluate(() => window.__open);
		const painted = state?.painted;
		if (!state || painted == null) throw new Error("the last message was never painted");
		const start = mode === "click" ? (state.clickAt ?? began) : 0;
		let top: { name: string; ms: number }[] | undefined;
		if (profile) top = topFunctions((await cdp.send("Profiler.stop")).profile);
		await sleep(1000);
		clearInterval(poll);
		const use1 = serverUse(pid);
		const after = await metrics();
		const requests = await page.evaluate((from) => {
			return (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
				.filter((e) => e.startTime >= from - 5 && /\/api\/(family|session)\?/.test(e.name))
				.map((e) => ({
					path: new URL(e.name).pathname + new URL(e.name).search.replace(/file=[^&]*/, "file=…"),
					status: e.responseStatus,
					kb: e.transferSize / 1024,
					ttfbMs: e.responseStart - e.requestStart,
					totalMs: e.responseEnd - e.startTime,
					end: e.responseEnd,
				}));
		}, start);
		const waterfall = await page.evaluate(
			([from, stop]) =>
				(performance.getEntriesByType("resource") as PerformanceResourceTiming[])
					.filter((e) => e.startTime >= (from as number) - 5 && e.startTime <= (stop as number))
					.map((e) => ({
						path:
							new URL(e.name).pathname.split("/").slice(-2).join("/") +
							new URL(e.name).search.replace(/file=[^&]*/, "file=…"),
						startMs: Math.round(e.startTime - (from as number)),
						endMs: Math.round(e.responseEnd - (from as number)),
						kb: Math.round(e.transferSize / 1024),
					})),
			[start, painted],
		);
		const tasks = state.lt.filter((t) => t.start + t.dur > start && t.start < painted);
		const dom = await page.evaluate(() => document.getElementsByTagName("*").length);
		const delta = (name: string) => (((after[name] as number) - (before[name] as number)) * 1000) | 0;
		return {
			ms: painted - start,
			fetchMs: Math.max(0, ...requests.map((r) => r.end - start)),
			transferKb: requests.reduce((s, r) => s + r.kb, 0),
			workMs: delta("TaskDuration"),
			scriptMs: delta("ScriptDuration"),
			layoutMs: delta("LayoutDuration"),
			styleMs: delta("RecalcStyleDuration"),
			longestTaskMs: Math.max(0, ...tasks.map((t) => t.dur)),
			heapMb: (after.JSHeapUsedSize as number) / (1024 * 1024),
			domNodes: dom,
			serverCpuMs: use1.cpuMs - use0.cpuMs,
			serverRssMb: peakRss,
			requests: requests.map(({ end, ...r }) => r),
			waterfall,
			...(top ? { topFunctions: top } : {}),
		};
	} finally {
		await browser.close();
		await server.stop();
	}
}

const results: Record<string, number> = {};
const detail: Record<string, Sample[]> = {};
for (const mode of ["click", "link"] as const) {
	const samples: Sample[] = [];
	for (let i = 0; i < runs; i++) {
		const s = await oneRun(mode);
		samples.push(s);
		console.error(
			`${label} ${mode} run ${i + 1}/${runs}: ${s.ms.toFixed(0)} ms, fetch ${s.fetchMs.toFixed(0)} ms, ${s.transferKb.toFixed(0)} KB, page work ${s.workMs} ms, server cpu ${s.serverCpuMs.toFixed(0)} ms, load ${execFileSync("sysctl", ["-n", "vm.loadavg"], { encoding: "utf8" }).trim()}`,
		);
	}
	detail[mode] = samples;
	for (const key of [
		"ms",
		"fetchMs",
		"transferKb",
		"workMs",
		"scriptMs",
		"layoutMs",
		"styleMs",
		"longestTaskMs",
		"heapMb",
		"domNodes",
		"serverCpuMs",
		"serverRssMb",
	] as const)
		results[`${mode}.${key}`] = median(samples.map((s) => s[key]));
}
const report = {
	label,
	checkout,
	session: realSession || `${megabytes} MB synthetic`,
	throttle: throttle || "none",
	runs,
	results,
	detail,
};
console.log(JSON.stringify(report, null, 2));
if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
