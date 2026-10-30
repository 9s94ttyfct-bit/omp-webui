import { isRecord } from "../../shared/guards.ts";

/**
 * Paths that change when a person moves to another computer: the home folder (`/Users/old` → `/Users/new`) and, when
 * they differ, omp's agent directory and this app's data directory. Every place that holds one is rewritten by the same
 * `PathMap`: a conversation's recorded folder, the files that name a conversation, the plugin registry, the settings.
 */

export interface PathPair {
	from: string;
	to: string;
}

const trimSlash = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") : p);

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class PathMap {
	readonly pairs: PathPair[];
	private readonly pattern: RegExp | null;

	constructor(pairs: PathPair[]) {
		// The longest `from` first: `/Users/a/.omp/agent` is a part of `/Users/a`, and the more specific one decides.
		const seen = new Set<string>();
		this.pairs = pairs
			.map((p) => ({ from: trimSlash(p.from), to: trimSlash(p.to) }))
			.filter((p) => p.from.length > 1 && p.from !== p.to && !seen.has(p.from) && !!seen.add(p.from))
			.sort((a, b) => b.from.length - a.from.length);
		// A folder name is not a prefix of a longer one (`/Users/al` is not `/Users/alice`): what follows the match must
		// not continue a name (a dot ends a sentence, a dot and a letter go on with the name), and what precedes it must not be the middle of one.
		this.pattern = this.pairs.length
			? new RegExp(
					`(?<![A-Za-z0-9_.~-])(?:${this.pairs.map((p) => escapeRegExp(p.from)).join("|")})(?![A-Za-z0-9_-]|\\.[A-Za-z0-9_-])`,
					"g",
				)
			: null;
	}

	/** Nothing changes: the two machines have the same paths. */
	get identity(): boolean {
		return this.pairs.length === 0;
	}

	/** `path` with its leading folder replaced when it is under one of the old ones; the same string otherwise. */
	map(path: string): string {
		for (const { from, to } of this.pairs) {
			if (path === from) return to;
			if (path.startsWith(`${from}/`)) return to + path.slice(from.length);
		}
		return path;
	}

	/** Whether `path` is under one of the old folders. */
	owns(path: string): boolean {
		return this.map(path) !== path;
	}

	/** `text` with every old folder in it replaced (inside quotes, command lines, JSON strings alike). */
	text(text: string): { text: string; count: number } {
		if (!this.pattern) return { text, count: 0 };
		let count = 0;
		const out = text.replace(this.pattern, (m) => {
			count++;
			return this.map(m);
		});
		return { text: out, count };
	}

	/** How many old folders are still named in `text` (after `text()` it should be none). */
	remaining(text: string): number {
		if (!this.pattern) return 0;
		return [...text.matchAll(this.pattern)].length;
	}
}

/** The folder name omp gives a session folder from a path: separators become `-`, a leading one goes. */
const encodeAbsolute = (p: string): string => p.replace(/^[\\/]+/, "").replace(/[\\/:]/g, "-");

/** omp's session folder of a working directory under `home` (`-<relative>`; `-` for the home folder itself). */
export function homeBucket(cwd: string, home: string): string | null {
	const h = trimSlash(home);
	if (cwd === h) return "-";
	if (!cwd.startsWith(`${h}/`)) return null;
	return `-${encodeAbsolute(cwd.slice(h.length + 1))}`;
}

/** …and for anything outside it: `--<encoded-absolute>--`. */
export const absoluteBucket = (cwd: string): string => `--${encodeAbsolute(cwd)}--`;

/**
 * Where the conversations of `oldCwd` belong on the new machine. omp names the folder after the working directory (a
 * path under home by its part below it: `-omp`; any other by its whole path: `--private-tmp--`), so a folder named the
 * first way is the same on the new machine and one named the second way after a path under the old home (omp wrote
 * those before 17.2.9) names a folder that is not there any more. A folder whose name is neither spelling of the
 * recorded directory keeps its name: it is something omp chose by other means.
 */
export function bucketFor(
	oldBucket: string,
	oldCwd: string,
	map: PathMap,
	oldHomes: string[],
	newHomes: string[],
): string {
	const newCwd = map.map(oldCwd);
	if (newCwd === oldCwd) return oldBucket;
	// A home folder is spelled twice when a link is on the way to it (`/var` → `/private/var`): omp names a folder after
	// the spelling it resolved, so either of the old ones may be the one in the bucket's name.
	const names = [...oldHomes.map((h) => homeBucket(oldCwd, h)), absoluteBucket(oldCwd)];
	if (!names.includes(oldBucket)) return oldBucket;
	for (const home of newHomes) {
		const bucket = homeBucket(newCwd, home);
		if (bucket) return bucket;
	}
	return absoluteBucket(newCwd);
}

