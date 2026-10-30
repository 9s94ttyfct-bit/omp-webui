/**
 * A goal run is one conversation that grows by a few entries every second for hours, and everything the page derives
 * from its entries (the tree, the path, the totals, the transcript's segments…) used to be derived again from the
 * first entry at every change: the cost of a step grew with the length of the history.
 *
 * Arrays that only ever grow at the end are made with `appended`, which records that the new array begins with
 * the old one. A derivation that kept what it computed for the old array (see `Fold`) then continues from where it
 * stopped, and reads only what was added. An array nobody appended to (a fresh fetch, a rewritten entry) is unknown
 * to it: that one is derived from the start, as before.
 */

/** The arrays one chain of appends made: each is the one before it with something added. */
interface Lineage {
	/** The longest of them. An append to any other would fork the chain, and starts one of its own instead. */
	tip: readonly unknown[];
}

const lineages = new WeakMap<readonly unknown[], Lineage>();

/** The lineage `items` belongs to, which it starts when it is none's yet. */
function lineageOf(items: readonly unknown[]): Lineage {
	let line = lineages.get(items);
	if (!line) {
		line = { tip: items };
		lineages.set(items, line);
	}
	return line;
}

/** Begin a lineage with `items`, so that arrays appended to it are known to begin with it. */
export function track(items: readonly unknown[]): void {
	lineageOf(items);
}

/** `prev` and then `added`: the same array when nothing is added. The result begins with `prev`, and is known to. */
export function appended<T>(prev: T[], added: readonly T[]): T[] {
	if (added.length === 0) return prev;
	const next = prev.concat(added);
	const line = lineageOf(prev);
	if (line.tip === prev) {
		line.tip = next;
		lineages.set(next, line);
	} else lineages.set(next, { tip: next });
	return next;
}

/** How many items `next` begins with that are those of `prev`, unchanged; null when it is not known to begin with them. */
export function extension(prev: readonly unknown[] | null | undefined, next: readonly unknown[]): number | null {
	if (!prev) return null;
	if (prev === next) return prev.length;
	const line = lineages.get(prev);
	return line !== undefined && line === lineages.get(next) && next.length >= prev.length ? prev.length : null;
}

/**
 * A value derived from an array by going through its items in order, kept as the array grows: `step` is given the state
 * so far, the array and where the new items begin, and returns the new state. The state may be changed in place when it
 * is private to the fold, or replaced when it is shared.
 *
 * What the fold has seen is kept for the longest array of each lineage, and for every array it was asked about once, so
 * that asking again is free and a conversation (or two tabs) never makes another's work start over. A fold that changes
 * its state in place (`inPlace`) forgets the shorter arrays as it goes on: their state is the longer one's now, and
 * asking about one of them again derives it from the start.
 */
export class Fold<T, S> {
	private readonly latest = new WeakMap<Lineage, { items: readonly T[]; state: S }>();
	private readonly seen = new WeakMap<readonly T[], { state: S }>();

	constructor(
		private readonly init: () => S,
		private readonly step: (state: S, items: readonly T[], from: number) => S,
		private readonly inPlace = false,
	) {}

	run(items: readonly T[]): S {
		const known = this.seen.get(items);
		if (known) return known.state;
		const line = lineageOf(items);
		const before = this.latest.get(line);
		// What was kept is of an array this one begins with, or of a longer one (this is an older array of the chain).
		const base = before && before.items.length <= items.length ? before : undefined;
		const state = this.step(base ? base.state : this.init(), items, base ? base.items.length : 0);
		if (base && this.inPlace && base.items !== items) this.seen.delete(base.items);
		this.seen.set(items, { state });
		// An older (shorter) array asked about after a newer one does not take its place.
		if (!before || base) this.latest.set(line, { items, state });
		return state;
	}
}
