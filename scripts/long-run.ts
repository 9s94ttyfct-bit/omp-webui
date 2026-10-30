/**
 * Long-run harness (`bun scripts/long-run.ts --help`): the page against hours of omp's time, in minutes of ours.
 *
 * An isolated server (a home, an agent directory and a data directory of its own, a fake omp that streams on a
 * script: tests/support/long-fake-omp.ts) with a conversation as long as a real one (a copy of a session file, or a
 * generated one), and a Chromium on it. The metrics are sampled every `--interval` seconds, so what grows or blocks
 * over time shows as a series, not as a single number:
 *
 *   goal    one prompt, then a goal-mode run of thousands of steps, all one turn, with Stop and Send probed throughout
 *   multi   several conversations stream at once; the page switches between them
 *   hidden  the page is hidden (no paint, throttled timers) while omp streams, then shown again
 *   dead    requests that never get an answer: the connection drops what it carries for a while, or the server stops
 *
 * Nothing here calls a model, and nothing touches ~/.omp or a running omp-webui: a session file given with
 * `--session` is copied into the harness's own directory, which is removed at the end.
 */
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { type Browser, type BrowserContext, type CDPSession, chromium, type Page } from "playwright";
import { writeBigSession } from "../tests/support/big-session.ts";
import { writeChatSession } from "../tests/support/chat-session.ts";
import { writeLongFakeOmp } from "../tests/support/long-fake-omp-bin.ts";
import { killTree, onShutdown } from "./lib/shutdown.ts";

// ------------------------------------------------------------------ options
const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
if (args.includes("--help")) {
	console.log(`options: --scenario goal|multi|hidden|dead  --label <name>  --dist <dir>  --port 7601  --minutes 10
  --interval 30 (seconds between samples)  --session <jsonl to copy> | --generate-mb 58
  --steps 6000 --step-ms 150 (script)  --out .tmp/long-run  --heap (heap snapshot at start and end)  --profile (CPU profile of 10 s in each sample round of --profile-round 3,20)\n  --ws-limit (the server may buffer a big reply: isolates the page's own cost from the server dropping messages)`);
	process.exit(0);
}
const scenario = opt("scenario", "goal");
const label = opt("label", scenario);
const root = resolve(import.meta.dir, "..");
const dist = resolve(opt("dist", join(root, "dist", "web")));
const port = Number(opt("port", "7601"));
const proxyPort = port + 1;
const minutes = Number(opt("minutes", "10"));
const intervalMs = Number(opt("interval", "30")) * 1000;
const sessionSource = opt("session", "");
const generateMb = Number(opt("generate-mb", "58"));
const steps = Number(opt("steps", "6000"));
const stepMs = Number(opt("step-ms", "150"));
const outDir = resolve(opt("out", join(root, ".tmp", "long-run")), label);
const wantHeap = args.includes("--heap");
const wantProfile = args.includes("--profile");
/** Raise the server's WebSocket backpressure limit, so a big reply does not make it drop what follows (see the preload). */
const wsLimit = args.includes("--ws-limit");
const profileRounds = opt("profile-round", "3").split(",").map(Number);

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const log = (m: string) => console.error(`[${((performance.now() - t0) / 1000).toFixed(0).padStart(5)}s] ${m}`);
const t0 = performance.now();

// ------------------------------------------------------------------ the isolated world
const workdir = mkdtempSync(join(tmpdir(), "ompw-longrun-"));
const home = join(workdir, "home");
const agentDir = join(home, ".omp", "agent");
const work = join(workdir, "work");
const token = `lr-${crypto.randomUUID()}`;
mkdirSync(agentDir, { recursive: true });
mkdirSync(work, { recursive: true });
mkdirSync(outDir, { recursive: true });
const started: ChildProcess[] = [];

function bucketOf(cwd: string): string {
	return join(agentDir, "sessions", cwd.replaceAll("/", "-"));
}

/** The conversation the page opens: a copy of `--session` (its project moved into the harness), or a generated one. */
function seedMain(): { file: string; entries: number } {
	if (sessionSource) {
		const bytes = readFileSync(sessionSource);
		// A live omp may be writing it: keep whole lines only.
		const end = bytes.lastIndexOf(0x0a) + 1;
		const text = bytes.subarray(0, end).toString("utf8");
		const firstTwo = text.slice(0, 4096).replace(/"cwd":"[^"]*"/, `"cwd":${JSON.stringify(work)}`);
		const body = firstTwo + text.slice(4096);
		const dir = bucketOf(work);
		mkdirSync(dir, { recursive: true });
		const name = sessionSource.split("/").at(-1) as string;
		const file = join(dir, name);
		writeFileSync(file, body);
		return { file, entries: body.split("\n").length };
	}
	const file = writeBigSession(agentDir, generateMb * 1024 * 1024, "Longrun main");
	return { file, entries: 0 };
}

