import {
	looksLikeSecret,
	MEMORY_CONTENT_MAX,
	type MemoryBank,
	type MemoryDetail,
	type MemoryKind,
	type MemoryOrigin,
	type MemoryOverview,
	type MemoryQuery,
	type MemoryScope,
} from "@shared/memory.ts";
import type { MessageKey } from "../i18n/index.ts";
import { shortPath } from "./format.ts";

/** What the kind chips show at first: what somebody saved (or omp consolidated), not the excerpts omp kept by itself. */
export const DEFAULT_KINDS: readonly MemoryKind[] = ["note", "consolidated"];

/** The filters of the list, as the controls above it hold them. */
export interface MemoryFilters {
	scope: MemoryScope | "all";
	/** One project's bank, or "" for all of them (only with `scope: "project"`). */
	bank: string;
	kinds: MemoryKind[];
	includeRetired: boolean;
}

export const INITIAL_FILTERS: MemoryFilters = {
	scope: "all",
	bank: "",
	kinds: [...DEFAULT_KINDS],
	includeRetired: false,
};

/** The query the list is asked for: the filters, the search text, and the part of the list wanted. */
export function queryOf(filters: MemoryFilters, q: string, limit: number, offset: number): Partial<MemoryQuery> {
	return {
		q: q.trim(),
		scope: filters.scope,
		bank: filters.scope === "project" ? filters.bank : "",
		kinds: filters.kinds,
		retired: filters.includeRetired ? "all" : "active",
		limit,
		offset,
	};
}

export const KIND_LABEL: Record<MemoryKind, { many: MessageKey; one: MessageKey; hint: MessageKey }> = {
	note: { many: "memory.kindNote", one: "memory.kindNoteOne", hint: "memory.kindNoteHint" },
	conversation: {
		many: "memory.kindConversation",
		one: "memory.kindConversationOne",
		hint: "memory.kindConversationHint",
	},
	consolidated: {
		many: "memory.kindConsolidated",
		one: "memory.kindConsolidatedOne",
		hint: "memory.kindConsolidatedHint",
	},
};

/** The sentence for who saved a memory (`other` takes the source's own words). */
export const ORIGIN_LABEL: Record<MemoryOrigin, MessageKey> = {
	learn: "memory.originLearn",
	retain: "memory.originRetain",
	saved: "memory.originSaved",
	web: "memory.originWeb",
	conversation: "memory.originConversation",
	consolidated: "memory.originConsolidated",
	other: "memory.originOther",
};

/** The banks of the projects, in the order the overview lists them. */
export const projectBanks = (overview: MemoryOverview): MemoryBank[] =>
	overview.banks.filter((b) => b.scope === "project");

/**
 * What each project's bank is called in a menu: the folder's name, and its path too where two projects share a name
 * (`~/work/app` and `~/play/app`), so that they can be told apart.
 */
export function projectNames(banks: readonly MemoryBank[], home?: string): Map<string, string> {
	const shared = new Map<string, number>();
	for (const b of banks) shared.set(b.label, (shared.get(b.label) ?? 0) + 1);
	return new Map(
		banks.map((b) => {
			const path = b.cwds[0];
			return [b.bank, (shared.get(b.label) ?? 0) > 1 && path ? `${b.label} (${shortPath(path, home)})` : b.label];
		}),
	);
}

/** The banks a memory can be added to a project with: the ones that can be read and that this page writes. */
export const addableProjects = (overview: MemoryOverview): MemoryBank[] =>
	projectBanks(overview).filter((b) => b.error === undefined && b.writeProblem === null);

/** What a memory held when an edit of it began: what the edit is a change of, and the etag a save carries. */
export interface Base {
	etag: string;
	content: string;
	importance: number | null;
}

/** An edit that is not saved yet: the text, the importance as it is typed ("" for none), and what it is an edit of. */
export interface Draft {
	content: string;
	importance: string;
	base: Base;
}

export const baseOf = (item: MemoryDetail): Base => ({
	etag: item.etag,
	content: item.content,
	importance: item.importance,
});

const typed = (importance: number | null): string => (importance === null ? "" : String(importance));

export const draftOf = (item: MemoryDetail): Draft => ({
	content: item.content,
	importance: typed(item.importance),
	base: baseOf(item),
});

/**
 * The importance a field holds: a number from 0 to 1, null for an empty field, `undefined` for what is not one. A memory
 * that has an importance keeps one (omp has no "none" to set), so an emptied field is not a valid one for it.
 */
export function importanceOf(field: string): number | null | undefined {
	if (field.trim() === "") return null;
	const n = Number(field);
	return Number.isFinite(n) && n >= 0 && n <= 1 ? n : undefined;
}

/** Whether the importance field of `draft` holds what the memory it is an edit of may have. */
export function importanceValid(draft: Draft): boolean {
	const importance = importanceOf(draft.importance);
	return importance !== undefined && (importance !== null || draft.base.importance === null);
}

/** What saving `draft` would change in the memory it is an edit of; empty when it changes nothing. */
export function changeOf(draft: Draft): { content?: string; importance?: number } {
	const change: { content?: string; importance?: number } = {};
	if (draft.content !== draft.base.content) change.content = draft.content;
	const importance = importanceOf(draft.importance);
	if (typeof importance === "number" && importance !== draft.base.importance) change.importance = importance;
	return change;
}

/** Whether `draft` can be saved: it changes something, the text is not empty or too long, the importance is valid. */
export function saveable(draft: Draft): boolean {
	if (!importanceValid(draft)) return false;
	if (draft.content.trim() === "" || draft.content.length > MEMORY_CONTENT_MAX) return false;
	return Object.keys(changeOf(draft)).length > 0;
}

/** Whether `draft` differs from what it is an edit of (as typed: an importance field with a stray zero is a change). */
export function dirty(draft: Draft): boolean {
	return draft.content !== draft.base.content || draft.importance.trim() !== typed(draft.base.importance);
}

/** Whether the memory is no longer as the edit began: `current` was changed (by omp, or another page) since. */
export const movedOn = (draft: Draft, current: MemoryDetail): boolean => draft.base.etag !== current.etag;

/**
 * Whether saving `draft` needs the person to say that a text shaped like a key or token is meant. Only a text the edit
 * typed asks: an importance-only change sends no text, so the server asks nothing of it either.
 */
export const secretTyped = (draft: Draft): boolean =>
	draft.content !== draft.base.content && looksLikeSecret(draft.content);

/**
 * "Keep mine" over a memory that moved on: what the person changed stays theirs, what they did not change is what the
 * memory holds now (an importance omp changed is not overwritten by the stale one the field still shows).
 */
export function rebase(draft: Draft, current: MemoryDetail): Draft {
	const now = draftOf(current);
	return {
		content: draft.content !== draft.base.content ? draft.content : now.content,
		importance: draft.importance.trim() !== typed(draft.base.importance) ? draft.importance : now.importance,
		base: now.base,
	};
}

/** A memory's place in the list and in the address of its detail. */
export const keyOf = (m: { bank: string; id: string }): string => `${m.bank}/${m.id}`;
