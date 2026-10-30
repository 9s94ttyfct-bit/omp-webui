import type { Job } from "./family.ts";
import { parseLine, withTitleSlot } from "./sessions/parse.ts";

/**
 * The JSON of a family's files, as the pieces `family-worker.ts` writes to its gzip stream.
 *
 * A piece is at most about `PIECE_CHARS` (a file's entries are cut into batches of that size), and nothing in this file
 * holds more than one batch of what it makes: a conversation of tens of MB is read as one text (a file is read once, so
 * a rewrite during the read cannot splice two versions of it) and goes out as a few hundred pieces that are each
 * written and let go of. A file's entries were once collected, joined into one string, put into one more string with
 * the rest of the file's document and handed to zlib in one piece: four copies of the file's JSON next to its text, all
 * of it in the worker at once, and the server's resident memory stays where that peak put it for a while.
 *
 * What a family holds while it is read is, besides that batch, the text of the file being read and the ids of the entries
 * of the files before it (`seen`: strings of their own, not pieces of those files' text). The text of a file read before is
 * garbage, and JavaScriptCore collects it when it decides to, not when the next file is read: a family of several long
 * files can have more than one text in memory at once (two kept 17 MB files and a 6 MB fork: 44 MB over idle at the end of
 * reading, against 24 for the fork alone, before a collection).
 */

/**
 * The type and the id of an entry from the start of its line, when the line starts as omp writes one
 * (`{"type":…,"id":…`): no parsing needed. The header (`type: "session"`) and the title slot (`type: "title"`) are
 * never entries of a family, and are never matched here.
 *
 * Written out and not a regular expression (`/^\{"type":"([^"\\]*)","id":"([^"\\]*)"/` was): JavaScriptCore keeps the last
 * successful match of every regular expression of a thread, its input among it, and a line is a piece of the file's text
 * that shares the text's memory. The worker, idle between jobs, held the whole text of the last conversation it built
 * (tens of MB) for as long as no other regular expression matched in it.
 */
const TYPE_OPEN = '{"type":"';
const ID_OPEN = '","id":"';

/** The index of the first `"` or `\` of `text` from `from` on, or its end: where a run of plain characters stops. */
function plainEnd(text: string, from: number): number {
	let i = from;
	while (i < text.length) {
		const c = text.charCodeAt(i);
		if (c === 34 || c === 92) break;
		i++;
	}
	return i;
}

export function entryStart(line: string): { type: string; id: string } | null {
	if (!line.startsWith(TYPE_OPEN)) return null;
	const typeEnd = plainEnd(line, TYPE_OPEN.length);
	if (!line.startsWith(ID_OPEN, typeEnd)) return null;
	const idAt = typeEnd + ID_OPEN.length;
	const idEnd = plainEnd(line, idAt);
	// The id is closed: a line cut off in it (omp was still writing) has none.
	if (line.charCodeAt(idEnd) !== 34) return null;
	return { type: line.slice(TYPE_OPEN.length, typeEnd), id: line.slice(idAt, idEnd) };
}

/**
 * The most characters of entries put into one piece. Large enough that the gzip stream is fed few and long pieces
 * (each one a call and a wait), small enough that a piece and what it was made of are young garbage by the time the next
 * is made.
 */
export const PIECE_CHARS = 256 * 1024;

/**
 * `id` as a string of its own. A piece of a line is a piece of the file's text: JavaScriptCore shares the memory of a
 * substring longer than a few characters (more than 8 Latin-1 ones) instead of copying it, so an id longer than that, held
 * in `seen`, would keep the whole text of its file alive for as long as `seen` is. (An id read by `entryStart` comes from
 * decoded text, which has no lone surrogate: the copy loses nothing.)
 */
const own = (id: string): string => Buffer.from(id).toString();

/**
 * The ids of the entries of a file the client holds, added to `seen`: a file after it that has them gets them from the
 * client, as it would from the file's own part of the document. Nothing is parsed that does not have to be.
 */
export function rememberIds(text: string, seen: Set<string>): void {
	for (let from = 0; from < text.length; ) {
		let to = text.indexOf("\n", from);
		if (to < 0) to = text.length;
		const line = text.slice(from, to);
		from = to + 1;
		const start = entryStart(line);
		if (start) {
			if (start.type !== "session" && start.type !== "title") seen.add(own(start.id));
			continue;
		}
		const obj = parseLine(line);
		if (obj && obj.type !== "session" && obj.type !== "title" && typeof obj.id === "string") seen.add(obj.id);
	}
}

/**
 * `items` as the inside of a JSON array, in pieces of about `PIECE_CHARS`: the first piece starts the list, every other
 * starts with the comma that follows what came before.
 */
function* listPieces(items: Iterable<string>): Generator<string> {
	let batch: string[] = [];
	let chars = 0;
	let first = true;
	for (const item of items) {
		batch.push(item);
		chars += item.length + 1;
		if (chars < PIECE_CHARS) continue;
		yield first ? batch.join(",") : `,${batch.join(",")}`;
		first = false;
		batch = [];
		chars = 0;
	}
	if (batch.length > 0) yield first ? batch.join(",") : `,${batch.join(",")}`;
}

/**
 * One file of the family as JSON, piece by piece: the entries of the file that no file before it has, and the id of
 * every entry of the file, in the file's order (`order`), when the file holds one that was sent already.
 *
 * The entries come first and the header after them: the header is whatever `session` line and `title` slot the file has
 * (the first of each, wherever they are), which is known only when the file has been read, and the entries are not held
 * until then.
 */
export function* memberPieces(
	file: string,
	text: string,
	seen: Set<string> | null,
	member: Job["members"][number],
	tag: string | null,
): Generator<string> {
	let header: Record<string, unknown> | null = null;
	let titleSlot: Record<string, unknown> | null = null;
	const order: string[] = [];
	let cut = false;
	/** The entries this file sends, each serialized as it is read. */
	function* entries(): Generator<string> {
		for (let from = 0; from < text.length; ) {
			let to = text.indexOf("\n", from);
			if (to < 0) to = text.length;
			const line = text.slice(from, to);
			from = to + 1;
			// An entry that was sent already: the same entry, with the same id, in the same file. It is not parsed again.
			const start = seen ? entryStart(line) : null;
			const known = start && start.type !== "session" && start.type !== "title" ? start.id : undefined;
			if (known !== undefined && seen?.has(known)) {
				order.push(known);
				cut = true;
				continue;
			}
			const obj = parseLine(line);
			if (!obj) continue;
			if (obj.type === "title" && !header) {
				titleSlot = obj;
				continue;
			}
			if (obj.type === "session" && !header) {
				header = obj;
				continue;
			}
			if (typeof obj.id !== "string") continue;
			if (!seen) {
				yield JSON.stringify(obj);
				continue;
			}
			order.push(obj.id);
			if (seen.has(obj.id)) cut = true;
			else {
				seen.add(obj.id);
				yield JSON.stringify(obj);
			}
		}
	}
	yield `{"file":${JSON.stringify(file)},"entries":[`;
	yield* listPieces(entries());
	yield `],"header":${JSON.stringify(withTitleSlot(header, titleSlot))}`;
	if (cut) {
		yield `,"order":[`;
		yield* listPieces(order.map((id) => JSON.stringify(id)));
		yield "]";
	}
	yield `,"subagents":${JSON.stringify(member.subagents)},"advisors":${JSON.stringify(member.advisors)}${tag === null ? "" : `,"tag":${JSON.stringify(tag)}`}}`;
}