function seedBulk(count: number): void {
	const dir = bucketOf(work);
	mkdirSync(dir, { recursive: true });
	for (let i = 0; i < count; i++) {
		const h = i.toString(16).padStart(4, "0");
		const id = `01a00000-0000-7000-8000-0000000c${h}`;
		const stamp = new Date(Date.UTC(2026, 0, 6, 0, i % 60)).toISOString();
		const msg = (n: number, parentId: string | null, role: string, text: string) => ({
			type: "message",
			id: `c${h}${n}`,
			parentId,
			timestamp: stamp,
			message: { role, content: [{ type: "text", text }], ...(role === "user" ? { attribution: "user" } : {}) },
		});
		const lines = [
			{ type: "session", version: 3, id, timestamp: stamp, cwd: work },
			msg(1, null, "user", `Bulk conversation ${i}?`),
			msg(2, `c${h}1`, "assistant", `Bulk conversation ${i}.`),
		];
		writeFileSync(
			join(dir, `2026-01-06T00-${String(i % 60).padStart(2, "0")}-00-000Z_${id}.jsonl`),
			`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
		);
	}
}

function seedMid(n: number, title: string, turns: number): string {
	const turnList = Array.from({ length: turns }, (_, i) => ({
		prompt: `${title} question ${i}: what does item ${i} do?`,
		reply: `Answer ${i}: ${"item ".repeat(40)}is fine.`,
	}));
	return writeChatSession(agentDir, { n, title, cwd: work, turns: turnList });
}

writeFileSync(
	join(agentDir, "config.yml"),
	"modelRoles:\n  default: anthropic/claude-haiku-5-5:low\n  smol: anthropic/claude-haiku-5-5\n  slow: anthropic/claude-haiku-5-5\n  tiny: anthropic/claude-haiku-5-5:low\n  commit: anthropic/claude-haiku-5-5\nspelling:\n  autocomplete: ngram\n",
);
const wrapper = writeLongFakeOmp(workdir);

// ------------------------------------------------------------------ server, and the connection the page uses
let server: ChildProcess | null = null;
const serverLog = createWriteStream(join(outDir, "server.log"));

async function startServer(): Promise<void> {
	const preload = wsLimit ? ["--preload", join(root, "tests/support/ws-backpressure-preload.ts")] : [];
	server = spawn("bun", [...preload, join(root, "server/main.ts")], {
		cwd: root,
		env: {
			...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("OMP_WEBUI_"))),
			HOME: home,
			PI_CODING_AGENT_DIR: agentDir,
			PI_NO_TITLE: "1",
			ANTHROPIC_API_KEY: "ompw-offline-placeholder",
			OMP_BIN: wrapper,
			OMP_WEBUI_DIST: dist,
			OMP_WEBUI_DATA_DIR: join(workdir, "data"),
			OMP_WEBUI_PORT: String(port),
			OMP_WEBUI_TOKEN: token,
			OMP_WEBUI_UPDATE_CHECK: "off",
			OMP_WEBUI_AUTO_TITLE: "off",
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	server.stdout?.pipe(serverLog, { end: false });
	server.stderr?.pipe(serverLog, { end: false });
	started.push(server);
	const deadline = Date.now() + 30_000;
	for (;;) {
		try {
			if ((await fetch(`http://127.0.0.1:${port}/api/meta`, { headers: { "x-omp-webui-token": token } })).ok) return;
		} catch {}
		if (Date.now() > deadline) throw new Error("the server did not start");
		await sleep(200);
	}
}

/** A TCP relay between the page and the server that can drop what it carries while keeping both ends open. */
type Wire = "pass" | "drop";
function startProxy(): { mode: (m: Wire) => void; close: () => void } {
	let mode: Wire = "pass";
	const sockets = new Set<net.Socket>();
	const listener = net.createServer((client) => {
		const up = net.connect(port, "127.0.0.1");
		sockets.add(client).add(up);
		client.on("data", (d) => mode === "pass" && up.write(d));
		up.on("data", (d) => mode === "pass" && client.write(d));
		const end = () => {
			client.destroy();
			up.destroy();
		};
		client.on("close", end).on("error", end);
		up.on("close", end).on("error", end);
	});
	listener.listen(proxyPort, "127.0.0.1");
	return {
		mode: (m) => {
			mode = m;
		},
		close: () => {
			listener.close();
			for (const s of sockets) s.destroy();
		},
	};
}

