import { fuzzyMatch } from "@shared/fuzzy.ts";
import type { SessionSummary } from "@shared/protocol.ts";

/**
 * What the sidebar's search asks of the list: a fuzzy match on the conversation's name, the project and range filters
 * beside it, and the order the results come in (best match first, then the most recent).
 */

/** How far back the list reaches: today (since local midnight), the last 7 or 30 days, or everything. */
export type DateRange = "today" | "week" | "month" | "all";

export const DATE_RANGES: readonly DateRange[] = ["today", "week", "month", "all"];

export interface SessionFilters {
	/** What has been typed in the filter field; empty filters nothing out. */
	query: string;
	/** The folder of the project to list, or `all`. */
	project: string;
	range: DateRange;
	/** Whether archived conversations are the ones listed (the sidebar's archive view). */
	archived: boolean;
}

/** What the sidebar's list is drawn from once its search bar (a chunk of its own) has had its say. */
export interface SearchResults {
	/** The conversations to list, in the order to list them (best match first while searching). */
	sessions: SessionSummary[];
	/** Where the query matched each row's name, by file. */
	marks: ReadonlyMap<string, readonly number[]>;
	/** Whether a query is narrowing the list: the rows are then one ranked list, not date groups. */
	searching: boolean;
	/**
	 * The conversations found by what was said in them and not by their name (#717), best first: listed after every
	 * name match, in a group of their own.
	 */
	content: SessionSummary[];
	/** The message each of `content` matched in, by file: the row shows it and opens the conversation there. */
	hits: ReadonlyMap<string, ContentMatch>;
}

/** Where a conversation found by what was said in it matched: the message, and a line of it with the match marked. */
export interface ContentMatch {
	entryId: string;
	snippet: string;
}

/**
 * The content matches to list (#717): the server's hits (best first) of the conversations the sidebar's filters keep
 * (`scope`: archive view, project, date range), one per conversation, without those already listed by name.
 */
export function contentMatches(
	found: readonly (ContentMatch & { file: string })[],
	scope: readonly SessionSummary[],
	titled: ReadonlySet<string>,
): { sessions: SessionSummary[]; hits: Map<string, ContentMatch> } {
	const byFile = new Map(scope.map((s) => [s.file, s]));
	const sessions: SessionSummary[] = [];
	const hits = new Map<string, ContentMatch>();
	for (const h of found) {
		const s = byFile.get(h.file);
		if (!s || titled.has(h.file) || hits.has(h.file)) continue;
		sessions.push(s);
		hits.set(h.file, { entryId: h.entryId, snippet: h.snippet });
	}
	return { sessions, hits };
}

/**
 * A page of the server's content matches, asked for one conversation past `limit` (#717): the first `limit` of them,
 * and whether that one came back, which is whether there are more to ask for.
 */
export function pageOf<T>(hits: readonly T[], limit: number): { hits: T[]; more: boolean } {
	return { hits: hits.slice(0, limit), more: hits.length > limit };
}

export interface RankedSession {
	session: SessionSummary;
	/** 0 when nothing was typed: the list is then the server's own order (newest first). */
	score: number;
	/** Where the query matched the conversation's name, for the row to mark. Empty when the project matched instead. */
	positions: number[];
}

const DAY = 86_400_000;

/** When `range` begins, at or after `now`'s own local midnight for today; null for `all` (no lower bound). */
export function rangeStart(range: DateRange, now: number): number | null {
	if (range === "all") return null;
	if (range === "today") {
		const midnight = new Date(now);
		midnight.setHours(0, 0, 0, 0);
		return midnight.getTime();
	}
	return now - (range === "week" ? 7 : 30) * DAY;
}

/** The name a row is found by: its title, or the first prompt when it has no title yet (what the row shows). */
export function sessionName(s: SessionSummary): string {
	return s.title || s.preview || "";
}

/**
 * Where `query` stands in `text` as written (case aside), preferring the start of a word: the positions of its
 * characters, or null when the text does not contain it.
 */
function wholeAt(query: string, text: string): number[] | null {
	const q = query.toLowerCase();
	const t = text.toLowerCase();
	// Lowercasing that changes a string's length would put the marks in the wrong place: no whole match then.
	if (!q || /\s/.test(q) || t.length !== text.length) return null;
	let at = -1;
	for (let i = t.indexOf(q); i !== -1; i = t.indexOf(q, i + 1)) {
		if (at === -1) at = i;
		if (i === 0 || /[\s\-_/.,:;()[\]]/.test(t[i - 1])) {
			at = i;
			break;
		}
	}
	return at === -1 ? null : Array.from({ length: q.length }, (_, k) => at + k);
}

/**
 * The characters of `text` a person would see the query in: each word of it where `text` contains it as typed (see
 * `wholeAt`). A word that is found only as letters spread over the text ("rate" in "Draft the changelog") is not marked:
 * a scattering of single letters across a name reads as noise, not as the reason the row is there.
 */
function marked(query: string, text: string): number[] {
	const at = new Set<number>();
	for (const word of query.split(/\s+/)) for (const i of wholeAt(word, text) ?? []) at.add(i);
	return [...at].sort((a, b) => a - b);
}

/**
 * One conversation against a query: its name first, and the project's name after it (a person who types `ompw` means
 * either the conversation called that or the one in the folder called that). A name that matches ranks above a
 * project that matches, and only a name's characters are given back to be marked: the row shows the title.
 *
 * A name that contains the query as typed is marked there, and ranks above one that only has its letters in order; a
 * name that has only its letters in order still matches (a few letters of each word are a way to find it) and is not
 * marked at all: "rate" marked as scattered letters of "Draft migration" read as noise beside "Rate limit".
 */
export function matchSession(s: SessionSummary, query: string): { score: number; positions: number[] } | null {
	const text = sessionName(s);
	const name = fuzzyMatch(query, text);
	if (name) {
		const positions = marked(query, text);
		// A query of several words is not "as typed" in a name that has its words apart: no bonus.
		const whole = positions.length > 0 && !/\s/.test(query.trim());
		return { score: name.score * 2 + (whole ? WHOLE_BONUS : 0), positions };
	}
	// A project's name is worth less than a conversation's own: it narrows the list without naming the row.
	const project = fuzzyMatch(query, s.project);
	if (project) return { score: project.score, positions: [] };
	return null;
}

/** More than any fuzzy score of a short query: a name that contains the query as typed comes first. */
const WHOLE_BONUS = 1000;

/**
 * The conversations `filters` names, in the order they are shown: with a query, best match first and the most
 * recently changed of equal matches next; without one, the order they come in (the server's: newest first, which the
 * sidebar groups by date). `archived` and `project` filter whatever the query does.
 */
export function rankSessions(
	sessions: readonly SessionSummary[],
	filters: SessionFilters,
	now: number,
): RankedSession[] {
	const start = rangeStart(filters.range, now);
	const query = filters.query.trim();
	const out: RankedSession[] = [];
	for (const s of sessions) {
		if (filters.project !== "all" && s.cwd !== filters.project) continue;
		if (start !== null && s.modifiedAt < start) continue;
		if (!query) {
			out.push({ session: s, score: 0, positions: [] });
			continue;
		}
		const match = matchSession(s, query);
		if (!match) continue;
		out.push({ session: s, score: match.score, positions: match.positions });
	}
	if (!query) return out;
	// Ties keep the order the list came in (newest first), which is what "then recency" means here.
	return out.sort((a, b) => b.score - a.score || b.session.modifiedAt - a.session.modifiedAt);
}
