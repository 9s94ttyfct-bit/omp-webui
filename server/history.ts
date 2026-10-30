import { closeSync, openSync } from "node:fs";
import { isRecord } from "../shared/guards.ts";
import { PATH_ABOVE_PROMPTS } from "../shared/protocol.ts";
import type { FamilyMember } from "./family.ts";
import { Attr, changedSince, type FileIndex, IndexCache, parseObject, Role, readEntries } from "./history-index.ts";
import { MIN_WINDOW_ENTRIES, ViewError, type ViewRequest, WINDOW_BYTES, WINDOW_ENTRIES } from "./history-request.ts";
import { statsOf } from "./history-stats.ts";

/**
 * `/api/family?view=…`: a window of the history of one conversation file, instead of the file whole. A conversation of
 * tens of MB, thousands of entries, opens on its last two hundred and loads earlier ones as they are scrolled to.
 *
 * A window is a stretch of one path of the file's tree (the ancestors of an entry by `parentId`: a file that holds
 * branches holds several paths), oldest first. It is cut where a page can show it: it begins at a prompt (the user's, or a
 * command the user ran) and, when more follows, ends before the next one, so that a turn is never split and a tool call is
 * never apart from its result. A turn longer than a few windows is cut before an assistant message instead, which is
 * as good: the calls of an assistant message are answered before the next one.
 *
 * The entries are not parsed and written again: the index (`history-index.ts`) knows where each one's line is, and the
 * lines of the window are read from the file and spliced into the answer as omp wrote them (each is parsed once, to be sure
 * it is valid JSON: the whole file's answer leaves a malformed line out, and so does this). What the page derives from the
 * whole path — the goal, the model it resumes with, the history Up walks through — comes from the path above the window
 * (`above`), and the other versions of its entries from every file of the family (`versions`).
 */

/** How far back a window looks for the prompt it begins at, or forward for the one it ends before: entries, and bytes. */
const EXTEND_ENTRIES = WINDOW_ENTRIES;
const EXTEND_BYTES = 3 * WINDOW_BYTES;
/** `above` looks at this many message lines for the prompts, and this many for the assistant message that tells the model. */
const PROMPT_LINES = 4000;
const ASSISTANT_LINES = 2000;
/** The last prompt of a file (for a list of the family) is looked for in this many of its last message lines. */
const LAST_PROMPT_LINES = 2000;
/** The text of a prompt a list of the family shows. */
const LAST_PROMPT_CHARS = 400;
/** The most versions of one entry listed, and the most entries of a window that have some. */
const MAX_VERSIONS = 50;
const MAX_GROUPS = 500;

/** A file read from was not what the index says: it was rewritten while the job ran. */
class Stale extends Error {
	constructor(readonly file: string) {
		super(`${file} changed while it was read`);
	}
}

const J = JSON.stringify;

/** The lines of entries read for one job, each read once, and the files they are read from. */
class Reader {
	private readonly fds = new Map<string, number>();
	private readonly memo = new Map<FileIndex, Map<number, string>>();

	/** `lenient`: a line that is not as the index says is left out, whatever the file did (the retry of a job that saw one). */
	constructor(private readonly lenient: boolean) {}

	private fd(index: FileIndex): number {
		let fd = this.fds.get(index.file);
		if (fd === undefined) {
			fd = openSync(index.file, "r");
			this.fds.set(index.file, fd);
		}
		return fd;
	}

	/**
	 * Read the lines of these entries that are not read yet, together, in file order: the order of a path is not the file's when a
	 * parent is written after its child (a file that something other than omp wrote), and `readEntries` needs them ascending.
	 */
	load(index: FileIndex, idxs: readonly number[]): void {
		let memo = this.memo.get(index);
		if (!memo) {
			memo = new Map();
			this.memo.set(index, memo);
		}
		const todo = idxs.filter((i) => !memo.has(i)).sort((a, b) => a - b);
		if (!todo.length) return;
		const texts = readEntries(this.fd(index), index, todo);
		for (let k = 0; k < todo.length; k++) memo.set(todo[k] as number, texts[k] as string);
	}

