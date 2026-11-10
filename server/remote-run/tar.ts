import { constants } from "node:fs";
import { chmod, type FileHandle, lstat, mkdir, open, readdir, readlink, symlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { RemoteCopyError } from "../../shared/remote-copy.ts";

/**
 * A folder as `remote_copy` sends it (`shared/remote-copy.ts`): a POSIX tar (ustar, with pax records for long or non-ASCII
 * names), written as it is sent and unpacked as it arrives, so neither side holds the whole of it. Folders, regular files and
 * symbolic links only; a file keeps its permission bits (never set-id) and time, a folder its time and its permissions with
 * the owner's always added.
 *
 * What is sent is walked first (`walkFolder`): a link is sent as a link only when it stays inside the folder (`staysInside`),
 * and is left out otherwise, as sockets, pipes and devices are; the walk counts them. What arrives is held to the same rules
 * before anything of it is written (`TarUnpacker`): a name that is absolute, has `..`, or leads through a link or a file it
 * named before; a link that leads out; a hard link or any other kind of entry; more bytes or entries than a call may copy:
 * each refuses the whole of it (`badArchive`, `tooLarge`). Every file is made new (`O_EXCL`, no link followed) in a folder the
 * unpacker made itself.
 */

export interface TarEntry {
	/** Its path inside the folder, its parts joined by `/`. */
	path: string;
	type: "file" | "dir" | "link";
	/** A file's bytes; 0 for the others. */
	size: number;
	/** Permission bits, `0o777` at most. */
	mode: number;
	/** When it was changed, in seconds. */
	mtime: number;
	/** Where a link points, as it says. */
	target?: string;
}

export interface Walked {
	entries: TarEntry[];
	files: number;
	/** The bytes of the files. */
	bytes: number;
	/** Links that lead out, and what is not a file, folder or link. */
	leftOut: number;
}

export interface TarLimits {
	maxBytes: number;
	maxEntries: number;
}

const BLOCK = 512;
const END = new Uint8Array(2 * BLOCK);
const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Whether a link at `path` (inside the folder) pointing to `target` stays inside: a relative target whose `..` parts all come
 * first, and are no more than the folders above the link. Nothing is normalised: `a/../b` goes through `a`, which may itself
 * be a link, so it is refused rather than read as `b`. A link that points to another link inside the folder stays inside:
 * each was held to this rule from the folder it is in, which is a real folder.
 */
export function staysInside(path: string, target: string): boolean {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: NUL is what is refused.
	if (target === "" || target.startsWith("/") || /^[A-Za-z]:/.test(target) || /[\\\u0000]/.test(target)) return false;
	const depth = path.split("/").length - 1;
	let ups = 0;
	let down = false;
	for (const part of target.split("/")) {
		if (part === "" || part === ".") continue;
		if (part === "..") {
			if (down) return false;
			ups++;
		} else down = true;
	}
	return ups <= depth;
}

/** An entry's name as it may be unpacked, or null when it would leave the folder (or names none). */
export function safeEntryPath(raw: string): string | null {
	const name = raw.replace(/\/+$/, "");
	// biome-ignore lint/suspicious/noControlCharactersInRegex: NUL is what is refused.
	if (name === "" || name.length > 4096 || name.startsWith("/") || /[\\\u0000]/.test(name)) return null;
	const parts = name.split("/");
	if (parts.length > 256 || parts.some((p) => p === "" || p === "." || p === "..")) return null;
	return name;
}

/** What the file system refused, as a copy's failure; anything else as it is. */
export function fsFailure(e: unknown, what: string): unknown {
	const code = (e as NodeJS.ErrnoException).code;
	if (code === "EACCES" || code === "EPERM" || code === "EROFS")
		return new RemoteCopyError(`${what}: permission denied`, "refused");
	if (code === "ENOSPC" || code === "EDQUOT") return new RemoteCopyError("The disk is full", "diskFull");
	return e;
}

/**
 * Every entry of the folder `root`, folders before what is in them and names in order, with the bytes of its files; throws
 * `tooLarge` once there are more than `limits` allow. `root` itself is not an entry.
 */
export async function walkFolder(root: string, limits: TarLimits): Promise<Walked> {
	const out: Walked = { entries: [], files: 0, bytes: 0, leftOut: 0 };
	const visit = async (rel: string): Promise<void> => {
		const dir = rel === "" ? root : join(root, rel);
		const names = await readdir(dir).catch((e) => Promise.reject(fsFailure(e, dir)));
		names.sort();
		for (const name of names) {
			const path = rel === "" ? name : `${rel}/${name}`;
			const st = await lstat(join(root, path));
			const mode = st.mode & 0o777;
			const mtime = Math.floor(st.mtimeMs / 1000);
			if (out.entries.length >= limits.maxEntries)
				throw new RemoteCopyError(`More than ${limits.maxEntries} files and folders to copy`, "tooLarge");
			if (st.isSymbolicLink()) {
				const target = await readlink(join(root, path));
				if (staysInside(path, target)) out.entries.push({ path, type: "link", size: 0, mode, mtime, target });
				else out.leftOut++;
			} else if (st.isDirectory()) {
				out.entries.push({ path, type: "dir", size: 0, mode, mtime });
				await visit(path);
			} else if (st.isFile()) {
				out.bytes += st.size;
				out.files++;
				if (out.bytes > limits.maxBytes)
					throw new RemoteCopyError(`More than ${limits.maxBytes} bytes of files to copy`, "tooLarge");
				out.entries.push({ path, type: "file", size: st.size, mode, mtime });
			} else out.leftOut++;
		}
	};
	await visit("");
	return out;
}

// ------------------------------------------------------------------ writing

/** `text` into `h` at `at`, at most `width` bytes. */
function put(h: Uint8Array, at: number, width: number, text: string): void {
	h.set(enc.encode(text).subarray(0, width), at);
}

/** A number in octal, as wide as the field with its NUL. */
const octal = (n: number, width: number): string =>
	`${Math.floor(n)
		.toString(8)
		.padStart(width - 1, "0")}\0`;

/** One pax record: `<length> <key>=<value>\n`, the length counting itself. */
function paxRecord(key: string, value: string): string {
	const body = ` ${key}=${value}\n`;
	const size = enc.encode(body).length;
	let len = size + String(size).length;
	while (String(len).length + size !== len) len = String(len).length + size;
	return `${len}${body}`;
}

const fitsUstar = (text: string): boolean => text.length < 100 && /^[\x20-\x7e]*$/.test(text);

function ustarHeader(name: string, type: string, size: number, mode: number, mtime: number, link: string): Uint8Array {
	const h = new Uint8Array(BLOCK);
	put(h, 0, 100, name);
	put(h, 100, 8, octal(mode, 8));
	put(h, 108, 8, octal(0, 8));
	put(h, 116, 8, octal(0, 8));
	put(h, 124, 12, octal(size, 12));
	put(h, 136, 12, octal(mtime, 12));
	put(h, 148, 8, "        ");
	put(h, 156, 1, type);
	put(h, 157, 100, link);
	put(h, 257, 6, "ustar\0");
	put(h, 263, 2, "00");
	let sum = 0;
	for (const b of h) sum += b;
	put(h, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
	return h;
}

const padOf = (size: number): number => (BLOCK - (size % BLOCK)) % BLOCK;

/** The blocks before an entry's bytes: a pax header for a name or link a ustar header cannot hold, then its own. */
function entryHead(e: TarEntry): Uint8Array {
	const name = e.type === "dir" ? `${e.path}/` : e.path;
	const link = e.target ?? "";
	let pax = "";
	if (!fitsUstar(name)) pax += paxRecord("path", name);
	if (!fitsUstar(link)) pax += paxRecord("linkpath", link);
	const type = e.type === "file" ? "0" : e.type === "dir" ? "5" : "2";
	const own = ustarHeader(
		fitsUstar(name) ? name : "././@PaxHeader",
		type,
		e.size,
		e.mode,
		e.mtime,
		fitsUstar(link) ? link : "",
	);
	if (pax === "") return own;
	const records = enc.encode(pax);
	const out = new Uint8Array(BLOCK + records.length + padOf(records.length) + BLOCK);
	out.set(ustarHeader("././@PaxHeader", "x", records.length, 0o644, e.mtime, ""), 0);
	out.set(records, BLOCK);
	out.set(own, out.length - BLOCK);
	return out;
}

/** How many bytes `packTar` sends for `entries`. */
export function tarSize(entries: readonly TarEntry[]): number {
	let n = END.length;
	for (const e of entries) n += entryHead(e).length + e.size + padOf(e.size);
	return n;
}

const READ_BYTES = 256 * 1024;

/**
 * The tar of `entries` (a `walkFolder` of `root`), made as it is read: exactly `tarSize(entries)` bytes, or an error
 * (`changed`) when a file is no longer the size it was walked at.
 */
export function packTar(root: string, entries: readonly TarEntry[]): ReadableStream<Uint8Array> {
	let i = 0;
	let file: { handle: FileHandle; left: number; entry: TarEntry } | null = null;
	const changed = (e: TarEntry) => new RemoteCopyError(`${e.path} changed while it was copied: try again`, "changed");
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				if (file) {
					const f = file;
					const buf = new Uint8Array(Math.min(READ_BYTES, f.left));
					const { bytesRead } = await f.handle.read(buf, 0, buf.length, null);
					if (bytesRead === 0) {
						await f.handle.close();
						file = null;
						throw changed(f.entry);
					}
					f.left -= bytesRead;
					controller.enqueue(bytesRead === buf.length ? buf : buf.subarray(0, bytesRead));
					if (f.left === 0) {
						const st = await f.handle.stat();
						await f.handle.close();
						file = null;
						if (st.size !== f.entry.size) throw changed(f.entry);
						const pad = padOf(f.entry.size);
						if (pad > 0) controller.enqueue(new Uint8Array(pad));
					}
					return;
				}
				const e = entries[i++];
				if (!e) {
					controller.enqueue(END);
					controller.close();
					return;
				}
				if (e.type === "file" && e.size > 0) {
					const handle = await open(join(root, e.path), constants.O_RDONLY | constants.O_NOFOLLOW).catch((err) => {
						throw (err as NodeJS.ErrnoException).code === "ENOENT" ? changed(e) : fsFailure(err, e.path);
					});
					const st = await handle.stat();
					if (!st.isFile() || st.size !== e.size) {
						await handle.close();
						throw changed(e);
					}
					file = { handle, left: e.size, entry: e };
				}
				controller.enqueue(entryHead(e));
			},
			async cancel() {
				await file?.handle.close();
				file = null;
			},
			// Nothing is read before it is asked for: a stream that is never read opens no file.
		},
		{ highWaterMark: 0 },
	);
}