// ------------------------------------------------------------------ what the page records about itself
/** Installed before the app loads: counts what the socket carries, and what the main thread could not do in time. */
function recorder(): void {
	const lr = {
		wsFrames: 0,
		wsBytes: 0,
		assistantEnds: 0,
		sent: [] as { t: number; type?: string; cmd?: string; req?: string }[],
		replies: {} as Record<string, number>,
		lag: [] as number[],
		longtasks: [] as { start: number; dur: number }[],
		events: [] as { name: string; dur: number; delay: number; start: number }[],
		raf: { n: 0, gaps: [] as number[], last: 0 },
		hidden: false,
		setHidden: (_v: boolean) => {},
		openSockets: 0,
		timers: { set: 0, cleared: 0 },
	};
	(window as unknown as { __lr: typeof lr }).__lr = lr;
	const proto = WebSocket.prototype;
	const nativeSend = proto.send;
	proto.send = function (this: WebSocket, data: Parameters<WebSocket["send"]>[0]) {
		try {
			const m = JSON.parse(String(data));
			lr.sent.push({ t: performance.now(), type: m.t, cmd: m.command?.type, req: m.req });
			if (lr.sent.length > 5000) lr.sent.splice(0, 2500);
		} catch {}
		return nativeSend.call(this, data);
	};
	const desc = Object.getOwnPropertyDescriptor(proto, "onmessage") as PropertyDescriptor;
	Object.defineProperty(proto, "onmessage", {
		configurable: true,
		get() {
			return desc.get?.call(this);
		},
		set(fn: ((ev: MessageEvent) => unknown) | null) {
			desc.set?.call(
				this,
				fn
					? function (this: WebSocket, ev: MessageEvent) {
							const t = performance.now();
							lr.lag.push(t - ev.timeStamp);
							const s = typeof ev.data === "string" ? ev.data : "";
							lr.wsFrames++;
							lr.wsBytes += s.length;
							if (s.startsWith('{"t":"reply"')) {
								const m = /"req":"(r\d+)"/.exec(s.slice(0, 80));
								if (m) lr.replies[m[1]] = t;
							} else if (s.startsWith("~")) {
								// A big reply comes in parts (shared/reply-parts.ts): it is there with the last one.
								const m = /^~(r\d+)~1~/.exec(s.slice(0, 30));
								if (m) lr.replies[m[1]] = t;
							} else if (s.length < 300_000 && s.includes('"type":"message_end"') && s.includes('"role":"assistant"'))
								lr.assistantEnds++;
							return fn.call(this, ev);
						}
					: fn,
			);
		},
	});
	new PerformanceObserver((list) => {
		for (const e of list.getEntries()) lr.longtasks.push({ start: e.startTime, dur: e.duration });
	}).observe({ type: "longtask", buffered: true });
	new PerformanceObserver((list) => {
		for (const e of list.getEntries() as PerformanceEventTiming[])
			lr.events.push({ name: e.name, dur: e.duration, delay: e.processingStart - e.startTime, start: e.startTime });
	}).observe({ type: "event", durationThreshold: 16, buffered: true } as PerformanceObserverInit);

	// Hiding the page: no paint (animation frames wait) and timers at one a second, as a background tab or an occluded window has.
	let hidden = false;
	const queued: [number, FrameRequestCallback][] = [];
	let fakeId = 1_000_000;
	const nativeRaf = window.requestAnimationFrame.bind(window);
	const nativeCancel = window.cancelAnimationFrame.bind(window);
	window.requestAnimationFrame = (cb) => {
		if (!hidden) return nativeRaf(cb);
		queued.push([++fakeId, cb]);
		return fakeId;
	};
	window.cancelAnimationFrame = (id) => {
		const at = queued.findIndex(([i]) => i === id);
		if (at >= 0) queued.splice(at, 1);
		else nativeCancel(id);
	};
	const nativeTimeout = window.setTimeout.bind(window);
	window.setTimeout = ((fn: TimerHandler, ms?: number, ...rest: unknown[]) =>
		nativeTimeout(fn, hidden ? Math.max(ms ?? 0, 1000) : ms, ...rest)) as typeof window.setTimeout;
	Object.defineProperty(document, "visibilityState", {
		configurable: true,
		get: () => (hidden ? "hidden" : "visible"),
	});
	Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
	lr.setHidden = (v) => {
		hidden = v;
		lr.hidden = v;
		document.dispatchEvent(new Event("visibilitychange"));
		if (!v) for (const [, cb] of queued.splice(0)) nativeRaf(cb);
	};
	const tick = (ts: number) => {
		if (lr.raf.last) lr.raf.gaps.push(ts - lr.raf.last);
		lr.raf.last = ts;
		nativeRaf(tick);
	};
	nativeRaf(tick);
	localStorage.setItem("ompw.autoTitle", "off");
}

// ------------------------------------------------------------------ sampling
/** What the recorder keeps (see `recorder`) that the sampler reads and empties. */
interface PageRecord {
	assistantEnds: number;
	wsFrames: number;
	wsBytes: number;
	sent: { t: number; req?: string; cmd?: string }[];
	replies: Record<string, number>;
	lag: number[];
	longtasks: { start: number; dur: number }[];
	events: { name: string; dur: number; delay: number; start: number }[];
	raf: { gaps: number[] };
}

interface Metrics {
	[name: string]: number;
}

const percentile = (xs: number[], p: number): number => {
	if (!xs.length) return 0;
	const sorted = [...xs].sort((a, b) => a - b);
	return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))];
};

class Sampler {
	private last: Metrics = {};
	private lastAt = performance.now();
	private lastEnds = 0;
	readonly rows: Record<string, number | string>[] = [];

	constructor(
		private readonly page: Page,
		private readonly cdp: CDPSession,
	) {}

	private async metrics(): Promise<Metrics> {
		const { metrics } = (await this.cdp.send("Performance.getMetrics")) as {
			metrics: { name: string; value: number }[];
		};
		return Object.fromEntries(metrics.map((m) => [m.name, m.value]));
	}

