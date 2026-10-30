import type { SessionEntry } from "@shared/protocol.ts";
import { extension } from "./lineage.ts";
import { type AgentMessage, blocks, isVisible, messageOf } from "./messages.ts";
import { type LiveNotice, LiveRows, noticeOf } from "./notices.ts";
import { siblingsOf, type TreeIndex } from "./tree.ts";

/** One agent turn: every row between two user prompts, with its assistant steps. */
export interface AgentTurn {
	rows: SessionEntry[];
	entries: SessionEntry[];
	messages: AgentMessage[];
	siblings?: { list: SessionEntry[]; index: number };
	/** The tool calls the turn's messages make (grows with the turn: the one set serves every version of it). */
	toolIds: Set<string>;
}

export type Segment = { kind: "prompt"; entry: SessionEntry } | { kind: "turn"; turn: AgentTurn };

/** Rows the user produced directly: `!command` / `$code` executions sent over RPC (agent tools are tool calls). */
const USER_EXEC: Record<string, true> = { bashExecution: true, pythonExecution: true };

/** What the user said to the agent. The agent's own reminders to itself (`attribution: "agent"`) are not prompts. */
export function isPrompt(m: AgentMessage): boolean {
	return (m.role === "user" || m.role === "developer") && m.attribution !== "agent";
}

/** A command the user ran themselves (`!command`, `$code`), not one of the agent's tool calls. */
export function isUserCommand(m: AgentMessage): boolean {
	return USER_EXEC[m.role] === true;
}

/**
 * Splits transcript rows into user prompts and agent turns. Agent-injected
 * user messages and notes stay inside the turn; a real user prompt — or a
 * command the user ran, or what a command printed — ends it and is shown on its own,
 * never folded into the collapsed steps of the previous turn, nor between the turn and its footer.
 */
export function segmentTranscript(rows: SessionEntry[], idx: TreeIndex): Segment[] {
	const out: Segment[] = [];
	let cur: AgentTurn | null = null;
	for (const e of rows) {
		const m = messageOf(e);
		if ((m && (isPrompt(m) || isUserCommand(m))) || noticeOf(e)?.kind === "command") {
			cur = null;
			out.push({ kind: "prompt", entry: e });
			continue;
		}
		if (!cur) {
			cur = { rows: [], entries: [], messages: [], toolIds: new Set() };
			out.push({ kind: "turn", turn: cur });
		}
		cur.rows.push(e);
		if (m?.role === "assistant") {
			cur.entries.push(e);
			cur.messages.push(m);
			for (const b of blocks(m)) if (b.type === "toolCall" && b.id) cur.toolIds.add(b.id);
		}
	}
	for (const s of out) {
		if (s.kind !== "turn" || !s.turn.entries.length) continue;
		const first = s.turn.entries[0];
		const sibs = siblingsOf(idx, first);
		if (sibs.length > 1) s.turn.siblings = { list: sibs, index: sibs.findIndex((x) => x.id === first.id) };
	}
	return out;
}

/** Whether two rows are the same row: the same entry, or the same notice shown live (those are made anew for each list). */
function sameRowOf(a: SessionEntry, b: SessionEntry): boolean {
	return a === b || (a.type === "live_notice" && b.type === "live_notice" && a.id === b.id && a.notice === b.notice);
}

function sameSiblings(a: AgentTurn["siblings"], b: AgentTurn["siblings"]): boolean {
	if (!a || !b) return a === b;
	return a.index === b.index && a.list.length === b.list.length && a.list.every((e, i) => e === b.list[i]);
}

function sameSegment(a: Segment, b: Segment): boolean {
	if (a.kind === "prompt") return b.kind === "prompt" && a.entry === b.entry;
	if (b.kind !== "turn" || a.turn.rows.length !== b.turn.rows.length) return false;
	return a.turn.rows.every((e, i) => sameRowOf(e, b.turn.rows[i])) && sameSiblings(a.turn.siblings, b.turn.siblings);
}

/** What a segment is told apart by: its first row. */
export function segmentKey(s: Segment): string {
	return s.kind === "prompt" ? s.entry.id : s.turn.rows[0].id;
}

/**
 * `next` with every segment that did not change replaced by the one `previous` had: a turn of the same rows is the
 * same object, so what is drawn from it can tell that nothing happened to it. The list is split anew whenever an entry
 * is added, and without this every turn on screen would be a new one each time.
 */
export function shareSegments(previous: Segment[], next: Segment[]): Segment[] {
	if (!previous.length) return next;
	const before = new Map(previous.map((s) => [segmentKey(s), s]));
	return next.map((s) => {
		const old = before.get(segmentKey(s));
		return old && sameSegment(old, s) ? old : s;
	});
}

