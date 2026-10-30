/**
 * Soak harness (`bun scripts/soak.ts --help`): hours of real use, against the real omp and Claude Haiku 5.5.
 *
 * An isolated world (tests/support/server.ts: a HOME, an agent directory and a data directory of its own, every model
 * role on anthropic/claude-haiku-5-5), the built web UI open in headless Chromium, and a simulated user: several
 * conversations run at once, each given a short prompt every so often that makes the model do cheap tool work or hand
 * a task to a subagent; the page switches between them, scrolls, opens the Agents panel, the settings and the search;
 * now and then a conversation is closed and another opened (or an old one resumed), and a goal is set, paused and
 * resumed in one of them.
 *
 * Every `--interval` seconds the harness measures what grows when something leaks: the server's memory, CPU and open
 * file descriptors, the omp processes and everything else below the server, the page's JS heap and DOM, how long
 * the page takes to answer and to show a click, WebSocket reconnects, errors. It writes `series.csv`, `series.json` and
 * `report.md` (start, end, max and the slope of each metric over the last hour, with a verdict) after every sample, so a
 * run that is stopped still has its report.
 *
 * Nothing here touches ~/.omp or a running omp-webui. The harness runs itself a second time as a child, so that what the
 * server writes to stderr lands in `server.stderr.log` (and is counted); all processes and temp dirs are removed at
 * the end, also on Ctrl-C and SIGTERM.
 */
import { spawn } from "node:child_process";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	readSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { loadavg } from "node:os";
import { basename, join, resolve } from "node:path";
import { type Browser, type BrowserContext, type CDPSession, chromium, type Page } from "playwright";
import { relayDirPath } from "../server/omp/relay-client.ts";
import { PREFS_SYNC_KEY } from "../shared/prefs.ts";
import type { LiveListing, SessionSummary } from "../shared/protocol.ts";
import { canCallModel } from "../tests/support/omp-env.ts";
import { removeRelayDir } from "../tests/support/relay-dirs.ts";
import { startTestServer, type TestServer } from "../tests/support/server.ts";
import {
	descendants,
	type EventKind,
	isZombie,
	kindOf,
	type Latency,
	type PowerCheck,
	type ProcRow,
	parseLsof,
	parsePmsetLog,
	parsePs,
	renderReport,
	type Sample,
	type SoakEvent,
	toCsv,
	verdictOf,
} from "../tests/support/soak-stats.ts";
import { connect, request } from "../tests/support/ws.ts";
import { armTurn, disarmTurn, isBusy, NO_TURN, nextTurn, pollTurn, type TurnState } from "./lib/turn-tracking.ts";

// ------------------------------------------------------------------ options
const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const root = resolve(import.meta.dir, "..");
const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);

if (args.includes("--help")) {
	console.log(`bun scripts/soak.ts [options]   (needs an Anthropic login: \`omp token anthropic\`; only Claude Haiku 5.5 is called)
  --minutes 180        how long the load runs
  --interval 60        seconds between samples
  --conversations 3    conversations kept active at once
  --think 60           mean seconds a conversation waits after a reply before its next prompt
  --subagent-every 4   every n-th prompt of a conversation hands a task to a subagent
  --rotate <min>       a conversation is closed and another opened (or an old one resumed) every so many minutes
                       (default 30, at most a quarter of the run)
  --goal-every <min>   a goal is set, paused and resumed in one conversation every so many minutes
                       (default 40, at most a third of the run)
  --stuck-min 10       a turn that runs longer than this is reported as a hang (and stopped)
  --max-cost 10        stop the run when the conversations have cost more than this many dollars
  --seed <n>           seed of the harness's own random choices (printed; default: the clock)
  --label <name>       default soak-<date>
  --out <dir>          outputs (default .tmp/soak/<label>)
  --dist <dir>         built web UI (default dist/web; built with vite when missing)
  --headed             show the browser

The harness holds the machine awake with \`caffeinate -dimsu\` and checks \`pmset -g log\` for Sleep/Wake events in the run
window at the end: a run that spans a sleep is reported INVALID (exit code 3). Other exit codes: 0 no crash or hang and no
sustained growth, 1 crash, hang, harness error or (for a run of an hour or more) growth, 2 no Anthropic login, 130 interrupted.`);
	process.exit(0);
}

const label = opt("label", `soak-${stamp}`);
const outDir = resolve(opt("out", join(root, ".tmp", "soak", label)));
const stderrLog = join(outDir, "server.stderr.log");

// ------------------------------------------------------------------ supervisor
/**
 * The server inherits its stderr from whoever starts it (tests/support/server.ts), so the harness runs itself as a
 * child whose stderr is the log file: what the server complains about is counted, not lost in a terminal.
 */
async function supervise(): Promise<never> {
	mkdirSync(outDir, { recursive: true });
	const fd = openSync(stderrLog, "w");
	// Holds the machine awake for as long as this process lives (-w): display, idle, disk, system and user-idle sleep.
	// A run that spans a sleep is invalid (see `checkPower`).
	let keepAwake: number | undefined;
	try {
		const caff = spawn("caffeinate", ["-dimsu", "-w", String(process.pid)], { stdio: "ignore" });
		caff.on("error", () => {});
		caff.unref();
		keepAwake = caff.pid;
	} catch {}
	const child = spawn(process.execPath, [import.meta.path, ...args], {
		stdio: ["inherit", "inherit", fd],
		env: { ...process.env, OMPW_SOAK_CHILD: "1", OMPW_SOAK_CAFFEINATE: keepAwake ? String(keepAwake) : "" },
	});
	closeSync(fd);
	// A terminal's Ctrl-C reaches the child itself; a signal sent to this process alone is passed on (the child
	// treats two in quick succession as one).
	for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) process.on(sig, () => child.kill(sig));
	const code = await new Promise<number>((done) => child.on("exit", (c, s) => done(c ?? (s ? 130 : 1))));
	if (code > 3 && code !== 130) {
		console.error(`soak: the harness ended with code ${code}; the end of its stderr:`);
		try {
			console.error(readFileSync(stderrLog, "utf8").split("\n").slice(-25).join("\n"));
		} catch {}
	}
	process.exit(code);
}

if (!process.env.OMPW_SOAK_CHILD) await supervise();

// ------------------------------------------------------------------ parameters
const minutes = Number(opt("minutes", "180"));
const intervalS = Number(opt("interval", "60"));
const nConvs = Number(opt("conversations", "3"));
const thinkS = Number(opt("think", "60"));
const subagentEvery = Math.max(1, Number(opt("subagent-every", "4")));
const plannedS = minutes * 60;
const rotateS = Math.min(Number(opt("rotate", "30")) * 60, plannedS / 4);
const goalEveryS = Math.min(Number(opt("goal-every", "40")) * 60, plannedS / 3);
const stuckS = Number(opt("stuck-min", "10")) * 60;
const maxCost = Number(opt("max-cost", "10"));
const seed = Number(opt("seed", String(Date.now() % 2 ** 31)));
const headed = args.includes("--headed");
const dist = resolve(opt("dist", join(root, "dist", "web")));
const MODEL = /haiku/i;
/** When the harness started: `pmset -g log` is asked for sleep events from here to the end. */
const harnessStartMs = Date.now();

const sleepRaw = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
/** The load's start: set once the server and the page are up, so that `t` in every output counts from there. */
let t0 = performance.now();
const nowS = () => (performance.now() - t0) / 1000;
const log = (m: string) => {
	const s = Math.round(nowS());
	console.log(`[${String(Math.floor(s / 60)).padStart(3)}:${String(s % 60).padStart(2, "0")}] ${m}`);
};

/** The harness's own random choices: a seeded generator, so that a run can be repeated. */
let rngState = seed >>> 0;
function rng(): number {
	rngState = (rngState + 0x6d2b79f5) >>> 0;
	let t = rngState;
	t = Math.imul(t ^ (t >>> 15), t | 1);
	t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
	return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const between = (lo: number, hi: number) => lo + rng() * (hi - lo);
const pick = <T>(xs: T[]): T => xs[Math.floor(rng() * xs.length)];

// ------------------------------------------------------------------ stopping
let stopping = false;
let endReason = "completed";
let firstSignalAt = 0;
const stopped = Promise.withResolvers<void>();

/** Sleep for `ms`, or until the run is stopped. */
const sleep = (ms: number) => Promise.race([sleepRaw(ms), stopped.promise]);

function stopRun(reason: string): void {
	if (stopping) return;
	stopping = true;
	endReason = reason;
	stopped.resolve();
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
	const { promise, resolve: done, reject } = Promise.withResolvers<T>();
	const timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms);
	p.then(done, reject).finally(() => clearTimeout(timer));
	return promise;
}

