import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from "bun:test";
import { replyMessages } from "../../shared/reply-parts.ts";
import { CONNECT_MS, PONG_MS, QUIET_MS, REPLY_MS, ReplyError, Socket } from "../../web/src/lib/ws.ts";

/**
 * A connection that is dead without saying so (a path that drops what it carries, a server that stopped answering,
 * a laptop that woke up) used to leave the page waiting for good: a request has no one to answer it, and its button
 * stays disabled. The page now asks a connection that has been quiet for a while something it must answer, and gives
 * up on one that does not; and a request of a kind that is answered at once is given up on when it is not.
 */

/** Minimal stand-in for the browser WebSocket: the test drives open/close/messages. */
class FakeWS {
	static OPEN = 1;
	static instances: FakeWS[] = [];
	readyState = 0;
	sent: { t?: string; req?: string; command?: { type?: string } }[] = [];
	closed = false;
	onopen: (() => void) | null = null;
	onclose: ((ev: { code: number }) => void) | null = null;
	onerror: (() => void) | null = null;
	onmessage: ((ev: { data: string }) => void) | null = null;
	constructor(public url: string) {
		FakeWS.instances.push(this);
	}
	send(text: string) {
		this.sent.push(JSON.parse(text));
	}
	close() {
		this.closed = true;
	}
	open() {
		this.readyState = FakeWS.OPEN;
		this.onopen?.();
	}
	/** The server says something. */
	say(msg: unknown) {
		this.onmessage?.({ data: JSON.stringify(msg) });
	}
	/** The server sends a text that is not JSON (a part of a big reply). */
	sayText(text: string) {
		this.onmessage?.({ data: text });
	}
	reply(req: string, data: unknown = null) {
		this.say({ t: "reply", req, ok: true, data });
	}
	/** The `list_lives` the page sent that has not been answered. */
	pings() {
		return this.sent.filter((m) => m.t === "list_lives");
	}
}

const saved = {
	WebSocket: globalThis.WebSocket,
	fetch: globalThis.fetch,
	location: (globalThis as { location?: unknown }).location,
};
beforeAll(() => {
	Object.assign(globalThis, { WebSocket: FakeWS, location: { protocol: "http:", host: "127.0.0.1:1" } });
});
afterAll(() => {
	Object.assign(globalThis, saved);
});
beforeEach(() => {
	vi.useFakeTimers();
	FakeWS.instances = [];
});
afterEach(() => {
	vi.useRealTimers();
	globalThis.fetch = saved.fetch;
});

/** A connected socket whose server answers whatever `answers` says it does. */
function connected() {
	const s = new Socket();
	const status: boolean[] = [];
	s.onStatus((c) => status.push(c));
	s.connect();
	const ws = FakeWS.instances.at(-1) as FakeWS;
	ws.open();
	return { s, ws, status };
}
const lastReq = (ws: FakeWS) => ws.sent.at(-1)?.req as string;

/** Time passes, and the connection answers whenever it is asked something: it is the one thing that does not answer. */
function passWhileAnswering(ws: FakeWS, ms: number): void {
	const answered = new Set<string>();
	for (let t = 0; t < ms; t += 1000) {
		vi.advanceTimersByTime(Math.min(1000, ms - t));
		for (const ping of ws.pings()) {
			if (ping.req && !answered.has(ping.req)) {
				answered.add(ping.req);
				ws.reply(ping.req, []);
			}
		}
	}
}

/** What a request ended with: its answer, or the code of the error it failed with. */
const outcomeOf = (p: Promise<unknown>) =>
	p.then(
		(answer) => ({ answer }),
		(e: ReplyError) => ({ failed: e.code }),
	);

test("a connection that says nothing for a while is asked something, and stays while it answers", () => {
	const { ws, status } = connected();
	vi.advanceTimersByTime(QUIET_MS + 6000);
	expect(ws.pings()).toHaveLength(1);
	ws.reply(lastReq(ws), []);
	vi.advanceTimersByTime(QUIET_MS + 6000);
	expect(ws.pings()).toHaveLength(2);
	ws.reply(lastReq(ws), []);
	vi.advanceTimersByTime(PONG_MS * 3);
	expect(status).toEqual([true]);
	expect(ws.closed).toBe(false);
});