/**
 * The transcript's segments of a path with live notices, kept as the path grows: the rows added go on after the last
 * segment (a prompt starts one, anything else joins the turn that is open or starts one), and only the last turn is a new
 * object. What the segments were made from is read from where the last call stopped, so what an added entry costs does
 * not depend on how many there already are. A path that is not the last one grown (another branch, another tree, a
 * notice that came or went) is split from the start, as `segmentTranscript` does.
 *
 * `keys` and `positions` (each segment's name, and where each is) are kept for the latest segments; read them in the
 * render that asked for them.
 *
 * A segment's name is its first row's id, and stays it when more of the segment comes in above: a conversation's history is
 * brought in a page at a time from its end, and a turn that runs longer than a page is cut by one, so the page above joins
 * it at its head. It is the same turn, longer, so it keeps the name (and with it the place of what was shown from it, the
 * pages it was cut into, and the element that draws it).
 */
export class Segmenter {
	segments: Segment[] = [];
	keys: string[] = [];
	positions = new Map<string, number>();
	private readonly liveRows = new LiveRows();
	private rows: SessionEntry[] | null = null;
	private byId: unknown = null;

	update(path: SessionEntry[], idx: TreeIndex, notices: LiveNotice[], streamed: string[]): Segment[] {
		const rows = this.liveRows.rows(path, notices, streamed);
		const from = this.byId === idx.byId ? extension(this.rows, rows) : null;
		if (from === null) return this.rebuild(rows, idx);
		if (from === rows.length) return this.segments;
		const segments = this.segments.slice();
		// The turn being added to: the open one (the last segment, when it is a turn) as a new version, or a new one.
		let working: AgentTurn | null = null;
		for (let i = from; i < rows.length; i++) {
			const e = rows[i];
			if (!isVisible(e)) continue;
			const m = messageOf(e);
			if ((m && (isPrompt(m) || isUserCommand(m))) || noticeOf(e)?.kind === "command") {
				working = null;
				segments.push({ kind: "prompt", entry: e });
				this.key(e.id, segments.length - 1);
				continue;
			}
			if (!working) {
				const last = segments.at(-1);
				if (last?.kind === "turn") {
					const t = last.turn;
					working = {
						rows: [...t.rows],
						entries: [...t.entries],
						messages: [...t.messages],
						siblings: t.siblings,
						toolIds: t.toolIds,
					};
					segments[segments.length - 1] = { kind: "turn", turn: working };
				} else {
					working = { rows: [], entries: [], messages: [], toolIds: new Set() };
					segments.push({ kind: "turn", turn: working });
					this.key(e.id, segments.length - 1);
				}
			}
			working.rows.push(e);
			if (m?.role === "assistant") {
				working.entries.push(e);
				working.messages.push(m);
				for (const b of blocks(m)) if (b.type === "toolCall" && b.id) working.toolIds.add(b.id);
				if (working.entries.length === 1) {
					const sibs = siblingsOf(idx, e);
					if (sibs.length > 1) working.siblings = { list: sibs, index: sibs.findIndex((x) => x.id === e.id) };
				}
			}
		}
		this.rows = rows;
		this.segments = segments;
		return segments;
	}

	private key(key: string, at: number): void {
		this.keys[at] = key;
		this.positions.set(key, at);
	}

	/** The names kept for turns that were joined at their head: the id of the first row they have now, and the name they had. */
	private renamed = new Map<string, string>();

	private rebuild(rows: SessionEntry[], idx: TreeIndex): Segment[] {
		const before = this.segments[0];
		const firstRow = before ? segmentKey(before) : null;
		const firstName = this.keys[0];
		this.segments = shareSegments(this.segments, segmentTranscript(rows.filter(isVisible), idx));
		const own = this.segments.map(segmentKey);
		const present = new Set(own);
		const renamed = new Map<string, string>();
		for (const [row, name] of this.renamed) if (present.has(row)) renamed.set(row, name);
		// The first segment's first row is inside another segment now: rows came in above it, into the same turn.
		if (firstRow !== null && firstName !== undefined && !present.has(firstRow)) {
			const joined = this.segments.findIndex((s) => s.kind === "turn" && s.turn.rows.some((r) => r.id === firstRow));
			if (joined >= 0) renamed.set(own[joined] as string, firstName);
		}
		this.renamed = renamed;
		this.keys = own.map((k) => renamed.get(k) ?? k);
		this.positions = new Map(this.keys.map((k, i): [string, number] => [k, i]));
		this.rows = rows;
		this.byId = idx.byId;
		return this.segments;
	}
}
