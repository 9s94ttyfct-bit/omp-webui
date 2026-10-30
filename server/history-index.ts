import { closeSync, fstatSync, openSync, readSync, type Stats } from "node:fs";
import { isRecord } from "../shared/guards.ts";
import { parseLine, withTitleSlot } from "./sessions/parse.ts";

/**
 * What the worker knows of a session file without parsing it: where each entry's line is (bytes), and the few fields a
 * path through the entries is made of (`id`, `parentId`, `type`, `timestamp`, and for a message its role). Built by one pass
 * over the bytes, which reads the fields from the start of each line when omp wrote it (key order `type, id, parentId,
 * timestamp`, then `message`) and parses the lines that do not start so. A window of the history is then a few byte ranges
 * of the file, spliced into the answer as they were written.
 *
 * A file only grows at its end while a conversation runs, so an index of a file that grew is extended from where it stopped
 * (`IndexCache`): the cost of a write does not depend on the length of the file.
 */

/** What a message's role makes of its entry, for the places that look for prompts, turns and assistant messages. */
export const Role = {
	/** A message whose role the start of its line did not say: read the line to know. */
	UNKNOWN: 0,
	USER: 1,
	DEVELOPER: 2,
	ASSISTANT: 3,
	BASH: 4,
	PYTHON: 5,
	/** A message of any other role (a tool result, a custom message…), or one without a readable role. */
	OTHER: 6,
	NOT_MESSAGE: 7,
} as const;

/** Whether a `user` or `developer` message was written by the agent itself (`attribution: "agent"`): that one is no prompt. */
export const Attr = { UNCHECKED: 0, AGENT: 1, NOT_AGENT: 2 } as const;

/** The version of a file as `statSync` tells it: what an index was made from. */
export interface Identity {
	mtimeMs: number;
	size: number;
	ctimeMs: number;
	ino: number;
}

function identityOf(st: Stats): Identity {
	return { mtimeMs: st.mtimeMs, size: st.size, ctimeMs: st.ctimeMs, ino: st.ino };
}

const sameIdentity = (a: Identity, b: Identity): boolean =>
	a.mtimeMs === b.mtimeMs && a.size === b.size && a.ctimeMs === b.ctimeMs && a.ino === b.ino;

/**
 * The pieces of one big file are read this many bytes at a time: what the worker holds while it indexes is a piece (a buffer and
 * the same bytes again as a string, see `scan`) and does not grow with the file, except for a line longer than a piece, which has
 * to be read whole (`nextChunk`). 16 MB pieces made the worker's heap peak at 32 MB for a 17 MB conversation and keep part of it
 * as fragmentation afterwards (the server's footprint after opening one was ~3 MB higher with them, measured with the
 * benchmark's long conversation).
 */
const CHUNK = 2 * 1024 * 1024;
/** What a line that does not fit in a piece is read with first: see `nextChunk`. */
const LONG_LINE_CHUNK = 16 * 1024 * 1024;

/**
 * The size of the next read of a line that did not end in the last one. Each read copies what the line has so far, so growing
 * from the piece in steps (2, 4, 8, 16 MB) peaks at about three times the line for one of 2-16 MB, where a jump to 16 MB at once
 * and doubling from there (32, 64 ...) peaks at about twice, as the 16 MB pieces did. Not capped: a line of any length must end
 * in a read, and a cap that the line outgrows would read the same bytes forever.
 */
export function nextChunk(chunk: number): number {
	return chunk < LONG_LINE_CHUNK ? LONG_LINE_CHUNK : chunk * 2;
}

/** How many bytes at each end of what was indexed are compared to tell a file that grew from one that was rewritten. */
const PROBE = 4096;
/** Entries closer than this are read with one read: the bytes between them cost less than another system call. */
const READ_GAP = 64 * 1024;
/** A read that joins entries is no larger than this (one entry that is larger is read alone). */
const READ_MAX = 4 * 1024 * 1024;

/** A parent that is not (yet) among the entries: asked again when it is needed. */
const MISSING = -2;

const SAFE = String.raw`[\x20\x21\x23-\x5b\x5d-\x7e]`;
/**
 * The start of a line as omp writes an entry: type, id, parentId, timestamp, and for a message its role. Printable ASCII
 * only (no escapes, no other characters): a line that has more is parsed.
 */
