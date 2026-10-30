import { PREF } from "@shared/prefs.ts";
import type { SessionSummary } from "@shared/protocol.ts";
import { useSyncExternalStore } from "react";
import { onPrefsChanged, setPref } from "./prefs.ts";

/**
 * The order of the sidebar's conversations (#701) and the Pinned group's fold (#700), both preferences the person chose
 * (`ompw.sessionSort`, `ompw.pinnedFolded`, kept in step with the server by `lib/prefs.ts`), and the grouping they make:
 *
 * - `activity` (the default): by last activity, under date headings (Today, Yesterday, …), as the list always was;
 * - `created`: by when each conversation started, under the date headings of that;
 * - `title`: by name, A to Z, one list without dates.
 *
 * In every order the pinned conversations come first, in the order they were pinned, and the conversations that are
 * working now (#699) come first after them: at the top of Today in the two orders by time, whatever day they were last
 * written to, and at the top of the list by name.
 */

export const SESSION_SORTS = ["activity", "created", "title"] as const;
export type SessionSort = (typeof SESSION_SORTS)[number];

/** The order a stored value names; anything else (not set, a value from another version) is `activity`. */
export const sessionSortOf = (v: string | null): SessionSort => SESSION_SORTS.find((s) => s === v) ?? "activity";

const sortNow = (): SessionSort => sessionSortOf(localStorage.getItem(PREF.sessionSort));
const pinnedFoldedNow = (): boolean => localStorage.getItem(PREF.pinnedFolded) === "on";

const changed = new Set<() => void>();
function subscribe(fn: () => void): () => void {
	changed.add(fn);
	const stop = onPrefsChanged((keys) => (keys.includes(PREF.sessionSort) || keys.includes(PREF.pinnedFolded)) && fn());
	return () => {
		changed.delete(fn);
		stop();
	};
}
const tell = () => {
	for (const fn of changed) fn();
};

export function setSessionSort(sort: SessionSort): void {
	setPref(PREF.sessionSort, sort);
	tell();
}

export function setPinnedFolded(folded: boolean): void {
	setPref(PREF.pinnedFolded, folded ? "on" : "off");
	tell();
}

export function useSessionSort(): SessionSort {
	return useSyncExternalStore(subscribe, sortNow, () => "activity");
}

export function usePinnedFolded(): boolean {
	return useSyncExternalStore(subscribe, pinnedFoldedNow, () => false);
}

export interface GroupInput {
	/** The conversations to list, in the order the session list has them (last activity first) or a search ranked them. */
	sessions: readonly SessionSummary[];
	/** The pinned files, in the order they were pinned (the first pinned first). */
	pins: readonly string[];
	sort: SessionSort;
	/** The files of the conversations that are working now. */
	working: ReadonlySet<string>;
	/** The heading of a time: `dateGroup`. */
	dateOf: (ms: number) => string;
	/** The heading of Today (what `dateOf` says of now). */
	today: string;
	pinnedLabel: string;
	/** The heading of the list by name. */
	byNameLabel: string;
	/** A search ranked `sessions`: its order stands (no other order, nothing moved up). */
	ranked: boolean;
	/** The Pinned group is folded: its heading is listed, its rows are not. */
	pinnedFolded: boolean;
}

/** The name the list shows a conversation by: its title, else the start of its first message. */
export const nameOf = (s: SessionSummary): string => (s.title ?? s.preview ?? "").trim();

const createdMs = (s: SessionSummary): number => {
	const at = Date.parse(s.createdAt);
	return Number.isFinite(at) ? at : s.modifiedAt;
};

/** The groups of the list, in display order: [heading, rows]. A folded Pinned group has its heading and no rows. */
export function sessionGroups(input: GroupInput): [string, SessionSummary[]][] {
	const { sessions, pins, sort, working, dateOf, today, ranked } = input;
	const out: [string, SessionSummary[]][] = [];
	const byFile = new Map(sessions.map((s) => [s.file, s]));
	const pinned = pins.map((f) => byFile.get(f)).filter((s): s is SessionSummary => Boolean(s));
	const pinSet = new Set(pins);
	// A search shows every match: a fold would hide one that matched.
	if (pinned.length) out.push([input.pinnedLabel, input.pinnedFolded && !ranked ? [] : pinned]);
	const dated = out.length;
	let rest = sessions.filter((s) => !pinSet.has(s.file));
	if (ranked) {
		pushByDate(out, rest, (s) => dateOf(s.modifiedAt), dated);
		return out;
	}
	if (sort === "created") rest = [...rest].sort((a, b) => createdMs(b) - createdMs(a));
	else if (sort === "title") rest = [...rest].sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
	const now = rest.filter((s) => working.has(s.file));
	const others = rest.filter((s) => !working.has(s.file));
	if (sort === "title") {
		if (rest.length) out.push([input.byNameLabel, [...now, ...others]]);
		return out;
	}
	const at = sort === "created" ? createdMs : (s: SessionSummary) => s.modifiedAt;
	if (now.length) out.push([today, now]);
	pushByDate(out, others, (s) => dateOf(at(s)), dated);
	return out;
}

/**
 * `list` appended under date headings: a row joins the last group when it has the same heading (the working ones' Today
 * goes on with the rest of today). `from`: the first group a row may join (the Pinned group is never one).
 */
function pushByDate(
	out: [string, SessionSummary[]][],
	list: readonly SessionSummary[],
	heading: (s: SessionSummary) => string,
	from: number,
): void {
	for (const s of list) {
		const g = heading(s);
		const last = out.length > from ? out.at(-1) : undefined;
		if (last && last[0] === g) last[1].push(s);
		else out.push([g, [s]]);
	}
}
