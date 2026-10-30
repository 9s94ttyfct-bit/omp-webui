/**
 * The wire between the server and an omp relay (relay.ts) on the relay's unix socket: frames of
 * `[type: u8][length: u32 big endian][payload]`. The relay carries omp's three pipes and nothing else, so the
 * server needs no more of omp than it has with a pipe of its own.
 */

/** The first argument of the relay command (`omp-webui-server --ompw-relay <socket> <omp> <args…>`). */
export const RELAY_FLAG = "--ompw-relay";

/** Server → relay. */
export const TO_RELAY = {
	/** Bytes for omp's stdin. */
	stdin: 1,
	/** Close omp's stdin: omp drains and exits. */
	stdinEnd: 2,
	/** One byte: 1 = keep omp running when this connection ends (a paused conversation, or one waiting out a usage limit), 0 = end it as a closed pipe would. */
	hold: 3,
} as const;

/** Relay → server. */
export const FROM_RELAY = {
	/** JSON `Hello`; the first frame of every connection. */
	hello: 1,
	/** Whole lines omp wrote to its stdout (never half of one: what a connection receives starts at a line). */
	stdout: 2,
	/** Bytes omp wrote to its stderr. */
	stderr: 3,
	/** JSON `ExitInfo`: omp has ended; nothing follows. */
	exit: 4,
	/** Another connection took over; this one is closed. */
	replaced: 5,
} as const;

export interface Hello {
	/** omp's process id (its own session and process group); null when it could not be started. */
	pid: number | null;
	relayPid: number;
	/** The tail of what omp wrote to stderr so far. */
	stderr: string;
}

export interface ExitInfo {
	code: number | null;
	signal: string | null;
}

/** Bytes of a frame before its payload: the type and the length. */
export const FRAME_HEADER = 5;

/** A frame whose payload is `payload`, or the pieces of it one after another: each is copied once, into the frame. */
export function encodeFrame(type: number, payload: Uint8Array | string | readonly Uint8Array[] = ""): Buffer {
	const parts =
		typeof payload === "string" ? [Buffer.from(payload)] : payload instanceof Uint8Array ? [payload] : payload;
	let length = 0;
	for (const part of parts) length += part.length;
	const out = Buffer.allocUnsafe(FRAME_HEADER + length);
	out[0] = type;
	out.writeUInt32BE(length, 1);
	let at = FRAME_HEADER;
	for (const part of parts) {
		out.set(part, at);
		at += part.length;
	}
	return out;
}

export interface Frame {
	type: number;
	payload: Buffer;
}

/**
 * Reassembles frames from the chunks a socket delivers. A large frame arrives in many chunks: they are joined once,
 * when the frame is complete, not on every chunk.
 */
export class FrameDecoder {
	private chunks: Buffer[] = [];
	private size = 0;
	/** The bytes held must reach this for something to be decoded: a header, then the whole frame once its length is known. */
	private need = FRAME_HEADER;

	push(chunk: Uint8Array): Frame[] {
		// A copy: the socket may reuse the memory it delivered.
		this.chunks.push(Buffer.from(chunk));
		this.size += chunk.length;
		if (this.size < this.need) return [];
		const buf = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
		const frames: Frame[] = [];
		let at = 0;
		for (;;) {
			if (buf.length - at < FRAME_HEADER) {
				this.need = FRAME_HEADER;
				break;
			}
			const total = FRAME_HEADER + buf.readUInt32BE(at + 1);
			if (buf.length - at < total) {
				this.need = total;
				break;
			}
			frames.push({ type: buf[at], payload: buf.subarray(at + FRAME_HEADER, at + total) });
			at += total;
		}
		const rest = buf.subarray(at);
		this.chunks = rest.length ? [rest] : [];
		this.size = rest.length;
		return frames;
	}
}

/** What `Outbox` needs of a socket. */
export interface Writable {
	write(data: Uint8Array): number;
}

/**
 * Writes to a socket that takes only what fits: the rest waits here until the socket reports it drained.
 * `backlog` is what is still waiting.
 */
export class Outbox {
	private queue: Uint8Array[] = [];
	private waiting: (() => void)[] = [];
	backlog = 0;

	constructor(private readonly socket: Writable) {}

	send(data: Uint8Array): void {
		if (this.queue.length === 0) {
			const n = Math.max(0, this.socket.write(data));
			if (n >= data.length) return;
			data = data.subarray(n);
		}
		this.queue.push(data);
		this.backlog += data.length;
	}

	/** The socket has room again. */
	drain(): void {
		while (this.queue.length) {
			const head = this.queue[0];
			const n = Math.max(0, this.socket.write(head));
			this.backlog -= n;
			if (n < head.length) {
				this.queue[0] = head.subarray(n);
				return;
			}
			this.queue.shift();
		}
		for (const done of this.waiting.splice(0)) done();
	}

	/** Resolves once everything sent has been written to the socket. */
	flushed(): Promise<void> {
		if (this.queue.length === 0) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.waiting.push(resolve);
		return promise;
	}

	/** Nothing more will be written (the socket is closed): release what waits on it. */
	abandon(): void {
		this.queue = [];
		this.backlog = 0;
		for (const done of this.waiting.splice(0)) done();
	}
}