const PREFIX = new RegExp(
	String.raw`\{"type":"(${SAFE}*)","id":"(${SAFE}*)","parentId":(null|"${SAFE}*"),"timestamp":"(${SAFE}*)"(?:,"message":\{"role":"([A-Za-z]*)")?`,
	"y",
);

export function roleCode(role: string): number {
	switch (role) {
		case "user":
			return Role.USER;
		case "developer":
			return Role.DEVELOPER;
		case "assistant":
			return Role.ASSISTANT;
		case "bashExecution":
			return Role.BASH;
		case "pythonExecution":
			return Role.PYTHON;
		default:
			return Role.OTHER;
	}
}

/**
 * `text` as a string of its own. A piece cut from a larger string (a regular expression's capture, a `slice`) shares the
 * larger one's characters: an id taken from a chunk of the file as it was read would keep the whole chunk in memory, and an
 * index of thousands of entries would hold the file's text. Copied through bytes, it holds its own few characters.
 */
function own(text: string): string {
	return Buffer.from(text, "latin1").toString("latin1");
}

/** Read `length` bytes of the file at `pos`; fewer when the file ends first. */
export function readBytes(fd: number, pos: number, length: number): Buffer {
	const buf = Buffer.allocUnsafe(length);
	let got = 0;
	while (got < length) {
		const n = readSync(fd, buf, got, length - got, pos + got);
		if (n === 0) break;
		got += n;
	}
	return got === length ? buf : buf.subarray(0, got);
}

/** A line as an object: null when it is not valid JSON, or is not an object. */
export function parseObject(text: string): Record<string, unknown> | null {
	try {
		const obj: unknown = JSON.parse(text);
		return isRecord(obj) ? obj : null;
	} catch {
		return null;
	}
}

/** What the figures of `view=stats` have added up so far, and how far (see `history-stats.ts`). */
export interface StatsState {
	/** The entries before this one are in the figures. */
	folded: number;
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
	byModel: Map<string, { tokens: number; cost: number; n: number }>;
	clock: { total: number; start: number | null; end: number };
}

export class FileIndex {
	readonly ids: string[] = [];
	/** The parent id each line names; null for none (or one that is not a string). */
	readonly parents: (string | null)[] = [];
	readonly types: string[] = [];
	readonly stamps: string[] = [];
	/** Where each entry's line is in the file, without the blanks around it. */
	readonly starts: number[] = [];
	readonly lens: number[] = [];
	readonly roles: number[] = [];
	readonly attrs: number[] = [];
	readonly byId = new Map<string, number>();
	private readonly parentIdx: number[] = [];
	/** Whether the last entry is a line that has no newline yet: it is read again when the file grows. */
	private pending = false;
	private sawHeader = false;
	private headerObj: Record<string, unknown> | null = null;
	private titleSlot: Record<string, unknown> | null = null;
	private headerJson: string | undefined;
	/** Two entries have one id: the index cannot be taken back a line, so a file that grew is read again from the start. */
	dups = false;
	identity: Identity = { mtimeMs: 0, size: 0, ctimeMs: 0, ino: 0 };
	/** Where the next pass over the file begins: the end of the last complete line. */
	end = 0;
	private headProbe = { len: 0, hash: "" };
	private tailProbe = "";
	private kids: Map<string | null, number[]> | null = null;
	private newest: Int32Array | null = null;
	/** Kept by `history-stats.ts`: what the figures of the file add up to, and how far. */
	stats: StatsState | null = null;
	/** Kept by `history.ts`: the last prompt of the file, and for how many entries it was looked for. */
	lastPromptOf: { n: number; text: string } | null = null;

	/** The types the file has, each once: a file is thousands of entries of a handful of types. */
	private readonly typeNames = new Map<string, string>();

	constructor(readonly file: string) {}

	private typeOf(captured: string): string {
		let kept = this.typeNames.get(captured);
		if (kept === undefined) {
			kept = own(captured);
			this.typeNames.set(kept, kept);
		}
		return kept;
	}

	get length(): number {
		return this.ids.length;
	}

	/** The entries whose figures can be trusted to be complete: all but a last line that is still being written. */
	get committed(): number {
		return this.pending ? this.ids.length - 1 : this.ids.length;
	}

	/** The id of the last entry line, null when there is none. */
	get head(): string | null {
		return this.ids.at(-1) ?? null;
	}