async function until(cond: () => Promise<boolean>, timeoutMs: number, everyMs = 500): Promise<boolean> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		if (await cond()) return true;
		if (Date.now() > end || stopping) return false;
		await sleepRaw(everyMs);
	}
}

// ------------------------------------------------------------------ what is recorded
const events: SoakEvent[] = [];
const samples: Sample[] = [];
const latencies: Latency[] = [
	{ name: "newChat", what: "New chat: click until omp is ready", points: [] },
	{ name: "firstSend", what: "New chat: Send until the conversation opens", points: [] },
	{ name: "switch", what: "Switch conversation (sidebar click until its content shows)", points: [] },
	{ name: "send", what: "Send until the prompt shows in the transcript", points: [] },
	{ name: "turnStart", what: "A prompt: Send until omp is seen working on it", points: [] },
	{ name: "panel", what: "Open the right panel", points: [] },
];
const activity: Record<string, number> = {
	"Prompts sent": 0,
	"  of which to a subagent": 0,
	"Turns completed": 0,
	"  of which over before omp was seen working": 0,
	"Turns omp started on its own": 0,
	"Conversations opened": 0,
	"  of which resumed": 0,
	"Conversations closed": 0,
	"Goals set": 0,
	"Goals paused": 0,
	"Goals resumed": 0,
	"Goals that omp completed": 0,
	"Goals dropped": 0,
	"Dialogs answered": 0,
	"Turns stopped by the harness": 0,
	"UI steps": 0,
	"UI steps that failed": 0,
};
const errorCounts = new Map<string, { source: string; message: string; count: number }>();
let uiFailures = 0;
let pageErrors = 0;
let consoleErrors = 0;
let serverErrors = 0;
let reconnectsBefore = 0;
let lastReconnects = 0;
let costUsd = 0;
let modelsSeen: string[] = [];

function event(kind: EventKind, message: string): void {
	events.push({ t: Math.round(nowS()), kind, message });
	if (kind !== "info") log(`${kind.toUpperCase()}: ${message}`);
}

function countError(source: string, message: string): void {
	const key = `${source}|${message.replace(/\d+/g, "#").slice(0, 160)}`;
	const known = errorCounts.get(key);
	if (known) known.count++;
	else errorCounts.set(key, { source, message: message.slice(0, 400), count: 1 });
}

function lat(name: string, ms: number): void {
	let l = latencies.find((x) => x.name === name);
	if (!l && name.startsWith("turn:")) {
		l = {
			name,
			what:
				name === "turn:own"
					? "A turn omp started on its own (a background job or a subagent finished): working time"
					: `A turn, ${name.slice(5)}: Send until omp is idle again`,
			points: [],
		};
		latencies.push(l);
	}
	l?.points.push({ t: nowS(), ms });
}

// ------------------------------------------------------------------ the world
let world: TestServer | null = null;
let serverPid = 0;
let relayDir = "";
let browser: Browser | null = null;
let context: BrowserContext | null = null;
let page: Page;
let cdp: CDPSession;
let pageGeneration = 0;
let pageCrashed = false;
/** The server and everything below it as last seen, by pid and command line: what a cleanup may kill. */
const snapshot = new Map<number, string>();
const cleanup: string[] = [];

const headers = () => ({ "x-omp-webui-token": world?.accessToken ?? "", "x-omp-webui": "1" });

async function api<T>(path: string, timeoutMs = 10_000): Promise<{ ok: boolean; ms: number; data: T | null }> {
	const start = performance.now();
	try {
		const res = await fetch(`${world?.url}${path}`, { headers: headers(), signal: AbortSignal.timeout(timeoutMs) });
		const data = res.ok ? ((await res.json()) as T) : null;
		return { ok: res.ok, ms: performance.now() - start, data };
	} catch {
		return { ok: false, ms: performance.now() - start, data: null };
	}
}

const PS = ["ps", "-A", "-ww", "-o", "pid=,ppid=,stat=,rss=,time=,command="];

async function run(cmd: string[]): Promise<string> {
	const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "ignore" });
	const out = await new Response(proc.stdout).text();
	await proc.exited;
	return out;
}

/** Whether a command line is one of this run's: the world's own paths, or its server's overlay directory. */
function isOurs(command: string): boolean {
	if (!world) return false;
	return (
		command.includes(world.root) ||
		(relayDir !== "" && command.includes(relayDir)) ||
		(serverPid > 0 && command.includes(`ompw-live-${serverPid}-`))
	);
}

/**
 * What of this run is still running: below this process (the browser), seen below the server before (same pid and
 * same command: a pid may be reused), or by its paths.
 */
function leftovers(): ProcRow[] {
	const rows = parsePs(Bun.spawnSync(PS, { stdout: "pipe", stderr: "ignore" }).stdout.toString());
	const mine = new Set(
		descendants(rows, process.pid)
			.filter((r) => r.command !== PS.join(" "))
			.map((r) => r.pid),
	);
	return rows.filter(
		(r) =>
			r.pid !== process.pid &&
			r.pid !== process.ppid &&
			(mine.has(r.pid) || snapshot.get(r.pid) === r.command || isOurs(r.command)),
	);
}

// ------------------------------------------------------------------ the page
interface SoakRecord {
	wsOpened: number;
	wsClosed: number;
	wsFrames: number;
	wsBytes: number;
	/** Requests sent, by id, not yet answered; when each was sent. */
	pending: Record<string, number>;
	pendingCount: number;
	longTasks: number[];
}

declare global {
	interface Window {
		__soak: SoakRecord;
		__soakClick: Promise<number>;
	}
}

/** Installed before the app loads: what the page can say of itself that the browser's metrics do not. */
function recorder(): void {
	const rec: SoakRecord = {
		wsOpened: 0,
		wsClosed: 0,
		wsFrames: 0,
		wsBytes: 0,
		pending: {},
		pendingCount: 0,
		longTasks: [],
	};
	window.__soak = rec;
	window.WebSocket = new Proxy(window.WebSocket, {
		construct(target, ctorArgs: ConstructorParameters<typeof WebSocket>) {
			const ws = new target(...ctorArgs);
			if (!String(ctorArgs[0]).endsWith("/ws")) return ws;
			rec.wsOpened++;
			const nativeSend = ws.send.bind(ws);
			ws.send = (data: Parameters<WebSocket["send"]>[0]) => {
				try {
					const m = JSON.parse(String(data));
					if (typeof m.req === "string" && rec.pendingCount < 5000) {
						rec.pending[m.req] = performance.now();
						rec.pendingCount++;
					}
				} catch {}
				return nativeSend(data);
			};
			ws.addEventListener("message", (ev) => {
				const s = typeof ev.data === "string" ? ev.data : "";
				rec.wsFrames++;
				rec.wsBytes += s.length;
				let m: RegExpExecArray | null = null;
				if (s.startsWith('{"t":"reply"')) m = /"req":"(r\d+)"/.exec(s.slice(0, 80));
				// A big reply comes in parts (shared/reply-parts.ts): it is there with the last one.
				else if (s.startsWith("~")) m = /^~(r\d+)~1~/.exec(s.slice(0, 30));
				if (m && rec.pending[m[1]] !== undefined) {
					delete rec.pending[m[1]];
					rec.pendingCount--;
				}
			});
			ws.addEventListener("close", () => {
				rec.wsClosed++;
			});
			return ws;
		},
	});
	new PerformanceObserver((list) => {
		for (const e of list.getEntries()) rec.longTasks.push(e.duration);
	}).observe({ type: "longtask", buffered: true });
}

async function openPage(): Promise<void> {
	await context?.close().catch(() => {});
	// Playwright's own handlers would close the browser and exit at once on a signal, ahead of the harness's report and cleanup.
	if (!browser)
		browser = await chromium.launch({
			channel: "chromium",
			headless: !headed,
			handleSIGINT: false,
			handleSIGTERM: false,
			handleSIGHUP: false,
		});
	const w = world as TestServer;
	const { id } = (await (await fetch(`${w.url}/api/prefs`, { headers: headers() })).json()) as { id: string };
	context = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: "en-US" });
	await context.addCookies([
		{
			name: "ompw_token",
			value: w.accessToken,
			domain: "127.0.0.1",
			path: "/",
			httpOnly: true,
			secure: false,
			sameSite: "Strict",
		},
	]);
	// A browser starts ahead of server preferences, so that none of them changes what the run does (see tests/e2e/fixtures.ts).
	await context.addInitScript(
		([key, value]) => localStorage.setItem(key, value),
		[PREFS_SYNC_KEY, `${id}:${Number.MAX_SAFE_INTEGER}`],
	);
	await context.addInitScript(recorder);
	page = await context.newPage();
	page.setDefaultTimeout(20_000);
	pageCrashed = false;
	const generation = ++pageGeneration;
	page.on("crash", () => {
		if (generation !== pageGeneration) return;
		pageCrashed = true;
		event("crash", "the page crashed (Chromium renderer)");
	});
	page.on("pageerror", (e) => {
		if (stopping) return;
		pageErrors++;
		countError("page", e.message);
	});
	page.on("console", (m) => {
		if (stopping || m.type() !== "error") return;
		consoleErrors++;
		countError("console", m.text());
	});
	page.on("response", (r) => {
		if (stopping || r.status() < 500) return;
		consoleErrors++;
		countError("http", `${r.status()} ${new URL(r.url()).pathname}`);
	});
	cdp = await context.newCDPSession(page);
	await cdp.send("Performance.enable");
	await page.goto(w.url);
	await page.getByTestId("session-list").waitFor({ timeout: 60_000 });
}

