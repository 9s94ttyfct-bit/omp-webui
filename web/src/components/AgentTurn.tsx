import { ChevronRight, CircleAlert, OctagonAlert, Wrench } from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { atEndOf } from "../lib/follow-end.ts";
import { fmtDuration } from "../lib/format.ts";
import { LiveKeys } from "../lib/live-keys.ts";
import { type AgentMessage, blocks, messageOf, type ToolResults, textOf } from "../lib/messages.ts";
import { blockerCount, isPinned } from "../lib/notices.ts";
import { unresolvedStop } from "../lib/retry.ts";
import type { AgentTurn } from "../lib/turns.ts";
import { useApp } from "../store/app.ts";
import type { OverlayMessage, ToolExec } from "../store/live.ts";
import { changedTools, EntryNote, type MessageActions, MessageRow, sameToolState, TurnFooter } from "./Message.tsx";
import { cx } from "./ui.tsx";

/** Collapse a finished turn's intermediate work once it has this many steps and tool calls. */
const MIN_STEPS = 3;
const MIN_TOOL_CALLS = 2;

const NO_OVERLAY: readonly OverlayMessage[] = [];
/** No streamed message was noted: every saved row is keyed by its own id. */
const NO_KEYS = new LiveKeys();

interface WorkStats {
	toolCalls: number;
	/** Tool calls that ended in an error. */
	failed: number;
	/** Notes the advisor marked as blocking. */
	blockers: number;
	/** How the turn's last step ended when it failed or was interrupted (that step stays on screen, apart from the folded ones). */
	ended: "error" | "aborted" | null;
	byTool: [string, number][];
	durationMs: number;
}

/**
 * How a step left its turn unfinished: it failed or was stopped, or a tool call of it was never answered (omp was killed
 * while the tool ran). Null for one that ended as steps do.
 */
function unfinished(
	m: AgentMessage,
	toolResults: ToolResults,
	tools: Record<string, ToolExec>,
): "error" | "aborted" | null {
	const unanswered = blocks(m).some((b) => b.type === "toolCall" && b.id && !toolResults.get(b.id) && !tools[b.id]);
	return unresolvedStop(m) ?? (unanswered ? "aborted" : null);
}

/**
 * What the folded steps did: the tool calls of every step before the answer, or before the step the turn ended on when
 * that one is kept (`tail`: its index, or -1; `ended`: how it ended), except the answer's own, which are on screen.
 */
function workStats(
	turn: AgentTurn,
	answer: number,
	tail: number,
	ended: WorkStats["ended"],
	toolResults: ToolResults,
	tools: Record<string, ToolExec>,
): WorkStats {
	const counts = new Map<string, number>();
	let toolCalls = 0;
	let failed = 0;
	const before = tail >= 0 ? tail : answer;
	for (const [i, m] of turn.messages.slice(0, before).entries()) {
		if (i === answer) continue;
		for (const b of blocks(m)) {
			if (b.type !== "toolCall") continue;
			toolCalls++;
			// The verdict the tool card shows: the saved result, else the live one.
			if (b.id && (toolResults.get(b.id)?.isError ?? tools[b.id]?.isError)) failed++;
			const name = b.name ?? "tool";
			counts.set(name, (counts.get(name) ?? 0) + 1);
		}
	}
	// The turn's own clock: notices announced live carry this browser's.
	const stamped = turn.rows.filter((e) => e.type !== "live_notice");
	const first = stamped[0]?.timestamp;
	const last = stamped.at(-1)?.timestamp;
	return {
		toolCalls,
		failed,
		blockers: blockerCount(turn.rows),
		ended,
		byTool: [...counts.entries()].sort((a, b) => b[1] - a[1]),
		durationMs: first && last ? Math.max(0, Date.parse(last) - Date.parse(first)) : 0,
	};
}

/** Index (in turn.messages) of the message holding the final answer: the last one with text. */
function answerIndex(messages: AgentMessage[]): number {
	for (let i = messages.length - 1; i >= 0; i--) if (textOf(messages[i]).trim()) return i;
	return messages.length - 1;
}

/**
 * Rows of a turn drawn when it has more. A goal run is one turn of thousands of steps (omp's own reminders do not end a
 * turn), and every row on screen is work for every frame it streams: the page spent more than the steps took.
 */
const ROWS_SHOWN = 60;
/** Rows "Show earlier steps" adds; the rows of a turn that grows leave from the top in blocks of this many. */
const ROWS_STEP = 60;
/** Rows kept above a search hit that was among the hidden ones. */
const FOCUS_CONTEXT = 3;