test("a connection that is heard from is not asked anything", () => {
	const { ws } = connected();
	for (let i = 0; i < 12; i++) {
		vi.advanceTimersByTime(QUIET_MS / 2);
		ws.say({ t: "hello", ompVersion: "x", serverVersion: "y", time: 0 });
	}
	expect(ws.pings()).toHaveLength(0);
});

test("a connection that does not answer is given up on: what waited on it fails, and a new one is made", async () => {
	const { s, ws, status } = connected();
	const waiting = s.request({ t: "rpc", liveId: "L1", command: { type: "bash", command: "sleep 1" } });
	const failure = waiting.catch((e: unknown) => e);
	vi.advanceTimersByTime(QUIET_MS + 6000);
	expect(ws.pings()).toHaveLength(1);
	expect(status).toEqual([true]);
	vi.advanceTimersByTime(PONG_MS + 100);
	expect(status).toEqual([true, false]);
	expect(ws.closed).toBe(true);
	const error = await failure;
	expect(error).toBeInstanceOf(ReplyError);
	expect((error as Error).message).toBe("Connection lost");
	// It is made again, as after any lost connection.
	vi.advanceTimersByTime(1000);
	expect(FakeWS.instances).toHaveLength(2);
	// What the dead connection says late is nothing to the page.
	ws.reply("r1", "late");
});

test("a request of a kind that is answered at once fails when it is not, and is not sent afterwards", async () => {
	const { s, ws } = connected();
	const stuck = s.rpc("L1", { type: "prompt", message: "hello" }).catch((e: unknown) => e);
	const sent = lastReq(ws);
	// The connection itself is fine: it answers what it is asked.
	passWhileAnswering(ws, REPLY_MS + 1000);
	const error = (await stuck) as ReplyError;
	expect(error).toBeInstanceOf(ReplyError);
	expect(error.code).toBe("timeout");
	expect(error.message).toMatch(/no answer/i);
	// An answer that comes after that is ignored.
	ws.reply(sent, { agentInvoked: true });
});

test("a prompt asks the server to say when omp has it; other requests do not", () => {
	const { s, ws } = connected();
	void s.rpc("L1", { type: "prompt", message: "hello" }).catch(() => {});
	void s.rpc("L1", { type: "steer", message: "this way" }).catch(() => {});
	void s.rpc("L1", { type: "prompt", message: "/compact" }).catch(() => {});
	void s.rpc("L1", { type: "get_state" }).catch(() => {});
	void s.request({ t: "list_lives" }).catch(() => {});
	expect(ws.sent.map((m) => [m.command?.type ?? m.t, "ack" in m ? m.ack : undefined])).toEqual([
		["prompt", true],
		["steer", true],
		["prompt", undefined],
		["get_state", undefined],
		["list_lives", undefined],
	]);
});

test("a prompt omp holds (behind a compaction, a handoff) is not given up on once the server has handed it over", async () => {
	const { s, ws } = connected();
	const outcomes: string[] = [];
	s.rpc("L1", { type: "prompt", message: "while it compacts" }).then(
		(r) => outcomes.push(`answered ${JSON.stringify(r)}`),
		(e: Error) => outcomes.push(e.message),
	);
	const sent = lastReq(ws);
	// The server took it to omp at once; omp answers when the compaction is over, minutes later. The connection is fine.
	vi.advanceTimersByTime(300);
	ws.say({ t: "ack", req: sent });
	passWhileAnswering(ws, 10 * 60_000);
	await Promise.resolve();
	expect(outcomes).toEqual([]);
	ws.reply(sent, { agentInvoked: true });
	await Promise.resolve();
	expect(outcomes).toEqual(['answered {"agentInvoked":true}']);
});

