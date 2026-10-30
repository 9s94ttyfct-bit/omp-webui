import type { SessionEntry, SessionFileData } from "@shared/protocol.ts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Answer } from "../lib/answer.ts";
import { ApiError, api, type HistoryRequest } from "../lib/api.ts";
import type { Extras } from "../lib/family.ts";
import {
	figuresOf,
	type Held,
	heldFrom,
	leadsOf,
	membersOf,
	needsStats,
	refreshed,
	StatsAsks,
	trimmedLater,
	versionEntries,
	wantsStats,
	withEarlier,
	withLater,
	withStats,
} from "../lib/history.ts";
import { noteSavedEntries } from "./app.ts";

/**
 * What a conversation's page holds of its history, and how it gets more. A conversation opens on the end of its path (the
 * server answers a window of it, see `FamilyViewKind`); the reader going up asks for the page above, a search hit far back
 * for the window around it, and the file changing under a page that shows it for the end again, which is put where it
 * belongs: the pages already loaded stay.
 */

export interface HistoryOptions {
	/** The conversation's file, as the page names it; null: none yet (a new chat). */
	file: string | null;
	/** The leaf of the branch on screen, when it is not the file's last entry. */
	leaf: string | null;
	/** Open around this entry rather than on the end (a search hit, a link to a message). */
	at?: string | null;
	/** An entry the reader was at (Back): the end is shown, and when this entry is not in it, the window around it. */
	resume?: string | null;
	/** The file is one omp named and has not written: nothing is on disk to ask for. */
	unwritten: boolean;
	/** A process of this page runs on the file: a file the server no longer finds is an empty history, not an error. */
	missingOk: boolean;
	/**
	 * Changes when a file of the family did: the end is asked for again. Null while the session list that names the family's
	 * files has not loaded: its arrival is not a change (the end asked for at the start is as current as the list).
	 */
	refetchKey: string | null;
	/** Bumped by Retry. */
	attempt: number;
	/** The entries of a process of this page on the file (omp's own, which go on past the stretch): the figures of the whole file are added to them. */
	process?: SessionEntry[];
}

export interface History {
	/** The files of the family, the one shown with the stretch held; null until the first window arrived, empty when there is no file. */
	members: SessionFileData[] | null;
	/** What the tree holds besides the files' entries: the other versions of the entries, and where they lead. */
	extras: Extras;
	held: Held | null;
	/** The conversation's canonical path, once known. */
	canonical: string | null;
	/** The entry that ends what is shown: the leaf, or the last entry of a stretch that stops short of it. */
	shown: string | null;
	/** The entries the figures of the whole file are added to: those of a process of this page on the file when it has any, else the stretch's. */
	figureEntries: SessionEntry[];
	/** The branch the window asked for around an entry (`at`) is on, when it is not the file's last: the page shows that branch. */
	adopted: string | null;
	earlier: boolean;
	later: boolean;
	/** A page is on its way above / below the stretch; `first`: the walk to the start of the conversation is going on. */
	loading: { earlier: boolean; later: boolean; first: boolean };
	error: string | null;
	/** The page above the stretch; resolves with whether one was added. */
	loadEarlier(): Promise<boolean>;
	/** The page below it; resolves with whether one was added. */
	loadLater(): Promise<boolean>;
	/** Everything above the stretch, a page at a time; resolves with whether the start of the conversation was reached. */
	loadFirst(): Promise<boolean>;
	/** The end of the path again, in place of a stretch that stops short of it. */
	showLatest(): Promise<void>;
	/**
	 * The window around an entry in place of the stretch; null when the file has no such entry. Resolves with where the path
	 * leads, and whether the window holds the entry.
	 */
	focus(id: string): Promise<{ leaf: string | null; head: string | null; holds: boolean } | null>;
}