	/** One row: what the window since the last one cost, and what the page holds now. */
	async sample(extra: Record<string, number | string> = {}): Promise<Record<string, number | string>> {
		const now = performance.now();
		const before = await this.metrics();
		const page = await this.page.evaluate(() => {
			const lr = (window as unknown as { __lr: PageRecord }).__lr;
			const out = {
				ends: lr.assistantEnds as number,
				frames: lr.wsFrames as number,
				bytes: lr.wsBytes as number,
				lag: lr.lag.splice(0) as number[],
				longs: lr.longtasks.splice(0) as { dur: number }[],
				events: lr.events.splice(0) as { name: string; dur: number; delay: number }[],
				gaps: lr.raf.gaps.splice(0) as number[],
				// Requests older than 10 s that nothing has answered: what a button or a refresh is still waiting for.
				unanswered: (lr.sent as { t: number; req?: string; cmd?: string }[]).filter(
					(m) => m.req && lr.replies[m.req] === undefined && performance.now() - m.t > 10_000,
				).length as number,
				unansweredCmds: [
					...new Set(
						(lr.sent as { t: number; req?: string; cmd?: string }[])
							.filter((m) => m.req && lr.replies[m.req] === undefined && performance.now() - m.t > 10_000)
							.map((m) => m.cmd),
					),
				]
					.slice(0, 4)
					.join(",") as string,
				rows: document.querySelectorAll('[data-testid="agent-turn"] > *').length,
				turns: document.querySelectorAll('[data-testid="agent-turn"]').length,
			};
			return out;
		});
		await this.cdp.send("HeapProfiler.collectGarbage");
		const after = await this.metrics();
		const promises = await this.promises();
		// The collection above stops the page for a while: that gap is the sampler's, not the page's.
		await this.page.evaluate(() => {
			const lr = (window as unknown as { __lr: { raf: { last: number; gaps: number[] } } }).__lr;
			lr.raf.last = 0;
			lr.raf.gaps.length = 0;
		});
		const dt = (now - this.lastAt) / 1000;
		const d = (name: string) => (before[name] ?? 0) - (this.last[name] ?? 0);
		const steps = page.ends - this.lastEnds;
		const row = {
			t: Math.round((now - t0) / 1000),
			steps: page.ends,
			dSteps: steps,
			heapMB: +((after.JSHeapUsedSize ?? 0) / 1048576).toFixed(1),
			nodes: after.Nodes ?? 0,
			listeners: after.JSEventListeners ?? 0,
			rows: page.rows,
			promises,
			unanswered: page.unanswered,
			unansweredCmds: page.unansweredCmds,
			busyPct: +((100 * d("TaskDuration")) / dt).toFixed(1),
			scriptPct: +((100 * d("ScriptDuration")) / dt).toFixed(1),
			layoutPct: +((100 * (d("LayoutDuration") + d("RecalcStyleDuration"))) / dt).toFixed(1),
			msPerStep: steps > 0 ? +((1000 * d("TaskDuration")) / steps).toFixed(1) : 0,
			frames: page.frames,
			longN: page.longs.length,
			longMaxMs: Math.round(Math.max(0, ...page.longs.map((l) => l.dur))),
			evMaxMs: Math.round(Math.max(0, ...page.events.map((e) => e.dur))),
			evOver200: page.events.filter((e) => e.dur > 200).length,
			lagP95: Math.round(percentile(page.lag, 95)),
			lagMax: Math.round(Math.max(0, ...page.lag)),
			rafOver100: page.gaps.filter((g) => g > 100).length,
			rafMax: Math.round(Math.max(0, ...page.gaps)),
			serverRssMB: this.serverRss(),
			...extra,
		};
		this.last = before;
		this.lastAt = performance.now();
		this.lastEnds = page.ends;
		this.rows.push(row);
		return row;
	}

	/** How many promises are alive after a collection: a count that climbs is something waiting that never settles. */
	private async promises(): Promise<number> {
		try {
			const proto = (await this.cdp.send("Runtime.evaluate", { expression: "Promise.prototype" })) as {
				result: { objectId: string };
			};
			const held = (await this.cdp.send("Runtime.queryObjects", { prototypeObjectId: proto.result.objectId })) as {
				objects: { objectId: string };
			};
			const count = (await this.cdp.send("Runtime.callFunctionOn", {
				objectId: held.objects.objectId,
				functionDeclaration: "function () { return this.length }",
				returnByValue: true,
			})) as { result: { value: number } };
			await this.cdp.send("Runtime.releaseObject", { objectId: held.objects.objectId });
			return count.result.value;
		} catch {
			return -1;
		}
	}

	private serverRss(): number {
		try {
			const pid = server?.pid;
			if (!pid) return 0;
			return Math.round(
				Number(execFileSync("ps", ["-o", "rss=", "-p", String(pid)], { encoding: "utf8" }).trim()) / 1024,
			);
		} catch {
			return 0;
		}
	}
}

// ------------------------------------------------------------------ probes: what a click costs
interface Probe {
	what: string;
	/** Host milliseconds from the click to the message leaving the page (main thread busy shows here). */
	toSent: number | null;
	/** … to the reply reaching the page. */
	toReply: number | null;
	/** … to the screen showing the result (the Stop button gone, the Send button free). */
	toUi: number | null;
	stuck: boolean;
}

async function clickAt(page: Page, testid: string): Promise<{ at: number; ok: boolean }> {
	const box = await page
		.getByTestId(testid)
		.first()
		.boundingBox({ timeout: 5000 })
		.catch(() => null);
	if (!box) return { at: 0, ok: false };
	const at = Date.now();
	await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
	return { at, ok: true };
}

/** Wait for a message of this kind to be sent after `since` (host ms); resolves its time (host ms) and request id, or null at the deadline. */
async function sentAfter(
	page: Page,
	since: number,
	cmd: string | null,
	within: number,
): Promise<{ t: number; req: string } | null> {
	const deadline = Date.now() + within;
	while (Date.now() < deadline) {
		const found = await page.evaluate(
			([sinceMs, command]) => {
				const lr = (window as unknown as { __lr: { sent: { t: number; cmd?: string; req?: string }[] } }).__lr;
				const m = lr.sent.find(
					(s) =>
						s.t + performance.timeOrigin >= (sinceMs as number) - 1 && (command ? s.cmd === command : true) && s.req,
				);
				return m ? { t: m.t + performance.timeOrigin, req: m.req as string } : null;
			},
			[since, cmd] as [number, string | null],
		);
		if (found) return found;
		await sleep(25);
	}
	return null;
}

async function replyAt(page: Page, req: string, within: number): Promise<number | null> {
	const deadline = Date.now() + within;
	while (Date.now() < deadline) {
		const t = await page.evaluate((r) => {
			const lr = (window as unknown as { __lr: { replies: Record<string, number> } }).__lr;
			return lr.replies[r] === undefined ? null : lr.replies[r] + performance.timeOrigin;
		}, req);
		if (t !== null) return t;
		await sleep(25);
	}
	return null;
}

