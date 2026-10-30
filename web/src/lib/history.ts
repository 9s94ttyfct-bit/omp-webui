import type { FamilyStats, PathAbove, SessionEntry, SessionFileData, VersionGroup } from "@shared/protocol.ts";
import { type Answer, entriesAfter } from "./answer.ts";
import { appended, extension, track } from "./lineage.ts";
import { messageOf } from "./messages.ts";
import { isPrompt, isUserCommand } from "./turns.ts";

/**
 * What the page holds of a conversation's history: one stretch of one path of its tree (see `FamilyViewKind`), the
 * conversation's other members by name, and what the rest of the path leaves. A conversation opens on the stretch at the
 * end of its path; earlier pages are put above it and later ones below as the reader goes there, so a stretch only ever
 * grows at its ends. These are the pure steps of that (the hook that asks the server is `store/history.ts`).
 */

export interface Held {
	/** The conversation's canonical path. */
	file: string;
	/** The leaf this was asked for: null is the file's last entry. A different branch is another stretch (another `Held`). */
	asked: string | null;
	/** The conversation's files with what a list of them needs; the entries of the file shown are not here but in `entries`. */
	members: SessionFileData[];
	/** The stretch, oldest first: each entry is the parent of the next. */
	entries: SessionEntry[];
	/** The entry the path leads to (the last of the stretch unless `later`), and the file's last entry. */
	leaf: string | null;
	head: string | null;
	/** The path goes on above the first entry / below the last one, to `leaf`. */
	earlier: boolean;
	later: boolean;
	/** What the path above the first entry leaves. */
	above: PathAbove;
	/** What the whole path to `leaf` leaves (null: the server did not say): what a stretch that stops short of it does not show. */
	end: Pick<PathAbove, "carry"> | null;
	/** What the path to the file's last entry leaves, when the leaf is another entry (null: the same as `end`, or not said). */
	headEnd: Pick<PathAbove, "carry"> | null;
	/** The other versions of the entries, by the parent they share. */
	versions: VersionGroup[];
	/** How many entries the file has, and what all of them add up to (null until asked, or not needed: see `needsStats`). */
	total: number;
	stats: FamilyStats | null;
}

export const NO_ABOVE: PathAbove = { carry: [], prompts: [] };

const viewed = (a: { file: string; members: SessionFileData[] }): SessionFileData | undefined =>
	a.members.find((m) => m.file === a.file);

/** The held stretch from a first answer. */
export function heldFrom(a: Answer, asked: string | null): Held {
	const own = viewed(a);
	return {
		file: a.file,
		asked,
		members: a.members,
		entries: own?.entries ?? [],
		leaf: a.view.leaf,
		head: a.view.head,
		earlier: a.view.earlier,
		later: a.view.later,
		above: a.view.above ?? NO_ABOVE,
		end: a.view.end ?? null,
		headEnd: a.view.headEnd ?? null,
		versions: a.view.versions,
		total: own?.total ?? own?.entries.length ?? 0,
		stats: null,
	};
}

/** Version groups of both, by parent: each group's entries and leads are those of both (the later answer's leads win). */
export function mergeVersions(a: VersionGroup[], b: VersionGroup[]): VersionGroup[] {
	if (!b.length) return a;
	if (!a.length) return b;
	const byParent = new Map<string | null, VersionGroup>(a.map((g) => [g.parent, g]));
	for (const g of b) {
		const known = byParent.get(g.parent);
		if (!known) {
			byParent.set(g.parent, g);
			continue;
		}
		const ids = new Set(known.entries.map((e) => e.id));
		byParent.set(g.parent, {
			parent: g.parent,
			entries: [...known.entries, ...g.entries.filter((e) => !ids.has(e.id))],
			leads: { ...known.leads, ...g.leads },
		});
	}
	return [...byParent.values()];
}

/**
 * The stretch with an older page put above it. `page` is the answer to `before` the first entry: it ends at that entry's
 * parent. Null when it does not join (the file was rewritten meanwhile): the caller asks for the end again.
 */
