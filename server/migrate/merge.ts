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
