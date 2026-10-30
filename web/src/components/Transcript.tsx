import type { SessionEntry } from "@shared/protocol.ts";
import { CircleAlert } from "lucide-react";
import {
	memo,
	type ReactElement,
	type ReactNode,
	type Ref,
	type RefCallback,
	type RefObject,
	Suspense,
	useCallback,
	useEffect,
	useImperativeHandle,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { AnchorHold, type EntryAnchor, entryAnchor, placeEntryAnchor } from "../lib/entry-anchor.ts";
import { type HandScroll, type Heading, watchHandScroll } from "../lib/hand-scroll.ts";
import { lazyChunk } from "../lib/lazy-chunk.ts";
import { LiveKeys } from "../lib/live-keys.ts";
import { messageOf, savedTimestamps, type ToolResults } from "../lib/messages.ts";
import { type CommandNote, ircKey, ircMode, type LiveNotice } from "../lib/notices.ts";
import { toastQuestionDropped } from "../lib/question-dropped.ts";
import type { ReadingWindow } from "../lib/reading.ts";
import { siblingsOf, type TreeIndex } from "../lib/tree.ts";
import { type AgentTurn, type Segment, Segmenter, segmentKey } from "../lib/turns.ts";
import type { LiveState, OverlayMessage, ToolExec } from "../store/live.ts";
import { AgentTurnBlock, sameTurn } from "./AgentTurn.tsx";
import { ErrorBoundary, MessageFailed } from "./ErrorBoundary.tsx";
import { ExitNotice } from "./ExitNotice.tsx";
import { EntryNote, type MessageActions, MessageRow, type Siblings, TypingDots } from "./Message.tsx";
import { QuestionDroppedNote, SleptNote } from "./NoticeRows.tsx";
import { LiveTurnStats } from "./TurnStats.tsx";
import { Spinner } from "./ui.tsx";

// A conversation held at its provider's quota floor (#652) says so in a chunk of its own, fetched when the first one is.
const { Chunk: QuotaHoldNote, retry: retryQuotaHoldNote } = lazyChunk(() => import("./QuotaHoldNote.tsx"));

/**
 * A conversation of hundreds of turns is tens of thousands of elements. Opening one shows its last
 * `INITIAL_SEGMENTS` messages (a prompt, or an agent's turn, each count as one) and "Show earlier messages"
 * adds `EARLIER_STEP` more at a time. What is shown stays mounted, so a block someone opened stays open.
 * A search hit among the earlier ones is shown with `FOCUS_CONTEXT` messages above it and `FOCUS_AFTER` below, and
 * "Show later messages" adds `LATER_STEP` more at a time: the messages between the hit and the latest are not
 * mounted all at once either.
 *
 * What is shown is also only a part of what the server has: a conversation opens on the end of its history and the pages
 * above (or below, after a hit) are asked for as the reader goes there (see `HistoryControls`). The reader going up by
 * hand reveals what is held and the next page comes before they reach it: while `PREFETCH_SEGMENTS` or fewer held messages
 * are left above the shown ones, the page above them is on its way.
 */
const INITIAL_SEGMENTS = 30;
const EARLIER_STEP = 30;
const LATER_STEP = 30;
const FOCUS_CONTEXT = 3;
const FOCUS_AFTER = 30;
const PREFETCH_SEGMENTS = 60;
/** How near the top (or the bottom) of the messages the reader is when the next ones are brought in, in pixels. */
const NEAR_EDGE_PX = 600;

const NO_TOOLS: Record<string, ToolExec> = {};
const NO_OVERLAY: OverlayMessage[] = [];
/** The turn that has no saved row yet: what streams after a prompt is drawn as one, so that it is the one saved rows join. */
const NO_TURN: AgentTurn = { rows: [], entries: [], messages: [], toolIds: new Set() };
const NO_NOTICES: LiveNotice[] = [];
const NO_COMMAND_NOTES: CommandNote[] = [];

/** What the transcript asks of the history it shows a stretch of (see `store/history.ts`). */
export interface HistoryControls {
	/** There is history above / below the messages held. */
	earlier: boolean;
	later: boolean;
	loading: { earlier: boolean; later: boolean; first: boolean };
	/** Each resolves with whether a page was added (`loadFirst`: whether the start was reached). */
	loadEarlier(): Promise<boolean>;
	loadLater(): Promise<boolean>;
	loadFirst(): Promise<boolean>;
	/** The end of the conversation in place of a stretch that stops short of it. */
	showLatest(): Promise<void>;
}

interface Props {
	/** The scroll container this renders in: showing earlier messages keeps what the reader was looking at in place. */
	scroller: RefObject<HTMLDivElement | null>;
	/** The branch on screen, root to leaf. */
	path: SessionEntry[];
	/** The whole family's tree: it knows each message's other versions. */
	idx: TreeIndex;
	toolResults: ToolResults;
	live: LiveState | undefined;
	streaming: boolean;
	actions: MessageActions;
	/** An entry to reveal (a search hit): its message is shown even when it is among the earlier ones. */
	focusId: string | null;
	/** The conversation has a file; without one (a new chat) an empty transcript says how to start. */
	hasFile: boolean;
	/** What commands printed in this conversation: shown where each was run. */
	commandNotes?: CommandNote[];
	/** What goes above the messages: a failed load, "viewing an earlier branch". */
	before?: ReactNode;
	/**
	 * Start the conversation's omp again, now that it has ended (see `ExitNotice`): null when the conversation has no
	 * file to resume, and so nothing to reopen.
	 */
	onReopen?: (() => Promise<void>) | null;
	/** The messages to start with, as a view left earlier had them (see `lib/reading.ts`); the latest ones when absent. */
	restore?: ReadingWindow;
	/** The history the messages are a stretch of; none: they are all there is. */
	history?: HistoryControls;
	ref?: Ref<TranscriptHandle>;
}

export interface TranscriptHandle {
	/** The latest message is among those shown (a window around a search hit may end before it). */
	endShown(): boolean;
	/** Show the latest messages instead of a window that ends before them. */
	showLatest(): void;
	/** The messages shown now. */
	window(): ReadingWindow;
}

interface PromptRowProps {
	entry: SessionEntry;
	siblings: Siblings | undefined;
	toolResults: ToolResults;
	tools: Record<string, ToolExec>;
	actions: MessageActions;
}

/** A prompt has no tool calls: what the tools are doing is none of its business (see `sameRow`). */
const PromptRow = memo(
	function PromptRow({ entry, siblings, toolResults, tools, actions }: PromptRowProps) {
		const message = messageOf(entry);
		// What a command printed is a segment of its own (see `segmentTranscript`): it has no message.
		if (!message) return <EntryNote entry={entry} />;
		return (
			<MessageRow
				entry={entry}
				message={message}
				toolResults={toolResults}
				tools={tools}
				actions={actions}
				siblings={siblings}
			/>
		);
	},
	(a, b) => a.entry === b.entry && a.siblings === b.siblings && a.actions === b.actions,
);

/** A turn that did not change does not render again for the tokens of the one being written, nor for another tool's. */
const TurnRow = memo(AgentTurnBlock, sameTurn);

/** What a segment is drawn from, besides the segment: the same for every segment, and it changes rarely (a tool ended, a message was saved). */
interface SegmentContext {
	idx: TreeIndex;
	toolResults: ToolResults;
	tools: Record<string, ToolExec>;
	actions: MessageActions;
	focus: string | null;
	release: number;
	keys: LiveKeys;
}

/** What only the turn that streams has. */
interface LiveTurn {
	live: boolean;
	tail: ReactNode;
	overlay: OverlayMessage[];
	onEnd: (reachesEnd: boolean) => void;
}

/**
 * A segment's row. The wrapper names the message to the reader's position (see `lib/reading.ts`): its top is what is
 * measured. `live` is for the turn that streams: it is drawn again for every token, and every other row is not (see
 * `Transcript`, which draws them once).
 */
function segmentRow(s: Segment, c: SegmentContext, name: string, live?: LiveTurn): ReactElement {
	if (s.kind === "prompt") {
		const list = siblingsOf(c.idx, s.entry);
		// A prompt's other versions (an edited prompt).
		const siblings: Siblings | undefined =
			list.length > 1 ? { list, index: list.findIndex((x) => x.id === s.entry.id) } : undefined;
		return (
			<div key={s.entry.id} data-segment={s.entry.id}>
				<ErrorBoundary resetKey={s.entry} fallback={(error) => <MessageFailed error={error} />}>
					<PromptRow
						entry={s.entry}
						siblings={siblings}
						toolResults={c.toolResults}
						tools={c.tools}
						actions={c.actions}
					/>
				</ErrorBoundary>
			</div>
		);
	}
	// A turn that was joined at its head keeps the name (and so the element) it had: it is the same turn.
	const first = s.turn.rows[0];
	return (
		<div key={name === first.id ? c.keys.entry(first) : name} data-segment={name}>
			<ErrorBoundary resetKey={s.turn} fallback={(error) => <MessageFailed error={error} />}>
				<TurnRow
					turn={s.turn}
					toolResults={c.toolResults}
					tools={c.tools}
					actions={c.actions}
					live={live?.live ?? false}
					tail={live?.tail ?? null}
					overlay={live?.overlay ?? NO_OVERLAY}
					keys={c.keys}
					focus={c.focus}
					release={c.release}
					onEnd={live?.onEnd}
				/>
			</ErrorBoundary>
		</div>
	);
}

/** Segments are drawn in pages of this many: what the browser lays out, tests for a hit and watches for a token is a page, not a message. */
const PAGE_SEGMENTS = 30;

interface PageProps {
	segments: Segment[];
	/** The name of each segment (`Segmenter.keys`): what tells it from the others, and stays when it is joined at its head. */
	names: readonly string[];
	/** The segments of this page are `segments[from]` up to, not including, `segments[to]`. */
	from: number;
	to: number;
	context: SegmentContext;
	/** The turn that streams, when its segment is on this page. */
	live?: LiveTurn;
	/** What follows the last segment, when this page is the one the next message will be on: the turn that has no saved row yet. */
	pending?: ReactElement;
}

/**
 * Where the pages of segments are cut. A page is a fixed run of segments, counted from where the first page began; when
 * earlier messages are put in front of the first (a page of history above it) the cuts stay with the messages they were
 * between, and the new ones are cut from the old start upwards. Read during a render, so it only moves forward when the
 * first message changes: a render that is made twice gives the same answer.
 */
class PagesOrigin {
	private first: string | undefined;
	private origin = 0;

	cut(first: string | undefined, positions: ReadonlyMap<string, number>): number {
		if (first !== this.first) {
			// The messages put above the old first one, when it is still there; another list starts over.
			const moved = this.first === undefined ? undefined : positions.get(this.first);
			this.origin = moved === undefined ? 0 : this.origin + moved;
			this.first = first;
		}
		return this.origin;
	}
}

/**
 * The page's wrapper pads its segments so that paint containment (see `[data-page][data-drawn]` in index.css) does not
 * cut off what overflows them at the edges: a focus ring, the flash of a search hit. The negative margin takes the room back.
 */
const PAGE_CLASS = "-m-1 flex flex-col gap-5 p-1";

/**
 * A page that holds none of what changed is not drawn again for a token. The rows and the turn that has no saved row yet are
 * one list: when that turn is saved it is a row of the list, under the same key, and keeps its element.
 */
const SegmentPage = memo(
	function SegmentPage({ segments, names, from, to, context, live, pending }: PageProps) {
		const rows = segments
			.slice(from, to)
			.map((s, i) =>
				segmentRow(s, context, names[from + i] ?? segmentKey(s), from + i === segments.length - 1 ? live : undefined),
			);
		if (pending) rows.push(pending);
		// A page that gains messages at its top (earlier ones were revealed) is drawn in full again before the browser may skip
		// it: what it remembered of its height is the height it had. (The first message, not its place: a page of history put above
		// moves every place and no page's messages.)
		const box = useRef<HTMLDivElement>(null);
		const top = segments[from];
		// biome-ignore lint/correctness/useExhaustiveDependencies: the first message of the page changing is the trigger.
		useLayoutEffect(() => {
			box.current?.removeAttribute("data-drawn");
		}, [top]);
		return (
			<div ref={box} data-page className={PAGE_CLASS}>
				{rows}
			</div>
		);
	},
	(a, b) => {
		if (a.from !== b.from || a.to !== b.to || a.context !== b.context || a.live !== b.live || a.pending !== b.pending)
			return false;
		for (let i = a.from; i < a.to; i++) if (a.segments[i] !== b.segments[i] || a.names[i] !== b.names[i]) return false;
		return true;
	},
);

/**
 * A button at an end of the messages goes when that end is reached ("Show earlier messages" at the first message). What
 * held the keyboard focus gives it to the message that is now at that end, instead of letting it fall to the page, so that
 * a reader who pages with the keyboard goes on from where they are. `into` is the ref the page reads the element by.
 */
function useEdgeHandoff(
	into: { current: HTMLDivElement | null },
	content: RefObject<HTMLElement | null>,
	last: boolean,
): RefCallback<HTMLDivElement> {
	const lost = useRef(false);
	const ref = useCallback(
		(el: HTMLDivElement | null) => {
			// Detached: the focus is still in it here, and gone to the page a moment later.
			if (!el && into.current?.contains(document.activeElement)) lost.current = true;
			into.current = el;
		},
		[into],
	);
	useLayoutEffect(() => {
		if (!lost.current) return;
		lost.current = false;
		if (document.activeElement && document.activeElement !== document.body) return;
		const messages = content.current?.querySelectorAll<HTMLElement>("[data-entry-id]");
		const target = messages?.[last ? messages.length - 1 : 0];
		if (!target) return;
		target.tabIndex = -1;
		target.focus({ preventScroll: true });
	});
	return ref;
}

export function Transcript({
	scroller,
	path,
	idx,
	toolResults,
	live,
	streaming,
	actions,
	focusId,
	hasFile,
	commandNotes = NO_COMMAND_NOTES,
	before,
	onReopen = null,
	restore,
	history,
	ref,
}: Props) {
	const t = useT();
	const liveNotices = live?.notices ?? NO_NOTICES;
	// Rows announced while omp worked and what commands printed, in the order they came.
	const notices = useMemo(
		() => (commandNotes.length ? [...liveNotices, ...commandNotes].sort((a, b) => a.at - b.at) : liveNotices),
		[liveNotices, commandNotes],
	);
	// IRC messages still arriving: a live card for one of them gives way to the message itself.
	const streamedIrc = (live?.overlay ?? NO_OVERLAY)
		.flatMap((o) =>
			ircMode(o.message.customType) ? [ircKey(o.message.customType, o.message.details, o.message.timestamp)] : [],
		)
		.join("\n");
	// The list goes on from where it was as entries are added (see `Segmenter`); the turns that are what they were stay the objects they were.
	const segmenter = useMemo(() => new Segmenter(), []);
	const pagesOrigin = useMemo(() => new PagesOrigin(), []);
	const segments = useMemo(
		() => segmenter.update(path, idx, notices, streamedIrc ? streamedIrc.split("\n") : []),
		[segmenter, path, idx, notices, streamedIrc],
	);
	const { keys, positions } = segmenter;
	const focusAt = useMemo(
		() =>
			focusId
				? segments.findIndex((s) =>
						s.kind === "prompt" ? s.entry.id === focusId : s.turn.rows.some((e) => e.id === focusId),
					)
				: -1,
		[segments, focusId],
	);

	// The messages shown, by key (a branch switch or a new message must not move them): `from` is the first (null shows
	// from the start; undefined is before the first render) and `to` the last (null shows through the latest). A key
	// that is not on the branch on screen any more starts over.
	const [from, setFrom] = useState<string | null | undefined>(restore?.from);
	const [to, setTo] = useState<string | null>(restore?.to ?? null);
	const total = keys.length;
	const placed = from === null ? 0 : from === undefined ? undefined : positions.get(from);
	const placedTo = to === null ? undefined : positions.get(to);
	const earlierMore = history?.earlier ?? false;
	const laterMore = history?.later ?? false;
	const loadingEarlier = history?.loading.earlier ?? false;
	const loadingLater = history?.loading.later ?? false;
	const loadingFirst = history?.loading.first ?? false;
	let start = placed ?? Math.max(0, total - INITIAL_SEGMENTS);
	let end = placedTo === undefined ? total : placedTo + 1;
	// A hit outside what is shown: the window moves to it. Showing the messages between would mount them all.
	if (focusAt >= 0 && (focusAt < start || focusAt >= end)) {
		start = Math.max(0, focusAt - FOCUS_CONTEXT);
		end = Math.min(total, focusAt + FOCUS_AFTER + 1);
	}
	// A page above the first message (or below the last) that is still to come must not show itself when it does: the
	// messages shown are named by their keys, and the first one is not "the start" while there is more above it.
	const wantedFrom = start === 0 && (!earlierMore || total === 0) ? null : keys[start];
	const wantedTo = end >= total && (!laterMore || total === 0) ? null : keys[end - 1];
	if (wantedFrom !== from && (placed === undefined || start !== placed)) setFrom(wantedFrom);
	if (wantedTo !== to) setTo(wantedTo);

	// Whether the rows of the last turn reach its last (a window it keeps around a search hit may stop short of it).
	const rowsReachEnd = useRef(true);
	const reportRowsEnd = useCallback((reaches: boolean) => {
		rowsReachEnd.current = reaches;
	}, []);
	// Changes when the latest messages are asked for: every turn lets go of a window it kept for a search hit.
	const [release, setRelease] = useState(0);
	const now = useRef({ end, total, later: laterMore, window: { from: wantedFrom, to: wantedTo } });
	const historyRef = useRef(history);
	historyRef.current = history;
	useLayoutEffect(() => {
		now.current = { end, total, later: laterMore, window: { from: wantedFrom, to: wantedTo } };
		// What is not drawn reports nothing: only a last turn that is on screen can stop short of the end.
		if (end < total || segments.at(-1)?.kind !== "turn") rowsReachEnd.current = true;
	});
	useImperativeHandle(
		ref,
		() => ({
			endShown: () => now.current.end >= now.current.total && !now.current.later && rowsReachEnd.current,
			showLatest: () => {
				setRelease((n) => n + 1);
				if (now.current.later) void historyRef.current?.showLatest();
				else if (now.current.end >= now.current.total) return;
				setFrom(undefined);
				setTo(null);
			},
			window: () => now.current.window,
		}),
		[],
	);

	/**
	 * What the reader's place is kept by when earlier messages are shown: the height and scroll position before, and the
	 * first message (`from`) the reveal leads to. Applied in the render that shows it, not in one that merely came first: a page
	 * of history arriving puts `start` somewhere else in the same commit that asks for the reveal.
	 */
	const keep = useRef<{ height: number; top: number; from: string | null; anchor: EntryAnchor | null } | null>(null);
	const content = useRef<HTMLDivElement>(null);
	/** Holds the reader's message in place while what is above it settles (see `lib/entry-anchor.ts`). */
	const hold = useMemo(() => new AnchorHold(), []);
	useEffect(() => () => hold.stop(), [hold]);
	const showEarlier = () => {
		const el = scroller.current;
		const next = Math.max(0, start - EARLIER_STEP);
		const revealed = next === 0 && !earlierMore ? null : (keys[next] ?? null);
		if (el) keep.current = { height: el.scrollHeight, top: el.scrollTop, from: revealed, anchor: entryAnchor(el) };
		setFrom(revealed);
		// The page above the ones that are left is brought in before the reader gets there.
		if (earlierMore && next < PREFETCH_SEGMENTS) void history?.loadEarlier();
	};
	/** The first message that was shown when more was asked for above it: what is revealed when the page comes. */
	const revealFor = useRef<string | null>(null);
	const loadEarlierAndReveal = () => {
		if (!history) return;
		revealFor.current = keys[0] ?? null;
		// The reader got ahead of a page that is on its way: it is shown when it arrives, not by another click.
		if (loadingEarlier) return;
		void history.loadEarlier().then((added) => {
			if (!added) revealFor.current = null;
		});
	};
	useLayoutEffect(() => {
		const first = revealFor.current;
		if (first === null || !(positions.get(first) ?? 0)) return;
		revealFor.current = null;
		showEarlier();
	});
	// A conversation of thousands of messages is not read back thirty at a time: the first ones are one click away.
	const toTop = useRef(false);
	const jumpToFirst = () => {
		toTop.current = true;
		setFrom(null);
		setTo(total > INITIAL_SEGMENTS ? keys[INITIAL_SEGMENTS - 1] : null);
	};
	/** The way to the first message is being loaded: the jump is made when the start of the conversation is held. */
	const firstWanted = useRef(false);
	const showFirst = () => {
		if (!earlierMore) return jumpToFirst();
		firstWanted.current = true;
		void history?.loadFirst().then((reached) => {
			if (!reached) firstWanted.current = false;
		});
	};
	useLayoutEffect(() => {
		if (!firstWanted.current || earlierMore) return;
		firstWanted.current = false;
		jumpToFirst();
	});
	// biome-ignore lint/correctness/useExhaustiveDependencies: the window moving is the trigger.
	useLayoutEffect(() => {
		if (!toTop.current) return;
		toTop.current = false;
		if (scroller.current) scroller.current.scrollTop = 0;
	}, [start, end, scroller]);
	// Later messages are added below the reader, which moves nothing.
	const showLater = () => {
		const next = Math.min(total, end + LATER_STEP);
		setTo(next >= total && !laterMore ? null : keys[next - 1]);
		if (laterMore && total - next < PREFETCH_SEGMENTS) void history?.loadLater();
	};
	/** The last message shown when more was asked for below it. */
	const revealAfter = useRef<string | null>(null);
	const loadLaterAndReveal = () => {
		if (!history) return;
		revealAfter.current = keys[total - 1] ?? null;
		if (loadingLater) return;
		void history.loadLater().then((added) => {
			if (!added) revealAfter.current = null;
		});
	};
	useLayoutEffect(() => {
		const last = revealAfter.current;
		if (last === null || (positions.get(last) ?? total - 1) >= total - 1) return;
		revealAfter.current = null;
		showLater();
	});
	// The reader's hand scrolling toward the top or the bottom brings in what is beyond: the messages held, then the page after them.
	// An end the hand moves away from asks for nothing, and when the hand turns it must ask: the way is part of what the
	// observers below are made of, so that they report the end they are at again (they report an end only as it comes into view).
	const [handState, setHandState] = useState<{ moved: boolean; heading: Heading }>({ moved: false, heading: null });
	const { moved, heading: handHeading } = handState;
	const hand = useRef<HandScroll | null>(null);
	useEffect(() => {
		const el = scroller.current;
		if (!el) return;
		const watching = watchHandScroll(el, (moved, heading) => setHandState({ moved, heading }));
		hand.current = watching;
		return () => {
			watching.stop();
			hand.current = null;
		};
	}, [scroller]);
	const edges = useRef({ earlier: () => {}, later: () => {} });
	edges.current = {
		earlier: () => (start > 0 ? showEarlier() : loadEarlierAndReveal()),
		later: () => (end < total ? showLater() : loadLaterAndReveal()),
	};
	const topEdge = useRef<HTMLDivElement | null>(null);
	const bottomEdge = useRef<HTMLDivElement | null>(null);
	const topHandoff = useEdgeHandoff(topEdge, content, false);
	const bottomHandoff = useEdgeHandoff(bottomEdge, content, true);
	const aboveMore = start > 0 || earlierMore;
	const belowMore = end < total || laterMore;
	// biome-ignore lint/correctness/useExhaustiveDependencies: the window moving, and a page arriving or loading, make it look again.
	useEffect(() => {
		const root = scroller.current;
		const looks: [HTMLElement | null, string, "earlier" | "later"][] = [
			[aboveMore ? topEdge.current : null, `${NEAR_EDGE_PX}px 0px 0px 0px`, "earlier"],
			[belowMore ? bottomEdge.current : null, `0px 0px ${NEAR_EDGE_PX}px 0px`, "later"],
		];
		const observers = looks.flatMap(([el, margin, which]) => {
			if (!el || !root) return [];
			const observer = new IntersectionObserver(
				([entry]) => {
					if (!entry?.isIntersecting || !moved) return;
					// A reader going away from this end (down, for the top) is not asking for what lies beyond it.
					if (hand.current?.heading() === (which === "earlier" ? "down" : "up")) return;
					edges.current[which]();
				},
				{ root, rootMargin: margin },
			);
			observer.observe(el);
			return [observer];
		});
		return () => {
			for (const observer of observers) observer.disconnect();
		};
	}, [aboveMore, belowMore, start, end, total, loadingEarlier, loadingLater, moved, handHeading, scroller]);
	// Earlier messages are added above the reader: move the scroll position down by what was added.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `start` is the trigger; the measurements come from showEarlier.
	useLayoutEffect(() => {
		const before = keep.current;
		const el = scroller.current;
		// Not this render's: the messages it asked to show are not drawn yet.
		if (before && before.from !== from) return;
		keep.current = null;
		if (!before || !el) return;
		// The message the reader was on is put back where it was; the height that was added is what is used when it is not drawn.
		if (before.anchor && placeEntryAnchor(el, before.anchor)) {
			if (content.current) hold.arm(el, content.current, before.anchor);
		} else el.scrollTop = before.top + (el.scrollHeight - before.height);
	}, [start, scroller, hold]);
	const endShown = end >= total && !laterMore;
	// A question the list could not keep (#650) is said in the conversation: the row below (and, for a page that is not
	// showing it, the toast of `lib/question-dropped.ts`). One toast per drop, whichever page is on screen.
	const dropped = live?.info.questionDropped;
	useEffect(() => {
		if (dropped) toastQuestionDropped(dropped);
	}, [dropped]);

	const tools = live?.tools ?? NO_TOOLS;
	const persisted = useMemo(() => savedTimestamps(path), [path]);
	const overlay = live?.overlay ?? NO_OVERLAY;
	const pendingOverlay = overlay.filter((o) => !(o.message.timestamp && persisted.has(o.message.timestamp)));
	// A streamed message and the entry omp saves for it are one row (see `LiveKeys`): noted before the rows are keyed.
	const liveKeys = useMemo(() => new LiveKeys(), []);
	liveKeys.note(overlay);
	// What follows the messages of a live turn: the typing dots, and the running stats.
	const liveTail = (
		<>
			{streaming && !pendingOverlay.some((o) => !o.ended) ? <TypingDots /> : null}
			{streaming && live ? <LiveTurnStats live={live} /> : null}
		</>
	);

	// Every row but the one that streams is drawn from what changes rarely, and is drawn once: a token is not work for
	// every message that was opened.
	const context = useMemo<SegmentContext>(
		() => ({ idx, toolResults, tools, actions, focus: focusId, release, keys: liveKeys }),
		[idx, toolResults, tools, actions, focusId, release, liveKeys],
	);
	const lastTurn = endShown && segments.at(-1)?.kind === "turn";
	const liveTurn: LiveTurn | undefined = lastTurn
		? { live: streaming, tail: liveTail, overlay: pendingOverlay, onEnd: reportRowsEnd }
		: undefined;
	// What streams when the conversation's last row is a prompt is a turn that has no saved row yet. It is drawn as the
	// turn it will be, under the key that turn will have, so that it is not drawn anew when its first row is saved: on
	// the page that row will be on, too.
	const showPending = endShown && segments.at(-1)?.kind !== "turn" && (pendingOverlay.length > 0 || streaming);
	const pendingTurn = showPending ? (
		<div key={pendingOverlay[0] ? liveKeys.overlay(pendingOverlay[0]) : "live-turn"}>
			<ErrorBoundary resetKey={null} fallback={(error) => <MessageFailed error={error} />}>
				<TurnRow
					turn={NO_TURN}
					toolResults={toolResults}
					tools={tools}
					actions={actions}
					live={streaming}
					tail={liveTail}
					overlay={pendingOverlay}
					keys={liveKeys}
				/>
			</ErrorBoundary>
		</div>
	) : undefined;
	const pages: ReactElement[] = [];
	// Pages are cut where they were: a page that was drawn and measured keeps its messages when earlier ones are added above
	// it, so what the browser remembered of its height is still true (the pages above it are new ones, numbered below it).
	const cut = pagesOrigin.cut(keys[0], positions);
	for (let p = Math.floor((start - cut) / PAGE_SEGMENTS); p * PAGE_SEGMENTS + cut < end + (showPending ? 1 : 0); p++) {
		const from = Math.max(start, p * PAGE_SEGMENTS + cut);
		const to = Math.min(end, (p + 1) * PAGE_SEGMENTS + cut);
		pages.push(
			<SegmentPage
				key={p}
				segments={segments}
				names={keys}
				from={from}
				to={to}
				context={context}
				live={total - 1 >= from && total - 1 < to ? liveTurn : undefined}
				pending={Math.floor((total - cut) / PAGE_SEGMENTS) === p ? pendingTurn : undefined}
			/>,
		);
	}
	// A page is drawn in full once, so that the browser knows its height; a frame later it may skip drawing it while it is
	// off screen (see `[data-page][data-drawn]` in index.css). Two frames: the height is taken after the first is laid out.
	// biome-ignore lint/correctness/useExhaustiveDependencies: the pages that are drawn are the trigger.
	useEffect(() => {
		let second = 0;
		const first = requestAnimationFrame(() => {
			second = requestAnimationFrame(() => {
				for (const el of content.current?.querySelectorAll<HTMLElement>("[data-page]:not([data-drawn])") ?? [])
					el.dataset.drawn = "";
			});
		});
		return () => {
			cancelAnimationFrame(first);
			cancelAnimationFrame(second);
		};
	}, [segments, start, end, showPending]);

	return (
		// Short of the latest message, "Scroll to bottom" floats over the bottom of the view: "Show later messages" stays above it.
		<div
			ref={content}
			className={`mx-auto flex max-w-3xl flex-col gap-5 px-4 pt-6 [overflow-anchor:none] sm:px-6 ${endShown ? "pb-6" : "pb-20"}`}
		>
			{before}
			{aboveMore ? (
				<div ref={topHandoff} className="flex flex-wrap items-center justify-center gap-2">
					<button
						type="button"
						data-testid="show-earlier"
						className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-muted hover:bg-hover hover:text-fg"
						aria-busy={start === 0 && loadingEarlier}
						onClick={start > 0 ? showEarlier : loadEarlierAndReveal}
					>
						{start > 0 ? (
							t("chat.showEarlier", { n: start })
						) : loadingEarlier ? (
							<>
								<Spinner size={12} /> {t("chat.loadingHistory")}
							</>
						) : (
							t("chat.loadEarlier")
						)}
					</button>
					{start > EARLIER_STEP || earlierMore ? (
						<button
							type="button"
							data-testid="show-first"
							className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-muted hover:bg-hover hover:text-fg"
							aria-busy={loadingFirst}
							onClick={showFirst}
						>
							{loadingFirst ? <Spinner size={12} /> : null}
							{t("chat.showFirst")}
						</button>
					) : null}
				</div>
			) : null}
			{pages}
			{belowMore ? (
				<div ref={bottomHandoff} className="flex justify-center">
					<button
						type="button"
						data-testid="show-later"
						className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-muted hover:bg-hover hover:text-fg"
						aria-busy={end >= total && loadingLater}
						onClick={end < total ? showLater : loadLaterAndReveal}
					>
						{end < total ? (
							t("chat.showLater", { n: total - end })
						) : loadingLater ? (
							<>
								<Spinner size={12} /> {t("chat.loadingHistory")}
							</>
						) : (
							t("chat.loadLater")
						)}
					</button>
				</div>
			) : null}
			{endShown && live?.lastError ? (
				<div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 p-3 text-sm text-danger">
					<CircleAlert size={16} className="mt-0.5 shrink-0" /> {live.lastError}
				</div>
			) : null}
			{endShown && live?.info.slept ? <SleptNote note={live.info.slept} /> : null}
			{endShown && live?.info.questionDropped ? <QuestionDroppedNote note={live.info.questionDropped} /> : null}
			{endShown && live?.info.quotaHold ? (
				// A chunk that is gone leaves the line out (the page stays); it is asked for again when the state changes.
				<ErrorBoundary fallback={() => null} resetKey={live.info.quotaHold.state} onError={retryQuotaHoldNote}>
					<Suspense fallback={null}>
						<QuotaHoldNote liveId={live.info.liveId} hold={live.info.quotaHold} />
					</Suspense>
				</ErrorBoundary>
			) : null}
			{endShown && live?.exited ? <ExitNotice live={live} onReopen={onReopen} /> : null}
			{!hasFile && !segments.length && !pendingOverlay.length ? (
				<div className="py-16 text-center text-sm text-muted">{t("chat.emptyStart")}</div>
			) : null}
		</div>
	);
}