	text(index: FileIndex, i: number): string {
		this.load(index, [i]);
		return (this.memo.get(index) as Map<number, string>).get(i) as string;
	}

	/**
	 * The line of entry `i` as written when it is valid JSON of that entry. Null for a line that is not (it is left out, as the
	 * whole file's answer leaves it out); a file that has changed since the index was made is `Stale` instead.
	 */
	valid(index: FileIndex, i: number): string | null {
		const text = this.text(index, i);
		const obj = parseObject(text);
		if (obj && obj.id === index.ids[i]) return text;
		if (!this.lenient && changedSince(index)) throw new Stale(index.file);
		return null;
	}

	/** The object of the message entry `i`, and what it says of the entry's role kept in the index; null for a line that is not JSON. */
	message(index: FileIndex, i: number): Record<string, unknown> | null {
		const obj = parseObject(this.text(index, i));
		if (obj) index.learn(i, obj);
		else index.roles[i] = Role.OTHER;
		return obj;
	}

	close(): void {
		for (const fd of this.fds.values()) closeSync(fd);
		this.fds.clear();
	}
}

/** What a window is allowed to hold. */
interface Budget {
	entries: number;
	bytes: number;
	min: number;
}

function budgetOf(limit: number | undefined): Budget {
	const entries = Math.min(limit ?? WINDOW_ENTRIES, WINDOW_ENTRIES);
	return {
		entries,
		bytes: Math.floor((WINDOW_BYTES * entries) / WINDOW_ENTRIES),
		min: Math.min(MIN_WINDOW_ENTRIES, entries),
	};
}

/** The tree of one file: walks a path up and down, and tells what kind of entry each is. */
class Path {
	constructor(
		readonly index: FileIndex,
		readonly reader: Reader,
	) {}

	/** A prompt of the user or a command they ran: where a turn begins. */
	turnStart(i: number): boolean {
		const { roles, attrs } = this.index;
		if (roles[i] === Role.UNKNOWN) this.reader.message(this.index, i);
		if (roles[i] === Role.BASH || roles[i] === Role.PYTHON) return true;
		if (roles[i] !== Role.USER && roles[i] !== Role.DEVELOPER) return false;
		if (attrs[i] === Attr.UNCHECKED) this.reader.message(this.index, i);
		return attrs[i] === Attr.NOT_AGENT && (roles[i] === Role.USER || roles[i] === Role.DEVELOPER);
	}

	assistant(i: number): boolean {
		if (this.index.roles[i] === Role.UNKNOWN) this.reader.message(this.index, i);
		return this.index.roles[i] === Role.ASSISTANT;
	}

	/** The entries from `from` up to the root, newest first, as many as the budget holds. */
	up(from: number, budget: Budget): number[] {
		const out: number[] = [];
		let bytes = 0;
		for (let i = from; i >= 0 && out.length <= this.index.length; i = this.index.parentOf(i)) {
			const len = this.index.lens[i] as number;
			if (out.length >= budget.min && (out.length >= budget.entries || bytes + len > budget.bytes)) break;
			out.push(i);
			bytes += len;
		}
		return out;
	}

	/** The entries below `at`, down to `leaf` (oldest first); null when `at` is not above `leaf`. */
	below(at: number, leaf: number): number[] | null {
		const chain: number[] = [];
		for (let i = leaf; i >= 0 && chain.length <= this.index.length; i = this.index.parentOf(i)) {
			if (i === at) return chain.reverse();
			chain.push(i);
		}
		return null;
	}

	/**
	 * `up` (newest first) made to begin at a turn: the window goes further back to the prompt its oldest entry belongs to, when
	 * there is one within reach (or to the root of the path: nothing is split there). When a turn is longer than that, the
	 * window begins at its oldest assistant message instead.
	 */
	alignStart(up: number[]): void {
		const first = up.at(-1);
		if (first === undefined || this.turnStart(first)) return;
		const more: number[] = [];
		let bytes = 0;
		for (let i = this.index.parentOf(first); ; i = this.index.parentOf(i)) {
			if (i < 0) {
				up.push(...more);
				return;
			}
			more.push(i);
			if (this.turnStart(i)) {
				up.push(...more);
				return;
			}
			bytes += this.index.lens[i] as number;
			if (more.length >= EXTEND_ENTRIES || bytes >= EXTEND_BYTES) break;
		}
		for (let k = up.length - 1; k >= 0; k--) {
			if (this.assistant(up[k] as number)) {
				up.length = k + 1;
				return;
			}
		}
	}

