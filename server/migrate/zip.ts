import { createHash } from "node:crypto";
import { open, rm } from "node:fs/promises";
import { Readable, type Transform, Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { crc32, createDeflateRaw, createInflateRaw } from "node:zlib";

/**
 * Archive container for "move everything to a new computer": a ZIP that is written as a stream (an entry is never held
 * in memory whole, so a multi-gigabyte conversation history costs a megabyte of heap) and read back by random access
 * (the central directory is the index; an entry is inflated on demand). Plain ZIP + ZIP64 so that the user can open an
 * archive with any unzip tool when something goes wrong on the new Mac; an archive that is encrypted as a whole is this
 * same zip inside `sealed.ts`'s container (the writer and the reader take a sink and a byte source for that), and only
 * the app, with the password, opens it.
 */

/** Nothing the writer or reader hands out is bigger than this per chunk, so memory stays flat whatever the entry. */
const CHUNK = 1024 * 1024;
/** Compressed bytes are fed to the inflater in small pieces: a hostile entry can expand ~1000x, and one piece is the unit that expansion is bounded by. */
const INFLATE_FEED = 64 * 1024;
const DEFAULT_BYTES_LIMIT = 256 * 1024 * 1024;

const SIG_LOCAL = 0x04034b50;
const SIG_DESCRIPTOR = 0x08074b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_EOCD64 = 0x06064b50;
const SIG_LOCATOR64 = 0x07064b50;

const MAX16 = 0xffff;
const MAX32 = 0xffffffff;
/** Names longer than this do not fit the 16-bit length field. */
const MAX_NAME_BYTES = 0xffff;
const EOCD_SIZE = 22;
const LOCATOR_SIZE = 20;
const EOCD64_SIZE = 56;

/** Bit 3: sizes and crc follow the data. Bit 11: names are UTF-8. */
const FLAG_DESCRIPTOR = 1 << 3;
const FLAG_UTF8 = 1 << 11;
const FLAG_ENCRYPTED = 1 | (1 << 6) | (1 << 13);

const HOST_UNIX = 3 << 8;
const S_IFREG = 0o100000;

// DOS timestamps cannot express anything outside this window; a clamp beats an archive nobody can open.
const DOS_MIN = Date.UTC(1980, 0, 1);
const DOS_MAX = Date.UTC(2107, 11, 31, 23, 59, 58);

export type ZipErrorCode = "corrupt" | "unsupported" | "aborted" | "name" | "tampered";

export class ZipError extends Error {
	constructor(
		message: string,
		readonly code: ZipErrorCode,
	) {
		super(message);
		this.name = "ZipError";
	}
}

export interface ZipWritten {
	name: string;
	size: number;
	compressedSize: number;
	crc32: number;
	/** Hex SHA-256 of the uncompressed bytes. */
	sha256: string;
}

export interface ZipAddOptions {
	/** Deflate (default) or store as is. */
	compress?: boolean;
	/** Deflate level, default 3: history is text, and level 3 is most of the saving for a fraction of the CPU. */
	level?: number;
	mtimeMs?: number;
	/** Unix permission bits, default 0o644. */
	mode?: number;
	signal?: AbortSignal;
	/** Uncompressed bytes consumed so far, called once per chunk. */
	onBytes?: (n: number) => void;
}

/**
 * MS-DOS date and time have no zone. They are written from, and read back as, UTC so that an archive round-trips to the
 * same millisecond value on every machine and in every test, whatever the local zone is. (Other tools will show the
 * time shifted by the exporter's offset; the importer does not care about the clock reading, only about ordering.)
 */
function toDos(ms: number): { time: number; date: number } {
	const rounded = Number.isFinite(ms) ? Math.round(ms / 2000) * 2000 : DOS_MIN;
	const d = new Date(Math.min(Math.max(rounded, DOS_MIN), DOS_MAX));
	return {
		time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
		date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
	};
}

function fromDos(time: number, date: number): number {
	const year = 1980 + (date >> 9);
	const month = Math.max(1, (date >> 5) & 0xf);
	const day = Math.max(1, date & 0x1f);
	return Date.UTC(year, month - 1, day, time >> 11, (time >> 5) & 0x3f, (time & 0x1f) * 2);
}

function checkName(name: string): Buffer {
	const bad = (why: string) => new ZipError(`Invalid archive entry name ${JSON.stringify(name)}: ${why}`, "name");
	if (name === "") throw bad("empty");
	if (name.startsWith("/")) throw bad("absolute");
	if (name.endsWith("/")) throw bad("directory");
	if (name.includes("\\")) throw bad("backslash");
	if (name.includes("\0")) throw bad("NUL");
	if (name.split("/").includes("..")) throw bad("parent segment");
	const raw = Buffer.from(name, "utf8");
	// A lone surrogate encodes to U+FFFD, so two different names could collapse into one stored name.
	if (raw.toString("utf8") !== name) throw bad("not valid Unicode");
	if (raw.length > MAX_NAME_BYTES) throw bad("too long");
	return raw;
}

/** Source of chunks, whatever shape the caller has; a stream is released on every exit path. */
async function* chunksOf(
	source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | Uint8Array,
): AsyncGenerator<Uint8Array> {
	if (source instanceof Uint8Array) {
		yield source;
		return;
	}
	if ("getReader" in source) {
		const reader = source.getReader();
		try {
			for (;;) {
				const r = await reader.read();
				if (r.done) return;
				yield r.value;
			}
		} finally {
			// Cancel (not just release) so a producer that is still writing is told to stop.
			await reader.cancel().catch(() => {});
		}
	}
	yield* source as AsyncIterable<Uint8Array>;
}

/**
 * Where a writer puts its bytes: an open file, or the sealed output of `sealed.ts`. The positions a writer asks for are
 * its own running total, so a sink may be append-only; `truncate` takes back what a failed entry had written. `sync` is
 * called once, after the last write, and makes everything durable (a sealed sink seals its last chunk in it).
 */
export interface ZipSink {
	write(buf: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesWritten: number }>;
	truncate(length: number): Promise<void>;
	sync(): Promise<void>;
	close(): Promise<void>;
}

export class ZipWriter {
	private pos = 0;
	private readonly central: Buffer[] = [];
	private readonly names = new Set<string>();
	private zip64Seen = false;
	/** Set by an entry that took itself back out of the file because its source failed; the writer stays usable. */
	private rolledBack = false;
	private busy = false;
	private done: "finished" | "aborted" | null = null;
	private failure: Error | null = null;

	private constructor(
		private readonly fh: ZipSink,
		private readonly path: string,
		private readonly zip64At: number,
	) {}

	static async create(path: string, options?: { zip64At?: number }): Promise<ZipWriter> {
		// 0o600: an archive can hold logins, and "wx" so that an existing file is never clobbered.
		const fh = await open(path, "wx", 0o600);
		return ZipWriter.createOn(fh, path, options);
	}

	/** A writer whose bytes go to `sink` (the file at `path`, which `abort` removes) instead of straight to a file. */
	static createOn(sink: ZipSink, path: string, options?: { zip64At?: number }): ZipWriter {
		// Above the 32-bit ceiling the field values themselves stop fitting, so the hook cannot raise it.
		return new ZipWriter(sink, path, Math.min(options?.zip64At ?? MAX32, MAX32));
	}

	private async writeAll(buf: Uint8Array): Promise<void> {
		let off = 0;
		while (off < buf.length) {
			if (this.done) throw new ZipError("Archive writer was aborted", "aborted");
			const { bytesWritten } = await this.fh.write(buf, off, buf.length - off, this.pos);
			off += bytesWritten;
			this.pos += bytesWritten;
		}
	}

	private assertUsable(): void {
		if (this.done === "aborted") throw new ZipError("Archive writer was aborted", "aborted");
		if (this.done === "finished") throw new Error("Archive writer is already finished");
		if (this.failure)
			throw new ZipError(`Archive writer is unusable after a failed entry: ${this.failure.message}`, "aborted");
	}

	async add(
		name: string,
		source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | Uint8Array,
		options: ZipAddOptions = {},
	): Promise<ZipWritten> {
		if (this.busy) throw new Error("ZipWriter.add must not be called concurrently");
		this.assertUsable();
		const rawName = checkName(name);
		if (this.names.has(name)) throw new ZipError(`Duplicate archive entry name ${JSON.stringify(name)}`, "name");
		const { signal } = options;
		if (signal?.aborted) throw new ZipError("Archive entry was aborted", "aborted");

		this.busy = true;
		try {
			return await this.addEntry(name, rawName, source, options);
		} catch (err) {
			if (this.rolledBack) this.rolledBack = false;
			else this.failure = err instanceof Error ? err : new Error(String(err));
			throw err;
		} finally {
			this.busy = false;
		}
	}

	private async addEntry(
		name: string,
		rawName: Buffer,
		source: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | Uint8Array,
		options: ZipAddOptions,
	): Promise<ZipWritten> {
		const compress = options.compress ?? true;
		const method = compress ? 8 : 0;
		const { signal } = options;
		const offset = this.pos;
		// A stream's size is unknown when the header goes out, and the header decides how wide the descriptor is. So a
		// stream always declares zip64 (the extra costs 20 bytes); a buffer declares it exactly when it is big enough.
		const local64 = source instanceof Uint8Array ? source.length >= this.zip64At : true;
		const dos = toDos(options.mtimeMs ?? Date.now());

		const header = Buffer.alloc(30 + rawName.length + (local64 ? 20 : 0));
		header.writeUInt32LE(SIG_LOCAL, 0);
		header.writeUInt16LE(local64 ? 45 : 20, 4);
		header.writeUInt16LE(FLAG_DESCRIPTOR | FLAG_UTF8, 6);
		header.writeUInt16LE(method, 8);
		header.writeUInt16LE(dos.time, 10);
		header.writeUInt16LE(dos.date, 12);
		// crc and both sizes stay zero: they follow the data in the descriptor.
		header.writeUInt16LE(rawName.length, 26);
		header.writeUInt16LE(local64 ? 20 : 0, 28);
		rawName.copy(header, 30);
		if (local64) {
			const x = 30 + rawName.length;
			header.writeUInt16LE(1, x);
			header.writeUInt16LE(16, x + 2);
		}
		await this.writeAll(header);

		let crc = 0;
		let size = 0;
		let compressedSize = 0;
		const sha = createHash("sha256");
		const aborted = () => new ZipError("Archive entry was aborted", "aborted");

		// Told apart from the archive's own failures and from an abort: only a source failure can be rolled back.
		let sourceFailure: { err: unknown } | undefined;
		let writeFailure = false;
		let inflight: Promise<void> = Promise.resolve();

		async function* hashed(): AsyncGenerator<Uint8Array> {
			const it = chunksOf(source)[Symbol.asyncIterator]();
			try {
				for (;;) {
					let next: IteratorResult<Uint8Array>;
					try {
						next = await it.next();
					} catch (err) {
						sourceFailure = { err };
						throw err;
					}
					if (next.done) return;
					if (signal?.aborted) throw aborted();
					const chunk = next.value;
					for (let off = 0; off < chunk.length; off += CHUNK) {
						const piece = chunk.subarray(off, off + CHUNK);
						crc = crc32(piece, crc);
						sha.update(piece);
						size += piece.length;
						options.onBytes?.(size);
						yield piece;
					}
				}
			} finally {
				await it.return?.(undefined).catch(() => {});
			}
		}

		const sink = new Writable({
			write: (chunk: Buffer, _enc, cb) => {
				inflight = this.writeAll(chunk).then(
					() => {
						compressedSize += chunk.length;
						cb();
					},
					(err) => {
						writeFailure = true;
						cb(err);
					},
				);
			},
		});
		const input = Readable.from(hashed(), { objectMode: false });
		const stages: (Readable | Transform | Writable)[] = compress
			? [input, createDeflateRaw({ level: options.level ?? 3 }), sink]
			: [input, sink];
		const run = pipeline(stages as [Readable, Writable]);

		// Racing the signal means a source that is stuck cannot hold the abort hostage: destroying the pipeline waits
		// for the generator to return, and a generator parked on a dead source never does.
		const abortion = Promise.withResolvers<never>();
		const onAbort = () => abortion.reject(aborted());
		signal?.addEventListener("abort", onAbort, { once: true });
		abortion.promise.catch(() => {});
		try {
			await Promise.race([run, abortion.promise]);
		} catch (err) {
			for (const s of stages) s.destroy();
			run.catch(() => {});
			if (sourceFailure && !writeFailure && !signal?.aborted) {
				// The source gave out (a file vanished or shrank under the read), the archive itself is fine: take the
				// half-written entry back out so the caller can go on with the next one, and tell it what really happened.
				await inflight.catch(() => {});
				await this.fh.truncate(offset);
				this.pos = offset;
				this.rolledBack = true;
				throw sourceFailure.err;
			}
			if (err instanceof ZipError) throw err;
			if (signal?.aborted) throw aborted();
			throw err;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}

		if (!local64 && (size >= MAX32 || compressedSize >= MAX32)) {
			throw new ZipError("Archive entry outgrew its non-zip64 header", "unsupported");
		}
		const descriptor = Buffer.alloc(local64 ? 24 : 16);
		descriptor.writeUInt32LE(SIG_DESCRIPTOR, 0);
		descriptor.writeUInt32LE(crc, 4);
		if (local64) {
			descriptor.writeBigUInt64LE(BigInt(compressedSize), 8);
			descriptor.writeBigUInt64LE(BigInt(size), 16);
		} else {
			descriptor.writeUInt32LE(compressedSize, 8);
			descriptor.writeUInt32LE(size, 12);
		}
		await this.writeAll(descriptor);

		this.central.push(
			this.centralRecord(rawName, {
				method,
				dos,
				crc,
				size,
				compressedSize,
				offset,
				local64,
				mode: options.mode ?? 0o644,
			}),
		);
		this.names.add(name);
		return { name, size, compressedSize, crc32: crc, sha256: sha.digest("hex") };
	}

	private centralRecord(
		rawName: Buffer,
		e: {
			method: number;
			dos: { time: number; date: number };
			crc: number;
			size: number;
			compressedSize: number;
			offset: number;
			local64: boolean;
			mode: number;
		},
	): Buffer {
		const big = { size: e.size >= this.zip64At, comp: e.compressedSize >= this.zip64At, off: e.offset >= this.zip64At };
		const extraData = (big.size ? 8 : 0) + (big.comp ? 8 : 0) + (big.off ? 8 : 0);
		const extraLen = extraData > 0 ? 4 + extraData : 0;
		if (extraLen > 0) this.zip64Seen = true;
		const needed = e.local64 || extraLen > 0 ? 45 : 20;

		const rec = Buffer.alloc(46 + rawName.length + extraLen);
		rec.writeUInt32LE(SIG_CENTRAL, 0);
		rec.writeUInt16LE(HOST_UNIX | needed, 4);
		rec.writeUInt16LE(needed, 6);
		rec.writeUInt16LE(FLAG_DESCRIPTOR | FLAG_UTF8, 8);
		rec.writeUInt16LE(e.method, 10);
		rec.writeUInt16LE(e.dos.time, 12);
		rec.writeUInt16LE(e.dos.date, 14);
		rec.writeUInt32LE(e.crc, 16);
		rec.writeUInt32LE(big.comp ? MAX32 : e.compressedSize, 20);
		rec.writeUInt32LE(big.size ? MAX32 : e.size, 24);
		rec.writeUInt16LE(rawName.length, 28);
		rec.writeUInt16LE(extraLen, 30);
		// 32: comment length, 34: disk number, 36: internal attributes: all zero.
		rec.writeUInt32LE(((S_IFREG | (e.mode & 0o7777)) << 16) >>> 0, 38);
		rec.writeUInt32LE(big.off ? MAX32 : e.offset, 42);
		rawName.copy(rec, 46);
		if (extraLen > 0) {
			let x = 46 + rawName.length;
			rec.writeUInt16LE(1, x);
			rec.writeUInt16LE(extraData, x + 2);
			x += 4;
			// The spec fixes the order, and only the fields that were set to all-ones are present.
			for (const [wide, value] of [
				[big.size, e.size],
				[big.comp, e.compressedSize],
				[big.off, e.offset],
			] as const) {
				if (!wide) continue;
				rec.writeBigUInt64LE(BigInt(value), x);
				x += 8;
			}
		}
		return rec;
	}

	async finish(): Promise<{ bytes: number; entries: number }> {
		if (this.busy) throw new Error("ZipWriter.finish called while an entry is being added");
		this.assertUsable();
		const entries = this.central.length;
		const cdOffset = this.pos;
		let cdSize = 0;
		let batch: Buffer[] = [];
		let batched = 0;
		for (const rec of this.central) {
			cdSize += rec.length;
			batch.push(rec);
			batched += rec.length;
			if (batched >= CHUNK) {
				await this.writeAll(Buffer.concat(batch));
				batch = [];
				batched = 0;
			}
		}
		this.central.length = 0;

		const zip64 = entries > MAX16 - 1 || cdOffset >= this.zip64At || cdSize >= this.zip64At || this.zip64Seen;
		const tail = Buffer.alloc(EOCD_SIZE + (zip64 ? EOCD64_SIZE + LOCATOR_SIZE : 0));
		let x = 0;
		if (zip64) {
			tail.writeUInt32LE(SIG_EOCD64, 0);
			tail.writeBigUInt64LE(BigInt(EOCD64_SIZE - 12), 4);
			tail.writeUInt16LE(HOST_UNIX | 45, 12);
			tail.writeUInt16LE(45, 14);
			// 16, 20: disk numbers, zero.
			tail.writeBigUInt64LE(BigInt(entries), 24);
			tail.writeBigUInt64LE(BigInt(entries), 32);
			tail.writeBigUInt64LE(BigInt(cdSize), 40);
			tail.writeBigUInt64LE(BigInt(cdOffset), 48);
			tail.writeUInt32LE(SIG_LOCATOR64, 56);
			// 60: disk with the zip64 end record, zero.
			tail.writeBigUInt64LE(BigInt(cdOffset + cdSize), 64);
			tail.writeUInt32LE(1, 72);
			x = EOCD64_SIZE + LOCATOR_SIZE;
		}
		tail.writeUInt32LE(SIG_EOCD, x);
		// Disk numbers are zero. When zip64 records follow, every count and offset is saturated so no reader can pick
		// the 16/32-bit value by mistake.
		tail.writeUInt16LE(zip64 ? MAX16 : entries, x + 8);
		tail.writeUInt16LE(zip64 ? MAX16 : entries, x + 10);
		tail.writeUInt32LE(zip64 ? MAX32 : cdSize, x + 12);
		tail.writeUInt32LE(zip64 ? MAX32 : cdOffset, x + 16);
		// x + 20: comment length, zero.
		await this.writeAll(Buffer.concat([...batch, tail]));

		await this.fh.sync();
		await this.fh.close();
		this.done = "finished";
		return { bytes: this.pos, entries };
	}

	async abort(): Promise<void> {
		if (this.done) return;
		this.done = "aborted";
		await this.fh.close().catch(() => {});
		await rm(this.path, { force: true });
	}
}

export interface ZipEntry {
	name: string;
	size: number;
	compressedSize: number;
	crc32: number;
	method: 0 | 8;
	mtimeMs: number;
	mode: number;
	offset: number;
}

function u64(buf: Buffer, at: number, what: string): number {
	const hi = buf.readUInt32LE(at + 4);
	// 2^53: beyond that a size or offset is not a number this process could address anyway.
	if (hi > 0x1fffff) throw new ZipError(`Archive ${what} is out of range`, "corrupt");
	return hi * 2 ** 32 + buf.readUInt32LE(at);
}

/** Where a reader gets bytes from, by position: a file, or the decrypted view of a sealed one (`sealed.ts`). */
export interface ByteSource {
	read(buf: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
	close(): Promise<void>;
}

export class ZipReader {
	private closed = false;
	private readonly byName = new Map<string, ZipEntry>();

	private constructor(
		private readonly fh: ByteSource,
		private readonly fileSize: number,
		readonly entries: readonly ZipEntry[],
	) {
		for (const e of entries) if (!this.byName.has(e.name)) this.byName.set(e.name, e);
	}

	static async open(path: string): Promise<ZipReader> {
		const fh = await open(path, "r");
		try {
			return await ZipReader.from(fh, (await fh.stat()).size);
		} catch (err) {
			await fh.close().catch(() => {});
			throw err;
		}
	}

	/** The archive in `source` (`size` bytes long). The reader owns the source from here: it is closed with the reader, and when the archive is refused. */
	static async from(source: ByteSource, size: number): Promise<ZipReader> {
		try {
			return new ZipReader(source, size, await ZipReader.readDirectory(source, size));
		} catch (err) {
			await source.close().catch(() => {});
			throw err;
		}
	}

	private static async readExact(fh: ByteSource, buf: Buffer, position: number, what: string): Promise<void> {
		let off = 0;
		while (off < buf.length) {
			const { bytesRead } = await fh.read(buf, off, buf.length - off, position + off);
			if (bytesRead === 0) throw new ZipError(`Archive is truncated (${what})`, "corrupt");
			off += bytesRead;
		}
	}

	private static async readDirectory(fh: ByteSource, size: number): Promise<ZipEntry[]> {
		if (size < EOCD_SIZE) throw new ZipError("Not a zip archive (too small)", "corrupt");
		const tailLen = Math.min(size, EOCD_SIZE + 0xffff);
		const tailStart = size - tailLen;
		const tail = Buffer.alloc(tailLen);
		await ZipReader.readExact(fh, tail, tailStart, "end record");

		// The comment is the only variable-length part, so the right candidate is the one whose comment ends the file.
		let at = -1;
		for (let i = tailLen - EOCD_SIZE; i >= 0; i--) {
			if (tail.readUInt32LE(i) === SIG_EOCD && i + EOCD_SIZE + tail.readUInt16LE(i + 20) === tailLen) {
				at = i;
				break;
			}
		}
		if (at < 0) throw new ZipError("Not a zip archive (no end record)", "corrupt");
		const eocdPos = tailStart + at;
		const disk = tail.readUInt16LE(at + 4);
		const cdDisk = tail.readUInt16LE(at + 6);
		let count = tail.readUInt16LE(at + 10);
		let cdSize = tail.readUInt32LE(at + 12);
		let cdOffset = tail.readUInt32LE(at + 16);
		let limit = eocdPos;

		if (eocdPos >= LOCATOR_SIZE) {
			const loc = Buffer.alloc(LOCATOR_SIZE);
			await ZipReader.readExact(fh, loc, eocdPos - LOCATOR_SIZE, "zip64 locator");
			if (loc.readUInt32LE(0) === SIG_LOCATOR64) {
				if (loc.readUInt32LE(4) !== 0 || loc.readUInt32LE(16) !== 1) {
					throw new ZipError("Multi-disk archives are not supported", "unsupported");
				}
				const at64 = u64(loc, 8, "zip64 record offset");
				if (at64 + EOCD64_SIZE > eocdPos) throw new ZipError("Archive zip64 end record is out of range", "corrupt");
				const rec = Buffer.alloc(EOCD64_SIZE);
				await ZipReader.readExact(fh, rec, at64, "zip64 end record");
				if (rec.readUInt32LE(0) !== SIG_EOCD64) throw new ZipError("Archive zip64 end record is damaged", "corrupt");
				if (rec.readUInt32LE(16) !== 0 || rec.readUInt32LE(20) !== 0) {
					throw new ZipError("Multi-disk archives are not supported", "unsupported");
				}
				count = u64(rec, 32, "entry count");
				cdSize = u64(rec, 40, "directory size");
				cdOffset = u64(rec, 48, "directory offset");
				limit = at64;
			} else if (disk !== 0 || cdDisk !== 0) {
				throw new ZipError("Multi-disk archives are not supported", "unsupported");
			}
		} else if (disk !== 0 || cdDisk !== 0) {
			throw new ZipError("Multi-disk archives are not supported", "unsupported");
		}

		if (cdOffset + cdSize > limit) throw new ZipError("Archive directory lies outside the file", "corrupt");
		// Each record is at least 46 bytes, so a count the directory cannot hold is damage, not something to allocate for.
		if (count * 46 > cdSize) throw new ZipError("Archive entry count does not match its directory", "corrupt");
		const dir = Buffer.alloc(cdSize);
		await ZipReader.readExact(fh, dir, cdOffset, "directory");

		const decoder = new TextDecoder("utf-8");
		const out: ZipEntry[] = [];
		let p = 0;
		for (let n = 0; n < count; n++) {
			if (p + 46 > cdSize || dir.readUInt32LE(p) !== SIG_CENTRAL) {
				throw new ZipError("Archive directory is damaged", "corrupt");
			}
			const madeBy = dir.readUInt16LE(p + 4);
			const flags = dir.readUInt16LE(p + 8);
			const method = dir.readUInt16LE(p + 10);
			const time = dir.readUInt16LE(p + 12);
			const date = dir.readUInt16LE(p + 14);
			const crc = dir.readUInt32LE(p + 16);
			let compressedSize = dir.readUInt32LE(p + 20);
			let entrySize = dir.readUInt32LE(p + 24);
			const nameLen = dir.readUInt16LE(p + 28);
			const extraLen = dir.readUInt16LE(p + 30);
			const commentLen = dir.readUInt16LE(p + 32);
			const startDisk = dir.readUInt16LE(p + 34);
			const external = dir.readUInt32LE(p + 38);
			let offset = dir.readUInt32LE(p + 42);
			const end = p + 46 + nameLen + extraLen + commentLen;
			if (end > cdSize) throw new ZipError("Archive directory is damaged", "corrupt");
			if (flags & FLAG_ENCRYPTED) throw new ZipError("Encrypted archives are not supported", "unsupported");
			if (method !== 0 && method !== 8) throw new ZipError(`Unsupported compression method ${method}`, "unsupported");
			if (startDisk !== 0 && startDisk !== MAX16)
				throw new ZipError("Multi-disk archives are not supported", "unsupported");
			const name = decoder.decode(dir.subarray(p + 46, p + 46 + nameLen));

			const needSize = entrySize === MAX32;
			const needComp = compressedSize === MAX32;
			const needOff = offset === MAX32;
			if (needSize || needComp || needOff) {
				let x = p + 46 + nameLen;
				const extraEnd = x + extraLen;
				let found = false;
				while (x + 4 <= extraEnd) {
					const id = dir.readUInt16LE(x);
					const len = dir.readUInt16LE(x + 2);
					if (x + 4 + len > extraEnd) throw new ZipError("Archive entry extra field is damaged", "corrupt");
					if (id === 1) {
						let y = x + 4;
						const dataEnd = y + len;
						const take = (what: string) => {
							if (y + 8 > dataEnd) throw new ZipError(`Archive entry ${what} is missing its zip64 value`, "corrupt");
							const v = u64(dir, y, what);
							y += 8;
							return v;
						};
						if (needSize) entrySize = take("size");
						if (needComp) compressedSize = take("compressed size");
						if (needOff) offset = take("offset");
						found = true;
						break;
					}
					x += 4 + len;
				}
				if (!found) throw new ZipError(`Archive entry ${JSON.stringify(name)} lacks its zip64 field`, "corrupt");
			}
			if (method === 0 && compressedSize !== entrySize) {
				throw new ZipError(`Archive entry ${JSON.stringify(name)} has inconsistent stored sizes`, "corrupt");
			}
			if (offset + 30 + compressedSize > size) {
				throw new ZipError(`Archive entry ${JSON.stringify(name)} lies outside the file`, "corrupt");
			}
			out.push({
				name,
				size: entrySize,
				compressedSize,
				crc32: crc,
				method,
				mtimeMs: fromDos(time, date),
				mode: madeBy >> 8 === 3 ? (external >>> 16) & 0o7777 : 0o644,
				offset,
			});
			p = end;
		}
		return out;
	}

	entry(name: string): ZipEntry | undefined {
		return this.byName.get(name);
	}

	stream(name: string, options?: { signal?: AbortSignal }): AsyncIterable<Uint8Array> {
		const entry = this.byName.get(name);
		if (!entry) throw new Error(`No such archive entry: ${name}`);
		if (this.closed) throw new Error("Archive reader is closed");
		return this.run(entry, options?.signal);
	}

	/** The entry's compressed bytes, read by position so any number of entries can be in flight on the one handle. */
	private async *rawBytes(
		entry: ZipEntry,
		piece: number,
		io: { error?: unknown },
		signal?: AbortSignal,
	): AsyncGenerator<Buffer> {
		try {
			const head = Buffer.alloc(30);
			await ZipReader.readExact(this.fh, head, entry.offset, "local header");
			if (head.readUInt32LE(0) !== SIG_LOCAL)
				throw new ZipError(`Archive entry ${JSON.stringify(entry.name)} has no local header`, "corrupt");
			// The local name and extra lengths may differ from the directory's, so they are read from here.
			let at = entry.offset + 30 + head.readUInt16LE(26) + head.readUInt16LE(28);
			const end = at + entry.compressedSize;
			if (end > this.fileSize)
				throw new ZipError(`Archive entry ${JSON.stringify(entry.name)} is truncated`, "corrupt");
			while (at < end) {
				if (signal?.aborted) throw new ZipError("Archive read was aborted", "aborted");
				const buf = Buffer.allocUnsafe(Math.min(piece, end - at));
				await ZipReader.readExact(this.fh, buf, at, "entry data");
				at += buf.length;
				yield buf;
			}
		} catch (err) {
			if (!(err instanceof ZipError)) io.error = err;
			throw err;
		}
	}

	private async *inflated(source: AsyncIterable<Buffer>): AsyncGenerator<Uint8Array> {
		const inflater = createInflateRaw({ chunkSize: 256 * 1024 });
		const feed = Readable.from(source, { objectMode: false });
		// A failure while reading the file has to reach whoever iterates the inflater, so it is forwarded there.
		feed.on("error", (err) => inflater.destroy(err));
		feed.pipe(inflater);
		try {
			for await (const chunk of inflater) yield chunk as Buffer;
		} finally {
			feed.destroy();
			inflater.destroy();
		}
	}

	private async *run(entry: ZipEntry, signal?: AbortSignal): AsyncGenerator<Uint8Array> {
		if (this.closed) throw new Error("Archive reader is closed");
		const io: { error?: unknown } = {};
		const label = JSON.stringify(entry.name);
		let crc = 0;
		let total = 0;
		const source: AsyncIterable<Uint8Array> =
			entry.method === 0
				? this.rawBytes(entry, CHUNK, io, signal)
				: this.inflated(this.rawBytes(entry, INFLATE_FEED, io, signal));
		try {
			for await (const chunk of source) {
				if (signal?.aborted) throw new ZipError("Archive read was aborted", "aborted");
				total += chunk.length;
				// Stop at the first byte beyond the declared size: that is how an inflate bomb is refused.
				if (total > entry.size) throw new ZipError(`Archive entry ${label} is larger than recorded`, "corrupt");
				crc = crc32(chunk, crc);
				for (let off = 0; off < chunk.length; off += CHUNK) yield chunk.subarray(off, off + CHUNK);
			}
		} catch (err) {
			if (err instanceof ZipError) throw err;
			if (io.error) throw io.error;
			throw new ZipError(
				`Archive entry ${label} is damaged: ${err instanceof Error ? err.message : String(err)}`,
				"corrupt",
			);
		}
		if (total !== entry.size) throw new ZipError(`Archive entry ${label} is shorter than recorded`, "corrupt");
		if (crc !== entry.crc32) throw new ZipError(`Archive entry ${label} fails its checksum`, "corrupt");
	}

	async bytes(name: string, maxBytes: number = DEFAULT_BYTES_LIMIT): Promise<Uint8Array> {
		const entry = this.byName.get(name);
		if (!entry) throw new Error(`No such archive entry: ${name}`);
		if (entry.size > maxBytes) {
			throw new ZipError(`Archive entry ${JSON.stringify(name)} is larger than ${maxBytes} bytes`, "corrupt");
		}
		const parts: Uint8Array[] = [];
		for await (const chunk of this.stream(name)) parts.push(chunk);
		return Buffer.concat(parts);
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		await this.fh.close();
	}
}
