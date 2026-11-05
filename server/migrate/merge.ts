import { open } from "node:fs/promises";
import { isRecord } from "../../shared/guards.ts";
import type { ConfigFormat } from "./secrets.ts";

/**
 * Putting what an archive holds next to what a Mac already has. `merge` keeps what is here and adds what is missing;
 * `replace` lets the archive's version win where both have one. Nothing that is only here is ever removed.
 */

/** A value that is a configuration object: parsed text of a JSON or YAML file. */
export type Doc = Record<string, unknown>;

export function parseDoc(text: string, format: ConfigFormat): Doc | null {
	try {
		const v: unknown = format === "json" ? JSON.parse(text) : Bun.YAML.parse(text);
		return isRecord(v) ? v : null;
	} catch {
		return null;
	}
}

function indentOf(text: string): string | number {
	const m = /^\n?([ \t]+)\S/m.exec(text);
	if (!m) return 2;
	return m[1].includes("\t") ? "\t" : m[1].length;
}

export function serializeDoc(doc: Doc, format: ConfigFormat, like: string): string {
	if (format === "json") return `${JSON.stringify(doc, null, indentOf(like))}\n`;
	return Bun.YAML.stringify(doc, null, typeof indentOf(like) === "number" ? (indentOf(like) as number) : 2);
}

/** A key written on a line of its own: its indentation, a list item's `- `, and the key, bare or quoted. */
const KEY_AT = /^(\s*)(-\s+)?(?:"([^"\\]*)"|'([^']*)'|([^\s#"'{}[\],:][^#:]*?))\s*:(?=\s|$)/;

/** A key of a block YAML or pretty-printed JSON file: the line it is on, its indentation, and the keys above it. */
interface KeyLine {
	line: number;
	indent: number;
	path: string[];
}

/** Each key written on a line of its own, outside a list (a list item's keys have no path here). */
function keyLines(lines: readonly string[]): KeyLine[] {
	const out: KeyLine[] = [];
	const stack: { indent: number; key: string | null }[] = [];
	for (const [i, line] of lines.entries()) {
		const trimmed = line.trimStart();
		if (trimmed === "" || trimmed.startsWith("#")) continue;
		const indent = line.length - trimmed.length;
		while (stack.length > 0 && (stack.at(-1)?.indent ?? -1) >= indent) stack.pop();
		const m = KEY_AT.exec(line);
		if (!m) continue;
		if (m[2]) {
			stack.push({ indent, key: null });
			continue;
		}
		const key = m[3] ?? m[4] ?? m[5]?.trim() ?? "";
		const above = stack.map((s) => s.key).filter((k): k is string => k !== null);
		if (above.length === stack.length) out.push({ line: i, indent, path: [...above, key] });
		stack.push({ indent, key });
	}
	return out;
}

/** The one line the key at `path` is written on; null when it is on none, or on more than one. */
function lineOfKey(lines: readonly string[], path: readonly string[]): KeyLine | null {
	const found = keyLines(lines).filter((k) => k.path.length === path.length && k.path.every((p, i) => p === path[i]));
	return found.length === 1 ? (found[0] ?? null) : null;
}

/**
 * `text` (a block YAML or pretty-printed JSON file) with the empty string at each of `changes` (keys written on a line of
 * their own, as `key: ""`) set to its value, every other line as it was. Null when one is not written that way, or when the
 * result does not read as `expected`.
 */
export function withScalars(
	text: string,
	format: ConfigFormat,
	changes: readonly { path: string[]; value: string | number }[],
	expected: Doc,
): string | null {
	const lines = text.split("\n");
	for (const { path, value } of changes) {
		const at = lineOfKey(lines, path);
		const line = at ? lines[at.line] : undefined;
		const head = line === undefined ? null : KEY_AT.exec(line);
		if (!at || line === undefined || !head) return null;
		const rest = line.slice(head[0].length);
		const blank = /^(\s*)(""|'')/.exec(rest);
		if (!blank) return null;
		const written = typeof value === "number" ? String(value) : JSON.stringify(value);
		lines[at.line] = `${line.slice(0, head[0].length)}${blank[1]}${written}${rest.slice(blank[0].length)}`;
	}
	const out = lines.join("\n");
	const doc = parseDoc(out, format);
	return doc && Bun.deepEquals(doc, expected) ? out : null;
}

/** Each key `after` has and `before` lacks, with its value; a key both have is looked into where both hold objects. */
function addedKeys(before: Doc, after: Doc, path: readonly string[] = []): { path: string[]; value: unknown }[] {
	return Object.entries(after).flatMap(([k, value]) => {
		if (!(k in before)) return [{ path: [...path, k], value }];
		const was = before[k];
		return isRecord(was) && isRecord(value) ? addedKeys(was, value, [...path, k]) : [];
	});
}

/**
 * `text` (a block YAML file that reads as `before`) with each key `after` adds to it written in after the last line of the
 * object it belongs to, every line that was there kept as it was: comments, blank lines and quoting stay. Null when such an
 * object is not written as a block of lines of its own, or when the result does not read as `after`.
 */