export function withEarlier(held: Held, page: Answer): Held | null {
	const own = viewed(page);
	const first = held.entries[0];
	if (!own || !first) return null;
	const last = own.entries.at(-1);
	if (!last || last.id !== first.parentId) return null;
	return {
		...held,
		members: page.members,
		entries: own.entries.concat(held.entries),
		earlier: page.view.earlier,
		above: page.view.above ?? NO_ABOVE,
		versions: mergeVersions(held.versions, page.view.versions),
	};
}

/** The stretch with a later page put below it (the answer to `after` the last entry); null when it does not join. */
export function withLater(held: Held, page: Answer): Held | null {
	const own = viewed(page);
	const last = held.entries.at(-1);
	const first = own?.entries[0];
	if (!own || !last || !first || first.parentId !== last.id) return null;
	return {
		...held,
		members: page.members,
		entries: held.entries.concat(own.entries),
		later: page.view.later,
		head: page.view.head,
		total: own.total ?? held.total,
		versions: mergeVersions(held.versions, page.view.versions),
	};
}

/**
 * The stretch held, brought up to the file as it is now: `fresh` is the end of the path asked for again. Where it joins
 * what is held (its first entry is one the stretch has) the entries from there on are the new ones, so an older page the
 * reader loaded stays; where it does not (the file moved on by more than a window, or was rewritten) it takes the place of
 * everything held. The statistics are of the file as it was: they are kept until the ones of the file as it is arrive (they
 * are asked for again, `wantsStats`), so that the cost shown does not go back to what the stretch alone adds up to meanwhile.
 *
 * A stretch that stops short of the end (the reader is at a search hit, a link, Back, or went up far) is not moved by the file
 * growing: it keeps its entries and its place, and takes what describes the file (its members, its last entry, how many
 * entries it has, the other versions, what its end leaves). The growth is the end's, and comes with the pages below when the
 * reader gets there.
 */
export function refreshed(held: Held, fresh: Answer): Held {
	const next = heldFrom(fresh, held.asked);
	if (held.later) {
		const toLast = held.asked === null;
		return {
			...held,
			members: next.members,
			head: next.head,
			total: next.total,
			versions: mergeVersions(held.versions, next.versions),
			// The path of the file's last entry leads to the new last entry; one asked for by its leaf leads where it did.
			leaf: toLast ? next.leaf : held.leaf,
			end: toLast ? next.end : held.end,
			headEnd: next.headEnd,
		};
	}
	const first = next.entries[0];
	const at = first ? held.entries.findIndex((e) => e.id === first.id) : -1;
	if (at < 0) return next;
	return {
		...next,
		entries: held.entries.slice(0, at).concat(next.entries),
		earlier: at > 0 ? held.earlier : next.earlier,
		above: at > 0 ? held.above : next.above,
		versions: mergeVersions(held.versions, next.versions),
		stats: held.stats,
	};
}

/** The most entries the page keeps of one path: going up past this, the end furthest from the reader is let go (`trimmedLater`). */
export const MAX_HELD_ENTRIES = 1200;

/** Where a turn begins (what the user sent, or a command they ran): where the stretch is cut, so that no turn is split. */
function startsTurn(e: SessionEntry | undefined): boolean {
	const m = e ? messageOf(e) : null;
	return m !== null && (isPrompt(m) || isUserCommand(m));
}

/**
 * The stretch with its later end let go once it holds more than `max` entries, so that a reader who goes up through
 * hundreds of pages holds the pages they are at and not every one they passed (and the page's elements, which are made of
 * what is held, stay as many). `later` is set: the pages below the cut come as any later page does, from the last entry
 * kept. Cut where a turn begins, the first one at or after `max`: a turn that goes beyond `max` (the one the reader is in,
 * when it is long) is kept whole, and where no turn begins after it nothing is let go.
 */
export function trimmedLater(held: Held, max = MAX_HELD_ENTRIES): Held {
	if (held.entries.length <= max) return held;
	let cut = max;
	while (cut < held.entries.length && !startsTurn(held.entries[cut])) cut++;
	if (cut >= held.entries.length) return held;
	const entries = held.entries.slice(0, cut);
	const kept = new Set(entries.map((e) => e.id));
	return {
		...held,
		entries,
		later: true,
		versions: held.versions.filter((g) => g.parent === null || kept.has(g.parent)),
	};
}

