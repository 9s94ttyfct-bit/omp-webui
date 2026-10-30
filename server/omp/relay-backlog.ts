import { closeSync, ftruncateSync, openSync, readSync, rmSync, writeSync } from "node:fs";
import { FRAME_HEADER } from "./relay-protocol.ts";

/**
 * What omp wrote while no server was connected to take it (see `ServerLink`): whole frames, oldest first.
 *
 * The first BACKLOG_MEMORY bytes are kept in memory. Beyond that the frames go to a file of the relay's own — made in
 * the relay's directory, opened and removed at once, so that no relay that is killed leaves it behind — until what is
 * held is BACKLOG_LIMIT. Past that `push` says no, and omp waits on its full pipe, as it does for a server that does not
 * take what it is sent. A file that cannot be written (a full disk) is the same: no.
 *
 * Order: what is in memory is always older than what is in the file (a frame goes to memory only while the file is
 * empty), so `take` empties memory first.
 */

/** Held in memory before the file is used. */
export const BACKLOG_MEMORY = 4 << 20;
/** Held at most, in memory and file together: more than a long turn's output, less than a disk is worth. */
export const BACKLOG_LIMIT = 256 << 20;
/** What one read of the file takes, at least. */
const READ_CHUNK = 256 << 10;

export class Backlog {
	private memory: Buffer[] = [];
	private memoryAt = 0;
	private memoryBytes = 0;
	private fd: number | null = null;
	private readAt = 0;
	private writeAt = 0;

	/**
	 * `spillPath`: where the file is made when memory is not enough (null: memory only, up to `memoryLimit`).
	 */
	constructor(
		private readonly spillPath: string | null = null,
		private readonly memoryLimit = BACKLOG_MEMORY,
		private readonly limit = BACKLOG_LIMIT,
	) {}

	/** Bytes held. */
	get size(): number {
		return this.memoryBytes + (this.writeAt - this.readAt);
	}

	/** Keep `frame` after what is held. False when it does not fit: nothing is kept, and the caller waits. */
	push(frame: Buffer): boolean {
		// A frame that is bigger than the limit still goes in when nothing is held: omp must be able to make progress.
		if (this.size > 0 && this.size + frame.length > (this.spillPath === null ? this.memoryLimit : this.limit))
			return false;
		const fileEmpty = this.writeAt === this.readAt;
		if (this.spillPath === null || (fileEmpty && this.memoryBytes + frame.length <= this.memoryLimit)) {
			this.memory.push(frame);
			this.memoryBytes += frame.length;
			return true;
		}
		return this.spill(frame);
	}

	/** The oldest whole frames, about `max` bytes of them (one at least). Empty when nothing is held. */
	take(max: number): Buffer[] {
		if (this.memoryAt < this.memory.length) {
			const frames: Buffer[] = [];
			let bytes = 0;
			while (this.memoryAt < this.memory.length && (frames.length === 0 || bytes < max)) {
				const frame = this.memory[this.memoryAt++];
				frames.push(frame);
				bytes += frame.length;
			}
			this.memoryBytes -= bytes;
			if (this.memoryAt === this.memory.length) {
				this.memory = [];
				this.memoryAt = 0;
			} else if (this.memoryAt >= 1024) {
				this.memory = this.memory.slice(this.memoryAt);
				this.memoryAt = 0;
			}
			return frames;
		}
		return this.takeFromFile(max);
	}

	/** The file is not needed any more (the relay ends). */
	close(): void {
		this.memory = [];
		this.memoryAt = 0;
		this.memoryBytes = 0;
		this.readAt = this.writeAt = 0;
		if (this.fd === null) return;
		try {
			closeSync(this.fd);
		} catch {
			// already closed
		}
		this.fd = null;
	}

	private spill(frame: Buffer): boolean {
		try {
			if (this.fd === null) {
				const path = this.spillPath as string;
				rmSync(path, { force: true });
				this.fd = openSync(path, "w+", 0o600);
				// Nobody else needs the name: the file goes with the relay, however it ends.
				rmSync(path, { force: true });
			}
			let done = 0;
			while (done < frame.length) done += writeSync(this.fd, frame, done, frame.length - done, this.writeAt + done);
			this.writeAt += frame.length;
			return true;
		} catch {
			return false;
		}
	}

	private takeFromFile(max: number): Buffer[] {
		const fd = this.fd;
		if (fd === null || this.readAt === this.writeAt) return [];
		const held = this.writeAt - this.readAt;
		let buf = this.readFile(fd, Math.min(held, Math.max(max, READ_CHUNK)));
		const frames: Buffer[] = [];
		let at = 0;
		while (buf.length - at >= FRAME_HEADER) {
			const total = FRAME_HEADER + buf.readUInt32BE(at + 1);
			if (buf.length - at < total) {
				// A frame bigger than what was read: this one alone, whole.
				if (at === 0) {
					buf = this.readFile(fd, total);
					frames.push(buf);
					at = total;
				}
				break;
			}
			frames.push(buf.subarray(at, at + total));
			at += total;
		}
		this.readAt += at;
		if (this.readAt === this.writeAt) {
			// Everything taken: the disk is given back, and the next frame starts a new file.
			try {
				ftruncateSync(fd, 0);
			} catch {
				// it only holds space until the relay ends
			}
			this.readAt = this.writeAt = 0;
		}
		return frames;
	}

	private readFile(fd: number, length: number): Buffer {
		const buf = Buffer.allocUnsafe(length);
		let done = 0;
		while (done < length) {
			const n = readSync(fd, buf, done, length - done, this.readAt + done);
			if (n === 0) throw new Error("the relay's spill file is shorter than what was written to it");
			done += n;
		}
		return buf;
	}
}