/**
 * The first of `total` rows to draw: all of them when `shown` is enough, else the last `shown` or a block more, so a
 * turn that grows moves its window once in `ROWS_STEP` rows and not on every one.
 */
export function windowStart(total: number, shown: number): number {
	return shown >= total ? 0 : Math.floor((total - shown) / ROWS_STEP) * ROWS_STEP;
}

/**
 * The window of a turn that is drawn to its end: its `saved` rows, then the `streamed` messages omp has sent and the page
 * has not read back as entries yet, as one list. What streams is windowed with the rest: on a page that is behind a fast
 * run, the read of the entries waits behind the frames, and the messages it has not saved pile up at the end (dozens),
 * each drawn on every frame, so the more behind the page is, the slower it gets. A message that is saved leaves the end
 * and joins the rows: the total, and so the window, stays where it was. `savedFrom`, `streamedFrom`: the first of each
 * to draw.
 */
export function windowOf(
	saved: number,
	streamed: number,
	shown: number,
): { start: number; savedFrom: number; streamedFrom: number } {
	const start = windowStart(saved + streamed, shown);
	return { start, savedFrom: Math.min(start, saved), streamedFrom: Math.max(0, start - saved) };
}

/** A window a reader asked for: the rows from `from` through `to` (by id, so that it stays where it is as the turn grows); `to` null: through the last. */
export interface PinnedRows {
	from: string;
	to: string | null;
}

/**
 * The rows to draw around a search hit (the `hit`th of `total`) that is among those the window leaves out: a block of rows
 * with a few before the hit, not everything from there to the end (a turn can have thousands). Null when the window already
 * draws it. Pure; `pinnedRows` keeps what it says.
 */
export function windowAround(total: number, shown: number, hit: number): { from: number; to: number } | null {
	if (hit < 0 || hit >= total || hit >= windowStart(total, shown)) return null;
	const from = Math.max(0, Math.floor((hit - FOCUS_CONTEXT) / ROWS_STEP) * ROWS_STEP);
	return { from, to: Math.min(total, from + ROWS_SHOWN + ROWS_STEP) };
}

/** Where a pinned window is among `rows` (`end` exclusive), or null when its first row is not among them any more. */
export function pinnedRange(rows: readonly { id: string }[], pin: PinnedRows): { start: number; end: number } | null {
	const start = rows.findIndex((e) => e.id === pin.from);
	if (start < 0) return null;
	if (pin.to === null) return { start, end: rows.length };
	const last = rows.findIndex((e, i) => i >= start && e.id === pin.to);
	return { start, end: last < 0 ? rows.length : last + 1 };
}

/** Whether nothing is running that could still start or answer a saved step's tool calls: its turn is not streaming, or a later step followed. */
function idleRow(live: boolean, row: { id: string }, turn: AgentTurn): boolean {
	return !live || row.id !== turn.entries.at(-1)?.id;
}

/**
 * The row of this turn at the top of the view, and where its top is, when the reader is inside the turn and not following
 * the end of the transcript (the chat page says so, on the view: a measure of the distance to the end is not the same
 * while a run adds rows faster than the page scrolls to them); null otherwise.
 */
function readerPlace(turn: HTMLElement | null): { el: Element; top: number } | null {
	const view = turn?.closest<HTMLElement>('[data-testid="transcript"]');
	if (!turn || !view || view.dataset.following !== "false") return null;
	const shown = view.getBoundingClientRect();
	for (const row of turn.children) {
		const box = row.getBoundingClientRect();
		if (box.bottom > shown.top + 1) return box.top < shown.bottom ? { el: row, top: box.top } : null;
	}
	return null;
}

/** Whether a step before the answer holds thinking the reader would not see in a folded turn. */
function thinksBeforeAnswer(turn: AgentTurn, answerId: string | undefined): boolean {
	return turn.rows.some((e) => {
		const m = messageOf(e);
		return (
			e.id !== answerId &&
			m !== null &&
			blocks(m).some((b) => b.type === "thinking" && !b.narration && b.thinking?.trim())
		);
	});
}