/** The held stretch with `stats` of the file. */
export function withStats(held: Held, stats: FamilyStats): Held {
	return { ...held, stats };
}

/**
 * Whether the figures that add up the whole file (cost, time worked, the models) cannot be taken from the stretch held: it
 * does not hold every entry of the file. A file whose entries are all held (a short conversation, no other branch in it) is added up here.
 */
export function needsStats(held: Held): boolean {
	return held.total > held.entries.length;
}

/**
 * Whether the figures of the file are to be asked for: the stretch cannot add them up (`needsStats`) and has none, or has
 * the ones of the file as it was (they end at an entry that is not the file's last any more), or has some that do not join
 * `entries` (see `figuresOf`) and so cannot be used (#711): the file went on between the window the page asked for and the
 * figures, or the entries it adds them to are a process's, which do not hold the entry the figures end at. `entries` are the
 * ones the page adds the figures to; by default the stretch's.
 */
export function wantsStats(held: Held, entries: readonly SessionEntry[] = held.entries): boolean {
	return (
		needsStats(held) && (held.stats === null || held.stats.through !== held.head || figuresOf(held, entries) === null)
	);
}

/** The wait before the first of the figures' asks that follow a miss (a request that failed, or an answer the page could not use). */
export const STATS_RETRY_MS = 1_000;
/** The longest wait between asks. */
export const STATS_RETRY_CAP_MS = 15_000;
/** How many misses in a row the page waits out before it leaves the figures alone, until what it holds changes. */
export const STATS_MISSES_MAX = 8;

/** How long to wait before asking for the figures again after `misses` misses in a row: none before the first ask, then twice as long each time, to a cap. */
export function statsDelay(misses: number): number {
	return misses <= 0 ? 0 : Math.min(STATS_RETRY_CAP_MS, STATS_RETRY_MS * 2 ** (misses - 1));
}

/** What the page wants of the figures (`StatsAsks.want`): the question (`key`), the stretch it is of, and the file. */
export interface StatsWanted {
	key: string;
	stretch: string;
	file: string;
}

/**
 * The asks for the figures of the whole file (#711), one at a time. The next is due a delay after the last one went out
 * (`STATS_RETRY_MS` at least, more after misses: `statsDelay`), not after the last change of what the page holds: a busy
 * run changes that several times a second, and a wait that started again at each change never ended. For the same reason
 * an ask on its way is not given up when what the page holds changes: its answer is used unless another file is on screen
 * (`land` says), and once it is in, the page is asked about again if it wants something else by then. A request that
 * failed is a miss and is tried again; an answer that cannot be used is a miss that waits for a new question.
 */
export class StatsAsks {
	private wanted: StatsWanted | null = null;
	private stretch = "";
	private misses = 0;
	/** When the last ask went out (0: never). */
	private at = 0;
	/** The question of the ask on its way. */
	private flying: string | null = null;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private stopped = false;

	constructor(
		private readonly fetch: (file: string) => Promise<FamilyStats>,
		/** Puts the figures of `file` into what the page holds; false: they cannot be used (a miss). */
		private readonly land: (file: string, stats: FamilyStats) => boolean,
	) {}

	/** What the page wants now; null: nothing. Called whenever it changes. */
	want(wanted: StatsWanted | null): void {
		this.wanted = wanted;
		if (!wanted) this.misses = 0;
		// Another stretch (another file, or the file grown past it) is a new question: what the last one met does not count.
		else if (wanted.stretch !== this.stretch) {
			this.stretch = wanted.stretch;
			this.misses = 0;
		}
		this.schedule();
	}

	/** The page is gone: nothing more is asked, and what comes back is not used. */
	stop(): void {
		this.stopped = true;
		clearTimeout(this.timer);
	}

	private schedule(): void {
		clearTimeout(this.timer);
		this.timer = undefined;
		const wanted = this.wanted;
		if (this.stopped || !wanted || this.flying !== null || this.misses >= STATS_MISSES_MAX) return;
		const wait = this.at
			? this.at + Math.max(STATS_RETRY_MS, statsDelay(this.misses)) - Date.now()
			: statsDelay(this.misses);
		if (wait > 0) this.timer = setTimeout(() => this.ask(wanted), wait);
		else this.ask(wanted);
	}