const NO_MEMBERS: SessionFileData[] = [];
const NO_EXTRAS: Extras = { entries: [], leads: new Map() };
const NO_ENTRIES: SessionEntry[] = [];
const messageOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export function useHistory(opts: HistoryOptions): History {
	const { file, leaf, unwritten, missingOk, refetchKey, attempt } = opts;
	const [held, setHeld] = useState<Held | null>(null);
	const [empty, setEmpty] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [adopted, setAdopted] = useState<string | null>(null);
	const [loading, setLoading] = useState({ earlier: false, later: false, first: false });
	const heldRef = useRef<Held | null>(null);
	/** What the held stretch was asked for: when this is still the page's file and leaf, a new window need not be asked for. */
	const askedFor = useRef<{ file: string; leaf: string | null } | null>(null);
	/** Bumped when the conversation or the branch on screen changes, or a stretch is replaced: answers to older questions are dropped. */
	const epoch = useRef(0);
	/** The page on its way at each end, and the walk to the start: a question for what is already being asked shares its answer. */
	const flight = useRef<{
		earlier: Promise<boolean> | null;
		later: Promise<boolean> | null;
		first: Promise<boolean> | null;
	}>({
		earlier: null,
		later: null,
		first: null,
	});
	const lastAnswer = useRef<Answer | null>(null);
	const first = useRef(opts.at ?? null);
	const resume = useRef(opts.at ? null : (opts.resume ?? null));
	/** `focus`, for the effect that asks for the end first and the window around `resume` when the end does not have it. */
	const focusRef = useRef<(id: string) => Promise<unknown>>(async () => null);
	/** The triggers of the last asking: a branch the page was moved to by a window it holds is not a reason to ask again. */
	const triggers = useRef({ refetchKey, attempt });
	/**
	 * The newest question for the end: an answer is used only while it is still the newest one. A question that is already on
	 * its way is the answer to a trigger that repeats (the session list arriving while the end is being fetched changes
	 * the effect's inputs and asks for nothing new), so it is not asked again and not dropped for it.
	 */
	const newest = useRef(0);
	const pending = useRef(false);
	/** Whether a missing file was an empty history when the question on its way was asked: a change of that asks again. */
	const askedMissing = useRef(missingOk);

	const commit = useCallback((next: Held | null) => {
		heldRef.current = next;
		setHeld(next);
	}, []);

	// The end of the path (or the window around `at` the first time): when the conversation, the branch or the family changes.
	useEffect(() => {
		if (!file) {
			newest.current++;
			pending.current = false;
			commit(null);
			setEmpty(true);
			return;
		}
		if (unwritten) {
			newest.current++;
			pending.current = false;
			commit(null);
			setEmpty(true);
			setError(null);
			return;
		}
		const same = askedFor.current?.file === file && askedFor.current.leaf === leaf;
		const asked =
			(triggers.current.refetchKey !== null && triggers.current.refetchKey !== refetchKey) ||
			triggers.current.attempt !== attempt;
		triggers.current = { refetchKey, attempt };
		// The branch was reached through a window the page holds (a search hit on another branch): it is what is shown.
		// And the end that is on its way for this file and branch is the answer to this trigger too.
		if (same && !asked && (heldRef.current || (pending.current && askedMissing.current === missingOk))) return;
		const mine = same ? epoch.current : ++epoch.current;
		askedFor.current = { file, leaf };
		const token = ++newest.current;
		pending.current = true;
		askedMissing.current = missingOk;
		const around = !same && first.current ? first.current : null;
		first.current = null;
		const ask = async (): Promise<Answer> => {
			if (around) {
				try {
					return await api.history(file, { kind: "around", at: around, leaf });
				} catch (e) {
					// The entry is not in the file any more: the end is what there is to show.
					if (!(e instanceof ApiError && e.code === "unknown_entry")) throw e;
				}
			}
			return api.history(file, { kind: "tail", leaf });
		};
		ask()
			.then((answer) => {
				if (token !== newest.current || mine !== epoch.current) return;
				// The same answer again (a 304): nothing changed, nothing is drawn again.
				if (same && answer === lastAnswer.current && heldRef.current) return;
				lastAnswer.current = answer;
				const current = heldRef.current;
				// The window around an entry on another branch than the file's last: that branch is what the page shows.
				const onBranch = answer.view.kind === "around" && answer.view.leaf !== answer.view.head;
				const next =
					same && current && current.file === answer.file && current.asked === leaf
						? refreshed(current, answer)
						: heldFrom(answer, onBranch ? answer.view.leaf : leaf);
				if (onBranch && answer.view.leaf !== leaf) {
					askedFor.current = { file, leaf: answer.view.leaf };
					setAdopted(answer.view.leaf);
				}
				commit(next);
				setError(null);
				// Back to a place above the end: the window around it comes in place of the end.
				const back = resume.current;
				resume.current = null;
				if (back && !next.entries.some((e) => e.id === back)) void focusRef.current(back);
			})
			.catch((e) => {
				if (token !== newest.current || mine !== epoch.current) return;
				// A live conversation's file that the session list holds but the server no longer finds (deleted under it): show
				// the live transcript instead of an error.
				if (missingOk && e instanceof ApiError && e.status === 404) {
					commit(null);
					setEmpty(true);
					setError(null);
				} else setError(messageOf(e));
			})
			.finally(() => {
				if (token === newest.current) pending.current = false;
			});
	}, [file, leaf, refetchKey, unwritten, missingOk, attempt, commit]);

	// The entries the figures of the file are added to: a process's when the page has any (it holds what the file has beyond
	// the stretch), else the stretch's. The header's chip adds them up the same way (`figuresOf`), and uses what is here.
	const processEntries = opts.process;
	const figureEntries = useMemo(
		() => (processEntries?.length ? processEntries : (held?.entries ?? NO_ENTRIES)),
		[processEntries, held?.entries],
	);
	const figureEntriesRef = useRef(figureEntries);
	figureEntriesRef.current = figureEntries;
	// What adds up the whole file is asked for when the page holds only a part of it, and kept asked for until the page can use
	// it (#711): when the file grew past the figures it has, and when the figures it has are of no use to it: the request failed,
	// or the answer ends at an entry that `figureEntries` does not hold (the file went on between the page's window and the
	// figures, or a process's entries replaced the stretch). Without this the chip stayed at "≥" until the stretch's last entry
	// or size changed, which those of a conversation that is running here never do.
	const wanting = useMemo(() => held !== null && wantsStats(held, figureEntries), [held, figureEntries]);
	const unusable = useMemo(
		() => held !== null && needsStats(held) && held.stats !== null && figuresOf(held, figureEntries) === null,
		[held, figureEntries],
	);
	const statsFor = held && wanting ? `${held.file}\0${held.head}\0${held.total}` : null;
	// Figures that cannot be used are asked for again when what they or the page end at changes: not while neither does.
	const statsKey =
		statsFor === null ? null : `${statsFor}\0${unusable ? `${held?.stats?.through}\0${figureEntries.at(-1)?.id}` : ""}`;
	const [asks] = useState(
		() =>
			new StatsAsks(
				(file) => api.historyStats(file),
				(file, stats) => {
					const now = heldRef.current;
					if (!now || now.file !== file) return false;
					const next = withStats(now, stats);
					commit(next);
					return figuresOf(next, figureEntriesRef.current) !== null;
				},
			),
	);
	useEffect(() => () => asks.stop(), [asks]);
	const statsFile = held?.file;
	useEffect(() => {
		asks.want(statsKey && statsFor && statsFile ? { key: statsKey, stretch: statsFor, file: statsFile } : null);
	}, [asks, statsKey, statsFor, statsFile]);

	// A process that starts on this file continues from the end of the stretch instead of fetching the file over the socket.
	useEffect(() => {
		if (held && !held.later && held.head !== null && held.leaf === held.head) noteSavedEntries(held.file, held.entries);
	}, [held]);

	/**
	 * Ask for one page and put it where it belongs; a page that does not join what is held means the file moved: the end is
	 * asked for again. Resolves with whether the page was added. A page already on its way is the answer to this question
	 * too: the caller gets that one's. `trim`: let go of what the page makes more than the page keeps (`trimmedLater`).
	 */
	const page = useCallback(
		(which: "earlier" | "later", trim = true): Promise<boolean> => {
			const running = flight.current[which];
			if (running) return running;
			const current = heldRef.current;
			if (!current) return Promise.resolve(false);
			const edge = which === "earlier" ? current.entries[0] : current.entries.at(-1);
			if (!edge || !(which === "earlier" ? current.earlier : current.later)) return Promise.resolve(false);
			const req: HistoryRequest =
				which === "earlier" ? { kind: "before", at: edge.id } : { kind: "after", at: edge.id, leaf: current.leaf };
			const mine = epoch.current;
			setLoading((s) => ({ ...s, [which]: true }));
			const ask = async (): Promise<boolean> => {
				try {
					const answer = await api.history(current.file, req);
					const now = heldRef.current;
					if (mine !== epoch.current || !now) return false;
					const edgeNow = which === "earlier" ? now.entries[0] : now.entries.at(-1);
					// What is held changed while the page was on its way (the end the other page let go of was this page's edge,
					// or the end was asked for again): the page was for a stretch that is not held, and the file did not move.
					if (edgeNow?.id !== edge.id) return false;
					const joined = which === "earlier" ? withEarlier(now, answer) : withLater(now, answer);
					if (joined) {
						commit(trim && which === "earlier" ? trimmedLater(joined) : joined);
						// A page that failed before is not the state of the conversation now.
						setError(null);
						return true;
					}
					const end = await api.history(now.file, { kind: "tail", leaf: now.asked });
					if (mine === epoch.current) {
						commit(heldFrom(end, now.asked));
						setError(null);
					}
					return false;
				} catch (e) {
					if (mine === epoch.current) setError(messageOf(e));
					return false;
				} finally {
					flight.current[which] = null;
					setLoading((s) => ({ ...s, [which]: false }));
				}
			};
			const run = ask();
			flight.current[which] = run;
			return run;
		},
		[commit],
	);
	const loadEarlier = useCallback(() => page("earlier"), [page]);
	const loadLater = useCallback(() => page("later"), [page]);

	/**
	 * Every page above the stretch, one after another, and the walk is one: a second question while it goes on is its answer.
	 * Nothing is let go on the way (the page shows the messages it showed until the walk is over, and then the first ones);
	 * the end furthest from them is let go when it has reached the start.
	 */
	const loadFirst = useCallback((): Promise<boolean> => {
		const running = flight.current.first;
		if (running) return running;
		const mine = epoch.current;
		setLoading((s) => ({ ...s, first: true }));
		const walk = async (): Promise<boolean> => {
			try {
				// A page that did not come (an error, the file moved) ends the walk.
				while (mine === epoch.current && heldRef.current?.earlier) if (!(await page("earlier", false))) return false;
				const now = heldRef.current;
				if (mine !== epoch.current || now === null) return false;
				commit(trimmedLater(now));
				return true;
			} finally {
				flight.current.first = null;
				setLoading((s) => ({ ...s, first: false }));
			}
		};
		const run = walk();
		flight.current.first = run;
		return run;
	}, [page, commit]);

	const replace = useCallback(
		async (req: HistoryRequest, asked: string | null): Promise<Held | null> => {
			const current = heldRef.current;
			if (!current) return null;
			const mine = ++epoch.current;
			try {
				const answer = await api.history(current.file, req);
				if (mine !== epoch.current) return null;
				const resolved = answer.view.leaf === answer.view.head ? null : answer.view.leaf;
				const next = heldFrom(answer, req.kind === "around" ? resolved : asked);
				askedFor.current = { file: askedFor.current?.file ?? current.file, leaf: next.asked };
				commit(next);
				setError(null);
				return next;
			} catch (e) {
				if (mine !== epoch.current) return null;
				if (!(e instanceof ApiError && e.code === "unknown_entry")) setError(messageOf(e));
				return null;
			}
		},
		[commit],
	);
	const showLatest = useCallback(async (): Promise<void> => {
		const current = heldRef.current;
		if (current?.later) await replace({ kind: "tail", leaf: current.asked }, current.asked);
	}, [replace]);
	const focus = useCallback(
		async (id: string) => {
			const next = await replace({ kind: "around", at: id, leaf: null }, null);
			return next ? { leaf: next.leaf, head: next.head, holds: next.entries.some((e) => e.id === id) } : null;
		},
		[replace],
	);

	focusRef.current = focus;

	const members = useMemo(() => (held ? membersOf(held) : empty ? NO_MEMBERS : null), [held, empty]);
	const extras = useMemo<Extras>(
		() => (held?.versions.length ? { entries: versionEntries(held), leads: leadsOf(held) } : NO_EXTRAS),
		[held],
	);
	const last = held?.entries.at(-1)?.id ?? null;
	return {
		members,
		extras,
		held,
		canonical: held?.file ?? null,
		figureEntries,
		shown: held ? (held.later ? last : held.leaf) : null,
		adopted,
		earlier: held?.earlier ?? false,
		later: held?.later ?? false,
		loading,
		error,
		loadEarlier,
		loadLater,
		loadFirst,
		showLatest,
		focus,
	};
}