	/**
	 * Where the window `down[0, taken)` ends: before a prompt when there is one within reach further on (`down` is the path
	 * below the start of the window), or at the end of the path; else before the nearest assistant message of the window.
	 */
	alignEnd(down: number[], taken: number): number {
		if (taken >= down.length || this.turnStart(down[taken] as number)) return Math.min(taken, down.length);
		let bytes = this.index.lens[down[taken] as number] as number;
		for (let m = taken + 1; ; m++) {
			if (m >= down.length) return down.length;
			if (this.turnStart(down[m] as number)) return m;
			if (m - taken >= EXTEND_ENTRIES || bytes >= EXTEND_BYTES) break;
			bytes += this.index.lens[down[m] as number] as number;
		}
		for (let j = taken; j > 0; j--) if (this.assistant(down[j] as number)) return j;
		return taken;
	}

	/** How many of `down` (oldest first) the budget holds. */
	take(down: number[], budget: Budget): number {
		let bytes = 0;
		let k = 0;
		for (; k < down.length; k++) {
			const len = this.index.lens[down[k] as number] as number;
			if (k >= budget.min && (k >= budget.entries || bytes + len > budget.bytes)) break;
			bytes += len;
		}
		return k;
	}
}

/** The stretch of a file's path a view asks for. */
interface Stretch {
	/** Oldest first; each entry is the parent of the next. */
	entries: number[];
	/** The entry the path leads to (-1: the file has no entries), and whether the stretch stops short of it. */
	leaf: number;
	later: boolean;
}

function entryOf(index: FileIndex, id: string | undefined, what: string): number | undefined {
	if (id === undefined) return undefined;
	const i = index.byId.get(id);
	if (i === undefined) throw new ViewError(`${what} "${id}" is not an entry of ${index.file}`, "unknown_entry");
	return i;
}

function select(view: ViewRequest, path: Path): Stretch {
	const { index } = path;
	const head = index.length - 1;
	const budget = budgetOf(view.limit);
	const at = entryOf(index, view.at, "The entry");
	const asked = entryOf(index, view.leaf, "The leaf");
	if (head < 0) return { entries: [], leaf: -1, later: false };
	switch (view.kind) {
		case "tail": {
			const leaf = asked ?? head;
			const up = path.up(leaf, budget);
			path.alignStart(up);
			return { entries: up.reverse(), leaf, later: false };
		}
		case "before": {
			const leaf = asked ?? head;
			const end = index.parentOf(at as number);
			if (end < 0) return { entries: [], leaf, later: false };
			const up = path.up(end, budget);
			path.alignStart(up);
			return { entries: up.reverse(), leaf, later: true };
		}
		case "after": {
			const leaf = asked ?? head;
			const down = path.below(at as number, leaf);
			if (!down?.length) return { entries: [], leaf, later: false };
			const end = path.alignEnd(down, path.take(down, budget));
			return { entries: down.slice(0, end), leaf, later: end < down.length };
		}
		case "around": {
			const from = at as number;
			// The path goes to the leaf asked for when the entry is above it, else to the file's last entry when the entry is on the
			// way to it, else to the newest entry under the entry.
			let leaf = asked ?? head;
			let chain = path.below(from, leaf);
			if (!chain) {
				leaf = head;
				chain = path.below(from, head);
			}
			if (!chain) {
				leaf = index.newestUnder()[from] as number;
				chain = path.below(from, leaf) ?? [];
			}
			// A quarter of the budget goes above the entry, the rest to it and below.
			const aboveEntries = Math.floor(budget.entries / 4);
			const aboveBytes = Math.floor(budget.bytes / 4);
			const minAbove = Math.floor(budget.min / 4);
			const upBudget: Budget = { entries: aboveEntries, bytes: aboveBytes, min: minAbove };
			const downBudget: Budget = {
				entries: budget.entries - aboveEntries,
				bytes: budget.bytes - aboveBytes,
				min: Math.max(1, budget.min - minAbove),
			};
			const down = [from, ...chain];
			const end = path.alignEnd(down, path.take(down, downBudget));
			const up = [from, ...path.up(index.parentOf(from), upBudget)];
			path.alignStart(up);
			return { entries: up.reverse().concat(down.slice(1, end)), leaf, later: end < down.length };
		}
		default:
			throw new Error(`No stretch of the path for the ${view.kind} view`);
	}
}