// ------------------------------------------------------------------ reading

const bad = (why: string) => new RemoteCopyError(`The folder that arrived ${why}`, "badArchive");

/** A field of a header as text, up to its first NUL. */
function field(h: Uint8Array, at: number, width: number): string {
	const raw = h.subarray(at, at + width);
	const nul = raw.indexOf(0);
	return dec.decode(nul < 0 ? raw : raw.subarray(0, nul));
}

function octalField(h: Uint8Array, at: number, width: number): number {
	if ((h[at] ?? 0) & 0x80) throw bad("has a number this copy does not read");
	const text = field(h, at, width).trim();
	if (text === "") return 0;
	if (!/^[0-7]+$/.test(text)) throw bad("is not a tar");
	return Number.parseInt(text, 8);
}

/** The records of a pax header. */
function paxRecords(data: Uint8Array): Record<string, string> {
	const out: Record<string, string> = {};
	let at = 0;
	while (at < data.length) {
		const space = data.indexOf(0x20, at);
		if (space < 0) throw bad("has a pax header this copy does not read");
		const len = Number(dec.decode(data.subarray(at, space)));
		if (!Number.isInteger(len) || len <= space - at || at + len > data.length) throw bad("has a broken pax header");
		const record = dec.decode(data.subarray(space + 1, at + len - 1));
		const eq = record.indexOf("=");
		if (eq > 0) out[record.slice(0, eq)] = record.slice(eq + 1);
		at += len;
	}
	return out;
}

