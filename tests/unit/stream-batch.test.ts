import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveInfo, OmpFrame, ServerMessage } from "../../shared/protocol.ts";
import type { BatchClock } from "../../web/src/lib/frame-batch.ts";
import type { Socket as SocketType } from "../../web/src/lib/ws.ts";
import type { LiveState } from "../../web/src/store/live.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

// The store reads localStorage as it loads; another test file's restore may have removed the stubs, so load after putting them back.
installGlobals();
const { FrameBatcher, HIDDEN_FLUSH_MS } = await import("../../web/src/lib/frame-batch.ts");
const { Socket } = await import("../../web/src/lib/ws.ts");
const { onServer, useApp } = await import("../../web/src/store/app.ts");
const { applyFrame, initialLive } = await import("../../web/src/store/live.ts");
const { useTurnClocks } = await import("../../web/src/store/turn-clock.ts");

/**
 * Streamed tokens are held until the page paints and applied as one batch: how many store writes that takes, and that
 * what is applied, and in which order, is what arrived.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const info: LiveInfo = {
	liveId: "SB1",
	pid: 1,
	cwd: "/",
	sessionFile: null,
	sessionId: null,
	args: [],
	startedAt: 0,
	streaming: true,
	exited: false,
	subscribers: 1,
	pausedAt: null,
	mode: "full",
};

/** A paint and a timer that only happen when the test says so. */
class ManualClock implements BatchClock {
	private frames = new Set<() => void>();
	private timers = new Set<{ fn: () => void; at: number }>();
	private now = 0;
	frame(fn: () => void) {
		this.frames.add(fn);
		return () => void this.frames.delete(fn);
	}
	timeout(fn: () => void, ms: number) {
		const timer = { fn, at: this.now + ms };
		this.timers.add(timer);
		return () => void this.timers.delete(timer);
	}
	/** The browser paints: every callback asked for before the paint runs. */
	paint(): void {
		for (const fn of [...this.frames]) {
			this.frames.delete(fn);
			fn();
		}
	}
	advance(ms: number): void {
		this.now += ms;
		for (const t of [...this.timers]) {
			if (t.at > this.now) continue;
			this.timers.delete(t);
			t.fn();
		}
	}
	get waiting(): number {
		return this.frames.size + this.timers.size;
	}
}

const update = (liveId: string, messageId: string, event: Record<string, unknown>): ServerMessage => ({
	t: "frame",
	liveId,
	frame: { type: "message_update", messageId, message: { role: "assistant" }, assistantMessageEvent: event },
});
const text = (liveId: string, messageId: string, delta: string, contentIndex = 0) =>
	update(liveId, messageId, { type: "text_delta", contentIndex, delta });
const frameOf = (type: string, liveId = "SB1", extra: Record<string, unknown> = {}): ServerMessage => ({
	t: "frame",
	liveId,
	frame: { type, ...extra },
});

/** The browser's WebSocket, as far as `Socket` uses it. */
class FakeWS {
	static OPEN = 1;
	readyState = 1;
	onopen?: () => void;
	onclose?: (ev: { code: number }) => void;
	onmessage?: (ev: { data: string }) => void;
	constructor(readonly url: string) {}
	send() {}
}