	/** What a parsed line (of a message entry) says of its role, for the entries the start of the line did not say it of. */
	learn(i: number, obj: Record<string, unknown>): void {
		const m = obj.message;
		if (isRecord(m) && typeof m.role === "string") {
			this.roles[i] = roleCode(m.role);
			this.attrs[i] = m.attribution === "agent" ? Attr.AGENT : Attr.NOT_AGENT;
		} else this.roles[i] = Role.OTHER;
	}

	/** The header as a page gets it (the title slot's title merged in), as JSON; `null` when the file has none. */
	header(): string {
		if (this.headerJson === undefined) this.headerJson = JSON.stringify(withTitleSlot(this.headerObj, this.titleSlot));
		return this.headerJson;
	}

	/** The index of the parent entry; -1 for a root, and for a parent the file does not have. */
	parentOf(i: number): number {
		const p = this.parentIdx[i] as number;
		if (p !== MISSING) return p;
		const q = this.byId.get(this.parents[i] as string);
		if (q === undefined || q === i) return -1;
		this.parentIdx[i] = q;
		return q;
	}

	/** Every entry by the id of its parent (null: the roots), in file order. Built once, and kept up to date as the file grows. */
	children(): Map<string | null, number[]> {
		if (!this.kids) {
			const kids = new Map<string | null, number[]>();
			for (let i = 0; i < this.ids.length; i++) {
				const key = this.parents[i] as string | null;
				const list = kids.get(key);
				if (list) list.push(i);
				else kids.set(key, [i]);
			}
			this.kids = kids;
		}
		return this.kids;
	}

	/**
	 * For each entry the newest entry under it (itself included) in this file: the greatest timestamp, and among equal ones the
	 * one written last. A parent is written before its children, so one sweep from the end settles every entry.
	 */
	newestUnder(): Int32Array {
		if (this.newest) return this.newest;
		const n = this.ids.length;
		const best = new Int32Array(n);
		for (let i = 0; i < n; i++) best[i] = i;
		const stamps = this.stamps;
		for (let i = n - 1; i >= 0; i--) {
			const p = this.parentOf(i);
			if (p < 0) continue;
			const b = best[i] as number;
			const c = best[p] as number;
			const sb = stamps[b] as string;
			const sc = stamps[c] as string;
			if (sb > sc || (sb === sc && b > c)) best[p] = b;
		}
		this.newest = best;
		return best;
	}

	/** A rough size in memory, for the cache's limit. */
	get weight(): number {
		return 4096 + this.ids.length * 260;
	}

	// ------------------------------------------------------------------ building

	/** Index the file `fd` (of version `now`) from its start. */
	build(fd: number, now: Identity): void {
		this.scan(fd, 0, now.size);
		this.seal(fd, now);
	}

	/**
	 * Whether this index can be taken on from where it stopped: it is the same file (an inode that was not replaced), at least as
	 * long as what was read, and the bytes at both ends of what was read are as they were. A write that changed what lies
	 * between them and left both ends alone is not seen; omp appends.
	 */
	canExtend(fd: number, now: Identity): boolean {
		if (this.dups || now.ino !== this.identity.ino || now.size < this.end) return false;
		const head = readBytes(fd, 0, this.headProbe.len);
		if (head.length !== this.headProbe.len || String(Bun.hash(head)) !== this.headProbe.hash) return false;
		return this.tailHash(fd) === this.tailProbe;
	}

	/** Index what the file has after the last complete line. */
	extend(fd: number, now: Identity): void {
		if (this.pending) this.popLast();
		this.scan(fd, this.end, now.size);
		this.seal(fd, now);
	}

	private seal(fd: number, now: Identity): void {
		this.identity = now;
		if (this.headProbe.len === 0 || this.headProbe.len < Math.min(PROBE, this.end)) {
			const len = Math.min(PROBE, this.end);
			this.headProbe = { len, hash: String(Bun.hash(readBytes(fd, 0, len))) };
		}
		this.tailProbe = this.tailHash(fd);
	}

	private tailHash(fd: number): string {
		const from = Math.max(0, this.end - PROBE);
		return String(Bun.hash(readBytes(fd, from, this.end - from)));
	}