const BOUND_MS = 15_000;
let stuckShots = 0;

/** What the page shows when a probe gave up: a screenshot, and the toasts and status text next to the composer. */
async function stuckEvidence(page: Page, what: string): Promise<void> {
	const n = ++stuckShots;
	const text = await page
		.evaluate(() => ({
			toasts: [...document.querySelectorAll('[data-testid="toast"], [role="status"], [role="alert"]')].map((e) =>
				(e.textContent ?? "").slice(0, 160),
			),
			working: document.body.innerText.includes("Working…"),
			composer: (document.querySelector('[data-testid="composer"]') as HTMLTextAreaElement | null)?.value?.slice(0, 80),
			sendDisabled: (document.querySelector('[data-testid="send"]') as HTMLButtonElement | null)?.disabled,
			stop: Boolean(document.querySelector('[data-testid="stop"]')),
			// What left the page last, and which of it was answered.
			sent: (() => {
				const lr = (
					window as unknown as {
						__lr: { sent: { t: number; type?: string; cmd?: string; req?: string }[]; replies: Record<string, number> };
					}
				).__lr;
				return lr.sent
					.slice(-14)
					.map(
						(m) =>
							`${m.type}${m.cmd ? `:${m.cmd}` : ""}${m.req ? `#${m.req}${lr.replies[m.req] === undefined ? " NO REPLY" : ""}` : ""}`,
					);
			})(),
		}))
		.catch(() => null);
	log(`${what} gave up: ${JSON.stringify(text)}`);
	await page.screenshot({ path: join(outDir, `stuck-${n}.png`) }).catch(() => {});
}

/** Click Stop (while a turn runs) and time what follows. */
async function stopProbe(page: Page): Promise<Probe> {
	const p: Probe = { what: "stop", toSent: null, toReply: null, toUi: null, stuck: false };
	const click = await clickAt(page, "stop");
	if (!click.ok) return { ...p, what: "stop (no button)", stuck: true };
	const sent = await sentAfter(page, click.at, "abort_and_restore_queue", BOUND_MS);
	if (!sent) return { ...p, stuck: true };
	p.toSent = Math.round(sent.t - click.at);
	const reply = await replyAt(page, sent.req, BOUND_MS);
	if (reply === null) return { ...p, stuck: true };
	p.toReply = Math.round(reply - click.at);
	const deadline = Date.now() + BOUND_MS;
	while (Date.now() < deadline) {
		if ((await page.getByTestId("stop").count()) === 0) {
			p.toUi = Date.now() - click.at;
			return p;
		}
		await sleep(25);
	}
	return { ...p, stuck: true };
}

/** Type a prompt and click Send; time the message, the reply, and the composer coming free again. */
async function sendProbe(page: Page, text: string): Promise<Probe> {
	const p: Probe = { what: "send", toSent: null, toReply: null, toUi: null, stuck: false };
	const composer = page.getByTestId("composer");
	await composer.fill(text, { timeout: 10_000 }).catch(() => {});
	const click = await clickAt(page, "send");
	if (!click.ok) return { ...p, what: "send (no button)", stuck: true };
	const sent = await sentAfter(page, click.at, "prompt", BOUND_MS);
	if (!sent) {
		await stuckEvidence(page, "send (no message left the page)");
		return { ...p, stuck: true };
	}
	p.toSent = Math.round(sent.t - click.at);
	const reply = await replyAt(page, sent.req, BOUND_MS);
	if (reply === null) return { ...p, stuck: true };
	p.toReply = Math.round(reply - click.at);
	const deadline = Date.now() + BOUND_MS;
	while (Date.now() < deadline) {
		// "Working…" under the composer is the page waiting for the reply (it also disables Send).
		if ((await page.getByText(/^Working…/).count()) === 0) {
			p.toUi = Date.now() - click.at;
			return p;
		}
		await sleep(25);
	}
	return { ...p, stuck: true };
}

const fakeScript = (o: Record<string, unknown> = {}) =>
	`@@fake ${JSON.stringify({ steps, stepMs, reminderEvery: 40, subagentEvery: 25, toolBytes: 4000, ...o })}`;

// ------------------------------------------------------------------ opening things
async function openConversation(page: Page, file: string): Promise<number> {
	const t = Date.now();
	await page.goto(`http://127.0.0.1:${proxyPort}/#/s/${encodeURIComponent(file)}`);
	await page.getByTestId("composer").waitFor({ timeout: 120_000 });
	await page
		.waitForFunction(
			() => document.querySelectorAll('[data-testid="agent-turn"], [data-testid="message"]').length > 0,
			null,
			{ timeout: 120_000 },
		)
		.catch(() => {});
	return Date.now() - t;
}

async function heapSnapshot(cdp: CDPSession, path: string): Promise<void> {
	const out = createWriteStream(path);
	const onChunk = (e: { chunk: string }) => out.write(e.chunk);
	cdp.on("HeapProfiler.addHeapSnapshotChunk", onChunk);
	await cdp.send("HeapProfiler.takeHeapSnapshot", { reportProgress: false });
	cdp.off("HeapProfiler.addHeapSnapshotChunk", onChunk);
	await new Promise<void>((r) => out.end(r));
	log(`heap snapshot -> ${path}`);
}

async function cpuProfile(cdp: CDPSession, ms: number, path: string): Promise<void> {
	await cdp.send("Profiler.enable");
	await cdp.send("Profiler.setSamplingInterval", { interval: 500 });
	await cdp.send("Profiler.start");
	await sleep(ms);
	const { profile } = (await cdp.send("Profiler.stop")) as { profile: unknown };
	writeFileSync(path, JSON.stringify(profile));
	log(`cpu profile -> ${path}`);
}