export function withAddedKeys(text: string, before: Doc, after: Doc): string | null {
	const step = indentOf(text);
	if (typeof step !== "number") return null;
	const lines = text.split("\n");
	for (const { path, value } of addedKeys(before, after)) {
		const block = Bun.YAML.stringify({ [path.at(-1) as string]: value }, null, step).split("\n");
		let at = lines.at(-1) === "" ? lines.length - 1 : lines.length;
		let indent = "";
		if (path.length > 1) {
			const parent = lineOfKey(lines, path.slice(0, -1));
			const line = parent ? lines[parent.line] : undefined;
			const head = line === undefined ? null : KEY_AT.exec(line);
			// The object is written on the lines below its key, not on the key's line (`key: {a: 1}`).
			if (!parent || line === undefined || !head || !/^\s*(#.*)?$/.test(line.slice(head[0].length))) return null;
			let last = -1;
			for (let i = parent.line + 1; i < lines.length; i++) {
				const below = lines[i] ?? "";
				const trimmed = below.trimStart();
				if (trimmed === "" || trimmed.startsWith("#")) continue;
				const depth = below.length - trimmed.length;
				if (depth <= parent.indent) break;
				if (last < 0) indent = below.slice(0, depth);
				last = i;
			}
			if (last < 0) return null;
			at = last + 1;
		}
		lines.splice(at, 0, ...block.map((l) => `${indent}${l}`));
	}
	const out = lines.join("\n");
	const doc = parseDoc(out, "yaml");
	return doc && Bun.deepEquals(doc, after) ? out : null;
}

/** Which key identifies an object in a list, for the lists whose items are things (a marketplace by its name). */
export type ListKeys = Record<string, string>;

/**
 * `from` added to `into` (a copy): a key `into` lacks is taken from `from`; a key both have keeps `into`'s value, except
 * that two objects are merged key by key, and in `replace` `from`'s value wins wherever both have a plain one. A list of
 * objects with an identifying key (`keys`) is merged by it. Returns whether anything changed.
 */
export function mergeDoc(into: Doc, from: Doc, mode: "merge" | "replace", keys: ListKeys = {}, path = ""): boolean {
	let changed = false;
	for (const [k, theirs] of Object.entries(from)) {
		const at = path ? `${path}.${k}` : k;
		if (!(k in into)) {
			into[k] = structuredClone(theirs);
			changed = true;
			continue;
		}
		const mine = into[k];
		if (isRecord(mine) && isRecord(theirs)) {
			if (mergeDoc(mine, theirs, mode, keys, at)) changed = true;
		} else if (Array.isArray(mine) && Array.isArray(theirs) && keys[at]) {
			const id = keys[at];
			for (const item of theirs) {
				const found = mine.findIndex((x) => isRecord(x) && isRecord(item) && x[id] === item[id]);
				if (found < 0) {
					mine.push(structuredClone(item));
					changed = true;
				} else if (mode === "replace" && JSON.stringify(mine[found]) !== JSON.stringify(item)) {
					mine[found] = structuredClone(item);
					changed = true;
				}
			}
		} else if (mode === "replace" && JSON.stringify(mine) !== JSON.stringify(theirs)) {
			into[k] = structuredClone(theirs);
			changed = true;
		}
	}
	return changed;
}

/** A list of strings, `from`'s items added after `into`'s (an item in both once). */
export function unionList(into: unknown, from: unknown): string[] {
	const out = Array.isArray(into) ? into.filter((x): x is string => typeof x === "string") : [];
	const have = new Set(out);
	if (Array.isArray(from)) {
		for (const x of from) {
			if (typeof x === "string" && !have.has(x)) {
				have.add(x);
				out.push(x);
			}
		}
	}
	return out;
}

/** How a file already on this Mac compares with the same one made from the archive. */
export interface Comparison {
	/** The same bytes. */
	same: boolean;
	/** The file here is the start of the other, which goes on from it (a conversation that was continued). */
	extends: boolean;
}

/** Compare two files by reading them side by side. */
export async function compareFiles(here: string, there: string): Promise<Comparison> {
	const a = await open(here, "r");
	try {
		const b = await open(there, "r");
		try {
			const sizeA = (await a.stat()).size;
			const sizeB = (await b.stat()).size;
			if (sizeA > sizeB) return { same: false, extends: false };
			const bufA = Buffer.allocUnsafe(1024 * 1024);
			const bufB = Buffer.allocUnsafe(1024 * 1024);
			let position = 0;
			while (position < sizeA) {
				const want = Math.min(bufA.length, sizeA - position);
				const ra = await a.read(bufA, 0, want, position);
				const rb = await b.read(bufB, 0, want, position);
				if (
					ra.bytesRead !== rb.bytesRead ||
					ra.bytesRead === 0 ||
					bufA.compare(bufB, 0, ra.bytesRead, 0, ra.bytesRead) !== 0
				)
					return { same: false, extends: false };
				position += ra.bytesRead;
			}
			return { same: sizeA === sizeB, extends: sizeB > sizeA };
		} finally {
			await b.close();
		}
	} finally {
		await a.close();
	}
}