	/** Take back the last entry (a line that had no newline when it was read). */
	private popLast(): void {
		const id = this.ids.pop() as string;
		this.byId.delete(id);
		this.parents.pop();
		this.types.pop();
		this.stamps.pop();
		this.starts.pop();
		this.lens.pop();
		this.roles.pop();
		this.attrs.pop();
		this.parentIdx.pop();
		this.pending = false;
		this.kids = null;
		this.newest = null;
		this.lastPromptOf = null;
	}

	private scan(fd: number, from: number, to: number): void {
		let pos = from;
		let chunk = CHUNK;
		this.end = from;
		while (pos < to) {
			const want = Math.min(chunk, to - pos);
			const buf = readBytes(fd, pos, want);
			const text = buf.toString("latin1");
			let at = 0;
			for (;;) {
				const nl = text.indexOf("\n", at);
				if (nl < 0) break;
				this.addLine(text, buf, at, nl, pos, true);
				at = nl + 1;
			}
			if (at === buf.length) {
				pos += at;
				chunk = CHUNK;
				this.end = pos;
				if (buf.length < want) return;
				continue;
			}
			// What is left is the start of a line.
			if (buf.length < want || pos + want >= to) {
				// That is the end of the file: a last line with no newline (yet).
				this.addLine(text, buf, at, buf.length, pos, false);
				this.end = pos + at;
				return;
			}
			if (at === 0) {
				// A line longer than what was read: read more of it.
				chunk = nextChunk(chunk);
				continue;
			}
			pos += at;
			chunk = CHUNK;
			this.end = pos;
		}
	}

	/**
	 * Take the line `[from, to)` of `text` (the bytes of `buf` decoded as latin1: a byte is a character, so the positions
	 * are the same in both) found `base` bytes into the file.
	 */
	private addLine(text: string, buf: Buffer, from: number, to: number, base: number, terminated: boolean): void {
		let s = from;
		let e = to;
		for (;;) {
			const c = text.charCodeAt(e - 1);
			if (e > s && (c === 13 || c === 32 || c === 9)) e--;
			else break;
		}
		for (;;) {
			const c = text.charCodeAt(s);
			if (s < e && (c === 13 || c === 32 || c === 9)) s++;
			else break;
		}
		if (s >= e) return;
		if (terminated && text.charCodeAt(s) === 123 && text.charCodeAt(e - 1) === 125) {
			PREFIX.lastIndex = s;
			const m = PREFIX.exec(text);
			if (m && m[1] !== "session" && m[1] !== "title") {
				const type = this.typeOf(m[1] as string);
				const parent = m[3] as string;
				this.push(
					own(m[2] as string),
					parent === "null" ? null : own(parent.slice(1, -1)),
					type,
					own(m[4] as string),
					base + s,
					e - s,
					type !== "message" ? Role.NOT_MESSAGE : m[5] === undefined ? Role.UNKNOWN : roleCode(m[5]),
					Attr.UNCHECKED,
				);
				return;
			}
		}
		const obj = parseLine(buf.toString("utf8", s, e));
		if (!obj) return;
		if (obj.type === "title" && !this.sawHeader) {
			if (terminated) this.titleSlot = obj;
			return;
		}
		if (obj.type === "session" && !this.sawHeader) {
			if (terminated) {
				this.headerObj = obj;
				this.sawHeader = true;
				this.headerJson = undefined;
			}
			return;
		}
		if (typeof obj.id !== "string") return;
		const type = typeof obj.type === "string" ? obj.type : "";
		let role: number = Role.NOT_MESSAGE;
		let attr: number = Attr.UNCHECKED;
		if (type === "message") {
			const m = obj.message;
			if (isRecord(m) && typeof m.role === "string") {
				role = roleCode(m.role);
				attr = m.attribution === "agent" ? Attr.AGENT : Attr.NOT_AGENT;
			} else role = Role.OTHER;
		}
		this.push(
			obj.id,
			typeof obj.parentId === "string" ? obj.parentId : null,
			type,
			typeof obj.timestamp === "string" ? obj.timestamp : "",
			base + s,
			e - s,
			role,
			attr,
		);
		if (!terminated) this.pending = true;
	}

