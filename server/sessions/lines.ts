import { closeSync, fstatSync, openSync, read, readSync } from "node:fs";

/**
 * Reading a session file from a byte offset, one line at a time, so that a grown file costs what it grew by:
 * the indexer remembers where it stopped and picks up from there instead of reading and parsing the whole
 * transcript again. Offsets are bytes; every line a cursor hands out says where the next one starts.
 */

/** Read at most this much at once: a chunk is decoded line by line, so memory stays small however large the file. */
const CHUNK_BYTES = 4 * 1024 * 1024;
/** How many bytes before an offset are hashed to tell "the file grew" from "the file was rewritten". */
const WINDOW_BYTES = 4096;
/** Indexing work (a scan, a transcript read for the first time) goes on this long before it lets the event loop run. */
export const SLICE_MS = 8;

const NEWLINE = 10;

/**
 * `read` as a promise, written out rather than made by `util.promisify`: this file is loaded by the search index's worker
 * too, where `node:util` is a module of its own to load (about 0.7 MB of the worker's memory), for one function (#585).
 */
function readAsync(fd: number, buffer: Buffer, offset: number, length: number, position: number) {
	const { promise, resolve, reject } = Promise.withResolvers<{ bytesRead: number }>();
	read(fd, buffer, offset, length, position, (error, bytesRead) => (error ? reject(error) : resolve({ bytesRead })));
	return promise;
}

export interface Line {
	text: string;
	/** Byte offset just past this line and its newline (or past its last byte when it has none). */
	end: number;
	/** False for the last line of the range when no newline follows it: the writer may not have finished it. */
	terminated: boolean;
}

/**
 * A session file, opened once. omp rewrites a transcript by writing a new file and renaming it over the old one, so a
 * path names different files at different moments, and a read that opens it again for every chunk is made of both:
 * the seam is garbled, and what an index saves as "read up to here" is wrong for the file that is there afterwards.
 * Everything an index takes in of one read (the lines, the bytes it fingerprints, the size and time it records) comes
 * from this one open file, whose bytes stay as they were however the path is replaced meanwhile. `close` it when the
 * read is done: a read that is in flight finishes first.
 */
export class SessionFile {
	/** The open file's descriptor; -1 once it is closed. */
	private fd: number;
	private reading = 0;
	private closing = false;

	private constructor(
		fd: number,
		/** The file's size when it was opened. */
		readonly size: number,
		/** The file's modification time when it was opened. */
		readonly mtimeMs: number,
	) {
		this.fd = fd;
	}

	/** The file at `path` opened, or null when it is not there (or cannot be read). */
	static open(path: string): SessionFile | null {
		let fd: number;
		try {
			fd = openSync(path, "r");
		} catch {
			return null;
		}
		try {
			const st = fstatSync(fd);
			return new SessionFile(fd, st.size, st.mtimeMs);
		} catch {
			closeSync(fd);
			return null;
		}
	}

	/** Whether the file is still open for reading. */
	get isOpen(): boolean {
		return this.fd >= 0 && !this.closing;
	}

	/** `length` bytes from `at` (fewer at the end of the file; none when it is closed or cannot be read). */
	read(at: number, length: number): Buffer {
		if (!this.isOpen) return Buffer.alloc(0);
		try {
			const buf = Buffer.allocUnsafe(length);
			let got = 0;
			while (got < length) {
				const n = readSync(this.fd, buf, got, length - got, at + got);
				if (n === 0) break;
				got += n;
			}
			return got === length ? buf : buf.subarray(0, got);
		} catch {
			return Buffer.alloc(0);
		}
	}

	/** `read`, without holding the event loop for the disk. */
	async readAt(at: number, length: number): Promise<Buffer> {
		if (!this.isOpen) return Buffer.alloc(0);
		this.reading++;
		try {
			const buf = Buffer.allocUnsafe(length);
			let got = 0;
			while (got < length) {
				const { bytesRead } = await readAsync(this.fd, buf, got, length - got, at + got);
				if (bytesRead === 0) break;
				got += bytesRead;
			}
			return got === length ? buf : buf.subarray(0, got);
		} catch {
			return Buffer.alloc(0);
		} finally {
			if (--this.reading === 0 && this.closing) this.release();
		}
	}

	/**
	 * A fingerprint of the bytes just before `end`. A transcript only ever grows at its end, so when the bytes before
	 * the offset an index stopped at still hash the same, everything it indexed is still what the file says; when
	 * they do not, the file was rewritten and has to be indexed again from the start.
	 */
	windowHash(end: number): string {
		const from = Math.max(0, end - WINDOW_BYTES);
		return String(Bun.hash(this.read(from, end - from)));
	}

	/** Complete lines between byte offsets `from` and `to` (the end of the file as it was opened by default). */
	lines(from: number, to = this.size, chunkBytes = CHUNK_BYTES): LineCursor {
		return new LineCursor(this, from, to, chunkBytes);
	}

	close(): void {
		this.closing = true;
		if (this.reading === 0) this.release();
	}

	private release(): void {
		if (this.fd < 0) return;
		closeSync(this.fd);
		this.fd = -1;
	}
}

/** Complete lines of a `SessionFile` between byte offsets `from` and `to`, read a chunk at a time. */
export class LineCursor {
	private buf: Buffer = Buffer.alloc(0);
	/** Absolute offset of `buf[0]`. */
	private start: number;
	/** Index in `buf` of the next unread byte. */
	private at = 0;
	private limit: number;

	constructor(
		private readonly file: SessionFile,
		from: number,
		to: number,
		private readonly chunkBytes = CHUNK_BYTES,
	) {
		this.start = from;
		this.limit = to;
	}

	/** The next line, or null when the range is used up. Reading a chunk is the only thing it waits for. */
	async next(): Promise<Line | null> {
		for (;;) {
			const nl = this.buf.indexOf(NEWLINE, this.at);
			if (nl >= 0) {
				const text = this.buf.toString("utf8", this.at, nl);
				this.at = nl + 1;
				return { text, end: this.start + this.at, terminated: true };
			}
			const have = this.start + this.buf.length;
			if (have >= this.limit) {
				if (this.at >= this.buf.length) return null;
				const text = this.buf.toString("utf8", this.at);
				this.at = this.buf.length;
				return { text, end: have, terminated: false };
			}
			const more = await this.file.readAt(have, Math.min(this.limit, have + this.chunkBytes) - have);
			if (more.length === 0) {
				// Shorter than it was when listed (truncated or removed since): what is there is all there is.
				this.limit = have;
				continue;
			}
			this.start += this.at;
			this.buf = Buffer.concat([this.buf.subarray(this.at), more]);
			this.at = 0;
		}
	}
}

/** Lets the event loop run: pings, frames and requests get their turn between slices of indexing work. */
export function yieldToLoop(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}