// ------------------------------------------------------------------ scenarios
function report(rows: Record<string, number | string>[], probes: (Probe & { t: number })[]): void {
	const cols = [
		"t",
		"steps",
		"heapMB",
		"nodes",
		"listeners",
		"rows",
		"promises",
		"unanswered",
		"busyPct",
		"scriptPct",
		"layoutPct",
		"msPerStep",
		"longN",
		"longMaxMs",
		"evMaxMs",
		"evOver200",
		"lagP95",
		"lagMax",
		"rafOver100",
		"rafMax",
		"serverRssMB",
	];
	console.log(cols.join("\t"));
	for (const r of rows) console.log(cols.map((c) => r[c] ?? "").join("\t"));
	if (probes.length) {
		console.log("\nprobe\tt\ttoSent\ttoReply\ttoUi\tstuck");
		for (const p of probes)
			console.log(
				`${p.what}\t${p.t}\t${p.toSent ?? "-"}\t${p.toReply ?? "-"}\t${p.toUi ?? "-"}\t${p.stuck ? "STUCK" : ""}`,
			);
	}
	writeFileSync(join(outDir, "samples.json"), JSON.stringify({ rows, probes }, null, 1));
}

async function runGoal(page: Page, cdp: CDPSession, main: string): Promise<void> {
	const sampler = new Sampler(page, cdp);
	const probes: (Probe & { t: number })[] = [];
	const loadMs = await openConversation(page, main);
	log(`opened the conversation in ${loadMs} ms`);
	const idle = await sampler.sample({ phase: "opened", loadMs });
	log(`opened: heap ${idle.heapMB} MB, ${idle.nodes} nodes`);
	if (wantHeap) await heapSnapshot(cdp, join(outDir, "heap-0.heapsnapshot"));

	const first = await sendProbe(page, fakeScript());
	probes.push({ ...first, t: Math.round((performance.now() - t0) / 1000) });
	log(
		`first send (starts omp on the whole conversation): sent ${first.toSent} ms, reply ${first.toReply} ms, ui ${first.toUi} ms${first.stuck ? " STUCK" : ""}`,
	);
	await sampler.sample({ phase: "started" });

	const end = performance.now() + minutes * 60_000;
	let n = 0;
	const streaming = async () => (await page.getByTestId("stop").count()) > 0;
	while (performance.now() < end) {
		await sleep(intervalMs);
		n++;
		if (wantProfile && profileRounds.includes(n)) await cpuProfile(cdp, 10_000, join(outDir, `cpu-${n}.cpuprofile`));
		const row = await sampler.sample({ phase: "run" });
		log(
			`t=${row.t}s steps=${row.steps} heap=${row.heapMB}MB nodes=${row.nodes} rows=${row.rows} busy=${row.busyPct}% ms/step=${row.msPerStep} long=${row.longN}/${row.longMaxMs}ms ev=${row.evMaxMs}ms`,
		);
		// Probes: a message queued behind the running turn, then Stop, then the run goes on.
		const at = Math.round((performance.now() - t0) / 1000);
		if (!(await streaming())) {
			probes.push({ ...(await sendProbe(page, fakeScript({ asAgent: true }))), what: "send (restart, idle)", t: at });
		} else if (n % 2 === 1) {
			probes.push({ ...(await sendProbe(page, "queued while it runs")), what: "send (while streaming)", t: at });
		} else {
			probes.push({ ...(await stopProbe(page)), t: at });
			// The run goes on: goal mode continues after an abort, as one turn.
			probes.push({ ...(await sendProbe(page, fakeScript({ asAgent: true }))), what: "send (after stop)", t: at });
		}
	}
	if (wantHeap) await heapSnapshot(cdp, join(outDir, "heap-1.heapsnapshot"));
	report(sampler.rows, probes);
}

async function runMulti(page: Page, cdp: CDPSession, main: string, mids: string[]): Promise<void> {
	const sampler = new Sampler(page, cdp);
	const probes: (Probe & { t: number })[] = [];
	const files = [main, ...mids];
	// Start every conversation's omp and its stream, one after the other.
	for (const [i, file] of files.entries()) {
		const ms = await openConversation(page, file);
		const p = await sendProbe(page, fakeScript({ steps: Math.floor(steps / (i + 1)) }));
		probes.push({
			...p,
			what: `send #${i + 1} (first, ${ms} ms to open)`,
			t: Math.round((performance.now() - t0) / 1000),
		});
		log(`conversation ${i + 1} started: sent ${p.toSent} ms, reply ${p.toReply} ms${p.stuck ? " STUCK" : ""}`);
	}
	await sampler.sample({ phase: "all started" });
	const end = performance.now() + minutes * 60_000;
	while (performance.now() < end) {
		// Look at each conversation in turn, and time the switch.
		for (const file of files) {
			const t = Date.now();
			await page.goto(`http://127.0.0.1:${proxyPort}/#/s/${encodeURIComponent(file)}`);
			await page.getByTestId("composer").waitFor({ timeout: 60_000 });
			await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
			probes.push({
				what: "switch",
				toSent: null,
				toReply: null,
				toUi: Date.now() - t,
				stuck: false,
				t: Math.round((performance.now() - t0) / 1000),
			});
			await sleep(intervalMs / files.length);
		}
		const row = await sampler.sample({ phase: "switching" });
		log(
			`t=${row.t}s steps=${row.steps} heap=${row.heapMB}MB nodes=${row.nodes} busy=${row.busyPct}% long=${row.longN}/${row.longMaxMs}ms`,
		);
		const stop = await stopProbe(page);
		probes.push({ ...stop, t: Math.round((performance.now() - t0) / 1000) });
	}
	report(sampler.rows, probes);
}