type State =
	| { kind: "header" }
	| { kind: "meta"; type: string; left: number; pad: number; parts: Uint8Array[] }
	| { kind: "data"; left: number; pad: number; handle: FileHandle | null; entry: TarEntry }
	| { kind: "skip"; left: number }
	| { kind: "end" };

/** The most a pax header or a GNU long name may hold. */
const META_MAX = 1024 * 1024;

/**
 * A tar unpacked into the folder `dest` (which exists, and is empty) as it arrives: `write` each piece in order, then `end`,
 * which says what was unpacked. Any refusal is thrown by the `write` or `end` that met it; `dest` is then the caller's to
 * remove (`close` first).
 */
export class TarUnpacker {
	files = 0;
	bytes = 0;
	#entries = 0;
	#state: State = { kind: "header" };
	readonly #head = new Uint8Array(BLOCK);
	#headLen = 0;
	#zeros = 0;
	#pax: Record<string, string> = {};
	#longName: string | null = null;
	#longLink: string | null = null;
	readonly #dirs = new Set<string>([""]);
	readonly #taken = new Set<string>();
	readonly #links = new Set<string>();
	readonly #times: { abs: string; mode: number; mtime: number }[] = [];

	constructor(
		private readonly dest: string,
		private readonly limits: TarLimits,
	) {}