/** A connected `Socket` on a fake WebSocket and fake timers (what holds tokens for the paint is a timer here); `deliver` is the server speaking. */
function withSocket(run: (socket: SocketType, ws: FakeWS, deliver: (m: ServerMessage) => void) => void): void {
	const g = globalThis as unknown as Record<string, unknown>;
	const saved = { WebSocket: g.WebSocket, location: g.location };
	vi.useFakeTimers();
	Object.assign(globalThis, {
		WebSocket: class extends FakeWS {
			constructor(url: string) {
				super(url);
				made = this;
			}
		},
		location: { protocol: "http:", host: "127.0.0.1:1" },
	});
	let made: FakeWS | undefined;
	try {
		const socket = new Socket();
		socket.connect();
		const ws = made as unknown as FakeWS;
		run(socket, ws, (m) => ws.onmessage?.({ data: JSON.stringify(m) }));
	} finally {
		vi.useRealTimers();
		Object.assign(globalThis, saved);
	}
}
/** The messages a batcher delivered, for the assertions. */
function recorder() {
	const clock = new ManualClock();
	const got: ServerMessage[] = [];
	const batcher = new FrameBatcher((m) => void got.push(m), clock);
	/** What each delivered message was, shortened: `type` or `type:delta`. */
	const shape = () =>
		got.map((m) => {
			if (m.t !== "frame") return m.t;
			const ev = m.frame.assistantMessageEvent as { type?: string; delta?: string } | undefined;
			return ev?.delta !== undefined ? `${ev.type}:${ev.delta}` : (ev?.type ?? m.frame.type);
		});
	return { clock, got, batcher, shape };
}

describe("held until the page paints", () => {
	test("tokens wait for the paint, then arrive as one frame with all their text, in order", () => {
		const { clock, batcher, shape } = recorder();
		for (const piece of ["Hel", "lo", ", ", "wor", "ld"]) batcher.push(text("SB1", "m1", piece));
		expect(shape()).toEqual([]);
		clock.paint();
		expect(shape()).toEqual(["text_delta:Hello, world"]);
	});

	test("the joined frame is the first frame of the run with the whole text as its delta", () => {
		const { clock, got, batcher } = recorder();
		batcher.push(text("SB1", "m1", "a"));
		batcher.push(text("SB1", "m1", "b"));
		clock.paint();
		expect(got).toEqual([text("SB1", "m1", "ab")]);
	});

	test("a hidden tab does not paint: the timer delivers what is held, and the paint after it finds nothing", () => {
		const { clock, shape, batcher } = recorder();
		batcher.push(text("SB1", "m1", "x"));
		clock.advance(HIDDEN_FLUSH_MS - 1);
		expect(shape()).toEqual([]);
		clock.advance(1);
		expect(shape()).toEqual(["text_delta:x"]);
		clock.paint();
		expect(shape()).toEqual(["text_delta:x"]);
		// Nothing is left waiting: the paint (or the timer, whichever came second) was cancelled with the first.
		expect(clock.waiting).toBe(0);
	});

	test("a paint also cancels the timer; the next token asks for both again", () => {
		const { clock, shape, batcher } = recorder();
		batcher.push(text("SB1", "m1", "a"));
		clock.paint();
		expect(clock.waiting).toBe(0);
		batcher.push(text("SB1", "m1", "b"));
		expect(clock.waiting).toBe(2);
		clock.advance(HIDDEN_FLUSH_MS);
		expect(shape()).toEqual(["text_delta:a", "text_delta:b"]);
	});

	test("flush delivers at once", () => {
		const { shape, batcher } = recorder();
		batcher.push(text("SB1", "m1", "a"));
		batcher.flush();
		expect(shape()).toEqual(["text_delta:a"]);
		batcher.flush();
		expect(shape()).toEqual(["text_delta:a"]);
	});

	test("the first update after a message starts is not held (the turn clock times the first token by when it arrives); the rest wait", () => {
		const { clock, shape, batcher } = recorder();
		batcher.push(frameOf("message_start", "SB1", { messageId: "m1", message: { role: "assistant" } }));
		batcher.push(update("SB1", "m1", { type: "text_start", contentIndex: 0 }));
		expect(shape()).toEqual(["message_start", "text_start"]);
		batcher.push(text("SB1", "m1", "a"));
		batcher.push(text("SB1", "m1", "b"));
		expect(shape()).toEqual(["message_start", "text_start"]);
		clock.paint();
		expect(shape()).toEqual(["message_start", "text_start", "text_delta:ab"]);
	});
});