async function runHidden(page: Page, cdp: CDPSession, main: string): Promise<void> {
	const sampler = new Sampler(page, cdp);
	const probes: (Probe & { t: number })[] = [];
	await openConversation(page, main);
	probes.push({ ...(await sendProbe(page, fakeScript())), t: 0 });
	await sampler.sample({ phase: "started" });
	await sleep(15_000);
	await sampler.sample({ phase: "visible" });
	const hiddenMs = (minutes * 60_000) / 2;
	await page.evaluate(() => (window as unknown as { __lr: { setHidden(v: boolean): void } }).__lr.setHidden(true));
	log(`hidden for ${hiddenMs / 1000}s`);
	const hide0 = performance.now();
	while (performance.now() - hide0 < hiddenMs) {
		await sleep(intervalMs);
		const row = await sampler.sample({ phase: "hidden" });
		log(`hidden: t=${row.t}s steps=${row.steps} heap=${row.heapMB}MB busy=${row.busyPct}% frames=${row.frames}`);
	}
	const show = Date.now();
	await page.evaluate(() => (window as unknown as { __lr: { setHidden(v: boolean): void } }).__lr.setHidden(false));
	await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
	probes.push({
		what: "show again (to first paint)",
		toSent: null,
		toReply: null,
		toUi: Date.now() - show,
		stuck: false,
		t: Math.round((performance.now() - t0) / 1000),
	});
	for (let i = 0; i < 3; i++) {
		await sleep(intervalMs);
		const row = await sampler.sample({ phase: "shown" });
		log(
			`shown: t=${row.t}s steps=${row.steps} heap=${row.heapMB}MB busy=${row.busyPct}% long=${row.longN}/${row.longMaxMs}ms`,
		);
	}
	probes.push({ ...(await stopProbe(page)), t: Math.round((performance.now() - t0) / 1000) });
	report(sampler.rows, probes);
}

/** What happened to a click that has no answer: when the page told the user, or got its answer, whichever came first. */
interface Outcome {
	what: string;
	/** `answered`, `error shown`, `reconnecting banner`, or `nothing` (the page was still waiting at the end). */
	how: string;
	ms: number;
}

const WAIT_MS = 150_000;

/** Wait for the first sign that the page has dealt with request `req` (sent after `since`), up to `WAIT_MS`. */
const FAILURE_TEXT = /(Send|Stop|Pause) failed|Connection lost|No answer from the server/;

/** Let the toast of an earlier failure go (they last a few seconds), so that only this click's own is counted. */
async function untilNoFailureShown(page: Page): Promise<void> {
	const deadline = Date.now() + 20_000;
	while (Date.now() < deadline && (await page.getByText(FAILURE_TEXT).count()) > 0) await sleep(250);
}

async function outcomeOf(page: Page, what: string, since: number, cmd: string): Promise<Outcome> {
	const sent = await sentAfter(page, since, cmd, 20_000);
	const deadline = Date.now() + WAIT_MS;
	while (Date.now() < deadline) {
		if (
			sent &&
			(await page.evaluate(
				(r) => (window as unknown as { __lr: { replies: Record<string, number> } }).__lr.replies[r] !== undefined,
				sent.req,
			))
		)
			return { what, how: "answered", ms: Date.now() - since };
		if ((await page.getByText(FAILURE_TEXT).count()) > 0) return { what, how: "error shown", ms: Date.now() - since };
		if ((await page.getByText("Reconnecting to the omp-webui server").count()) > 0)
			return { what, how: "reconnecting banner", ms: Date.now() - since };
		await sleep(100);
	}
	return { what, how: "nothing", ms: WAIT_MS };
}