	async write(chunk: Uint8Array): Promise<void> {
		let at = 0;
		while (at < chunk.length) {
			const s = this.#state;
			const rest = chunk.length - at;
			switch (s.kind) {
				case "end":
					// What a tar is padded with after its end.
					return;
				case "header": {
					const n = Math.min(BLOCK - this.#headLen, rest);
					this.#head.set(chunk.subarray(at, at + n), this.#headLen);
					this.#headLen += n;
					at += n;
					if (this.#headLen === BLOCK) {
						this.#headLen = 0;
						await this.#header(this.#head);
					}
					break;
				}
				case "meta": {
					const n = Math.min(s.left, rest);
					s.parts.push(chunk.slice(at, at + n));
					s.left -= n;
					at += n;
					if (s.left === 0) {
						this.#meta(s.type, Buffer.concat(s.parts));
						this.#state = s.pad > 0 ? { kind: "skip", left: s.pad } : { kind: "header" };
					}
					break;
				}
				case "data": {
					const n = Math.min(s.left, rest);
					if (s.handle) {
						const handle = s.handle;
						try {
							let done = 0;
							while (done < n) done += (await handle.write(chunk, at + done, n - done)).bytesWritten;
						} catch (e) {
							throw fsFailure(e, s.entry.path);
						}
					}
					s.left -= n;
					at += n;
					if (s.left === 0) {
						await this.#fileDone(s);
						this.#state = s.pad > 0 ? { kind: "skip", left: s.pad } : { kind: "header" };
					}
					break;
				}
				case "skip": {
					const n = Math.min(s.left, rest);
					s.left -= n;
					at += n;
					if (s.left === 0) this.#state = { kind: "header" };
					break;
				}
			}
		}
	}

	/** Every piece has been written: the tar must have ended. The folders get their times and permissions. */
	async end(): Promise<{ files: number; bytes: number }> {
		// A tar that stops after its last entry, with no end blocks, is one that was cut short.
		if (this.#state.kind !== "end") throw bad("was cut short");
		for (const t of this.#times.reverse()) {
			await chmod(t.abs, t.mode | 0o700);
			await utimes(t.abs, t.mtime, t.mtime);
		}
		return { files: this.files, bytes: this.bytes };
	}

	/** Stop: a file being written is closed (what is in `dest` is left for the caller to remove). */
	async close(): Promise<void> {
		const s = this.#state;
		if (s.kind === "data") await s.handle?.close().catch(() => {});
		this.#state = { kind: "end" };
	}

	async #header(h: Uint8Array): Promise<void> {
		if (h.every((b) => b === 0)) {
			if (++this.#zeros === 2) this.#state = { kind: "end" };
			return;
		}
		if (this.#zeros > 0) throw bad("is not a tar");
		let sum = 0;
		for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 0x20 : (h[i] as number);
		if (octalField(h, 148, 8) !== sum) throw bad("is not a tar");
		const type = field(h, 156, 1) || "0";
		const size = this.#pax.size !== undefined ? Number(this.#pax.size) : octalField(h, 124, 12);
		if (!Number.isSafeInteger(size) || size < 0) throw bad("has an entry of no size");
		if (type === "x" || type === "g" || type === "L" || type === "K") {
			if (size > META_MAX) throw bad("has a header too large to read");
			this.#state = size === 0 ? { kind: "header" } : { kind: "meta", type, left: size, pad: padOf(size), parts: [] };
			return;
		}
		const prefix = field(h, 257, 6).startsWith("ustar") ? field(h, 345, 155) : "";
		const raw = this.#pax.path ?? this.#longName ?? (prefix ? `${prefix}/${field(h, 0, 100)}` : field(h, 0, 100));
		const link = this.#pax.linkpath ?? this.#longLink ?? field(h, 157, 100);
		const mtime = this.#pax.mtime !== undefined ? Math.floor(Number(this.#pax.mtime)) : octalField(h, 136, 12);
		const mode = octalField(h, 100, 8) & 0o777;
		this.#pax = {};
		this.#longName = null;
		this.#longLink = null;
		if (++this.#entries > this.limits.maxEntries)
			throw new RemoteCopyError(`More than ${this.limits.maxEntries} files and folders to copy`, "tooLarge");
		const path = safeEntryPath(raw);
		if (path === null) throw bad(`has an entry that leads out of the folder (${JSON.stringify(raw)})`);
		const entryType = type === "0" || type === "7" ? "file" : type === "5" ? "dir" : type === "2" ? "link" : null;
		if (entryType === null)
			throw bad(
				`holds ${JSON.stringify(path)}, which is not a file, a folder or a link (type ${JSON.stringify(type)})`,
			);
		const entry: TarEntry = {
			path,
			type: entryType,
			size: entryType === "file" ? size : 0,
			mode,
			mtime: Number.isFinite(mtime) ? mtime : 0,
			...(entryType === "link" ? { target: link } : {}),
		};
		await this.#place(entry);
		if (entryType === "file") return;
		// A folder or a link with bytes: they are not written.
		const skip = size + padOf(size);
		if (skip > 0) this.#state = { kind: "skip", left: skip };
	}

	#meta(type: string, data: Uint8Array): void {
		if (type === "x") Object.assign(this.#pax, paxRecords(data));
		else if (type === "L") this.#longName = field(data, 0, data.length);
		else if (type === "K") this.#longLink = field(data, 0, data.length);
		// `g`: what holds for every entry after it (a comment, a charset) changes nothing here.
	}

	/** Make the entry's place: its folders (only ones this made), then the folder, the link, or the file to write. */
	async #place(e: TarEntry): Promise<void> {
		const parts = e.path.split("/");
		let at = "";
		for (const part of parts.slice(0, -1)) {
			at = at === "" ? part : `${at}/${part}`;
			if (this.#links.has(at) || (this.#taken.has(at) && !this.#dirs.has(at)))
				throw bad(`has an entry that leads through a link or a file (${JSON.stringify(e.path)})`);
			if (!this.#dirs.has(at)) await this.#mkdir(at);
		}
		if (this.#dirs.has(e.path) && e.type === "dir") return;
		if (this.#taken.has(e.path) || this.#dirs.has(e.path)) throw bad(`names ${JSON.stringify(e.path)} twice`);
		const abs = join(this.dest, e.path);
		if (e.type === "dir") {
			await this.#mkdir(e.path);
			this.#times.push({ abs, mode: e.mode, mtime: e.mtime });
			return;
		}
		this.#taken.add(e.path);
		if (e.type === "link") {
			const target = e.target ?? "";
			if (!staysInside(e.path, target))
				throw bad(`has a link that leads out of the folder (${JSON.stringify(e.path)} → ${JSON.stringify(target)})`);
			this.#links.add(e.path);
			await symlink(target, abs).catch((err) => Promise.reject(fsFailure(err, e.path)));
			return;
		}
		if (this.bytes + e.size > this.limits.maxBytes)
			throw new RemoteCopyError(`More than ${this.limits.maxBytes} bytes of files to copy`, "tooLarge");
		const handle = await open(
			abs,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		).catch((err) => Promise.reject(fsFailure(err, e.path)));
		const state: State = { kind: "data", left: e.size, pad: padOf(e.size), handle, entry: e };
		if (e.size === 0) await this.#fileDone(state);
		else this.#state = state;
	}

	async #mkdir(path: string): Promise<void> {
		await mkdir(join(this.dest, path), { mode: 0o700 }).catch((err) => Promise.reject(fsFailure(err, path)));
		this.#dirs.add(path);
		this.#taken.add(path);
	}

	async #fileDone(s: Extract<State, { kind: "data" }>): Promise<void> {
		const handle = s.handle;
		s.handle = null;
		if (!handle) return;
		try {
			await handle.chmod(s.entry.mode);
			await handle.utimes(s.entry.mtime, s.entry.mtime);
		} finally {
			await handle.close();
		}
		this.files++;
		this.bytes += s.entry.size;
	}
}