test("a prompt the server does not acknowledge fails at the bound, and what comes after that is nothing", async () => {
	const { s, ws } = connected();
	const outcome = s.rpc("L1", { type: "prompt", message: "never taken" }).catch((e: unknown) => e);
	const sent = lastReq(ws);
	passWhileAnswering(ws, REPLY_MS + 1000);
	const error = (await outcome) as ReplyError;
	expect(error.code).toBe("timeout");
	expect(error.message).toMatch(/no answer/i);
	ws.say({ t: "ack", req: sent });
	ws.reply(sent, { agentInvoked: true });
});

test("an acknowledgement a moment before the bound moves the wait on to the answer, which is not bounded", async () => {
	const { s, ws } = connected();
	const outcomes: string[] = [];
	s.rpc("L1", { type: "prompt", message: "taken late" }).then(
		() => outcomes.push("answered"),
		(e: Error) => outcomes.push(e.message),
	);
	const sent = lastReq(ws);
	passWhileAnswering(ws, REPLY_MS - 1000);
	ws.say({ t: "ack", req: sent });
	passWhileAnswering(ws, REPLY_MS * 3);
	await Promise.resolve();
	expect(outcomes).toEqual([]);
	ws.reply(sent, null);
	await Promise.resolve();
	expect(outcomes).toEqual(["answered"]);
});

test("a prompt omp holds still ends when the connection is dead: the page stops waiting, and does not call it failed", async () => {
	const { s, ws, status } = connected();
	const outcome = outcomeOf(s.rpc("L1", { type: "prompt", message: "held" }));
	ws.say({ t: "ack", req: lastReq(ws) });
	// Nothing answers any more, and nothing is heard.
	vi.advanceTimersByTime(QUIET_MS + 6000 + PONG_MS + 100);
	expect(status).toEqual([true, false]);
	// omp has the prompt (the server said so): it is no more "not sent" than it is "sent and answered".
	expect(await outcome).toEqual({ answer: undefined });
});

test("a prompt the server has handed to omp is not failed by a connection that ends before omp answers (#361)", async () => {
	const { s, ws } = connected();
	const prompt = outcomeOf(s.rpc("L1", { type: "prompt", message: "held behind a compaction" }));
	const steer = outcomeOf(s.rpc("L1", { type: "steer", message: "this way" }));
	const goal = outcomeOf(s.rpc("L1", { type: "goal", op: "create", objective: "ship it" }));
	for (const m of ws.sent) ws.say({ t: "ack", req: m.req });
	// omp holds them (behind a compaction), then the connection ends: it has all three, and the drafts they came from are not given back.
	passWhileAnswering(ws, REPLY_MS - 15_000);
	ws.onclose?.({ code: 1006 });
	expect(await prompt).toEqual({ answer: undefined });
	expect(await steer).toEqual({ answer: undefined });
	expect(await goal).toEqual({ answer: undefined });
});

test("a prompt the server has not acknowledged when the connection ends is failed, and is not sent afterwards", async () => {
	const { s, ws } = connected();
	const prompt = outcomeOf(s.rpc("L1", { type: "prompt", message: "not taken yet" }));
	const query = outcomeOf(s.rpc("L1", { type: "get_state" }));
	const acked = outcomeOf(s.rpc("L1", { type: "prompt", message: "taken" }));
	ws.say({ t: "ack", req: ws.sent[2]?.req });
	ws.onclose?.({ code: 1006 });
	expect(await prompt).toEqual({ failed: "connection-lost" });
	expect(await query).toEqual({ failed: "connection-lost" });
	expect(await acked).toEqual({ answer: undefined });
	// The next connection sends none of them.
	vi.advanceTimersByTime(1000);
	const next = FakeWS.instances.at(-1) as FakeWS;
	next.open();
	expect(next.sent.filter((m) => m.t === "rpc")).toEqual([]);
});

test("a socket the server ended because the Cloudflare Access token ran out loads the page again, and does not retry", () => {
	const { ws, status } = connected();
	const loc = globalThis.location as unknown as { reload: () => void };
	const reload = vi.fn();
	loc.reload = reload;
	ws.onclose?.({ code: 4401 });
	expect(reload).toHaveBeenCalledTimes(1);
	// The new page makes its own connection; this one does not queue another (a retry would come within a second).
	vi.advanceTimersByTime(QUIET_MS - 1000);
	expect(FakeWS.instances).toHaveLength(1);
	expect(status).toEqual([true]);
});