// ------------------------------------------------------------------ what the path above leaves

/** A message's text as the page reads it (`textOf` in `web/src/lib/messages.ts`): its text blocks and its narration. */
function textOf(message: Record<string, unknown>): string {
	const { content } = message;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === "text") parts.push(typeof block.text === "string" ? block.text : "");
		else if (block.type === "thinking" && block.narration === true)
			parts.push(typeof block.thinking === "string" ? block.thinking : "");
	}
	return parts.join("\n");
}

/**
 * What the page derives from the whole path, from the part of it above the window that begins at `first`: the last mode,
 * thinking level and default model it was set to (and the model of the last assistant message when none was), and the prompts
 * (see `PathAbove`).
 */
function above(path: Path, first: number | undefined): string {
	if (first === undefined) return `{"carry":[],"prompts":[]}`;
	const { carry, prompts } = pathCarry(path, path.index.parentOf(first), true);
	return `{"carry":${carry},"prompts":${J(prompts)}}`;
}

/**
 * What the whole path to the leaf leaves, as `above` does for the part above a window (`FamilyView.end`): for a page that holds
 * a window that stops short of the leaf, and reads the model, the thinking level and the goal from what the path ends with.
 */
function endOf(path: Path, leaf: number): string {
	if (leaf < 0) return `{"carry":[]}`;
	return `{"carry":${pathCarry(path, leaf, false).carry}}`;
}

/**
 * The carry (as the JSON of the entries, oldest first) of the path from `from` (the entry itself included) up to the root, and,
 * when `withPrompts`, the prompts on it, oldest first.
 */
function pathCarry(path: Path, from: number, withPrompts: boolean): { carry: string; prompts: string[] } {
	const { index, reader } = path;
	let mode = -1;
	let thinking = -1;
	let model = -1;
	let stub = -1;
	let stubText = "";
	let looked = 0;
	/** Newest first, until reversed. */
	const prompts: string[] = [];
	const promptsDone = () => !withPrompts || prompts.length >= PATH_ABOVE_PROMPTS || looked > PROMPT_LINES;
	for (let i = from, steps = 0; i >= 0 && steps <= index.length; i = index.parentOf(i), steps++) {
		const type = index.types[i];
		if (type === "message") {
			looked++;
			const role = index.roles[i];
			const wantsPrompt =
				!promptsDone() &&
				(role === Role.UNKNOWN || role === Role.BASH || (role === Role.USER && index.attrs[i] !== Attr.AGENT));
			const wantsStub =
				stub < 0 && model < 0 && looked <= ASSISTANT_LINES && (role === Role.UNKNOWN || role === Role.ASSISTANT);
			const m = wantsPrompt || wantsStub ? reader.message(index, i)?.message : undefined;
			if (!isRecord(m)) continue;
			if (wantsStub && m.role === "assistant" && typeof m.provider === "string" && typeof m.model === "string") {
				if (m.provider && m.model) {
					stub = i;
					stubText = J({
						type: "message",
						id: index.ids[i],
						parentId: index.parents[i],
						timestamp: index.stamps[i],
						message: { role: "assistant", provider: m.provider, model: m.model },
					});
				}
			}
			if (wantsPrompt) {
				let sent = "";
				if (m.role === "user" && m.attribution !== "agent") sent = textOf(m).trim();
				else if (m.role === "bashExecution" && m.command) sent = `!${String(m.command)}`;
				if (sent && sent !== prompts.at(-1)) prompts.push(sent);
			}
		} else if (type === "mode_change") {
			if (mode < 0 && reader.valid(index, i) !== null) mode = i;
		} else if (type === "thinking_level_change") {
			if (thinking < 0 && reader.valid(index, i) !== null) thinking = i;
		} else if (type === "model_change" && model < 0) {
			const text = reader.valid(index, i);
			const obj = text === null ? null : parseObject(text);
			if (obj && (obj.role === undefined || obj.role === "default") && typeof obj.model === "string" && obj.model)
				model = i;
		}
		if (mode >= 0 && thinking >= 0 && model >= 0 && promptsDone()) break;
	}
	const carry: [number, string][] = [];
	if (mode >= 0) carry.push([mode, reader.text(index, mode)]);
	if (thinking >= 0) carry.push([thinking, reader.text(index, thinking)]);
	if (model >= 0) carry.push([model, reader.text(index, model)]);
	else if (stub >= 0) carry.push([stub, stubText]);
	carry.sort((a, b) => a[0] - b[0]);
	return { carry: `[${carry.map((c) => c[1]).join(",")}]`, prompts: prompts.reverse() };
}