/** One at a time on the page: the sampler's probes and the user's steps must not interleave. */
class Lock {
	private tail: Promise<unknown> = Promise.resolve();
	run<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.tail.then(fn);
		this.tail = next.catch(() => {});
		return next;
	}
}
const ui = new Lock();

/** A user step: on the page, alone. A failure is the harness's own (counted, with its message), not a crash. */
async function step<T>(name: string, fn: () => Promise<T>): Promise<T | undefined> {
	if (stopping) return undefined;
	activity["UI steps"]++;
	try {
		return await ui.run(() => withTimeout(fn(), 120_000, name));
	} catch (e) {
		if (stopping) return undefined;
		activity["UI steps that failed"]++;
		uiFailures++;
		const message = `${name}: ${(e as Error).message.split("\n")[0]}`;
		countError("harness-ui", message);
		if (uiFailures <= 40) event("warn", `UI step failed — ${message}`);
		await ui
			.run(async () => {
				await page.keyboard.press("Escape");
				await page.keyboard.press("Escape");
			})
			.catch(() => {});
		if (pageCrashed || page.isClosed()) await recoverPage();
		return undefined;
	}
}

async function recoverPage(): Promise<void> {
	if (stopping) return;
	reconnectsBefore += lastReconnects;
	lastReconnects = 0;
	try {
		await ui.run(() => openPage());
		event("info", "the page was reopened");
	} catch (e) {
		event("hang", `could not reopen the page: ${(e as Error).message}`);
	}
}

// ------------------------------------------------------------------ conversations
interface GoalRun {
	phase: "active" | "paused" | "resumed";
	pauseAt: number;
	resumeAt: number;
	dropAt: number;
	/** While resumed: when to look again whether omp has completed it. */
	checkAt: number;
	setAt: number;
	resumedAt: number;
	/** While resumed: since when omp has had nothing running although the goal is active; null while it works. */
	idleSince: number | null;
}

interface Conv {
	n: number;
	cwd: string;
	liveId: string | null;
	pid: number | null;
	file: string | null;
	closed: boolean;
	prompts: number;
	/**
	 * What the harness knows of the turn in flight: when the prompt was sent, whether omp has been seen working on
	 * it, and when that work began (see `scripts/lib/turn-tracking.ts`).
	 */
	turn: TurnState;
	/** What the prompt in flight asks for (the kind of work decides how long a turn takes). */
	kind: string;
	nextPromptAt: number;
	goal: GoalRun | null;
	stuckReported: boolean;
	holding: LiveListing["holding"];
	/** Until when omp finishing a goal that has just ended is not counted as a turn. */
	goalTailUntil: number;
}

const convs: Conv[] = [];
let seq = 0;
let liveList: LiveListing[] = [];

const isOpen = (c: Conv) => !c.closed;
const think = () => thinkS * between(0.5, 1.5);

const TOOL_PROMPTS: { kind: string; text: (n: number) => string }[] = [
	{ kind: "bash: date", text: () => "Use bash to run `date +%s` and reply with just the number." },
	{ kind: "read", text: () => "Use the read tool on notes.txt and reply with its first line only." },
	{
		kind: "bash: ls",
		text: () =>
			"Use bash to run `ls` in the current folder and reply with how many entries it printed, in one short sentence.",
	},
	{
		kind: "write",
		text: (n) =>
			`Use the write tool to create a file named note-${n}.txt containing the text "soak ${n}", then reply with "written".`,
	},
	{ kind: "bash: echo", text: (n) => `Use bash to run \`echo soak-${n}-$RANDOM\` and reply with the output only.` },
	{ kind: "no tool", text: () => "Reply with the single word PONG." },
];

function promptFor(c: Conv): { text: string; subagent: boolean; kind: string } {
	const n = c.prompts + 1;
	if ((c.prompts + c.n) % subagentEvery === 0)
		return {
			text: `Use the task tool to spawn exactly one subagent whose assignment is: run \`echo sub-${c.n}-${n}\` with bash and report the output. After it finishes, reply with DONE.`,
			subagent: true,
			kind: "subagent",
		};
	const p = TOOL_PROMPTS[(c.prompts + c.n) % TOOL_PROMPTS.length];
	return { text: p.text(n), subagent: false, kind: p.kind };
}

/** What the server says of every live omp process; updates what the harness knows of each conversation. */
async function refreshLives(): Promise<void> {
	const r = await api<LiveListing[]>("/api/lives", 8000);
	if (!r.data) return;
	liveList = r.data;
	const now = nowS();
	for (const c of convs) {
		if (c.closed || !c.liveId) continue;
		const live = liveList.find((l) => l.liveId === c.liveId);
		if (!live || live.exited) {
			c.closed = true;
			event("error", `conversation ${c.n}: its omp process ended without being closed (pid ${c.pid})`);
			continue;
		}
		c.holding = live.holding;
		if (c.goal?.phase === "resumed") {
			if (live.streaming || live.holding === "working" || live.holding === "asking") c.goal.idleSince = null;
			else c.goal.idleSince ??= now;
		}
		c.file = live.sessionFile ?? c.file;
		// What the harness knows of the turn in flight, and whether this poll ended it.
		const update = pollTurn(c.turn, { streaming: live.streaming, holding: live.holding }, now);
		if (update.started && !c.goal && c.turn.sentAt !== 0) lat("turnStart", (now - c.turn.sentAt) * 1000);
		if (update.ended) {
			if (!c.goal && now >= c.goalTailUntil) {
				if (update.endedOnItsOwn) {
					activity["Turns omp started on its own"]++;
					lat("turn:own", (now - (c.turn.workingSince || now)) * 1000);
				} else {
					activity["Turns completed"]++;
					if (update.endedUnseen) activity["  of which over before omp was seen working"]++;
					lat(`turn:${c.kind}`, (now - c.turn.sentAt) * 1000);
				}
			}
			c.stuckReported = false;
			c.nextPromptAt = now + think();
		}
		c.turn = nextTurn(c.turn, { streaming: live.streaming, holding: live.holding }, now);
	}
}

const rowSelector = (file: string) => `[data-testid="session-item"][data-file=${JSON.stringify(file)}]`;

/** Show conversation `c` the way a user does: its row in the sidebar. */
async function switchTo(c: Conv): Promise<void> {
	const start = performance.now();
	// The selection mode (see `clickProbe`) would turn a click on a row into a selection.
	const select = page.getByTestId("select-sessions");
	if ((await select.getAttribute("aria-pressed")) === "true") await select.click();
	if (c.file && (await page.locator(rowSelector(c.file)).count()) > 0) {
		const row = page.locator(rowSelector(c.file));
		if ((await row.getAttribute("aria-current")) !== "page") await row.click();
		await page.locator(`${rowSelector(c.file)}[aria-current="page"]`).waitFor();
	} else {
		await page.evaluate(
			(h) => {
				location.hash = h;
			},
			c.file ? `#/s/${encodeURIComponent(c.file)}` : `#/live/${c.liveId}`,
		);
	}
	await page.getByTestId("composer").waitFor();
	await page.getByTestId("msg-user").first().waitFor();
	lat("switch", performance.now() - start);
}

/** Find the omp process the server started for a conversation, once its first prompt is in. */
async function findLive(c: Conv, bySession: boolean): Promise<boolean> {
	return until(
		async () => {
			await refreshLives();
			const live = liveList.find(
				(l) => !l.exited && (bySession ? l.sessionFile === c.file : l.cwd.endsWith(`/proj-${c.n}`)),
			);
			if (!live) return false;
			c.liveId = live.liveId;
			c.pid = live.pid;
			c.file = live.sessionFile ?? c.file;
			return Boolean(c.file);
		},
		30_000,
		700,
	);
}

