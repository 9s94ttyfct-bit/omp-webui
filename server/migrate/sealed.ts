import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { type FileHandle, open } from "node:fs/promises";
import { COST, deriveKey, type KdfParams, kdfAcceptable, newSalt, WrongPasswordError } from "./crypto.ts";
import { type ByteSource, ZipError, type ZipErrorCode, type ZipSink } from "./zip.ts";

/**
 * "Encrypt the whole file": the archive (the zip, with its manifest and every entry) written under a password so that
 * nothing about it can be read, and nothing in it changed, without the password.
 *
 *     MAGIC "OMPWENC2" | header length (u32) | header JSON | chunk 0 | chunk 1 | …
 *     chunk = nonce (12) | ciphertext | tag (16)
 *
 * The header is the only plain part: scrypt's cost and salt, the chunk size and a check value that tells a wrong password
 * from a damaged file. What is encrypted is the zip itself, cut in chunks of 64 KiB, each sealed on its own with
 * AES-256-GCM under a random nonce that is stored with it. The additional data of a chunk is the whole header, the
 * chunk's number and a flag for the last chunk. So a chunk that was changed, moved, repeated or taken from another file
 * fails its tag, the flag on the last chunk makes a cut (or an addition) fail, and the header cannot be altered. A stolen
 * file can be tried against passwords at scrypt's price and no cheaper.
 *
 * Chunks are what makes it possible to stream (the writer holds one chunk; no plaintext zip is ever on disk) and to
 * read by position (the zip reader asks for byte ranges; a read decrypts the chunks it touches and keeps a few). The
 * nonce is random for every sealing rather than derived from the chunk's number because a writer that takes back a
 * failed entry seals the same chunk number again with other bytes: a derived nonce would then be used twice under one key.
 */

export const SEALED_MAGIC = Buffer.from("OMPWENC2");
export const SEALED_CHUNK = 64 * 1024;
const TAG = 16;
const NONCE = 12;
/** What a chunk costs beyond its bytes: its own nonce and its tag. */
export const SEALED_OVERHEAD = NONCE + TAG;
const SEALED_FULL = SEALED_CHUNK + SEALED_OVERHEAD;
const PRELUDE = SEALED_MAGIC.length + 4;
const MAX_HEADER = 4096;
/** Chunk numbers are 32 bits: 256 TiB, far beyond the largest archive the server takes. */
const MAX_CHUNK_INDEX = 2 ** 32 - 1;
const CACHE_CHUNKS = 16;

/** A sealed file that fails: `tampered` (changed, cut or damaged: GCM cannot tell which) or `unsupported` (not made by this version). */
export class SealedError extends ZipError {
	constructor(message: string, code: Extract<ZipErrorCode, "tampered" | "unsupported"> = "tampered") {
		super(message, code);
		this.name = "SealedError";
	}
}

export interface SealedHeader extends KdfParams {
	v: 2;
	alg: "aes-256-gcm";
	kdf: "scrypt";
	chunk: number;
	/** SHA-256 of the second half of the scrypt output, base64: not the key, and no use but telling a wrong password. */
	check: string;
}

/** A sealed file's plain part, read: the header, its exact bytes (every chunk authenticates them), and where the first chunk starts. */
export interface SealedPrelude {
	header: SealedHeader;
	headerBytes: Buffer;
	end: number;
}

/** What opening a sealed file's header and password gives: the key, and the header every chunk authenticates. */
export interface SealedKey extends SealedPrelude {
	key: Buffer;
}

const u32 = (n: number): Buffer => {
	const b = Buffer.alloc(4);
	b.writeUInt32BE(n);
	return b;
};

const b64Length = (value: unknown, bytes: number): value is string =>
	typeof value === "string" && Buffer.from(value, "base64").length === bytes;

async function readExact(fh: FileHandle, buf: Buffer, position: number): Promise<boolean> {
	let off = 0;
	while (off < buf.length) {
		const { bytesRead } = await fh.read(buf, off, buf.length - off, position + off);
		if (bytesRead === 0) return false;
		off += bytesRead;
	}
	return true;
}

/** Whether the file at `path` starts like a sealed archive (what is in it is not looked at). */
export async function isSealed(path: string): Promise<boolean> {
	const fh = await open(path, "r");
	try {
		const head = Buffer.alloc(SEALED_MAGIC.length);
		return (await readExact(fh, head, 0)) && head.equals(SEALED_MAGIC);
	} finally {
		await fh.close();
	}
}