interface TurnBlockProps {
	turn: AgentTurn;
	toolResults: ToolResults;
	tools: Record<string, ToolExec>;
	actions: MessageActions;
	/** The turn is still streaming (no collapse, no footer). */
	live: boolean;
	/** What follows the rows of a live turn: the typing dots, the running stats. */
	tail?: ReactNode;
	/** The messages streaming into the turn that omp has not saved yet: drawn after its rows, and replaced in place by the saved row. */
	overlay?: readonly OverlayMessage[];
	/** What a row is keyed by, so that a streamed message and the saved entry that replaces it are one row. */
	keys?: LiveKeys;
	/** An entry that must be visible (search target): the turn opens, and draws the rows around it, if it is a hidden step. */
	focus?: string | null;
	/** Changes when the reader asks for the latest messages (a send, the arrow at the bottom): a window kept for a search hit goes. */
	release?: number;
	/** Told, after each draw, whether the turn's rows reach its last (the last turn tells Transcript whether the end is shown). */
	onEnd?: (reachesEnd: boolean) => void;
}

/**
 * A turn is drawn again when it changed, or when the saved result or live state of one of its own tool calls did: the
 * maps of every tool in the conversation are new objects whenever any of them moves (see `sameRow`).
 */
export function sameTurn(a: TurnBlockProps, b: TurnBlockProps): boolean {
	if (
		a.turn !== b.turn ||
		a.actions !== b.actions ||
		a.live !== b.live ||
		a.tail !== b.tail ||
		a.overlay !== b.overlay ||
		a.keys !== b.keys ||
		a.focus !== b.focus ||
		a.release !== b.release ||
		a.onEnd !== b.onEnd
	)
		return false;
	if (a.toolResults === b.toolResults && a.tools === b.tools) return true;
	// The tools that moved (a handful), and whether one of them is a call of this turn: not a look at every call of it.
	const changed = changedTools(a, b);
	if (changed === null) return sameToolState(a, b, b.turn.messages);
	for (const id of changed) if (b.turn.toolIds.has(id)) return false;
	return true;
}