describe("order", () => {
	test("any other message delivers the held tokens first, then itself", () => {
		const others: ServerMessage[] = [
			frameOf("message_end", "SB1", { messageId: "m1" }),
			frameOf("tool_execution_start", "SB1", { toolCallId: "t1", toolName: "bash" }),
			frameOf("queue_update"),
			frameOf("agent_end"),
			{ t: "reply", req: "r1", ok: true, data: {} },
			{ t: "live_exit", liveId: "SB1", code: 0, stderr: "" },
			{ t: "live", info },
			{ t: "sessions_changed" } as ServerMessage,
		];
		for (const other of others) {
			const { got, batcher } = recorder();
			batcher.push(text("SB1", "m1", "a"));
			batcher.push(text("SB1", "m1", "b"));
			batcher.push(other);
			batcher.push(text("SB1", "m1", "c"));
			batcher.flush();
			expect(got, JSON.stringify(other)).toEqual([text("SB1", "m1", "ab"), other, text("SB1", "m1", "c")]);
		}
	});

	test("deltas of another block, another kind or another message are not joined, and keep their place", () => {
		const { clock, shape, batcher } = recorder();
		batcher.push(update("SB1", "m1", { type: "thinking_delta", contentIndex: 0, delta: "t1 " }));
		batcher.push(update("SB1", "m1", { type: "thinking_delta", contentIndex: 0, delta: "t2" }));
		batcher.push(update("SB1", "m1", { type: "thinking_end", contentIndex: 0, content: "t1 t2" }));
		batcher.push(update("SB1", "m1", { type: "text_start", contentIndex: 1 }));
		batcher.push(text("SB1", "m1", "a", 1));
		batcher.push(text("SB1", "m1", "b", 1));
		batcher.push(text("SB1", "m1", "c", 2));
		batcher.push(text("SB1", "m2", "d", 2));
		batcher.push(update("SB1", "m2", { type: "toolcall_delta", contentIndex: 2, delta: "{" }));
		batcher.push(update("SB1", "m2", { type: "toolcall_delta", contentIndex: 2, delta: "}" }));
		clock.paint();
		expect(shape()).toEqual([
			"thinking_delta:t1 t2",
			"thinking_end",
			"text_start",
			"text_delta:ab",
			"text_delta:c",
			"text_delta:d",
			"toolcall_delta:{}",
		]);
	});

	test("conversations are independent: each keeps its own order and joins its own tokens", () => {
		const { clock, got, batcher } = recorder();
		batcher.push(text("A", "m1", "a1"));
		batcher.push(text("B", "m1", "b1"));
		batcher.push(text("A", "m1", "a2"));
		batcher.push(text("B", "m1", "b2"));
		clock.paint();
		expect(got).toEqual([text("A", "m1", "a1a2"), text("B", "m1", "b1b2")]);
	});

	test("a snapshot frame (omp without the delta projection) is a full state, never joined with another", () => {
		const { clock, got, batcher } = recorder();
		const snap = (t: string) =>
			update("SB1", "m1", {
				type: "text_delta",
				contentIndex: 0,
				delta: t.slice(-1),
				partial: { role: "assistant", content: [{ type: "text", text: t }] },
			});
		batcher.push(snap("a"));
		batcher.push(snap("ab"));
		clock.paint();
		expect(got).toEqual([snap("a"), snap("ab")]);
	});

	test("a frame without a message id or delta passes through untouched", () => {
		const { clock, got, batcher } = recorder();
		const odd: ServerMessage = { t: "frame", liveId: "SB1", frame: { type: "message_update" } };
		batcher.push(odd);
		batcher.push(odd);
		clock.paint();
		expect(got).toEqual([odd, odd]);
	});

	test("a listener that throws loses nothing: the rest of the batch is delivered, then the error is thrown", () => {
		const clock = new ManualClock();
		const seen: string[] = [];
		const batcher = new FrameBatcher((m) => {
			seen.push(m.t === "frame" ? String(m.frame.type) : m.t);
			if (seen.length === 1) throw new Error("listener failed");
		}, clock);
		batcher.push(text("SB1", "m1", "a"));
		batcher.push(update("SB1", "m1", { type: "text_end", contentIndex: 0, content: "a" }));
		batcher.push(text("L2", "m9", "z"));
		expect(() => clock.paint()).toThrow("listener failed");
		expect(seen).toEqual(["message_update", "message_update", "message_update"]);
	});
});