/** What the first lines of a session file say about it: found without reading the rest. */
export interface SessionHead {
	id: string | null;
	cwd: string | null;
}

/** How far into a session file its header is looked for: omp writes it in the first lines (a 256-byte title slot, then it). */
export const HEAD_BYTES = 64 * 1024;

/** The header's fields that name a folder or another session's file. */
const PATH_FIELDS = ["cwd", "parentSession"] as const;
const PATH_LIST_FIELDS = ["additionalDirectories", "previousSessionFiles"] as const;

/** The fields that name another conversation's file: its folder may have been renamed (`fix` says where it is now). */
const SESSION_FILE_FIELDS = new Set<string>(["parentSession", "previousSessionFiles"]);

/** A header line with its paths mapped; `changed` says whether anything was. */
export function mapHeader(
	header: Record<string, unknown>,
	map: PathMap,
	fix: (path: string) => string = (p) => p,
): { header: Record<string, unknown>; changed: boolean } {
	let changed = false;
	const next: Record<string, unknown> = { ...header };
	for (const key of PATH_FIELDS) {
		const value = header[key];
		if (typeof value === "string" && value.startsWith("/")) {
			const mapped = SESSION_FILE_FIELDS.has(key) ? fix(map.map(value)) : map.map(value);
			if (mapped !== value) {
				next[key] = mapped;
				changed = true;
			}
		}
	}
	for (const key of PATH_LIST_FIELDS) {
		const value = header[key];
		if (!Array.isArray(value)) continue;
		const mapped = value.map((v) =>
			typeof v === "string" ? (SESSION_FILE_FIELDS.has(key) ? fix(map.map(v)) : map.map(v)) : v,
		);
		if (mapped.some((v, i) => v !== value[i])) {
			next[key] = mapped;
			changed = true;
		}
	}
	return { header: next, changed };
}

function parseLine(line: string): Record<string, unknown> | null {
	if (!line.includes('"session"')) return null;
	try {
		const v: unknown = JSON.parse(line);
		return isRecord(v) && v.type === "session" ? v : null;
	} catch {
		return null;
	}
}

/** The session header in the first bytes of a file (null when there is none in that window). */
export function sniffHead(bytes: Uint8Array): SessionHead | null {
	const text = Buffer.from(bytes.subarray(0, HEAD_BYTES)).toString("utf8");
	for (const line of text.split("\n")) {
		const header = parseLine(line);
		if (header)
			return {
				id: typeof header.id === "string" ? header.id : null,
				cwd: typeof header.cwd === "string" ? header.cwd : null,
			};
	}
	return null;
}

/**
 * The session file with the paths in its header mapped. Only the window at the start is looked at and rewritten; the rest
 * of the file goes through as it is (a transcript can be hundreds of megabytes). A file whose header is not found in the
 * window is passed on unchanged.
 */
export async function* rewriteSession(
	source: AsyncIterable<Uint8Array>,
	map: PathMap,
	onHeader?: (h: { before: Record<string, unknown>; changed: boolean }) => void,
	fix?: (path: string) => string,
): AsyncGenerator<Uint8Array> {
	let held: Buffer[] = [];
	let heldBytes = 0;
	let decided = false;
	for await (const chunk of source) {
		if (decided) {
			yield chunk;
			continue;
		}
		held.push(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength));
		heldBytes += chunk.byteLength;
		if (heldBytes < HEAD_BYTES) continue;
		decided = true;
		yield* emitHead(Buffer.concat(held), map, onHeader, fix);
		held = [];
	}
	if (!decided) yield* emitHead(Buffer.concat(held), map, onHeader, fix);
}

function* emitHead(
	head: Buffer,
	map: PathMap,
	onHeader: ((h: { before: Record<string, unknown>; changed: boolean }) => void) | undefined,
	fix: ((path: string) => string) | undefined,
): Generator<Uint8Array> {
	if (head.length === 0) return;
	const window = head.subarray(0, Math.min(head.length, HEAD_BYTES));
	const cut = window.lastIndexOf(0x0a);
	// No complete line in the window: nothing to read a header from.
	if (cut < 0) {
		yield head;
		return;
	}
	const lines = window.subarray(0, cut).toString("utf8").split("\n");
	let changedAny = false;
	for (let i = 0; i < lines.length; i++) {
		const header = parseLine(lines[i]);
		if (!header) continue;
		const mapped = mapHeader(header, map, fix);
		onHeader?.({ before: header, changed: mapped.changed });
		if (mapped.changed) {
			lines[i] = JSON.stringify(mapped.header);
			changedAny = true;
		}
	}
	if (!changedAny) {
		yield head;
		return;
	}
	yield Buffer.from(`${lines.join("\n")}\n`, "utf8");
	yield head.subarray(cut + 1);
}
