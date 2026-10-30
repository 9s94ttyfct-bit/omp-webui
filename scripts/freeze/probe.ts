#!/usr/bin/env bun
/**
 * The pages of the long-run harness (scripts/freeze/run.ts): a few tabs attached to every live conversation, doing what the
 * web UI does on its own (refreshing the session list when it changes, asking omp for its state, reading the family of a
 * conversation, searching), and, besides that, timing what a person waits for:
 *
 * - `meta`: a trivial HTTP request. Its time is the event-loop lag of the server, as a page sees it.
 * - `prompt` / `abort`: a command sent over the socket, until the reply is back, and until omp read it (omp's log).
 *
 * One JSON line per measurement goes to the file named in the settings; the orchestrator summarizes them.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { partOf } from "../../shared/reply-parts.ts";

interface Settings {
	port: number;
	token: string;
	/** Session files of the live conversations, the first of which is the big one. */
	lives: string[];
	tabs: number;
	seconds: number;
	out: string;
	/** Probe cadence, in ms. */
	metaMs: number;
	promptMs: number;
	abortMs: number;
	stateMs: number;
	searchMs: number;
	familyMs: number;
	/** Every so often a page that attaches asks for everything at once: the whole session, then a few small things. */
	hydrateMs: number;
}

const s: Settings = JSON.parse(readFileSync(process.env.FREEZE_PROBE ?? "", "utf8"));
const origin = `http://127.0.0.1:${s.port}`;
const headers = { "x-omp-webui-token": s.token, "x-omp-webui": "1" };
const now = () => performance.timeOrigin + performance.now();
const record = (kind: string, fields: Record<string, unknown>) =>
	appendFileSync(s.out, `${JSON.stringify({ kind, at: now(), ...fields })}\n`);

interface Reply {
	t: "reply";
	req: string;
	ok: boolean;
	data?: unknown;
	error?: string;
	/** The size of the whole message, when it was read as far as its head only. */
	bytes?: number;
}

class Tab {
	readonly ws: WebSocket;
	private readonly waiting = new Map<string, (r: Reply) => void>();
	private seq = 0;
	frames = 0;
	bytes = 0;
	changed = 0;
	ready: Promise<void>;