async function readHeader(fh: FileHandle): Promise<SealedPrelude> {
	const cut = () => new SealedError("The encrypted file is cut off");
	const prelude = Buffer.alloc(PRELUDE);
	if (!(await readExact(fh, prelude, 0)) || !prelude.subarray(0, SEALED_MAGIC.length).equals(SEALED_MAGIC)) throw cut();
	const length = prelude.readUInt32BE(SEALED_MAGIC.length);
	if (length > MAX_HEADER)
		throw new SealedError("The encrypted file's header is not one this app wrote", "unsupported");
	const headerBytes = Buffer.alloc(length);
	if (!(await readExact(fh, headerBytes, PRELUDE))) throw cut();
	let header: SealedHeader;
	try {
		header = JSON.parse(headerBytes.toString("utf8")) as SealedHeader;
	} catch {
		throw new SealedError("The encrypted file's header cannot be read", "unsupported");
	}
	if (
		header === null ||
		typeof header !== "object" ||
		header.v !== 2 ||
		header.alg !== "aes-256-gcm" ||
		header.kdf !== "scrypt" ||
		!kdfAcceptable(header) ||
		header.chunk !== SEALED_CHUNK ||
		!b64Length(header.salt, 16) ||
		!b64Length(header.check, 32)
	) {
		throw new SealedError("The encrypted file uses parameters this version does not know", "unsupported");
	}
	return { header, headerBytes, end: PRELUDE + length };
}

/** The key and the check value from one scrypt run: the first half encrypts, the second only proves the password. */
async function keysOf(password: string, kdf: KdfParams): Promise<{ key: Buffer; check: Buffer }> {
	const out = await deriveKey(password, kdf, 64);
	const key = Buffer.from(out.subarray(0, 32));
	const check = createHash("sha256").update(out.subarray(32)).digest();
	out.fill(0);
	return { key, check };
}

/**
 * The key of the sealed file at `path` for `password`, which takes scrypt's half second. `WrongPasswordError` when the
 * password is not the one it was made with (said by the header's check value, so it is never mistaken for damage).
 */
export async function unlockSealed(path: string, password: string): Promise<SealedKey> {
	const fh = await open(path, "r");
	let read: SealedPrelude;
	try {
		read = await readHeader(fh);
	} finally {
		await fh.close();
	}
	const { key, check } = await keysOf(password, read.header);
	if (!timingSafeEqual(check, Buffer.from(read.header.check, "base64"))) {
		key.fill(0);
		throw new WrongPasswordError();
	}
	return { key, header: read.header, headerBytes: read.headerBytes, end: read.end };
}

/** The additional data of a chunk: the header, the chunk's number and whether it is the last. */
function aadOf(k: Pick<SealedKey, "headerBytes">, index: number, last: boolean): Buffer {
	const tail = Buffer.alloc(5);
	tail.writeUInt32BE(index, 0);
	tail[4] = last ? 1 : 0;
	return Buffer.concat([k.headerBytes, tail]);
}

/**
 * `plain` sealed as chunk `index`: `nonce | ciphertext | tag`. The nonce is random and new for every sealing, so that a
 * chunk sealed again after a rollback (`SealedWriter.truncate`) never shares a (key, nonce) with the one it replaces.
 */