describe("what the store ends with", () => {
	const frames: OmpFrame[] = readFileSync(join(import.meta.dir, "../fixtures/delta-frames.jsonl"), "utf8")
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l));

	/** The frames recorded from a real omp run, fed to the store as they come (`every`: a paint after that many of them; 0: only at the end). */
	function replay(every: number): LiveState {
		let s: LiveState = initialLive(info);
		const clock = new ManualClock();
		const batcher = new FrameBatcher((m) => {
			if (m.t === "frame") s = applyFrame(s, m.frame);
		}, clock);
		frames.forEach((frame, i) => {
			batcher.push({ t: "frame", liveId: "SB1", frame });
			if (every && (i + 1) % every === 0) clock.paint();
		});
		batcher.flush();
		return s;
	}

	test("the recorded run ends in the same state however the paints fall between its frames", () => {
		const direct = frames.reduce<LiveState>(applyFrame, initialLive(info));
		for (const every of [0, 1, 2, 3, 5, 7, 11]) {
			const batched = replay(every);
			expect(batched.overlay, `paint every ${every}`).toEqual(direct.overlay);
			expect(batched.tools).toEqual(direct.tools);
		}
	});

	test("a long run of tokens ends in exactly their text", () => {
		const pieces = Array.from({ length: 500 }, (_, i) => `word${i} `);
		let s: LiveState = initialLive(info);
		const clock = new ManualClock();
		const batcher = new FrameBatcher((m) => {
			if (m.t === "frame") s = applyFrame(s, m.frame);
		}, clock);
		batcher.push(frameOf("message_start", "SB1", { messageId: "m1", message: { role: "assistant" } }));
		batcher.push(update("SB1", "m1", { type: "text_start", contentIndex: 0 }));
		pieces.forEach((p, i) => {
			batcher.push(text("SB1", "m1", p));
			if (i % 37 === 36) clock.paint();
		});
		batcher.flush();
		const block = s.overlay.find((o) => o.messageId === "m1")?.message.content;
		expect(block).toEqual([{ type: "text", text: pieces.join("") }]);
	});

	test("a delta that adds nothing to the message (a tool call's arguments) leaves the live state as it is", () => {
		let s: LiveState = initialLive(info);
		for (const f of [
			{ type: "message_start", messageId: "m1", message: { role: "assistant" } },
			{
				type: "message_update",
				messageId: "m1",
				message: { role: "assistant" },
				assistantMessageEvent: { type: "toolcall_start", contentIndex: 0 },
			},
		] as OmpFrame[])
			s = applyFrame(s, f);
		const before = s;
		const after = applyFrame(s, {
			type: "message_update",
			messageId: "m1",
			message: { role: "assistant" },
			assistantMessageEvent: { type: "toolcall_delta", contentIndex: 0, delta: '{"a":' },
		});
		expect(after).toBe(before);
	});
});

