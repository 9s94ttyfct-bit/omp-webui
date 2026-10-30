/**
 * What the server sends a page over its WebSocket, in order and without loss.
 *
 * Bun's `ServerWebSocket.send` keeps what the connection cannot take yet, up to `backpressureLimit` (16 MiB), and above
 * that throws the message away: it returns 0, the connection stays open, and nobody is told. One large answer is enough to
 * get there (the whole of a 58 MB conversation, sent when a page attaches, leaves the socket over the limit for as long as
 * the page takes to read it), and every reply and frame sent meanwhile is lost. A reply that never comes leaves the
 * request it answers waiting for ever; a lost `agent_end` leaves the page showing a turn that is over. Neither is
 * noticed until the page is reloaded.
 *
 * `WsOutbox` sends only while the socket holds little, and keeps the rest itself, in order, until Bun says the socket
 * has drained. A page that stops reading altogether (a hidden window, a stuck thread) would make that queue grow without
 * end: past `maxQueued` the connection is closed instead, and the page, which reconnects and asks for the state of
 * everything it shows, starts from the truth rather than from what it happened to receive.
 */

/** What `WsOutbox` needs of Bun's `ServerWebSocket`. */
export interface OutSocket {
	/** Bytes sent; -1 when the connection kept it for later; 0 when it was dropped (the connection is closed, or over its limit). */
	send(data: string): number;
	getBufferedAmount(): number;
	close(code?: number, reason?: string): void;
}

/**
 * Messages are handed to the socket while it holds less than this. Well below Bun's limit, so that a message is never sent
 * to a socket that would drop it; a message larger than the limit by itself is still accepted, whole, by an empty socket.
 */
export const HIGH_WATER = 1 << 20;
/**
 * What may wait for a page that is not reading, in characters, before its connection is closed: more than the whole of a
 * very long conversation (58 MB) queued behind another answer, far less than a window left hidden for hours would pile up.
 * A page that comes back after that reconnects and asks for the state of what it shows, which is cheaper for it than
 * replaying all it missed.
 */
export const MAX_QUEUED = 64 << 20;
/** WebSocket close code 1013, "try again later": the page reconnects as it does after any dropped connection. */
const TOO_SLOW = 1013;

export class WsOutbox {
	/** Held messages are `queue[head..]`: taking one from the front moves `head`, not the whole array. */
	private queue: string[] = [];
	private head = 0;
	private queued = 0;
	private dead = false;
	private readonly highWater: number;
	private readonly maxQueued: number;

	constructor(
		private readonly socket: OutSocket,
		limits: { highWater?: number; maxQueued?: number } = {},
	) {
		this.highWater = limits.highWater ?? HIGH_WATER;
		this.maxQueued = limits.maxQueued ?? MAX_QUEUED;
	}

	/** Characters held back for a socket that has not taken them yet. */
	get backlog(): number {
		return this.queued;
	}

	/** Send `text` after everything sent before it. */
	send(text: string): void {
		if (this.dead) return;
		// Bun's `drain` is what normally empties the queue; looking here too means a message is never stuck behind a drain that was missed.
		this.flush();
		if (this.dead) return;
		if (this.queue.length === this.head && this.socket.getBufferedAmount() < this.highWater) {
			this.transmit(text);
			return;
		}
		this.queue.push(text);
		this.queued += text.length;
		if (this.queued > this.maxQueued) {
			this.abandon();
			this.socket.close(TOO_SLOW, "Too slow to keep up");
		}
	}

	/** The socket can take more (Bun's `drain`). */
	drain(): void {
		if (!this.dead) this.flush();
	}

	/** The connection is over: what is held has nobody to go to. */
	abandon(): void {
		this.dead = true;
		this.queue = [];
		this.head = 0;
		this.queued = 0;
	}

	private flush(): void {
		while (!this.dead && this.head < this.queue.length && this.socket.getBufferedAmount() < this.highWater) {
			const text = this.queue[this.head++] as string;
			this.queued -= text.length;
			this.transmit(text);
		}
		if (this.head === this.queue.length) {
			this.queue = [];
			this.head = 0;
		} else if (this.head > 4096 && this.head * 2 > this.queue.length) {
			// A long queue is not shifted message by message: what is behind `head` is dropped once, when it is half of it.
			this.queue = this.queue.slice(this.head);
			this.head = 0;
		}
	}

	private transmit(text: string): void {
		// Below the limit a send comes back 0 only when the connection is gone: nothing after it will arrive either.
		if (this.socket.send(text) === 0) this.abandon();
	}
}