	constructor(readonly n: number) {
		this.ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`, { headers: { ...headers, origin } } as unknown as string[]);
		const open = Promise.withResolvers<void>();
		this.ready = open.promise;
		this.ws.addEventListener("open", () => open.resolve());
		this.ws.addEventListener("message", (ev) => this.onMessage(String(ev.data)));
		this.ws.addEventListener("close", () => record("tab_closed", { tab: n }));
	}

	/** What a big reply has come to so far, by request: it arrives in parts (see shared/reply-parts.ts). */
	private readonly partBytes = new Map<string, number>();

	private onMessage(text: string): void {
		this.bytes += text.length;
		// A part of a big reply: the reply is there with its last, and its size is the sum of the parts.
		const req = partOf(text);
		if (req !== null) {
			const total = (this.partBytes.get(req) ?? 0) + text.length;
			if (text.startsWith(`~${req}~1~`)) {
				this.partBytes.delete(req);
				this.waiting.get(req)?.({ t: "reply", req, ok: true, bytes: total });
				this.waiting.delete(req);
			} else this.partBytes.set(req, total);
			return;
		}
		// Only replies are decoded: the frames are counted, which is what a page reading them has to keep up with.
		// A reply is read as far as its head when it is large: the answer to `get_entries` of a big session is tens of MB.
		const head = /^\{"t":"reply","req":"([^"]+)","ok":(true|false)/.exec(text.slice(0, 200));
		if (head) {
			const req = head[1] as string;
			this.waiting.get(req)?.(
				text.length < 200_000
					? { ...(JSON.parse(text) as Reply), bytes: text.length }
					: { t: "reply", req, ok: head[2] === "true", bytes: text.length },
			);
			this.waiting.delete(req);
		} else if (text.startsWith('{"t":"frame"')) this.frames++;
		else if (text.startsWith('{"t":"sessions_changed"')) {
			this.changed++;
			onSessionsChanged();
		}
	}

	request(message: Record<string, unknown>): Promise<Reply> {
		const req = `${this.n}-${++this.seq}`;
		const { promise, resolve } = Promise.withResolvers<Reply>();
		this.waiting.set(req, resolve);
		this.ws.send(JSON.stringify({ ...message, req }));
		return promise;
	}
}

const tabs = Array.from({ length: s.tabs }, (_, n) => new Tab(n));
await Promise.all(tabs.map((t) => t.ready));

// Every tab attaches to every conversation, as the app does for the ones it shows or lists.
const liveIds: string[] = [];
for (const file of s.lives) {
	const reply = await (tabs[0] as Tab).request({ t: "open", target: { kind: "resume", sessionFile: file } });
	if (!reply.ok) throw new Error(`open ${file}: ${reply.error}`);
	const id = (reply.data as { liveId: string }).liveId;
	liveIds.push(id);
	for (const tab of tabs.slice(1)) await tab.request({ t: "attach", liveId: id });
}
record("attached", { lives: liveIds });

async function timed(kind: string, fields: Record<string, unknown>, run: () => Promise<unknown>): Promise<void> {
	const began = now();
	try {
		await run();
		record(kind, { ...fields, began, ms: now() - began });
	} catch (e) {
		record(kind, { ...fields, began, ms: now() - began, error: String(e) });
	}
}

let cursor: string | null = null;
let sessionsReloadedAt = 0;
let sessionsTimer: ReturnType<typeof setTimeout> | null = null;
/** The page's own throttle: one reload of the session list per 1.5 s however many changes there were. */
function onSessionsChanged(): void {
	if (sessionsTimer) return;
	sessionsTimer = setTimeout(
		() => {
			sessionsTimer = null;
			sessionsReloadedAt = Date.now();
			void reloadSessions();
		},
		Math.max(0, sessionsReloadedAt + 1500 - Date.now()),
	);
}

async function reloadSessions(): Promise<void> {
	await timed("sessions", {}, async () => {
		const res = await fetch(`${origin}/api/sessions`, {
			headers: cursor ? { ...headers, "x-sessions-since": cursor } : headers,
		});
		cursor = res.headers.get("x-sessions-cursor");
		const body = await res.arrayBuffer();
		record("sessions_size", { bytes: body.byteLength, full: cursor === null });
	});
	// The page asks again for the subagents of the conversation on screen whenever its totals changed.
	await timed("subagents", {}, async () =>
		(
			await fetch(`${origin}/api/subagents?file=${encodeURIComponent(s.lives[0] as string)}`, { headers })
		).arrayBuffer(),
	);
}

let probe = 0;
const every = (ms: number, run: () => void) => setInterval(run, ms);
const stop = Date.now() + s.seconds * 1000;
const timers: ReturnType<typeof setInterval>[] = [];

timers.push(
	every(
		s.metaMs,
		() => void timed("meta", {}, async () => (await fetch(`${origin}/api/meta`, { headers })).arrayBuffer()),
	),
);

timers.push(
	every(s.promptMs, () => {
		const n = ++probe;
		const tab = tabs[n % tabs.length] as Tab;
		const liveId = liveIds[n % liveIds.length] as string;
		void timed("prompt", { probe: n, live: liveId }, () =>
			tab.request({ t: "rpc", liveId, command: { type: "prompt", message: "probe", probe: n } }),
		);
	}),
);

timers.push(
	every(s.stateMs, () => {
		for (const liveId of liveIds)
			void timed("state", { live: liveId }, () =>
				(tabs[0] as Tab).request({ t: "rpc", liveId, command: { type: "get_state" } }),
			);
	}),
);

let abortAt = 0;
timers.push(
	every(s.abortMs, () => {
		const n = ++probe;
		const liveId = liveIds[abortAt++ % liveIds.length] as string;
		const tab = tabs[0] as Tab;
		void timed("abort", { probe: n, live: liveId }, async () => {
			await tab.request({ t: "rpc", liveId, command: { type: "abort", probe: n } });
			// What a person does next: send again, so that the conversation keeps streaming.
			setTimeout(
				() => void tab.request({ t: "rpc", liveId, command: { type: "prompt", message: "again", probe: -n } }),
				300,
			);
		});
	}),
);

timers.push(
	every(
		s.searchMs,
		() =>
			void timed("search", {}, async () =>
				(await fetch(`${origin}/api/search?q=alpha&limit=50`, { headers })).arrayBuffer(),
			),
	),
);

const etags = new Map<string, string>();
timers.push(
	every(s.familyMs, () => {
		const file = s.lives[0] as string;
		void timed("family", {}, async () => {
			const known = etags.get(file);
			const res = await fetch(`${origin}/api/family?file=${encodeURIComponent(file)}`, {
				headers: known ? { ...headers, "if-none-match": known } : headers,
			});
			const etag = res.headers.get("etag");
			if (etag) etags.set(file, etag);
			const body = await res.arrayBuffer();
			record("family_size", { status: res.status, bytes: body.byteLength });
		});
	}),
);

/** A page that attaches asks, at once, for the whole session and a few small things; what a person sees is whether the small ones come. */
async function hydrate(): Promise<void> {
	const tab = tabs[0] as Tab;
	const liveId = liveIds[0] as string;
	const began = now();
	const ask = (command: Record<string, unknown>) =>
		Promise.race([
			tab.request({ t: "rpc", liveId, command }).then((r) => ({ ms: now() - began, bytes: r.bytes ?? 0 })),
			Bun.sleep(20_000).then(() => null),
		]);
	const [entries, ...small] = await Promise.all([
		ask({ type: "get_entries" }),
		ask({ type: "get_state" }),
		ask({ type: "get_state" }),
		ask({ type: "get_available_commands" }),
	]);
	record("hydrate", {
		began,
		ms: entries?.ms ?? null,
		bytes: entries?.bytes ?? 0,
		answered: small.filter(Boolean).length,
		asked: small.length,
	});
}
timers.push(every(s.hydrateMs, () => void hydrate()));
// This process's own loop lag and what the tabs received each second: a probe that is itself late measures nothing.
let last = performance.now();
let lag = 0;
timers.push(
	setInterval(() => {
		const t = performance.now();
		lag = Math.max(lag, t - last - 10);
		last = t;
	}, 10),
);
let before = { frames: 0, bytes: 0 };
timers.push(
	setInterval(() => {
		const frames = tabs.reduce((n, t) => n + t.frames, 0);
		const bytes = tabs.reduce((n, t) => n + t.bytes, 0);
		record("rx", { frames: frames - before.frames, bytes: bytes - before.bytes, probeLag: Math.round(lag * 10) / 10 });
		before = { frames, bytes };
		lag = 0;
	}, 1000),
);

// A conversation that has no turn running starts one: the load must not depend on a command that was lost.
for (const liveId of liveIds)
	void (tabs[0] as Tab).request({ t: "rpc", liveId, command: { type: "prompt", message: "go" } });

while (Date.now() < stop) await Bun.sleep(500);
for (const t of timers) clearInterval(t);
record("done", {});
for (const tab of tabs) tab.ws.close();
process.exit(0);