	private ask(wanted: StatsWanted): void {
		this.timer = undefined;
		this.at = Date.now();
		this.flying = wanted.key;
		this.fetch(wanted.file).then(
			(stats) => {
				this.flying = null;
				if (this.stopped) return;
				// Another file is on screen: these figures are not its, and say nothing of its own.
				if (this.wanted?.file === wanted.file) this.misses = this.land(wanted.file, stats) ? 0 : this.misses + 1;
				// The page wants something else by now: that is asked about (an unusable answer to the same question waits).
				if (this.wanted && this.wanted.key !== wanted.key) this.schedule();
			},
			() => {
				this.flying = null;
				if (this.stopped) return;
				this.misses++;
				this.schedule();
			},
		);
	}
}

/**
 * The server's figures of the file, for adding `entries` to them (`sumEntries`, `usageByModel`, `activeMs`): the entries the page
 * has of the file, which are the stretch's own or those of a process on it. Null where the page adds up by itself or cannot use them:
 * the stretch holds the whole file, they are not there yet, or they end at an entry `entries` does not hold.
 *
 * A stretch that stops short of the file's end holds only entries the figures include, whichever they are: they say so by
 * ending at its last entry, so that nothing is added to them. Those are not the entries of a process on the file, which go on
 * to the end.
 */
export function figuresOf(held: Held, entries: readonly SessionEntry[]): FamilyStats | null {
	const stats = held.stats;
	if (!needsStats(held) || !stats) return null;
	// A stretch of another branch than the file's last holds nothing the figures do not include either (they are of the whole file).
	if ((held.later || held.leaf !== held.head) && entries === held.entries)
		return { ...stats, through: entries.at(-1)?.id ?? null };
	return entriesAfter(entries, stats.through) === null ? null : stats;
}

/** The files of the family as the tree is built from them: the viewed file with the stretch, the others as they were sent. */
export function membersOf(held: Held): SessionFileData[] {
	return held.members.map((m) => (m.file === held.file ? { ...m, entries: held.entries } : m));
}

/** The entries of the other versions, once each: what the tree needs besides the stretch. */
export function versionEntries(held: Held): SessionEntry[] {
	const seen = new Set(held.entries.map((e) => e.id));
	const out: SessionEntry[] = [];
	for (const g of held.versions) {
		for (const e of g.entries) {
			if (seen.has(e.id)) continue;
			seen.add(e.id);
			out.push(e);
		}
	}
	return out;
}

/** Where each version leads (see `VersionGroup.leads`), by the entry that starts it. */
export function leadsOf(held: Held): Map<string, { leaf: string; files: string[] }> {
	const out = new Map<string, { leaf: string; files: string[] }>();
	for (const g of held.versions) for (const [id, lead] of Object.entries(g.leads)) out.set(id, lead);
	return out;
}

/**
 * The path with what lies above it in front, for what is derived from the whole path (the goal, the model, the providers).
 * Made by `appended` where the path only grew, so that what is derived from it goes on from where it was (see `lineage.ts`);
 * with nothing above, the path itself.
 */
export class Carried {
	private last: { above: readonly SessionEntry[]; path: SessionEntry[]; out: SessionEntry[] } | null = null;

	derive(above: readonly SessionEntry[], path: SessionEntry[]): SessionEntry[] {
		if (!above.length) {
			// Nothing above (the start of the conversation was reached): what was kept of a longer path is let go.
			this.last = null;
			return path;
		}
		const last = this.last;
		if (last && last.above === above) {
			const from = extension(last.path, path);
			if (from !== null) {
				const out = from === path.length ? last.out : appended(last.out, path.slice(from));
				this.last = { above, path, out };
				return out;
			}
		}
		const out = above.concat(path);
		track(out);
		this.last = { above, path, out };
		return out;
	}
}

/** The prompts above and those of the path, a repeat in a row once (as `promptsOf` reads them). */
export function joinPrompts(above: readonly string[], path: readonly string[]): string[] {
	if (!above.length) return path.slice();
	if (!path.length) return above.slice();
	return above.at(-1) === path[0] ? [...above, ...path.slice(1)] : [...above, ...path];
}
