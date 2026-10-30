import { expect, test } from "bun:test";
import { type OutSocket, WsOutbox } from "../../server/ws-out.ts";

/**
 * What a page is sent over its WebSocket. Bun's `send` keeps what the socket cannot take yet, up to a limit, and above it
 * throws the message away (it returns 0 and the connection stays open): a reply or a frame lost that way is never
 * delivered, and the page waits for it for ever. `WsOutbox` must never let that happen to a message.
 */

/** A socket that behaves as Bun's does (measured: a stalled reader, 16 MiB limit): accepted messages are delivered in order, the rest are dropped. */
class FakeSocket implements OutSocket {
	/** What the page will receive. */
	delivered: string[] = [];
	/** Bytes accepted and not yet taken by the page. */
	buffered = 0;
	/** Closed by the server: its code. */
	closedWith: number | null = null;
	/** The page is not reading: what is sent stays buffered. */
	stalled = false;
	/** Sends that came back 0. */
	dropped = 0;
	/** The page went away: every send returns 0. */
	gone = false;

	constructor(private readonly limit: number) {}

	send(data: string): number {
		if (this.gone || this.closedWith !== null || this.buffered > this.limit) {
			this.dropped++;
			return 0;
		}
		this.delivered.push(data);
		if (!this.stalled) return data.length;
		this.buffered += data.length;
		return -1;
	}

	getBufferedAmount(): number {
		return this.buffered;
	}

	close(code?: number): void {
		this.closedWith = code ?? 1005;
	}

	/** The page reads again: everything buffered is taken. */
	unstall(): void {
		this.stalled = false;
		this.buffered = 0;
	}
}

const big = (n: number) => "x".repeat(n);

test("a reply that follows a very large message is not dropped, and arrives after the large one's turn", () => {
	const socket = new FakeSocket(100);
	socket.stalled = true;
	const out = new WsOutbox(socket, { highWater: 50, maxQueued: 1_000_000 });
	// What a page asks for when it attaches: the whole session, then small things. The first is over the limit by itself.
	out.send(big(500));
	out.send("get_state reply");
	out.send("goal reply");
	// Sent straight to the socket, the last two would have come back 0. The outbox holds them.
	expect(socket.dropped).toBe(0);
	expect(socket.delivered).toEqual([big(500)]);

	socket.unstall();
	out.drain();
	expect(socket.delivered).toEqual([big(500), "get_state reply", "goal reply"]);
	expect(socket.dropped).toBe(0);
});

test("messages go out in the order they were sent, however long they waited", () => {
	const socket = new FakeSocket(100);
	socket.stalled = true;
	const out = new WsOutbox(socket, { highWater: 50, maxQueued: 1_000_000 });
	out.send(big(60));
	const later = Array.from({ length: 200 }, (_, i) => `m${i}`);
	for (const m of later) out.send(m);
	socket.unstall();
	out.drain();
	expect(socket.delivered).toEqual([big(60), ...later]);
});

test("while the socket keeps up nothing is held back", () => {
	const socket = new FakeSocket(100);
	const out = new WsOutbox(socket, { highWater: 50, maxQueued: 1_000_000 });
	for (let i = 0; i < 20; i++) out.send(`m${i}`);
	expect(out.backlog).toBe(0);
	expect(socket.delivered).toHaveLength(20);
});

test("a large message is held until what was sent before it has been taken: draining sends as much as fits and goes on at the next drain", () => {
	const socket = new FakeSocket(1000);
	socket.stalled = true;
	const out = new WsOutbox(socket, { highWater: 50, maxQueued: 1_000_000 });
	out.send(big(80));
	out.send(big(200));
	out.send("small");
	expect(socket.delivered).toEqual([big(80)]);
	// Taken, but the next large one is accepted at once and fills the socket again: the rest waits for the following drain.
	socket.buffered = 0;
	out.drain();
	expect(socket.delivered).toEqual([big(80), big(200)]);
	socket.unstall();
	out.drain();
	expect(socket.delivered).toEqual([big(80), big(200), "small"]);
	expect(out.backlog).toBe(0);
});

test("a page that cannot keep up for too long is disconnected, so that it comes back and starts from the truth", () => {
	const socket = new FakeSocket(100);
	socket.stalled = true;
	const out = new WsOutbox(socket, { highWater: 50, maxQueued: 1000 });
	out.send(big(60));
	for (let i = 0; i < 20; i++) out.send(big(100));
	expect(socket.closedWith).toBe(1013);
	// What was held is let go, and nothing more is sent to a closed socket.
	expect(out.backlog).toBe(0);
	const before = socket.dropped;
	out.send("late");
	out.drain();
	expect(socket.dropped).toBe(before);
	expect(socket.delivered).not.toContain("late");
});

test("a socket whose page is gone is let go of, not held for", () => {
	const socket = new FakeSocket(100);
	const out = new WsOutbox(socket, { highWater: 50, maxQueued: 1_000_000 });
	socket.gone = true;
	out.send("a");
	// The send came back 0 below the limit: the connection is gone, whatever is sent later has nobody to read it.
	socket.stalled = true;
	out.send(big(500));
	out.send("b");
	expect(out.backlog).toBe(0);
	expect(socket.dropped).toBe(1);
});

test("abandoning drops what is held", () => {
	const socket = new FakeSocket(100);
	socket.stalled = true;
	const out = new WsOutbox(socket, { highWater: 50, maxQueued: 1_000_000 });
	out.send(big(60));
	out.send("a");
	out.abandon();
	expect(out.backlog).toBe(0);
	socket.unstall();
	out.drain();
	expect(socket.delivered).toEqual([big(60)]);
});