	private push(
		id: string,
		parent: string | null,
		type: string,
		stamp: string,
		start: number,
		len: number,
		role: number,
		attr: number,
	): void {
		const i = this.ids.length;
		this.ids.push(id);
		this.types.push(type);
		this.stamps.push(stamp);
		this.starts.push(start);
		this.lens.push(len);
		this.roles.push(role);
		this.attrs.push(attr);
		if (this.byId.has(id)) this.dups = true;
		this.byId.set(id, i);
		const p = parent === null ? -1 : (this.byId.get(parent) ?? MISSING);
		// A parent that is among the entries is held as that entry's own id, not as a second copy of it (a conversation is a
		// chain: every entry would otherwise hold its parent's id again). One that is not (yet) is held as it came: the caller
		// made it a string of its own (`own` for what was cut from a piece of the file, a parsed line's field already is one).
		const key = parent === null ? null : p >= 0 && p !== i ? (this.ids[p] as string) : parent;
		this.parents.push(key);
		this.parentIdx.push(p === i ? MISSING : p);
		this.newest = null;
		if (this.kids) {
			const list = this.kids.get(key);
			if (list) list.push(i);
			else this.kids.set(key, [i]);
		}
	}
}

/**
 * The indexes of the files a worker has read lately: a handful, the least recently used going first, and none left when
 * their estimated size passes the limit. A file that grew is taken on from where its index stopped; one that was
 * replaced or rewritten is indexed again.
 */
export class IndexCache {
	private readonly map = new Map<string, FileIndex>();
	private readonly max: number;
	private readonly bytes: number;

	constructor(options: { max?: number; bytes?: number } = {}) {
		this.max = options.max ?? 6;
		this.bytes = options.bytes ?? 256 * 1024 * 1024;
	}

	/** The index of `file` as it is now. A file that is gone fails, as every read of it does. */
	get(file: string): FileIndex {
		const fd = openSync(file, "r");
		try {
			const now = identityOf(fstatSync(fd));
			const kept = this.map.get(file);
			this.map.delete(file);
			if (kept) {
				if (sameIdentity(kept.identity, now)) {
					this.map.set(file, kept);
					return kept;
				}
				if (kept.canExtend(fd, now)) {
					kept.extend(fd, now);
					this.map.set(file, kept);
					return kept;
				}
			}
			const fresh = new FileIndex(file);
			fresh.build(fd, now);
			this.map.set(file, fresh);
			return fresh;
		} finally {
			closeSync(fd);
		}
	}

	/** Forget the index of `file` (what was read from it turned out not to be what the index says). */
	drop(file: string): void {
		this.map.delete(file);
	}

	/** Let go of the least recently used indexes beyond the limits. Called between jobs: a job holds the indexes it works on. */
	trim(): void {
		let total = 0;
		for (const index of this.map.values()) total += index.weight;
		for (const [file] of this.map) {
			if (this.map.size <= this.max && total <= this.bytes) break;
			if (this.map.size <= 1) break;
			total -= (this.map.get(file) as FileIndex).weight;
			this.map.delete(file);
		}
	}

	get size(): number {
		return this.map.size;
	}
}

/**
 * The lines of the entries `idxs` (ascending), as text, in as few reads as the file's layout allows: entries closer than
 * `READ_GAP` are read together.
 */
export function readEntries(fd: number, index: FileIndex, idxs: readonly number[]): string[] {
	const out = new Array<string>(idxs.length);
	let g = 0;
	while (g < idxs.length) {
		const first = idxs[g] as number;
		const base = index.starts[first] as number;
		let stop = base + (index.lens[first] as number);
		let h = g + 1;
		while (h < idxs.length) {
			const next = idxs[h] as number;
			const s = index.starts[next] as number;
			const e = s + (index.lens[next] as number);
			if (s - stop > READ_GAP || e - base > READ_MAX) break;
			stop = e;
			h++;
		}
		const buf = readBytes(fd, base, stop - base);
		for (let k = g; k < h; k++) {
			const i = idxs[k] as number;
			const from = (index.starts[i] as number) - base;
			out[k] = buf.toString("utf8", from, from + (index.lens[i] as number));
		}
		g = h;
	}
	return out;
}

/** Whether `index`'s file is no longer the version the index was made of. */
export function changedSince(index: FileIndex): boolean {
	const fd = openSync(index.file, "r");
	try {
		return !sameIdentity(index.identity, identityOf(fstatSync(fd)));
	} catch {
		return true;
	} finally {
		closeSync(fd);
	}
}