test("any other end of the connection is retried, not a reload", () => {
	const { ws } = connected();
	const loc = globalThis.location as unknown as { reload: () => void };
	const reload = vi.fn();
	loc.reload = reload;
	ws.onclose?.({ code: 1006 });
	vi.advanceTimersByTime(1000);
	expect(reload).not.toHaveBeenCalled();
	expect(FakeWS.instances).toHaveLength(2);
});

/** What the page's own `fetch` answers (a test that never calls this has the real one: it must not be reached). */
function fetchAnswers(answer: () => Promise<unknown>) {
	const fetched = vi.fn((_url: string, _init?: RequestInit) => answer());
	globalThis.fetch = fetched as unknown as typeof fetch;
	return fetched;
}
/** A socket whose handshake was refused: it never opened, and closed. */
function refused() {
	const s = new Socket();
	s.connect();
	const ws = FakeWS.instances.at(-1) as FakeWS;
	ws.onclose?.({ code: 1006 });
	return { s, ws };
}
/** The answer of a `fetch` has been taken up. */
const settled = async () => {
	for (let i = 0; i < 5; i++) await Promise.resolve();
};

test("a connection refused before it opened, where Cloudflare Access answers with a redirect to its sign-in, loads the page again", async () => {
	// A redirect that cannot be followed (another origin) is all a socket's handshake gets; a request told not to follow
	// it says what it was.
	const fetched = fetchAnswers(async () => ({ type: "opaqueredirect" }));
	const loc = globalThis.location as unknown as { reload: () => void };
	const reload = vi.fn();
	loc.reload = reload;
	refused();
	await settled();
	expect(reload).toHaveBeenCalledTimes(1);
	expect(fetched).toHaveBeenCalledTimes(1);
	expect(fetched.mock.calls[0]?.[0]).toBe("/api/meta");
	expect(fetched.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
});

test("a connection refused while the network is out is retried, and the page is not loaded again", async () => {
	fetchAnswers(() => Promise.reject(new TypeError("Load failed")));
	const loc = globalThis.location as unknown as { reload: () => void };
	const reload = vi.fn();
	loc.reload = reload;
	refused();
	await settled();
	vi.advanceTimersByTime(1000);
	expect(reload).not.toHaveBeenCalled();
	expect(FakeWS.instances).toHaveLength(2);
});

test("a connection refused by a server that answers as usual (it is starting, or says no) is retried, not a reload", async () => {
	fetchAnswers(async () => ({ type: "basic", status: 401 }));
	const loc = globalThis.location as unknown as { reload: () => void };
	const reload = vi.fn();
	loc.reload = reload;
	refused();
	await settled();
	vi.advanceTimersByTime(1000);
	expect(reload).not.toHaveBeenCalled();
	expect(FakeWS.instances).toHaveLength(2);
});

test("a connection that was open and dropped asks nothing: its session was good a moment ago", async () => {
	const fetched = fetchAnswers(async () => ({ type: "opaqueredirect" }));
	const { ws } = connected();
	ws.onclose?.({ code: 1006 });
	await settled();
	expect(fetched).not.toHaveBeenCalled();
});

test("a refusal that follows another before the first was answered asks once", async () => {
	const { promise, resolve } = Promise.withResolvers<unknown>();
	const fetched = fetchAnswers(() => promise);
	const loc = globalThis.location as unknown as { reload: () => void };
	loc.reload = vi.fn();
	refused();
	vi.advanceTimersByTime(1000);
	(FakeWS.instances.at(-1) as FakeWS).onclose?.({ code: 1006 });
	expect(fetched).toHaveBeenCalledTimes(1);
	resolve({ type: "basic" });
});

test("Stop is such a request too", async () => {
	const { s, ws } = connected();
	const stop = s.rpc("L1", { type: "abort_and_restore_queue" }).catch((e: unknown) => e);
	passWhileAnswering(ws, REPLY_MS + 1000);
	expect(((await stop) as ReplyError).code).toBe("timeout");
});

test("stopping a subagent is such a request too: omp answers it at once, and a button waiting on it must not wait for good", async () => {
	const { s, ws } = connected();
	const stop = s.act("L1", { type: "cancel_subagent", subagentId: "Scout" }).catch((e: unknown) => e);
	passWhileAnswering(ws, REPLY_MS + 1000);
	expect(((await stop) as ReplyError).code).toBe("timeout");
});

test("a command that takes as long as it takes (a !command, a slash command) is not given up on", async () => {
	const { s, ws } = connected();
	const outcomes: string[] = [];
	for (const command of [
		{ type: "bash", command: "make" },
		{ type: "prompt", message: "/compact" },
		{ type: "compact" },
	]) {
		s.rpc("L1", command).then(
			() => outcomes.push("answered"),
			(e: Error) => outcomes.push(e.message),
		);
	}
	const bashReq = ws.sent[0].req as string;
	// An hour, with the connection answering whenever it is asked.
	passWhileAnswering(ws, 3600_000);
	await Promise.resolve();
	expect(outcomes).toEqual([]);
	ws.reply(bashReq, { exitCode: 0 });
	await Promise.resolve();
	expect(outcomes).toEqual(["answered"]);
});

/** A reply of about `n` entries, as the JSON text omp wrote it. */
const entriesText = (n: number) =>
	JSON.stringify({
		entries: Array.from({ length: n }, (_, i) => ({ id: `e${i}`, text: "x".repeat(80) })),
		leafId: `e${n - 1}`,
	});

test("a big reply that takes minutes to arrive is heard as it comes: the connection is not given up on, and the request does not time out", async () => {
	const { s, ws, status } = connected();
	const outcomes: unknown[] = [];
	s.rpc("L1", { type: "get_entries" }).then(
		(r) => outcomes.push(r),
		(e: Error) => outcomes.push(e.message),
	);
	const req = lastReq(ws);
	const text = entriesText(60);
	const parts = replyMessages(req, text, 400);
	expect(parts.length).toBeGreaterThan(10);
	// A part every 15 s: more than the connection's quiet time and the request's bound have passed long before the last.
	for (const part of parts.slice(0, -1)) {
		ws.sayText(part);
		vi.advanceTimersByTime(15_000);
	}
	expect(parts.length * 15_000).toBeGreaterThan(QUIET_MS + PONG_MS + REPLY_MS);
	expect(ws.pings()).toHaveLength(0);
	expect(status).toEqual([true]);
	expect(outcomes).toEqual([]);
	ws.sayText(parts.at(-1) as string);
	await Promise.resolve();
	expect(outcomes).toEqual([JSON.parse(text)]);
});

test("a request waiting for a big reply gives up when its bound passes without a part", async () => {
	const { s, ws } = connected();
	const outcome = s.rpc("L1", { type: "get_entries" }).catch((e: unknown) => e);
	const req = lastReq(ws);
	const parts = replyMessages(req, entriesText(40), 400);
	ws.sayText(parts[0] as string);
	// The connection answers whatever it is asked; the reply is what stops.
	passWhileAnswering(ws, REPLY_MS - 1000);
	ws.sayText(parts[1] as string);
	passWhileAnswering(ws, REPLY_MS - 1000);
	let settled = false;
	void outcome.then(() => {
		settled = true;
	});
	await Promise.resolve();
	expect(settled).toBe(false);
	passWhileAnswering(ws, 2000);
	const error = (await outcome) as ReplyError;
	expect(error.code).toBe("timeout");
	// What comes of it later is nothing.
	for (const part of parts.slice(2)) ws.sayText(part);
});

test("parts that stop coming on a connection that says nothing else are a dead connection", async () => {
	const { s, ws, status } = connected();
	const outcome = s.rpc("L1", { type: "get_entries" }).catch((e: unknown) => e);
	const parts = replyMessages(lastReq(ws), entriesText(40), 400);
	ws.sayText(parts[0] as string);
	ws.sayText(parts[1] as string);
	// Nothing more, and nothing answers the question the page asks.
	vi.advanceTimersByTime(QUIET_MS + 6000 + PONG_MS + 100);
	expect(status).toEqual([true, false]);
	expect(((await outcome) as ReplyError).code).toBe("connection-lost");
	// A new connection does not inherit half a reply: its parts are its own.
	vi.advanceTimersByTime(1000);
	const next = FakeWS.instances.at(-1) as FakeWS;
	next.open();
	const again = s.rpc("L1", { type: "get_entries" }).catch((e: unknown) => e);
	const text = entriesText(40);
	for (const part of replyMessages(lastReq(next), text, 400)) next.sayText(part);
	expect(await again).toEqual(JSON.parse(text));
});

test("a big reply whose text is not JSON fails its request instead of leaving it waiting", async () => {
	const { s, ws } = connected();
	const outcome = s.rpc("L1", { type: "get_entries" }).catch((e: unknown) => e);
	for (const part of replyMessages(lastReq(ws), `{"entries":[${"1,".repeat(300)}`, 400)) ws.sayText(part);
	const error = (await outcome) as ReplyError;
	expect(error).toBeInstanceOf(ReplyError);
	expect(error.code).toBe("bad-reply");
});

test("a connection that never opens (its handshake was lost) is given up on and tried again", () => {
	const s = new Socket();
	s.connect();
	const first = FakeWS.instances.at(-1) as FakeWS;
	vi.advanceTimersByTime(CONNECT_MS - 100);
	expect(FakeWS.instances).toHaveLength(1);
	vi.advanceTimersByTime(200);
	expect(first.closed).toBe(true);
	// Tried again, after the usual wait.
	vi.advanceTimersByTime(1000);
	expect(FakeWS.instances).toHaveLength(2);
	const second = FakeWS.instances.at(-1) as FakeWS;
	second.open();
	// One that opens in time is left alone.
	vi.advanceTimersByTime(CONNECT_MS * 2);
	expect(second.closed).toBe(false);
});

test("a request made while there is no connection fails when the connection is given up on, and is not sent when one returns", async () => {
	const s = new Socket();
	s.connect();
	const first = FakeWS.instances.at(-1) as FakeWS;
	const waiting = s.rpc("L1", { type: "get_state" }).catch((e: unknown) => e);
	vi.advanceTimersByTime(REPLY_MS + 1);
	expect(await waiting).toBeInstanceOf(ReplyError);
	first.open();
	expect(first.sent.filter((m) => m.t === "rpc")).toEqual([]);
});

/**
 * Through Cloudflare's tunnel the connection crosses a proxy that drops a WebSocket nothing has crossed for about 100 s.
 * The page's own question to a quiet connection (a message each way every `QUIET_MS` plus the look interval) is what keeps
 * it open: the server says nothing on its own when no conversation is working.
 */
test("a connection that nothing but the page's own question crosses stays open through a proxy that drops one idle for 100 s", () => {
	const PROXY_IDLE_LIMIT_MS = 100_000;
	const { ws, status } = connected();
	let lastCrossed = Date.now();
	let longestIdle = 0;
	let dropped = false;
	const answered = new Set<string>();
	// Five minutes (the page was idle for 120 s five times over): every second the proxy looks, and the server answers what it is asked.
	for (let t = 0; t < 300_000 && !dropped; t += 1000) {
		const sentBefore = ws.sent.length;
		vi.advanceTimersByTime(1000);
		if (ws.sent.length > sentBefore) lastCrossed = Date.now();
		for (const ping of ws.pings()) {
			if (ping.req && !answered.has(ping.req)) {
				answered.add(ping.req);
				ws.reply(ping.req, []);
				lastCrossed = Date.now();
			}
		}
		longestIdle = Math.max(longestIdle, Date.now() - lastCrossed);
		if (Date.now() - lastCrossed > PROXY_IDLE_LIMIT_MS) dropped = true;
	}
	expect(dropped).toBe(false);
	expect(longestIdle).toBeLessThanOrEqual(QUIET_MS + 6000);
	expect(FakeWS.instances).toHaveLength(1);
	expect(ws.closed).toBe(false);
	expect(status).toEqual([true]);
});