describe("store writes", () => {
	beforeEach(() => {
		useApp.setState({ lives: { SB1: initialLive(info) }, toasts: [] });
		useTurnClocks.setState({}, true);
	});

	test("the first token is timed when it arrives, not when the page paints", () => {
		const batcher = new FrameBatcher(onServer, new ManualClock());
		batcher.push(frameOf("agent_start"));
		batcher.push(frameOf("message_start", "SB1", { messageId: "m1", message: { role: "assistant" } }));
		expect(useTurnClocks.getState().SB1?.step?.firstTokenAt).toBeUndefined();
		batcher.push(update("SB1", "m1", { type: "thinking_start", contentIndex: 0 }));
		expect(useTurnClocks.getState().SB1?.step?.firstTokenAt).toBeNumber();
	});

	/** How many times the store told its subscribers about a change while `run` ran. */
	function writes(run: () => void): number {
		let n = 0;
		const off = useApp.subscribe(() => void n++);
		try {
			run();
		} finally {
			off();
		}
		return n;
	}

	const overlayText = () => {
		const block = useApp.getState().lives.SB1?.overlay.find((o) => o.messageId === "m1")?.message.content;
		return Array.isArray(block) ? block.map((b) => b.text).join("") : "";
	};

	test("one frame's worth of tokens is one store write; delivered one by one they were one write each", () => {
		const pieces = Array.from({ length: 40 }, (_, i) => `tok${i} `);
		const clock = new ManualClock();
		const batcher = new FrameBatcher(onServer, clock);
		batcher.push(frameOf("message_start", "SB1", { messageId: "m1", message: { role: "assistant" } }));
		batcher.push(update("SB1", "m1", { type: "text_start", contentIndex: 0 }));
		clock.paint();

		expect(writes(() => pieces.forEach((p) => void batcher.push(text("SB1", "m1", p))))).toBe(0);
		expect(writes(() => clock.paint())).toBe(1);
		expect(overlayText()).toBe(pieces.join(""));

		// What the page did before: each token on its own.
		const alone = writes(() => pieces.forEach((p) => void onServer(text("SB1", "m1", p))));
		expect(alone).toBe(pieces.length);
		expect(overlayText()).toBe(pieces.join("") + pieces.join(""));
	});

	test("tokens that come through the socket are applied as one write when the page paints, not one each", () => {
		withSocket((socket, ws, deliver) => {
			socket.on(onServer);
			deliver(frameOf("message_start", "SB1", { messageId: "m1", message: { role: "assistant" } }));
			deliver(update("SB1", "m1", { type: "text_start", contentIndex: 0 }));
			vi.advanceTimersByTime(HIDDEN_FLUSH_MS);
			expect(ws.url).toContain("/ws");

			const pieces = Array.from({ length: 60 }, (_, i) => `t${i} `);
			// Nothing is applied while the tokens are still arriving...
			expect(writes(() => pieces.forEach((p) => void deliver(text("SB1", "m1", p))))).toBe(0);
			expect(overlayText()).toBe("");
			// ...and all of them are, in one write, when the page paints.
			expect(writes(() => void vi.advanceTimersByTime(HIDDEN_FLUSH_MS))).toBe(1);
			expect(overlayText()).toBe(pieces.join(""));
		});
	});

	test("a dropped connection is reported after the tokens that came before it", () => {
		withSocket((socket, ws, deliver) => {
			const order: string[] = [];
			socket.on((m) => {
				if (m.t === "frame") order.push(`token:${(m.frame.assistantMessageEvent as { delta: string }).delta}`);
			});
			socket.onStatus((connected) => void order.push(connected ? "open" : "closed"));
			deliver(text("SB1", "m1", "a"));
			deliver(text("SB1", "m1", "b"));
			expect(order).toEqual([]);
			ws.onclose?.({ code: 1006 });
			expect(order).toEqual(["token:ab", "closed"]);
		});
	});

	test("the end of a message applies the tokens before it, in the same call", () => {
		const clock = new ManualClock();
		const batcher = new FrameBatcher(onServer, clock);
		batcher.push(frameOf("message_start", "SB1", { messageId: "m1", message: { role: "assistant" } }));
		batcher.push(update("SB1", "m1", { type: "text_start", contentIndex: 0 }));
		batcher.push(text("SB1", "m1", "Hello "));
		batcher.push(text("SB1", "m1", "there"));
		expect(overlayText()).toBe("");
		batcher.push(
			frameOf("message_end", "SB1", {
				messageId: "m1",
				message: { role: "assistant", content: [{ type: "text", text: "Hello there" }] },
			}),
		);
		const overlay = useApp.getState().lives.SB1?.overlay.find((o) => o.messageId === "m1");
		expect(overlay?.ended).toBe(true);
		expect(overlayText()).toBe("Hello there");
	});
});