async function runDead(page: Page, cdp: CDPSession, main: string, wire: { mode: (m: Wire) => void }): Promise<void> {
	const sampler = new Sampler(page, cdp);
	const outcomes: Outcome[] = [];
	const probes: (Probe & { t: number })[] = [];
	const say = (o: Outcome) => {
		outcomes.push(o);
		log(`${o.what}: ${o.how} after ${(o.ms / 1000).toFixed(1)} s`);
	};
	const startRun = async () => {
		if ((await page.getByTestId("stop").count()) === 0)
			await sendProbe(page, fakeScript({ asAgent: true, steps: 2000, stepMs: 200 }));
	};
	await openConversation(page, main);
	probes.push({ ...(await sendProbe(page, fakeScript({ steps: 2000, stepMs: 200 }))), what: "send (healthy)", t: 0 });
	await sleep(2000);
	probes.push({ ...(await stopProbe(page)), what: "stop (healthy)", t: 0 });
	await startRun();
	await sleep(1500);

	// 1. The path drops everything it carries for a while, both ways, with both ends open.
	log("wire: drop");
	wire.mode("drop");
	let at = Date.now();
	await page
		.getByTestId("stop")
		.click({ timeout: 5000 })
		.catch(() => {});
	say(await outcomeOf(page, "Stop while the wire drops everything", at, "abort_and_restore_queue"));
	wire.mode("pass");
	await sleep(1000);
	// What the page says and can do after the wire is back (everything sent while it was down is gone).
	const banner = await page.getByText("Reconnecting to the omp-webui server").count();
	log(`wire back: reconnecting banner ${banner ? "still shown" : "gone"}`);
	await sleep(15_000);
	const stillBanner = await page.getByText("Reconnecting to the omp-webui server").count();
	say({
		what: "the page after the wire came back (15 s)",
		how: stillBanner ? "reconnecting banner" : "recovered",
		ms: 15_000,
	});
	await startRun();
	await sleep(1500);
	probes.push({ ...(await stopProbe(page)), what: "stop (after the wire came back)", t: 1 });
	await startRun();

	// 2. omp stops answering (swapped out, wedged); the server and the page are fine.
	const lives = (await (
		await fetch(`http://127.0.0.1:${port}/api/lives`, { headers: { "x-omp-webui-token": token } })
	).json()) as { pid: number | null }[];
	const ompPid = lives[0]?.pid;
	if (ompPid) {
		log(`omp ${ompPid}: SIGSTOP`);
		process.kill(ompPid, "SIGSTOP");
		at = Date.now();
		await page.getByTestId("composer").fill("queued while omp is stuck");
		await clickAt(page, "send");
		say(await outcomeOf(page, "Send while omp is stuck", at, "prompt"));
		await untilNoFailureShown(page);
		at = Date.now();
		await page
			.getByTestId("stop")
			.click({ timeout: 5000 })
			.catch(() => {});
		say(await outcomeOf(page, "Stop while omp is stuck", at, "abort_and_restore_queue"));
		process.kill(ompPid, "SIGCONT");
		log(`omp ${ompPid}: SIGCONT`);
		await sleep(3000);
	}

	// 3. The server stops for a while (busy, swapped out) and continues.
	const pid = server?.pid as number;
	await startRun();
	log("server: SIGSTOP");
	process.kill(pid, "SIGSTOP");
	at = Date.now();
	const stopped = page
		.getByTestId("stop")
		.click({ timeout: 5000 })
		.catch(() => {});
	await sleep(20_000);
	process.kill(pid, "SIGCONT");
	log("server: SIGCONT");
	await stopped;
	say(await outcomeOf(page, "Stop while the server is stopped for 20 s", at, "abort_and_restore_queue"));
	await sleep(3000);
	const rows = [await sampler.sample({ phase: "end" })];
	report(rows, probes);
	console.log("\nwhat the user saw\twhen\tafter");
	for (const o of outcomes) console.log(`${o.what}\t${o.how}\t${(o.ms / 1000).toFixed(1)} s`);
	writeFileSync(join(outDir, "outcomes.json"), JSON.stringify(outcomes, null, 1));
}

// ------------------------------------------------------------------ main
async function main(): Promise<void> {
	const wire = startProxy();
	let browser: Browser | null = null;
	// Also what SIGINT/SIGTERM run (a `finally` does not on a signal). The server may be SIGSTOPped by a scenario at that
	// moment (`dead`): killTree continues it first, or it would keep its port and ignore the SIGTERM.
	const cleanup = onShutdown(async () => {
		wire.close();
		await browser?.close().catch(() => {});
		if (server?.pid) await killTree(server.pid, 5000);
		// What the server started for the conversations (relays, the fake omp): ours, by the path it was given. They
		// outlive a server that died first, so they are found by their command line, not as its children.
		let orphans: number[] = [];
		try {
			orphans = execFileSync("pgrep", ["-f", workdir], { encoding: "utf8" }).split("\n").filter(Boolean).map(Number);
		} catch {}
		await Promise.all(orphans.filter((pid) => pid !== process.pid).map((pid) => killTree(pid, 2000)));
		rmSync(workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		log("cleaned up");
	});
	try {
		log(`workdir ${workdir}; dist ${dist}`);
		const mainSession = seedMain();
		const mids =
			scenario === "multi"
				? [seedMid(1, "Mid one", 150), seedMid(2, "Mid two", 150), seedMid(3, "Mid three", 150)]
				: [];
		seedBulk(300);
		log(
			`seeded: main ${mainSession.file.split("/").at(-1)} (${(readFileSync(mainSession.file).length / 1048576).toFixed(1)} MB), ${mids.length} more, 300 small`,
		);
		await startServer();
		// Playwright would handle the signals itself (close the browser, exit) and race `cleanup` above, which does both.
		browser = await chromium.launch({
			channel: "chromium",
			headless: true,
			handleSIGINT: false,
			handleSIGTERM: false,
			handleSIGHUP: false,
		});
		const context: BrowserContext = await browser.newContext({
			viewport: { width: 1400, height: 900 },
			locale: "en-US",
		});
		await context.addCookies([
			{
				name: "ompw_token",
				value: token,
				domain: "127.0.0.1",
				path: "/",
				httpOnly: true,
				secure: false,
				sameSite: "Strict",
			},
		]);
		await context.addInitScript(recorder);
		const page = await context.newPage();
		page.on("pageerror", (e) => log(`pageerror: ${e.message}`));
		const cdp = await context.newCDPSession(page);
		await cdp.send("Performance.enable");
		if (scenario === "serve") {
			// Only the world: for poking at it by hand (a raw WebSocket, curl). Ends after `--minutes`.
			console.log(JSON.stringify({ url: `http://127.0.0.1:${port}`, token, session: mainSession.file, agentDir }));
			await sleep(minutes * 60_000);
		} else if (scenario === "goal") await runGoal(page, cdp, mainSession.file);
		else if (scenario === "multi") await runMulti(page, cdp, mainSession.file, mids);
		else if (scenario === "hidden") await runHidden(page, cdp, mainSession.file);
		else if (scenario === "dead") await runDead(page, cdp, mainSession.file, wire);
		else throw new Error(`unknown scenario ${scenario}`);
	} finally {
		await cleanup();
	}
}

await main();
process.exit(0);