async function typeAndSend(text: string): Promise<void> {
	await page.getByTestId("composer").fill(text);
	await page.getByTestId("send").click();
}

function newConv(n: number, cwd: string): Conv {
	return {
		n,
		cwd,
		liveId: null,
		pid: null,
		file: null,
		closed: false,
		prompts: 0,
		turn: { ...NO_TURN },
		kind: "",
		nextPromptAt: 0,
		goal: null,
		stuckReported: false,
		holding: null,
		goalTailUntil: 0,
	};
}

function countPrompt(sent: { subagent: boolean }): void {
	activity["Prompts sent"]++;
	if (sent.subagent) activity["  of which to a subagent"]++;
}

/** A new conversation in a folder of its own, with its first prompt. */
async function openNew(): Promise<Conv | null> {
	const n = ++seq;
	const cwd = join((world as TestServer).work, `proj-${n}`);
	mkdirSync(cwd, { recursive: true });
	writeFileSync(join(cwd, "notes.txt"), `soak notes ${n}\nsecond line\n`);
	const c = newConv(n, cwd);
	const first = promptFor(c);
	const ok = await step(`new conversation ${n}`, async () => {
		await page.evaluate((dir) => localStorage.setItem("ompw.cwd", dir), cwd);
		// Leave the new-chat page first, so that it opens afresh on this folder (and gives up the previous warm-up process).
		await page.evaluate(() => {
			location.hash = "#/settings";
		});
		await page.getByTestId("settings-page").waitFor();
		const start = performance.now();
		await page.getByTestId("new-chat").click();
		await page.getByTestId("model-picker").filter({ hasText: MODEL }).waitFor({ timeout: 90_000 });
		lat("newChat", performance.now() - start);
		const sendStart = performance.now();
		c.turn = armTurn(c.turn, nowS());
		wakeTurnWatcher();
		await typeAndSend(first.text);
		await page.waitForFunction(() => /#\/(s|live)\//.test(location.hash), undefined, { timeout: 30_000 });
		lat("firstSend", performance.now() - sendStart);
		return true;
	});
	if (!ok) {
		// A model picker that shows another model than Haiku: nothing is called, the run ends.
		const shown = await page
			.getByTestId("model-picker")
			.innerText({ timeout: 2000 })
			.catch(() => "");
		if (shown && !MODEL.test(shown)) {
			event("error", `the model picker shows "${shown}", not Haiku: the run stops so that nothing else is called`);
			stopRun("the model is not Haiku");
		}
		return null;
	}
	c.prompts = 1;
	c.kind = first.kind;
	countPrompt(first);
	convs.push(c);
	activity["Conversations opened"]++;
	if (!(await findLive(c, false)))
		event("error", `conversation ${n}: the server lists no omp process for it after 30 s`);
	log(`conversation ${n} opened (pid ${c.pid ?? "?"})`);
	return c;
}

/** An earlier conversation, taken up again from the sidebar: omp starts on its session file once a prompt is sent. */
async function resume(old: Conv): Promise<Conv | null> {
	if (!old.file) return null;
	const c = { ...newConv(++seq, old.cwd), file: old.file, prompts: old.prompts };
	const next = promptFor(c);
	const ok = await step(`resume conversation ${old.n}`, async () => {
		await page.evaluate(
			(h) => {
				location.hash = h;
			},
			`#/s/${encodeURIComponent(old.file as string)}`,
		);
		await page.getByTestId("composer").waitFor();
		const before = await page.getByTestId("msg-user").count();
		c.turn = armTurn(c.turn, nowS());
		wakeTurnWatcher();
		await typeAndSend(next.text);
		await page.getByTestId("msg-user").nth(before).waitFor({ timeout: 30_000 });
		return true;
	});
	if (!ok) return null;
	c.prompts++;
	c.kind = next.kind;
	countPrompt(next);
	convs.push(c);
	activity["Conversations opened"]++;
	activity["  of which resumed"]++;
	if (!(await findLive(c, true)))
		event("error", `conversation ${old.n} resumed: the server lists no omp process for it after 30 s`);
	log(`conversation ${old.n} resumed as ${c.n} (pid ${c.pid ?? "?"})`);
	return c;
}

/** End a conversation's omp process the way the Settings page does. */
async function closeConv(c: Conv): Promise<void> {
	if (!c.pid) return;
	const pid = c.pid;
	const busy = c.turn.seenWorking;
	// From here on its process going away is expected (see `refreshLives`).
	c.closed = true;
	await step(`close conversation ${c.n}`, async () => {
		await page.evaluate(() => {
			location.hash = "#/settings";
		});
		const row = page.getByTestId("running-session").filter({ hasText: `pid ${pid}` });
		await row.waitFor();
		await row.getByRole("button", { name: /^Close/ }).click();
	});
	const gone = await until(async () => {
		await refreshLives();
		return !liveList.some((l) => l.pid === pid && !l.exited);
	}, 20_000);
	activity["Conversations closed"]++;
	if (!gone) event("error", `conversation ${c.n}: its omp process (pid ${pid}) is still listed 20 s after Close`);
	else log(`conversation ${c.n} closed${busy ? " while it was working" : ""}`);
}

async function sendPrompt(c: Conv): Promise<void> {
	const next = promptFor(c);
	// The state the conversation had before the prompt was armed: a send that fails puts it back.
	const was = { ...c.turn };
	const sent = await step(`prompt to conversation ${c.n}`, async () => {
		await switchTo(c);
		const before = await page.getByTestId("msg-user").count();
		const start = performance.now();
		// The prompt is armed before it is sent: a poll that sees omp working while the send step is still running
		// must not lose the turn (see `scripts/lib/turn-tracking.ts`).
		c.turn = armTurn(c.turn, nowS());
		wakeTurnWatcher();
		await typeAndSend(next.text);
		await page.getByTestId("msg-user").nth(before).waitFor({ timeout: 30_000 });
		lat("send", performance.now() - start);
		return true;
	});
	if (!sent) {
		// The send did not happen: nothing is in flight, and the turn is not booked. Were it left armed, the polls
		// would find an idle conversation with a prompt in flight and book a turn of the grace (#518).
		c.turn = disarmTurn(was);
		c.nextPromptAt = nowS() + think();
		return;
	}
	c.prompts++;
	c.kind = next.kind;
	countPrompt(next);
}

/** A dialog a turn waits on (a tool approval, a question): answered the way a user who agrees would. */
async function answerDialog(c: Conv): Promise<void> {
	await step(`dialog of conversation ${c.n}`, async () => {
		await switchTo(c);
		const dialog = page.getByTestId("ui-request").first();
		if (!(await dialog.isVisible())) return;
		const button = dialog.getByRole("button", { name: /Allow|Approve|Yes|Submit|Confirm|Accept|OK/i }).first();
		if (await button.count()) await button.click();
		else await page.keyboard.press("Escape");
		activity["Dialogs answered"]++;
	});
}

// ------------------------------------------------------------------ goals
const GOAL_OBJECTIVE =
	"Run `sleep 15 && date` with bash three times, one command per turn, and reply to each with the time in one short sentence. Mark the goal complete only after the third.";

async function startGoal(c: Conv): Promise<void> {
	const ok = await step(`goal in conversation ${c.n}`, async () => {
		await switchTo(c);
		await page.getByTestId("open-goal").click();
		await page.getByTestId("goal-direct-toggle").click();
		await page.getByTestId("goal-objective").fill(GOAL_OBJECTIVE);
		await page.getByTestId("goal-budget").fill("50000");
		await page.getByTestId("goal-create").click();
		await page.getByTestId("goal-bar").waitFor({ timeout: 60_000 });
		return true;
	});
	if (!ok) return;
	const now = nowS();
	c.goal = {
		phase: "active",
		setAt: now,
		resumedAt: 0,
		idleSince: null,
		pauseAt: now + between(25, 40),
		resumeAt: 0,
		dropAt: now + 240,
		checkAt: 0,
	};
	c.turn = armTurn(c.turn, now);
	wakeTurnWatcher();
	activity["Goals set"]++;
	log(`goal set in conversation ${c.n}`);
}

/** A goal as both sides show it: the web bar, what the server says of the omp process, and what that process has running. */
async function goalDiag(c: Conv): Promise<string> {
	const bar = page.getByTestId("goal-bar");
	const status = (await bar.getAttribute("data-status", { timeout: 2000 }).catch(() => null)) ?? "no bar";
	const text = (await bar.innerText({ timeout: 2000 }).catch(() => "")).replace(/\s+/g, " ").slice(0, 160);
	await refreshLives();
	const live = liveList.find((l) => l.liveId === c.liveId);
	const kids = parsePs(await run(PS)).filter((r) => r.ppid === c.pid);
	const children = kids.length ? kids.map((k) => `${k.pid} ${k.stat} ${k.command.slice(0, 70)}`).join(" | ") : "none";
	const omp = await ompView(c);
	return `bar ${status} "${text}"; server: streaming=${live?.streaming}, holding=${live?.holding}, exited=${live?.exited}; ${omp}; omp pid ${c.pid} children: ${children}; session tail: ${sessionTail(c.file)}; cost so far $${costUsd.toFixed(3)}`;
}

/** What omp itself answers to `goal get` and `get_state` (the bar shows what the page was told, which can differ). */
async function ompView(c: Conv): Promise<string> {
	if (!c.liveId || !world) return "omp itself: no live id";
	let ws: WebSocket | null = null;
	try {
		ws = await withTimeout(connect(world), 5000, "the websocket");
		const goal = await withTimeout(
			request<{ goal?: Record<string, unknown> | null }>(ws, {
				t: "rpc",
				liveId: c.liveId,
				command: { type: "goal", op: "get" },
			}),
			8000,
			"goal get",
		);
		const state = await withTimeout(
			request<Record<string, unknown>>(ws, { t: "rpc", liveId: c.liveId, command: { type: "get_state" } }),
			8000,
			"get_state",
		);
		const g = goal?.goal;
		const goalText = g ? `status=${String(g.status)}, tokensUsed=${String(g.tokensUsed)}` : "none";
		const pick = Object.entries(state ?? {})
			.filter(([k, v]) => /streaming|settled|queued|compact|retry/i.test(k) && typeof v !== "object")
			.map(([k, v]) => `${k}=${String(v)}`);
		return `omp itself: goal ${goalText}; state ${pick.join(", ") || "?"}`;
	} catch (e) {
		return `omp itself: unavailable (${(e as Error).message.slice(0, 80)})`;
	} finally {
		ws?.close();
	}
}

/** The last entries of a conversation's session file, one short word each: what omp last did, for a stall. */
function sessionTail(file: string | null): string {
	if (!file) return "no file";
	try {
		const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
		const words = lines.slice(-8).map((line) => {
			const e = JSON.parse(line) as Record<string, unknown>;
			const m = (e.message ?? {}) as { role?: string; stopReason?: string; content?: unknown };
			const parts = Array.isArray(m.content)
				? m.content.map((p: { type?: string; name?: string }) => p.name ?? p.type ?? "?").join("+")
				: typeof m.content === "string"
					? "text"
					: "";
			return [e.type ?? "?", e.customType, m.role, parts, m.stopReason].filter(Boolean).join(":");
		});
		return `${lines.length} entries, last ${words.length}: ${words.join(" | ")}`;
	} catch (e) {
		return `unreadable (${(e as Error).message.slice(0, 60)})`;
	}
}

async function goalStep(c: Conv): Promise<void> {
	const g = c.goal;
	if (!g) return;
	const now = nowS();
	const bar = page.getByTestId("goal-bar");
	await step(`goal step in conversation ${c.n}`, async () => {
		await switchTo(c);
		if ((await bar.count()) === 0) {
			// Gone: omp completed it.
			activity["Goals that omp completed"]++;
			c.goal = null;
			log(`goal in conversation ${c.n} ended`);
		} else if (g.phase === "active" && now >= g.pauseAt) {
			await bar.getByRole("button", { name: "Pause goal" }).click();
			await page.locator('[data-testid="goal-bar"][data-status="paused"]').waitFor();
			event("info", `goal in conversation ${c.n} paused; ${await goalDiag(c)}`);
			g.phase = "paused";
			g.resumeAt = now + between(15, 30);
			activity["Goals paused"]++;
			log(`goal in conversation ${c.n} paused`);
		} else if (g.phase === "paused" && now >= g.resumeAt) {
			await bar.getByRole("button", { name: "Resume goal" }).click();
			await page.locator('[data-testid="goal-bar"][data-status="active"]').waitFor();
			g.phase = "resumed";
			g.resumedAt = now;
			g.idleSince = null;
			event("info", `goal in conversation ${c.n} resumed; ${await goalDiag(c)}`);
			activity["Goals resumed"]++;
			log(`goal in conversation ${c.n} resumed`);
		} else if (g.phase === "resumed" && now >= g.dropAt) {
			// omp has not completed it in time: say what it looks like from both sides before it is dropped.
			const diag = await goalDiag(c);
			await page.screenshot({ path: join(outDir, `goal-stalled-${c.n}-${Math.round(now)}s.png`) }).catch(() => {});
			event(
				"warn",
				`goal in conversation ${c.n} not completed ${Math.round(now - g.setAt)} s after it was set (${Math.round(now - g.resumedAt)} s after it was resumed); ${g.idleSince === null ? "omp is working on it" : `omp has been idle for ${Math.round(now - g.idleSince)} s while the web bar still shows it active`}; dropped. ${diag}`,
			);
			await bar.getByRole("button", { name: "Drop goal" }).click();
			await page.getByRole("dialog").getByRole("button", { name: "Drop goal" }).click();
			await bar.waitFor({ state: "detached" });
			activity["Goals dropped"]++;
			c.goal = null;
			log(`goal in conversation ${c.n} dropped`);
		} else g.checkAt = now + 20;
	});
	if (!c.goal) {
		// omp may still be finishing the goal's last turn (its closing message): that is not a prompt's turn.
		c.goalTailUntil = nowS() + 10;
		c.nextPromptAt = nowS() + Math.max(think(), 12);
		c.turn = { ...NO_TURN };
	}
}

/** Whether the next step of a goal is due. */
function goalDue(c: Conv): boolean {
	const g = c.goal;
	if (!g) return false;
	const now = nowS();
	if (g.phase === "active") return now >= g.pauseAt;
	if (g.phase === "paused") return now >= g.resumeAt;
	return now >= g.dropAt || now >= g.checkAt;
}

// ------------------------------------------------------------------ what a user does between prompts
let lastUsageAt = 0;

async function scrollTranscript(): Promise<void> {
	const box = await page.getByTestId("transcript").boundingBox({ timeout: 3000 });
	if (!box) return;
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.wheel(0, -between(600, 2600));
	await sleepRaw(between(300, 900));
	await page.mouse.wheel(0, -between(200, 1200));
	await sleepRaw(between(300, 900));
	await page.mouse.wheel(0, 6000);
}

async function panelTour(): Promise<void> {
	const panel = page.getByTestId("right-panel");
	if (!(await panel.isVisible())) {
		const start = performance.now();
		await page.getByTestId("toggle-panel").click();
		await panel.waitFor();
		lat("panel", performance.now() - start);
	}
	await sleepRaw(between(500, 1500));
	const agent = page.getByTestId("subagent-item");
	const agents = await agent.count();
	if (agents > 0) {
		await agent.nth(Math.floor(rng() * agents)).click();
		await page.getByTestId("subagent-detail").waitFor();
		await sleepRaw(between(800, 2000));
	}
	if (rng() < 0.6) await page.getByTestId("right-panel-close").click();
}

/** Open another page of the app, stay a moment, and go back to a conversation. */
async function visit(hash: string, testid: string): Promise<void> {
	await page.evaluate((h) => {
		location.hash = h;
	}, hash);
	await page.getByTestId(testid).waitFor();
	await sleepRaw(between(1000, 2500));
	const open = convs.filter(isOpen);
	if (open.length) await switchTo(pick(open));
}

async function searchPalette(): Promise<void> {
	await page.keyboard.press("ControlOrMeta+k");
	await page.getByTestId("palette-input").waitFor();
	await page.keyboard.type(pick(["pong", "soak", "done", "echo", "notes"]), { delay: 60 });
	await sleepRaw(between(800, 1800));
	await page.keyboard.press("Escape");
}

async function filterSidebar(): Promise<void> {
	const filter = page.getByTestId("session-filter");
	try {
		await filter.fill("proj");
		await sleepRaw(between(500, 1200));
	} finally {
		await filter.fill("");
	}
}

async function idleBrowse(): Promise<void> {
	const open = convs.filter(isOpen);
	const needsChat = new Set(["scroll", "agents panel"]);
	const actions: [number, string, () => Promise<unknown>][] = [
		[4, "scroll", scrollTranscript],
		[3, "agents panel", panelTour],
		[3, "switch", async () => open.length && switchTo(pick(open))],
		[1.5, "settings", () => visit("#/settings", "settings-page")],
		[1.5, "search", searchPalette],
		[1, "filter", filterSidebar],
		[
			nowS() - lastUsageAt > 600 ? 1 : 0,
			"usage",
			async () => {
				lastUsageAt = nowS();
				await visit("#/usage", "usage-page");
			},
		],
	];
	let roll = rng() * actions.reduce((a, [w]) => a + w, 0);
	for (const [w, name, fn] of actions) {
		roll -= w;
		if (roll > 0 || w === 0) continue;
		activity[`Page: ${name}`] = (activity[`Page: ${name}`] ?? 0) + 1;
		await step(name, async () => {
			if (needsChat.has(name) && open.length && !/^#\/(s|live)\//.test(await page.evaluate(() => location.hash)))
				await switchTo(pick(open));
			await fn();
		});
		return;
	}
}

// ------------------------------------------------------------------ sampling
let prevProc: { wall: number; serverCpu: number; cpuByPid: Map<number, number> } | null = null;
let apiFails = 0;
let hangReported = false;
let stderrOffset = 0;

const SERVER_ERROR =
	/\b(error|exception|uncaught|unhandled|fatal|panic|rejection|ECONNRESET|EPIPE|EMFILE|ENFILE|ENOMEM)\b/i;

/** What the server has written to its stderr since the last look; the lines that tell of an error are counted. */
function readServerStderr(): void {
	try {
		const size = statSync(stderrLog).size;
		if (size <= stderrOffset) return;
		const fd = openSync(stderrLog, "r");
		const buf = Buffer.alloc(size - stderrOffset);
		try {
			readSync(fd, buf, 0, buf.length, stderrOffset);
		} finally {
			closeSync(fd);
		}
		stderrOffset = size;
		for (const line of buf.toString("utf8").split("\n")) {
			if (!line.trim() || !SERVER_ERROR.test(line)) continue;
			serverErrors++;
			countError("server", line.trim());
		}
	} catch {}
}

async function sampleProcesses(row: Sample): Promise<void> {
	const rows = parsePs(await run(PS));
	const self = rows.find((r) => r.pid === serverPid);
	if (!self) {
		// A terminal's Ctrl-C reaches the server too: it going away while the run is being stopped is not a crash.
		if (!stopping) {
			event("crash", `the server (pid ${serverPid}) is no longer running`);
			stopRun("the server crashed");
		}
		return;
	}
	const kids = descendants(rows, serverPid);
	for (const k of [self, ...kids]) snapshot.set(k.pid, k.command);
	const wall = performance.now();
	row.serverRssMb = self.rssKb / 1024;
	row.ompProcs = kids.filter((k) => kindOf(k.command) === "omp").length;
	row.relayProcs = kids.filter((k) => kindOf(k.command) === "relay").length;
	row.otherProcs = kids.filter((k) => kindOf(k.command) === "other").length;
	row.zombies = kids.filter(isZombie).length;
	row.treeRssMb = kids.reduce((a, k) => a + k.rssKb, 0) / 1024;
	const tree = new Set(kids.map((k) => k.pid));
	row.strays = rows.filter(
		(r) => r.pid !== serverPid && r.pid !== process.pid && !tree.has(r.pid) && isOurs(r.command),
	).length;
	if (prevProc) {
		const dt = (wall - prevProc.wall) / 1000;
		row.serverCpuPct = (100 * (self.cpuSec - prevProc.serverCpu)) / dt;
		let used = 0;
		for (const k of kids) used += k.cpuSec - (prevProc.cpuByPid.get(k.pid) ?? 0);
		row.treeCpuPct = (100 * Math.max(0, used)) / dt;
	}
	prevProc = { wall, serverCpu: self.cpuSec, cpuByPid: new Map(kids.map((k) => [k.pid, k.cpuSec])) };
	const fds = parseLsof(await run(["lsof", "-nP", "-p", String(serverPid)]));
	row.serverFds = fds.total;
	row.serverSockets = fds.sockets;
	row.serverPipes = fds.pipes;
	row.serverFiles = fds.files;
	row.serverEstablished = fds.established;
}

async function sampleServer(row: Sample): Promise<void> {
	const meta = await api("/api/meta", 10_000);
	row.apiMs = meta.ok ? meta.ms : null;
	if (!meta.ok) {
		apiFails++;
		if (apiFails >= 3 && !hangReported) {
			hangReported = true;
			event("hang", `the server has not answered /api/meta for ${apiFails} samples in a row`);
		}
		if (apiFails >= 10) stopRun("the server stopped answering");
	} else {
		apiFails = 0;
		hangReported = false;
	}
	const lives = await api<LiveListing[]>("/api/lives", 8000);
	row.livesOpen = lives.data ? lives.data.filter((l) => !l.exited).length : null;
	const sessions = await api<SessionSummary[]>("/api/sessions", 15_000);
	if (!Array.isArray(sessions.data)) return;
	const ours = sessions.data.filter((s) => s.cwd.includes(basename((world as TestServer).root)));
	costUsd = ours.reduce((a, s) => a + s.usage.cost, 0);
	modelsSeen = [...new Set(ours.flatMap((s) => s.models))];
	const other = modelsSeen.filter((m) => !MODEL.test(m));
	if (other.length) {
		event("error", `a model other than Haiku was used: ${other.join(", ")}`);
		stopRun("a model other than Haiku was used");
	}
	if (costUsd > maxCost) {
		event("warn", `the conversations have cost $${costUsd.toFixed(2)}, over --max-cost ${maxCost}`);
		stopRun("cost limit reached");
	}
}

/** What a click costs: a real mouse click (through the browser's input pipeline) on a toggle, until its DOM effect. */
async function clickProbe(): Promise<number | null> {
	const sel = '[data-testid="select-sessions"]';
	const box = await page.locator(sel).boundingBox({ timeout: 3000 });
	if (!box) return null;
	const x = box.x + box.width / 2;
	const y = box.y + box.height / 2;
	/** Arm the page to note when the toggle flips, then click it; resolves the page's clock at the flip. */
	const click = async (): Promise<number> => {
		await page.evaluate((selector) => {
			const want = document.querySelector(selector)?.getAttribute("aria-pressed") !== "true";
			const { promise, resolve: flipped } = Promise.withResolvers<number>();
			window.__soakClick = promise;
			const obs = new MutationObserver(() => {
				if (document.querySelector(selector)?.getAttribute("aria-pressed") !== String(want)) return;
				obs.disconnect();
				flipped(performance.timeOrigin + performance.now());
			});
			obs.observe(document.body, { subtree: true, attributes: true, attributeFilter: ["aria-pressed"] });
		}, sel);
		const start = performance.timeOrigin + performance.now();
		await page.mouse.click(x, y);
		const at = await withTimeout(
			page.evaluate(() => window.__soakClick),
			10_000,
			"the click",
		);
		return Math.max(0, at - start);
	};
	const ms = await click();
	await click();
	return ms;
}

async function samplePage(row: Sample): Promise<void> {
	if (pageCrashed || page.isClosed()) {
		await recoverPage();
		return;
	}
	await ui.run(async () => {
		const start = performance.now();
		try {
			await withTimeout(
				page.evaluate(() => 1),
				15_000,
				"page.evaluate",
			);
		} catch (e) {
			event("hang", `the page does not answer: ${(e as Error).message}`);
			return;
		}
		row.evalMs = performance.now() - start;
		try {
			row.clickMs = await clickProbe();
		} catch (e) {
			event("warn", `click probe: ${(e as Error).message.split("\n")[0]}`);
		}
		const rec = await page.evaluate(() => {
			const r = window.__soak;
			const now = performance.now();
			return {
				wsOpened: r.wsOpened,
				pendingOld: Object.values(r.pending).filter((t) => now - t > 10_000).length,
				longTasks: r.longTasks.splice(0),
				wsBytes: r.wsBytes,
				domShown: document.getElementsByTagName("*").length,
			};
		});
		row.domShown = rec.domShown;
		row.wsMb = rec.wsBytes / 1048576;
		row.wsPending = rec.pendingOld;
		lastReconnects = Math.max(0, rec.wsOpened - 1);
		row.longTasks = rec.longTasks.length;
		row.longTaskMaxMs = rec.longTasks.length ? Math.max(...rec.longTasks) : 0;
		// What a leak leaves behind is measured in the same view every time (what the user happened to be looking at
		// would move the figures), after the view that was on screen has been unmounted and collected.
		try {
			if (await page.getByTestId("right-panel").isVisible()) await page.getByTestId("right-panel-close").click();
			await page.evaluate(() => {
				location.hash = "#/settings";
			});
			await page.getByTestId("settings-page").waitFor();
		} catch (e) {
			event("warn", `could not leave the conversation to measure the page: ${(e as Error).message.split("\n")[0]}`);
			return;
		}
		await sleepRaw(500);
		// Garbage the browser has not collected yet is not a leak: collect until the node count stops moving.
		let m: Record<string, number> = {};
		let settled = 0;
		for (let i = 0; i < 10 && settled < 2; i++) {
			await cdp.send("HeapProfiler.collectGarbage");
			await sleepRaw(250);
			const { metrics } = (await cdp.send("Performance.getMetrics")) as { metrics: { name: string; value: number }[] };
			const before = `${m.Nodes}/${m.JSEventListeners}`;
			m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
			settled = `${m.Nodes}/${m.JSEventListeners}` === before ? settled + 1 : 0;
		}
		const counts = await page.evaluate(() => {
			let all = 1; // the document itself
			const walker = document.createTreeWalker(document, NodeFilter.SHOW_ALL);
			while (walker.nextNode()) all++;
			return { all, elements: document.getElementsByTagName("*").length };
		});
		row.heapMb = (m.JSHeapUsedSize ?? 0) / 1048576;
		row.cdpNodes = m.Nodes ?? null;
		row.domNodes = counts.elements;
		// Nodes the browser still counts although the document no longer holds them: kept alive by a reference.
		row.detachedNodes = m.Nodes === undefined ? null : Math.max(0, m.Nodes - counts.all);
		row.listeners = m.JSEventListeners ?? null;
	});
}

let lastSampleWall = 0;

async function sampleOnce(): Promise<void> {
	const row: Sample = { t: 0 };
	const wall = Date.now();
	// A sample that comes much later than the interval says the machine slept (or the harness stalled): the timings around it are not the product's.
	if (lastSampleWall && wall - lastSampleWall > Math.max(3 * intervalS * 1000, intervalS * 1000 + 90_000))
		event(
			"warn",
			`a sample came ${Math.round((wall - lastSampleWall) / 1000)} s after the previous one (interval ${intervalS} s): the machine may have slept, or the harness stalled`,
		);
	lastSampleWall = wall;
	row.load1 = loadavg()[0];
	await sampleProcesses(row).catch((e) => event("warn", `process sample: ${(e as Error).message}`));
	await sampleServer(row).catch((e) => event("warn", `server sample: ${(e as Error).message}`));
	await samplePage(row).catch((e) => event("warn", `page sample: ${(e as Error).message.split("\n")[0]}`));
	readServerStderr();
	row.t = Math.round(nowS() * 10) / 10;
	row.iso = new Date().toISOString();
	row.wsReconnects = reconnectsBefore + lastReconnects;
	row.pageErrors = pageErrors;
	row.consoleErrors = consoleErrors;
	row.serverErrors = serverErrors;
	row.uiFailures = uiFailures;
	row.turnsDone = activity["Turns completed"];
	row.turnsSent = activity["Prompts sent"];
	row.convsOpen = convs.filter(isOpen).length;
	row.costUsd = costUsd;
	samples.push(row);
	writeOutputs(true);
	const g = (k: string, d = 0) => (typeof row[k] === "number" ? (row[k] as number).toFixed(d) : "–");
	log(
		`sample: rss ${g("serverRssMb")} MB, cpu ${g("serverCpuPct")}%, fds ${g("serverFds")}, procs omp/relay/other ${g("ompProcs")}/${g("relayProcs")}/${g("otherProcs")}, ` +
			`heap ${g("heapMb")} MB, nodes ${g("domNodes")}, click ${g("clickMs")} ms, reconnects ${g("wsReconnects")}, cost $${costUsd.toFixed(3)}`,
	);
}

/**
 * Notes when each turn starts and ends. The driver looks at omp only between its page steps (seconds apart), which
 * would time a turn that is over in a second at the next look; this looks every 300 ms while a turn is in flight.
 *
 * It looks every 300 ms from the moment a prompt is sent, not from the moment a turn is first seen: a turn that
 * begins and ends between two looks is a turn the harness never saw, and it would report it as one that never
 * started (whose time is the grace). The watcher is woken when a prompt is sent, so a short turn is not missed.
 */
async function turnWatcher(): Promise<void> {
	while (!stopping) {
		// A turn in flight: one the harness's prompt started, or one omp started on its own (a background job or
		// a subagent finished) — the conversation is busy either way, and the turn is to be seen from its first
		// moment.
		const inFlight = convs.some((c) => !c.closed && c.liveId && isBusy(c.turn));
		// A prompt that was just sent: look again at once, so that a turn that is over in a second is still seen.
		await Promise.race([sleep(inFlight ? 300 : 2000), woken()]);
		if (!stopping) await refreshLives();
	}
}

/** Resolves when the watcher is to look again now. */
let wakeWatcher: () => void = () => {};

/** A promise that resolves when the watcher is woken. */
function woken(): Promise<void> {
	return new Promise((resolve) => {
		wakeWatcher = resolve;
	});
}

/** Tell the turn watcher to look again now: a prompt was sent, and the turn must be seen from its first moment. */
function wakeTurnWatcher(): void {
	wakeWatcher();
}

async function sampler(): Promise<void> {
	for (let k = 0; !stopping; k++) {
		await sampleOnce();
		const wait = (k + 1) * intervalS - nowS();
		if (wait > 0) await sleep(wait * 1000);
		if (nowS() >= plannedS) break;
	}
}

// ------------------------------------------------------------------ power
let power: PowerCheck | null = null;
let loadStart: number | null = null;
let loadEnd: number | null = null;

/** Whether the machine slept while the run was going, from what macOS logged: the timings and slopes of such a run mean nothing. */
async function checkPower(): Promise<void> {
	const to = Date.now();
	const caff = Number(process.env.OMPW_SOAK_CAFFEINATE);
	let caffeinate = "not running (caffeinate could not be started)";
	if (caff) {
		try {
			process.kill(caff, 0);
			caffeinate = `\`caffeinate -dimsu\` (pid ${caff}) held the machine awake for the whole run`;
		} catch {
			caffeinate = `\`caffeinate -dimsu\` (pid ${caff}) was no longer running at the end`;
		}
	}
	const check: PowerCheck = {
		from: new Date(harnessStartMs).toISOString(),
		to: new Date(to).toISOString(),
		caffeinate,
		events: [],
	};
	try {
		const proc = Bun.spawn(["pmset", "-g", "log"], { stdout: "pipe", stderr: "ignore" });
		const timer = setTimeout(() => proc.kill(), 120_000);
		const out = await new Response(proc.stdout).text();
		clearTimeout(timer);
		await proc.exited;
		const found = parsePmsetLog(out, harnessStartMs, to);
		if (found.lines === 0) check.error = "`pmset -g log` printed no dated line";
		check.events = found.events;
	} catch (e) {
		check.error = `\`pmset -g log\` failed: ${(e as Error).message}`;
	}
	power = check;
	if (check.events.length)
		event(
			"error",
			`the machine slept during the run (${check.events.map((e) => `${e.at} ${e.kind}`).join(", ")}): the run is invalid`,
		);
	else if (check.error) event("warn", `sleep could not be ruled out: ${check.error}`);
}

// ------------------------------------------------------------------ outputs
let versions: Record<string, string> = {};
const startedAt = new Date().toISOString();

function reportInput(inProgress: boolean) {
	return {
		label,
		params: {
			minutes,
			"sample interval (s)": intervalS,
			conversations: nConvs,
			"think (s)": thinkS,
			"subagent every": subagentEvery,
			"rotate (s)": Math.round(rotateS),
			"goal every (s)": Math.round(goalEveryS),
			"stuck after (s)": stuckS,
			seed,
			...(loadStart === null ? {} : { "host load avg (1 min) at start": loadStart.toFixed(2) }),
			...(loadEnd === null ? {} : { "host load avg (1 min) at end": loadEnd.toFixed(2) }),
		},
		versions,
		startedAt,
		runSeconds: samples.at(-1)?.t ?? 0,
		plannedSeconds: plannedS,
		endReason: inProgress ? "in progress" : endReason,
		samples,
		events,
		latencies,
		activity: {
			...activity,
			"Spent (Haiku)": `$${costUsd.toFixed(3)}`,
			"Models used": modelsSeen.join(", ") || "–",
		},
		cleanup,
		inProgress,
		errorSummary: [...errorCounts.values()].sort((a, b) => b.count - a.count),
		power: inProgress ? null : power,
	};
}

function writeOutputs(inProgress: boolean): void {
	try {
		const input = reportInput(inProgress);
		writeFileSync(join(outDir, "series.csv"), toCsv(samples, ["turnsDone", "turnsSent", "convsOpen", "costUsd"]));
		writeFileSync(join(outDir, "series.json"), JSON.stringify({ ...input, verdict: verdictOf(input).line }, null, 1));
		writeFileSync(join(outDir, "report.md"), renderReport(input));
	} catch (e) {
		console.log(`could not write outputs: ${(e as Error).message}`);
	}
}

// ------------------------------------------------------------------ driver
async function watchdog(): Promise<void> {
	const now = nowS();
	for (const c of convs.filter(isOpen)) {
		// A turn that omp was seen working on: it is the one that can hang.
		if (!c.turn.seenWorking || c.stuckReported) continue;
		const since = c.turn.workingSince;
		if (now - since < (c.goal ? stuckS * 2 : stuckS)) continue;
		c.stuckReported = true;
		event(
			"hang",
			`conversation ${c.n} has been working for ${Math.round((now - since) / 60)} min (holding: ${c.holding})`,
		);
		await step(`stop conversation ${c.n}`, async () => {
			await switchTo(c);
			await page
				.screenshot({ path: join(outDir, `stuck-conversation-${c.n}-${Math.round(now)}s.png`) })
				.catch(() => {});
			const stop = page.getByTestId("stop");
			if ((await stop.count()) > 0) await stop.click();
			activity["Turns stopped by the harness"]++;
		});
	}
}

let nextRotateAt = 0;
let nextGoalAt = 0;
let rotations = 0;

/** One thing for the user to do now, if any is due. */
async function act(): Promise<boolean> {
	const now = nowS();
	const open = convs.filter(isOpen);
	if (now >= nextRotateAt && open.length >= nConvs) {
		nextRotateAt = now + rotateS;
		const oldest = open.filter((c) => !c.goal).sort((a, b) => a.n - b.n)[0];
		if (oldest) {
			await closeConv(oldest);
			rotations++;
			// Every other rotation takes up an earlier conversation again, the others start a new one.
			const resumable = convs.filter((c) => c.closed && c.file && c.prompts > 0).sort((a, b) => a.n - b.n)[0];
			if (!(rotations % 2 === 0 && resumable && (await resume(resumable)))) await openNew();
			return true;
		}
	}
	const withGoal = open.find(goalDue);
	if (withGoal) {
		await goalStep(withGoal);
		return true;
	}
	if (now >= nextGoalAt && !open.some((c) => c.goal)) {
		const idle = open.find((c) => !isBusy(c.turn) && c.prompts > 0);
		if (idle) {
			nextGoalAt = now + goalEveryS;
			await startGoal(idle);
			return true;
		}
	}
	const asking = open.find((c) => c.holding === "asking");
	if (asking) {
		await answerDialog(asking);
		return true;
	}
	const ready = open
		.filter((c) => !c.goal && !isBusy(c.turn) && now >= c.nextPromptAt)
		.sort((a, b) => a.nextPromptAt - b.nextPromptAt)[0];
	if (ready) {
		await sendPrompt(ready);
		return true;
	}
	return false;
}

async function driver(): Promise<void> {
	nextRotateAt = rotateS;
	nextGoalAt = goalEveryS / 2;
	for (let i = 0; i < nConvs && !stopping; i++) await openNew();
	while (!stopping && nowS() < plannedS) {
		await refreshLives();
		await watchdog();
		if (!(await act())) await idleBrowse();
		await sleep(between(800, 2500));
	}
}

// ------------------------------------------------------------------ cleanup
let cleaned = false;

function killAll(rows: ProcRow[], signal: NodeJS.Signals): void {
	for (const r of rows) {
		try {
			process.kill(r.pid, signal);
		} catch {}
	}
}

async function cleanUp(): Promise<void> {
	if (cleaned) return;
	cleaned = true;
	try {
		if (serverPid) for (const k of descendants(parsePs(await run(PS)), serverPid)) snapshot.set(k.pid, k.command);
	} catch {}
	await context?.close().catch(() => {});
	await browser?.close().catch(() => {});
	if (world) await world.stop().catch((e) => cleanup.push(`server.stop() failed: ${(e as Error).message}`));
	await sleepRaw(500);
	const rest = leftovers();
	if (rest.length) {
		const what = rest.map((r) => `${kindOf(r.command)} pid ${r.pid}`).join(", ");
		cleanup.push(
			`${rest.length} process(es) of the run were still running after the server was stopped and were killed: ${what}`,
		);
		event("warn", `after the server was stopped, ${rest.length} process(es) of the run were still running (${what})`);
		killAll(rest, "SIGTERM");
		await sleepRaw(1500);
		killAll(leftovers(), "SIGKILL");
	} else cleanup.push("no process of the run was left after the server was stopped");
	if (world) {
		try {
			removeRelayDir(join(world.root, "data"));
			rmSync(world.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
		} catch {}
		cleanup.push(
			existsSync(world.root)
				? `could not remove ${world.root}`
				: `removed the temp dir ${basename(world.root)} and the relay directory`,
		);
	}
}

/** Last resort, in `exit` (no awaiting): kill what is the run's and remove the temp dir. */
function emergency(): void {
	if (cleaned) return;
	killAll(leftovers(), "SIGKILL");
	if (world) {
		try {
			removeRelayDir(join(world.root, "data"));
			rmSync(world.root, { recursive: true, force: true });
		} catch {}
	}
}

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
	process.on(sig, () => {
		const now = Date.now();
		if (!firstSignalAt) {
			firstSignalAt = now;
			log(`${sig}: stopping, writing the report and cleaning up`);
			stopRun(`interrupted (${sig})`);
		} else if (now - firstSignalAt > 1500) {
			log(`${sig} again: cleaning up at once`);
			emergency();
			process.exit(130);
		}
	});
}
process.on("exit", emergency);
process.on("unhandledRejection", (e) => {
	if (!stopping) event("warn", `harness: unhandled rejection: ${e instanceof Error ? e.message : String(e)}`);
});

// ------------------------------------------------------------------ main
async function build(): Promise<void> {
	if (existsSync(join(dist, "index.html"))) return;
	log("building the web UI");
	const proc = Bun.spawn(["bunx", "vite", "build", "--outDir", dist], {
		cwd: root,
		stdout: "ignore",
		stderr: "inherit",
	});
	if ((await proc.exited) !== 0) throw new Error("vite build failed");
}

async function main(): Promise<number> {
	mkdirSync(outDir, { recursive: true });
	if (!canCallModel()) {
		console.log("soak: needs an Anthropic login (`omp token anthropic`), and OMPW_E2E_OFFLINE must not be set");
		return 2;
	}
	let exitCode = 0;
	try {
		await build();
		log(`seed ${seed}; output ${outDir}`);
		world = await startTestServer(0, { OMP_WEBUI_DIST: dist }, { login: true });
		const port = new URL(world.url).port;
		serverPid = Number((await run(["lsof", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])).split("\n")[0]);
		if (!serverPid) throw new Error(`could not find the server listening on port ${port}`);
		relayDir = relayDirPath(join(world.root, "data"));
		const meta = (await api<{ ompVersion: string; serverVersion: string }>("/api/meta")).data;
		await openPage();
		versions = {
			omp: meta?.ompVersion ?? "?",
			"omp-webui": meta?.serverVersion ?? "?",
			bun: Bun.version,
			chromium: browser?.version() ?? "?",
			"model (all roles)": "anthropic/claude-haiku-5-5",
			"server pid": String(serverPid),
			"temp root": world.root,
		};
		log(`server on ${world.url} (pid ${serverPid}); omp ${versions.omp}; root ${world.root}`);
		t0 = performance.now();
		loadStart = loadavg()[0];
		const sampling = sampler();
		const driving = driver();
		const watching = turnWatcher();
		await Promise.race([Promise.all([sampling, driving]), stopped.promise]);
		stopRun(endReason);
		await Promise.race([Promise.allSettled([sampling, driving, watching]), sleepRaw(8000)]);
		// The last sample, with everything still up (the screenshot first: sampling leaves the page on the Settings view).
		await ui.run(() => page.screenshot({ path: join(outDir, "final.png") })).catch(() => {});
		await sampleOnce().catch(() => {});
		log(`run ended: ${endReason}`);
	} catch (e) {
		endReason = `harness error: ${(e as Error).message}`;
		event("error", `harness: ${(e as Error).stack ?? (e as Error).message}`);
		exitCode = 1;
	} finally {
		await cleanUp();
		readServerStderr();
		loadEnd = loadavg()[0];
		await checkPower();
		writeOutputs(false);
	}
	const verdict = verdictOf(reportInput(false));
	log(`verdict: ${verdict.line}`);
	console.log(`report: ${join(outDir, "report.md")}`);
	if (endReason.startsWith("interrupted")) return 130;
	if (exitCode === 0 && verdict.invalid) exitCode = 3;
	if (exitCode === 0 && (verdict.failures.length || (!verdict.short && verdict.growth.length))) exitCode = 1;
	return exitCode;
}

process.exit(await main());