function sealChunk(k: Pick<SealedKey, "key" | "headerBytes">, index: number, last: boolean, plain: Uint8Array): Buffer {
	const nonce = randomBytes(NONCE);
	const cipher = createCipheriv("aes-256-gcm", k.key, nonce);
	cipher.setAAD(aadOf(k, index, last));
	return Buffer.concat([nonce, cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
}

function openChunk(k: Pick<SealedKey, "key" | "headerBytes">, index: number, last: boolean, sealed: Buffer): Buffer {
	const decipher = createDecipheriv("aes-256-gcm", k.key, sealed.subarray(0, NONCE));
	decipher.setAAD(aadOf(k, index, last));
	decipher.setAuthTag(sealed.subarray(sealed.length - TAG));
	try {
		// The plaintext is handed out only once `final` has checked the tag.
		return Buffer.concat([decipher.update(sealed.subarray(NONCE, sealed.length - TAG)), decipher.final()]);
	} catch {
		throw new SealedError("The file was changed after it was made, or it is damaged");
	}
}

async function writeAll(fh: FileHandle, buf: Uint8Array, position: number): Promise<void> {
	let off = 0;
	while (off < buf.length) {
		const { bytesWritten } = await fh.write(buf, off, buf.length - off, position + off);
		off += bytesWritten;
	}
}

/**
 * The sealed file being written, as a sink for `ZipWriter`: the zip's bytes come in from the start to the end, and what
 * goes to disk is chunks. One chunk is held back until more bytes arrive (or `sync` seals it as the last), because a
 * chunk is sealed knowing whether it is the last. A failed entry that a zip writer takes back (`truncate`) is taken back
 * here too, down to a byte of an earlier chunk if need be.
 */
export class SealedWriter implements ZipSink {
	private readonly chunk = Buffer.allocUnsafe(SEALED_CHUNK);
	/** Bytes held in `chunk`: the beginning of chunk number `sealed`. */
	private held = 0;
	/** Chunks on disk. */
	private sealed = 0;
	private length = 0;
	private finished = false;

	private constructor(
		private readonly fh: FileHandle,
		private readonly k: SealedKey,
	) {}

	/**
	 * A new sealed file at `path` (which must not exist) under `password`; scrypt runs first, so a failure leaves no file.
	 * `N` is scrypt's cost, `COST.N` unless a test asks for a cheaper one (a file made with it opens like any other).
	 */
	static async create(path: string, password: string, options: { N?: number } = {}): Promise<SealedWriter> {
		const kdf: KdfParams = { ...COST, N: options.N ?? COST.N, salt: newSalt() };
		const { key, check } = await keysOf(password, kdf);
		const header: SealedHeader = {
			v: 2,
			alg: "aes-256-gcm",
			kdf: "scrypt",
			...kdf,
			chunk: SEALED_CHUNK,
			check: check.toString("base64"),
		};
		const headerBytes = Buffer.from(JSON.stringify(header), "utf8");
		const end = PRELUDE + headerBytes.length;
		let fh: FileHandle | undefined;
		try {
			// 0o600 and "wx": an archive holds everything, and an existing file is never clobbered. Read too: a rollback re-reads a chunk.
			fh = await open(path, "wx+", 0o600);
			await writeAll(fh, Buffer.concat([SEALED_MAGIC, u32(headerBytes.length), headerBytes]), 0);
		} catch (e) {
			key.fill(0);
			await fh?.close().catch(() => {});
			throw e;
		}
		return new SealedWriter(fh, { key, header, headerBytes, end });
	}

	private async seal(last: boolean): Promise<void> {
		if (this.sealed >= MAX_CHUNK_INDEX) throw new Error("The archive is too large to encrypt");
		const sealed = sealChunk(this.k, this.sealed, last, this.chunk.subarray(0, this.held));
		await writeAll(this.fh, sealed, this.k.end + this.sealed * SEALED_FULL);
		this.sealed++;
		this.held = 0;
	}

	async write(buf: Uint8Array, offset: number, length: number, position: number): Promise<{ bytesWritten: number }> {
		if (this.finished) throw new Error("The sealed file is finished");
		if (position !== this.length) throw new Error("A sealed file is written from its start to its end");
		const end = offset + length;
		for (let at = offset; at < end; ) {
			if (this.held === SEALED_CHUNK) await this.seal(false);
			const take = Math.min(SEALED_CHUNK - this.held, end - at);
			this.chunk.set(buf.subarray(at, at + take), this.held);
			this.held += take;
			at += take;
		}
		this.length += length;
		return { bytesWritten: length };
	}

	async truncate(length: number): Promise<void> {
		if (this.finished) throw new Error("The sealed file is finished");
		if (length > this.length) throw new Error("A sealed file cannot grow by truncation");
		const start = this.sealed * SEALED_CHUNK;
		if (length >= start) {
			this.held = length - start;
			this.length = length;
			return;
		}
		// Back into a chunk that is on disk: it was sealed as a middle one; its first bytes become the held ones again.
		// When it is sealed again (with other bytes after `keep`) it gets a nonce of its own, never the one it had.
		const index = Math.floor(length / SEALED_CHUNK);
		const keep = length - index * SEALED_CHUNK;
		if (keep > 0) {
			const sealed = Buffer.alloc(SEALED_FULL);
			if (!(await readExact(this.fh, sealed, this.k.end + index * SEALED_FULL))) {
				throw new Error("The sealed file lost a chunk while it was written");
			}
			this.chunk.set(openChunk(this.k, index, false, sealed).subarray(0, keep), 0);
		}
		await this.fh.truncate(this.k.end + index * SEALED_FULL);
		this.sealed = index;
		this.held = keep;
		this.length = length;
	}

	/** Seals the last chunk and makes the file durable: once, after the last write. */
	async sync(): Promise<void> {
		if (!this.finished) {
			await this.seal(true);
			this.finished = true;
		}
		await this.fh.sync();
	}

	async close(): Promise<void> {
		this.k.key.fill(0);
		await this.fh.close();
	}
}

/**
 * A sealed file opened with its key, read by position as if it were the plain zip: what `ZipReader.from` is given.
 * Opening checks the last chunk, so a file that was cut or had bytes added is refused at once; every other chunk is
 * checked when it is read, and `authenticateAll` reads the ones no read has touched, so that after it nothing in the
 * file can have been changed.
 */
export class SealedFile implements ByteSource {
	/** The zip's length: what the chunks hold. */
	readonly size: number;
	private readonly chunks: number;
	private readonly lastLength: number;
	private readonly verified: Uint8Array;
	private readonly cache = new Map<number, Promise<Buffer>>();
	private closed = false;

	private constructor(
		private readonly fh: FileHandle,
		private readonly k: SealedKey,
		geometry: { chunks: number; lastLength: number },
	) {
		this.chunks = geometry.chunks;
		this.lastLength = geometry.lastLength;
		this.size = (geometry.chunks - 1) * SEALED_CHUNK + geometry.lastLength - SEALED_OVERHEAD;
		this.verified = new Uint8Array(geometry.chunks);
	}

	/** The sealed file at `path` under `key`, which the file owns from here: it is wiped when the file is closed, or when it cannot be opened. */
	static async open(path: string, key: SealedKey): Promise<SealedFile> {
		const fh = await open(path, "r");
		try {
			const body = (await fh.stat()).size - key.end;
			const chunks = Math.ceil(body / SEALED_FULL);
			const lastLength = body - (chunks - 1) * SEALED_FULL;
			if (body < SEALED_OVERHEAD || lastLength < SEALED_OVERHEAD || chunks > MAX_CHUNK_INDEX + 1)
				throw new SealedError("The encrypted file is cut off");
			const file = new SealedFile(fh, key, { chunks, lastLength });
			// The end of the file: a cut, or bytes added, fails here (the last chunk is sealed as the last).
			await file.decrypt(chunks - 1);
			return file;
		} catch (e) {
			key.key.fill(0);
			await fh.close().catch(() => {});
			throw e;
		}
	}

	private async decrypt(index: number): Promise<Buffer> {
		if (this.closed) throw new Error("The sealed file is closed");
		const last = index === this.chunks - 1;
		const sealed = Buffer.alloc(last ? this.lastLength : SEALED_FULL);
		if (!(await readExact(this.fh, sealed, this.k.end + index * SEALED_FULL))) {
			throw new SealedError("The encrypted file is cut off");
		}
		const plain = openChunk(this.k, index, last, sealed);
		this.verified[index] = 1;
		return plain;
	}

	private chunk(index: number): Promise<Buffer> {
		const hit = this.cache.get(index);
		if (hit) {
			this.cache.delete(index);
			this.cache.set(index, hit);
			return hit;
		}
		const made = this.decrypt(index);
		this.cache.set(index, made);
		// A chunk that failed is not kept; the one who asked has the error.
		made.catch(() => this.cache.delete(index));
		for (const old of this.cache.keys()) {
			if (this.cache.size <= CACHE_CHUNKS) break;
			this.cache.delete(old);
		}
		return made;
	}

	async read(buf: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }> {
		let done = 0;
		while (done < length && position + done < this.size) {
			const at = position + done;
			const index = Math.floor(at / SEALED_CHUNK);
			const plain = await this.chunk(index);
			const from = at - index * SEALED_CHUNK;
			const take = Math.min(length - done, plain.length - from);
			if (take <= 0) break;
			plain.copy(buf, offset + done, from, from + take);
			done += take;
		}
		return { bytesRead: done };
	}

	/** Reads and checks every chunk no read has checked yet. */
	async authenticateAll(signal?: AbortSignal): Promise<void> {
		for (let i = 0; i < this.chunks; i++) {
			if (signal?.aborted) throw new ZipError("Archive read was aborted", "aborted");
			if (!this.verified[i]) await this.decrypt(i);
		}
	}

	async close(): Promise<void> {
		if (this.closed) return;
		this.closed = true;
		this.cache.clear();
		this.k.key.fill(0);
		await this.fh.close();
	}
}
