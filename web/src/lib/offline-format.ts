import { type ContextBreakdown, type ContextItem, type ModeState, RESERVED_ROWS } from "@shared/offline.ts";

/** What the Settings mode section shows, worked out from what the server measured. */

/**
 * Whether `incoming` says something older than the state the page holds: the server numbers every state it says
 * (`rev`, within one run of it, `boot`), and a state read before another one was announced can arrive after it.
 */
export function modeSuperseded(held: ModeState | null, incoming: ModeState): boolean {
	return held !== null && held.boot === incoming.boot && incoming.rev < held.rev;
}

/** 1234 → "1.2K"; small counts as they are. */
export function formatTokens(n: number): string {
	return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(n);
}

/** How much less Light's start is than Full's, in whole percent; null when it is no less. */
export function savingPercent(full: number, light: number): number | null {
	if (full <= 0 || light >= full) return null;
	return Math.round((1 - light / full) * 100);
}

export interface ContextRow {
	label: string;
	full: number | null;
	light: number | null;
}

/** One row per kind of content, in omp's order, with each side's tokens (null: that side did not measure). */
export function contextRows(full: ContextBreakdown | null, light: ContextBreakdown | null): ContextRow[] {
	const filled = (b: ContextBreakdown | null): ContextItem[] =>
		b?.items.filter((i) => !RESERVED_ROWS.test(i.label)) ?? [];
	const labels = [...new Set([...filled(full), ...filled(light)].map((i) => i.label))];
	const tokens = (b: ContextBreakdown | null, label: string): number | null =>
		b ? (filled(b).find((i) => i.label === label)?.tokens ?? 0) : null;
	return labels.map((label) => ({ label, full: tokens(full, label), light: tokens(light, label) }));
}

/** Names or globs as typed, separated by commas: the list they mean. */
export function parseList(text: string): string[] {
	return [
		...new Set(
			text
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean),
		),
	];
}
