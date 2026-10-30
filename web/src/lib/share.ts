import type { ProjectGroup } from "@shared/project-groups.ts";
import type { SessionSummary } from "@shared/protocol.ts";

/**
 * The session list as just fetched, keeping the objects of the rows that did not change: a list that is the same as
 * before comes back as the array it replaces, so nothing that shows it renders again.
 */
export function shareSessions(prev: SessionSummary[], next: SessionSummary[]): SessionSummary[] {
	const before = new Map(prev.map((s) => [s.file, s]));
	const shared = next.map((s) => {
		const old = before.get(s.file);
		return old && sameRow(old, s) ? old : s;
	});
	return shared.length === prev.length && shared.every((s, i) => s === prev[i]) ? prev : shared;
}

/** The server only reads a file again when its time or size changed; the rest is compared in full. */
function sameRow(old: SessionSummary, next: SessionSummary): boolean {
	return old.modifiedAt === next.modifiedAt && old.size === next.size && JSON.stringify(old) === JSON.stringify(next);
}

/**
 * The list after the server's answer to "what changed since": the rows it sent replace (or join) theirs, the files it
 * named are gone, and the newest write comes first as in a full list. Every other row keeps its object, and a list
 * that did not change comes back as the array it replaces.
 */
export function applySessionChanges(
	prev: SessionSummary[],
	changed: SessionSummary[],
	removed: string[],
): SessionSummary[] {
	const before = new Map(prev.map((s) => [s.file, s]));
	const fresh = changed.filter((s) => {
		const old = before.get(s.file);
		return !(old && sameRow(old, s));
	});
	const gone = new Set(removed.filter((f) => before.has(f)));
	if (fresh.length === 0 && gone.size === 0) return prev;
	const replaced = new Set([...fresh.map((s) => s.file), ...gone]);
	const next = [...prev.filter((s) => !replaced.has(s.file)), ...fresh.filter((s) => !gone.has(s.file))];
	// Stable: rows written at the same moment keep the order they had.
	next.sort((a, b) => b.modifiedAt - a.modifiedAt);
	return next.length === prev.length && next.every((s, i) => s === prev[i]) ? prev : next;
}

/** `next`, or the array it replaces when both hold the same strings in the same order. */
export function shareStrings(prev: string[], next: string[]): string[] {
	return prev.length === next.length && prev.every((s, i) => s === next[i]) ? prev : next;
}

/** `next`, or the array it replaces when both hold the same groups in the same order (a change that changes nothing). */
export function shareGroups(prev: ProjectGroup[], next: ProjectGroup[]): ProjectGroup[] {
	return prev.length === next.length && prev.every((g, i) => JSON.stringify(g) === JSON.stringify(next[i]))
		? prev
		: next;
}