// ------------------------------------------------------------------ the other versions of the window's entries

/** The groups of entries that share a parent with an entry of the window, over every file of the family. */
function versions(viewed: FileIndex, family: FileIndex[], reader: Reader, window: number[]): string[] {
	const groups: string[] = [];
	const inWindow = new Set(window.map((i) => viewed.ids[i] as string));
	for (const i of window) {
		if (groups.length >= MAX_GROUPS) break;
		const parent = viewed.parents[i] as string | null;
		const own = viewed.ids[i] as string;
		/** The distinct children of the parent, in the order the family wrote them. */
		const children = new Map<string, { file: FileIndex; at: number }>();
		for (const file of family) {
			for (const c of file.children().get(parent) ?? []) {
				const id = file.ids[c] as string;
				if (!children.has(id)) children.set(id, { file, at: c });
			}
		}
		if (children.size < 2) continue;
		let ids = [...children.keys()];
		if (ids.length > MAX_VERSIONS) {
			ids = ids.slice(0, MAX_VERSIONS);
			if (!ids.includes(own)) ids[MAX_VERSIONS - 1] = own;
		}
		const others: string[] = [];
		for (const id of ids) {
			if (inWindow.has(id)) continue;
			const from = children.get(id) as { file: FileIndex; at: number };
			const text = reader.valid(from.file, from.at);
			if (text !== null) others.push(text);
		}
		const leads = ids.map((id) => `${J(id)}:${lead(family, id)}`);
		groups.push(`{"parent":${J(parent)},"entries":[${others.join(",")}],"leads":{${leads.join(",")}}}`);
	}
	return groups;
}

/** Where the entry `id` leads in the family: the newest entry under it (of equal timestamps, the one written last), and the files that hold that. */
function lead(family: FileIndex[], id: string): string {
	let best: { file: FileIndex; at: number } | null = null;
	for (const file of family) {
		const at = file.byId.get(id);
		if (at === undefined) continue;
		const newest = file.newestUnder()[at] as number;
		if (!best || (file.stamps[newest] as string) >= (best.file.stamps[best.at] as string)) best = { file, at: newest };
	}
	if (!best) return `{"leaf":${J(id)},"files":[]}`;
	const leaf = best.file.ids[best.at] as string;
	return J({ leaf, files: family.filter((f) => f.byId.has(leaf)).map((f) => f.file) });
}

// ------------------------------------------------------------------ what a list of the family shows of each file

/** The first text block of the file's last user message, as far back as it is easy to look: the text a list of the family shows. */
function lastPrompt(index: FileIndex, reader: Reader): string {
	if (index.lastPromptOf?.n === index.length) return index.lastPromptOf.text;
	let text = "";
	for (let i = index.length - 1, looked = 0; i >= 0 && looked < LAST_PROMPT_LINES; i--) {
		if (index.types[i] !== "message") continue;
		looked++;
		if (index.roles[i] === Role.UNKNOWN) reader.message(index, i);
		if (index.roles[i] !== Role.USER) continue;
		const m = reader.message(index, i)?.message;
		if (isRecord(m)) {
			const content = m.content;
			text = (typeof content === "string" ? content : Array.isArray(content) ? firstText(content) : "").slice(
				0,
				LAST_PROMPT_CHARS,
			);
			// Never end on half of a surrogate pair.
			const last = text.charCodeAt(text.length - 1);
			if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
		}
		break;
	}
	index.lastPromptOf = { n: index.length, text };
	return text;
}