export function AgentTurnBlock({
	turn,
	toolResults,
	tools,
	actions,
	live,
	tail,
	overlay = NO_OVERLAY,
	keys = NO_KEYS,
	focus,
	release,
	onEnd,
}: TurnBlockProps) {
	const t = useT();
	const keepThinkingOpen = useApp((s) => s.keepThinkingOpen);
	// An explicit choice (a click, or a search target that sits in a hidden step) beats the setting.
	const [chosen, setChosen] = useState<boolean | null>(() =>
		focus && turn.rows.some((e) => e.id === focus) ? true : null,
	);
	const [shown, setShown] = useState(ROWS_SHOWN);
	/** The rows the reader asked for (a search hit among the hidden ones), kept after the hit is no longer the focus. */
	const [pin, setPin] = useState<PinnedRows | null>(null);
	// A turn that ends while the reader is inside it, away from the end they follow, stays open: folding its steps would
	// remove the card or the paragraph they are reading and throw the view to the end of the turn. It folds when they
	// reach the end or ask for the latest messages (a send), or when they fold it themselves.
	const root = useRef<HTMLDivElement>(null);
	const anchor = useRef<{ el: Element; top: number } | null>(null);
	// Whether the reader moved the view by hand while the turn ran: a view that is merely behind a run that adds rows faster
	// than the page scrolls to them is not a reader (they get the fold).
	const scrolledByHand = useRef(false);
	useEffect(() => {
		const view = live ? root.current?.closest<HTMLElement>('[data-testid="transcript"]') : null;
		if (!view) return;
		const moved = () => {
			scrolledByHand.current = true;
		};
		const keys = (e: KeyboardEvent) => {
			if (["PageUp", "ArrowUp", "Home", "PageDown", "ArrowDown", "End", " "].includes(e.key)) moved();
		};
		view.addEventListener("wheel", moved, { passive: true });
		view.addEventListener("touchmove", moved, { passive: true });
		view.addEventListener("keydown", keys);
		// A drag of the scrollbar is a press on the view itself, not on what is in it.
		const press = (e: PointerEvent) => {
			if (e.target === view) moved();
		};
		view.addEventListener("pointerdown", press);
		return () => {
			view.removeEventListener("wheel", moved);
			view.removeEventListener("touchmove", moved);
			view.removeEventListener("keydown", keys);
			view.removeEventListener("pointerdown", press);
		};
	}, [live]);
	const [held, setHeld] = useState(false);
	const [wasLive, setWasLive] = useState(live);
	if (wasLive !== live) {
		setWasLive(live);
		const place = wasLive && !live && scrolledByHand.current ? readerPlace(root.current) : null;
		if (place) {
			anchor.current = place;
			setHeld(true);
		}
	}
	useEffect(() => {
		const view = held ? root.current?.closest<HTMLElement>('[data-testid="transcript"]') : null;
		if (!view) return;
		const follows = () => {
			// The chat page's own measure: a reader follows the end again where it says they are at it, and not before.
			if (atEndOf(view)) setHeld(false);
		};
		view.addEventListener("scroll", follows, { passive: true });
		return () => view.removeEventListener("scroll", follows);
	}, [held]);
	// The summary row (and whatever else a finished turn adds above the steps) pushes the reader's place down as the turn
	// ends: the view moves with the row they were on, by what it moved.
	useLayoutEffect(() => {
		const place = anchor.current;
		anchor.current = null;
		const view = held ? root.current?.closest<HTMLElement>('[data-testid="transcript"]') : null;
		if (place && view) view.scrollTop += place.el.getBoundingClientRect().top - place.top;
	}, [held]);
	const answer = answerIndex(turn.messages);
	const answerEntry = turn.entries[answer];
	// A turn whose last step failed, was stopped, or left tool calls unanswered has no text to be the answer after it: how
	// it ended is what it ended with, and that step stays on screen (with its Retry or Continue) when the steps fold.
	const last = turn.messages.length - 1;
	const ended = last > answer && !live ? unfinished(turn.messages[last], toolResults, tools) : null;
	const failed = ended ? last : -1;
	const failedEntry = failed >= 0 ? turn.entries[failed] : undefined;
	// A turn that is still running does not fold, and what folds needs the figures of its work.
	const foldable = !live && turn.entries.length >= MIN_STEPS && answer > 0;
	const stats = foldable ? workStats(turn, answer, failed, ended, toolResults, tools) : null;
	const collapsible = stats !== null && stats.toolCalls >= MIN_TOOL_CALLS;
	// Folded steps would hide their thinking from someone who asked to keep it expanded: open the turn instead.
	const expanded = chosen ?? (held || (keepThinkingOpen && collapsible && thinksBeforeAnswer(turn, answerEntry?.id)));
	const collapsed = collapsible && !expanded;
	// The answer stays, and so does what the reader must not miss (a failed end, an advisor's blockers, a model fallback).
	const visibleRows = collapsed
		? turn.rows.filter((e) => e.id === answerEntry?.id || e.id === failedEntry?.id || isPinned(e))
		: turn.rows;

	// A search hit in this turn: the turn opens, and the rows around the hit are drawn and stay so. The page clears its
	// focus right after scrolling to the hit; what it asked for must not go with it. The same hit asked for again is a new
	// request: the focus goes null in between.
	const [handled, setHandled] = useState<string | null>(null);
	if (focus !== (handled ?? null) && (focus || handled)) {
		setHandled(focus ?? null);
		const hit = focus ? turn.rows.findIndex((e) => e.id === focus) : -1;
		if (hit >= 0) {
			if (!chosen) setChosen(true);
			// The hit among the rows as they are once the turn is open (all of them).
			const around = windowAround(turn.rows.length, shown, hit);
			if (around)
				setPin({
					from: turn.rows[around.from].id,
					to: around.to >= turn.rows.length ? null : turn.rows[around.to - 1].id,
				});
			else setPin(null);
		}
	}
	// The latest messages were asked for: the window goes.
	const [released, setReleased] = useState(release);
	if (release !== released) {
		setReleased(release);
		setPin(null);
		setHeld(false);
	}

	const range = pin ? pinnedRange(visibleRows, pin) : null;
	// A window the reader pinned is theirs: what streams is drawn whole after it, when it reaches the end.
	const drawn = range
		? { start: range.start, savedFrom: range.start, streamedFrom: 0 }
		: windowOf(visibleRows.length, overlay.length, shown);
	const { start } = drawn;
	const end = range ? range.end : visibleRows.length;
	const reachesEnd = end >= visibleRows.length;
	const reported = useRef(onEnd);
	reported.current = onEnd;
	useLayoutEffect(() => reported.current?.(reachesEnd));

	// Earlier rows are added above the reader: move the scroll position down by what was added.
	const earlier = useRef<HTMLButtonElement>(null);
	const keep = useRef<{ scroller: HTMLElement; height: number; top: number } | null>(null);
	const showEarlier = () => {
		const scroller = earlier.current?.closest<HTMLElement>('[data-testid="transcript"]');
		if (scroller) keep.current = { scroller, height: scroller.scrollHeight, top: scroller.scrollTop };
		if (range) {
			const from = Math.max(0, range.start - ROWS_STEP);
			setPin({ from: visibleRows[from].id, to: pin?.to ?? null });
		} else setShown(visibleRows.length + overlay.length - start + ROWS_STEP);
	};
	// Later rows are added below the reader, which moves nothing. A window that reaches the last row is the ordinary one
	// again: it goes on from where it stood, a block at a time, as the turn grows.
	const showLater = () => {
		if (!range || !pin) return;
		const to = Math.min(visibleRows.length, range.end + ROWS_STEP);
		if (to >= visibleRows.length) {
			setShown(visibleRows.length + overlay.length - range.start);
			setPin(null);
		} else setPin({ from: pin.from, to: visibleRows[to - 1].id });
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: `start` is the trigger; the measurements come from showEarlier.
	useLayoutEffect(() => {
		const before = keep.current;
		keep.current = null;
		if (before) before.scroller.scrollTop = before.top + (before.scroller.scrollHeight - before.height);
	}, [start]);

	return (
		<div ref={root} className="flex flex-col gap-2" data-testid="agent-turn">
			{collapsible && stats ? (
				<button
					type="button"
					data-testid="work-summary"
					aria-expanded={expanded}
					onClick={() => setChosen(!expanded)}
					className="flex w-fit items-center gap-2 rounded-lg px-2 py-1 text-xs text-muted hover:bg-hover hover:text-fg"
				>
					<ChevronRight size={13} className={cx("transition-transform", expanded && "rotate-90")} />
					<Wrench size={13} />
					<span>
						{stats.durationMs ? t("chat.turnWorkedFor", { duration: fmtDuration(stats.durationMs) }) : ""}
						{t(stats.toolCalls === 1 ? "chat.turnToolCall" : "chat.turnToolCalls", { n: stats.toolCalls })}
						{stats.failed ? (
							<>
								{" · "}
								<span className="text-danger" data-testid="work-failed">
									<CircleAlert size={13} className="mr-1 inline align-text-bottom" aria-hidden />
									{t("chat.turnFailed", { n: stats.failed })}
								</span>
							</>
						) : null}
						{stats.ended ? (
							<>
								{" · "}
								<span className="text-danger" data-testid="work-ended">
									<CircleAlert size={13} className="mr-1 inline align-text-bottom" aria-hidden />
									{t(stats.ended === "aborted" ? "chat.turnEndedAborted" : "chat.turnEndedError")}
								</span>
							</>
						) : null}
						{stats.blockers ? (
							<>
								{" · "}
								<span className="text-danger" data-testid="work-blockers">
									<OctagonAlert size={13} className="mr-1 inline align-text-bottom" aria-hidden />
									{t(stats.blockers === 1 ? "chat.turnBlocker" : "chat.turnBlockers", { n: stats.blockers })}
								</span>
							</>
						) : null}
					</span>
					<span className="text-faint">{stats.byTool.map(([n, c]) => `${c} ${n}`).join(" · ")}</span>
				</button>
			) : null}
			{start > 0 ? (
				<button
					ref={earlier}
					type="button"
					data-testid="show-earlier-steps"
					className="mx-auto rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-muted hover:bg-hover hover:text-fg"
					onClick={showEarlier}
				>
					{t("chat.turnShowEarlier", { n: start })}
				</button>
			) : null}
			{[
				...visibleRows.slice(drawn.savedFrom, end).map((e) => {
					const m = messageOf(e);
					if (!m) return <EntryNote key={e.id} entry={e} />;
					return (
						<MessageRow
							key={keys.entry(e)}
							entry={e}
							message={m}
							toolResults={toolResults}
							tools={tools}
							actions={actions}
							idle={idleRow(live, e, turn)}
						/>
					);
				}),
				// In the same list as the saved rows, under the key the saved row will have: when omp saves the message, its row
				// is the one that was streaming, not a new one.
				...(reachesEnd
					? overlay
							.slice(drawn.streamedFrom)
							.map((o) => (
								<MessageRow
									key={keys.overlay(o)}
									entry={null}
									message={o.message}
									toolResults={toolResults}
									tools={tools}
									actions={actions}
									streaming={!o.ended}
									idle={!live}
									readOnly
								/>
							))
					: []),
			]}
			{!reachesEnd ? (
				<button
					type="button"
					data-testid="show-later-steps"
					className="mx-auto rounded-full border border-border bg-surface px-3 py-1.5 text-xs text-muted hover:bg-hover hover:text-fg"
					onClick={showLater}
				>
					{t("chat.turnShowLater", { n: visibleRows.length - end })}
				</button>
			) : null}
			{reachesEnd ? tail : null}
			{reachesEnd && turn.entries.length && !live ? (
				<TurnFooter entries={turn.entries} messages={turn.messages} actions={actions} siblings={turn.siblings} />
			) : null}
		</div>
	);
}