function firstText(content: unknown[]): string {
	const block = content.find((b) => isRecord(b) && b.type === "text");
	return isRecord(block) && typeof block.text === "string" ? block.text : "";
}

// ------------------------------------------------------------------ the answer

/**
 * The indexes of this worker's jobs: kept between them, so a window of a file the worker has read is a few reads, for as long
 * as the worker lives (it stops a few seconds after its last job, `WORKER_IDLE_MS` in `family.ts`: the next window after that
 * indexes the file again, ~0.4 ms per MB).
 */
export const indexes = new IndexCache();

/**
 * The pieces of the JSON answer to a view request (`FamilyDocument` for a window, `FamilyStatsDocument` for `stats`), to be
 * written one after the other. `members` are the family in order; `file` is the one the view is of.
 * Throws `ViewError` when the request names an entry the file does not have.
 */
export function answerView(
	file: string,
	members: FamilyMember[],
	view: ViewRequest,
	cache: IndexCache = indexes,
): string[] {
	try {
		for (let attempt = 0; ; attempt++) {
			const reader = new Reader(attempt > 0);
			try {
				return build(file, members, view, cache, reader);
			} catch (e) {
				// A file that was rewritten while it was read: what was indexed is not what is there. Once more, from the file as it is.
				if (!(e instanceof Stale) || attempt > 0) throw e;
				cache.drop(e.file);
			} finally {
				reader.close();
			}
		}
	} finally {
		cache.trim();
	}
}

function build(file: string, members: FamilyMember[], view: ViewRequest, cache: IndexCache, reader: Reader): string[] {
	const viewedAt = members.findIndex((m) => m.file === file);
	if (viewedAt < 0) throw new Error(`${file} is not a member of its own family`);
	if (view.kind === "stats") return [`{"file":${J(file)},"stats":${J(statsOf(cache.get(file)))}}`];
	const family = members.map((m) => cache.get(m.file));
	const viewed = family[viewedAt] as FileIndex;
	const path = new Path(viewed, reader);
	const stretch = select(view, path);

	const lines: string[] = [];
	const kept: number[] = [];
	reader.load(viewed, stretch.entries);
	for (const i of stretch.entries) {
		const text = reader.valid(viewed, i);
		if (text === null) continue;
		lines.push(text);
		kept.push(i);
	}
	const first = kept[0];
	const last = kept.at(-1);
	const earlier = first !== undefined && viewed.parents[first] !== null && viewed.parentOf(first) >= 0;
	const later = last !== undefined && last !== stretch.leaf && stretch.later;
	const parts = [
		`"kind":${J(view.kind)}`,
		`"leaf":${J(stretch.leaf >= 0 ? viewed.ids[stretch.leaf] : null)}`,
		`"head":${J(viewed.head)}`,
		`"earlier":${earlier}`,
		`"later":${later}`,
	];
	if (view.kind !== "after") parts.push(`"above":${above(path, first)}`);
	if (view.kind === "tail" || view.kind === "around") {
		parts.push(`"end":${endOf(path, stretch.leaf)}`);
		if (stretch.leaf >= 0 && stretch.leaf !== viewed.length - 1)
			parts.push(`"headEnd":${endOf(path, viewed.length - 1)}`);
	}
	parts.push(`"versions":[${versions(viewed, family, reader, kept).join(",")}]`);

	const out = [`{"file":${J(file)},"members":[`];
	for (const [k, m] of members.entries()) {
		const index = family[k] as FileIndex;
		const own = m.file === file ? lines.join(",") : "";
		out.push(
			`${k ? "," : ""}{"file":${J(m.file)},"header":${index.header()},"entries":[${own}],"subagents":${J(m.subagents)},"advisors":${J(m.advisors)},"tag":${J(m.tag)},"head":${J(index.head)},"total":${index.length},"lastPrompt":${J(lastPrompt(index, reader))}}`,
		);
	}
	out.push(`],"view":{${parts.join(",")}}}`);
	return out;
}
