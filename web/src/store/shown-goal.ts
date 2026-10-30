import { type Goal, goalHeld } from "@shared/goal.ts";
import { create } from "zustand";
import { liveFor, useApp, type View } from "./app.ts";
import type { LiveState } from "./live.ts";

/**
 * The goal the conversation on screen holds, and the one place that says whether a goal is held there at all.
 *
 * The chat view knows it: the goal the running omp holds, or, when no omp runs for the conversation, the one its
 * transcript leaves (a goal set and paused in the terminal). The header's Goal control, the ⋯ menu's row and the
 * command palette's entry all read this one answer, so they cannot disagree about what the conversation holds: an
 * entry labelled "Set a goal" beside a header that reads "Current goal" would offer a goal omp would refuse
 * (`A goal is already active`).
 *
 * What is published belongs to one conversation, named by its key, so a reader takes it only for that conversation: a
 * goal of the conversation before is never shown for the one after it.
 */

interface Shown {
	/** The goal of the conversation on screen; null where it holds none. */
	goal: Goal | null;
	/** The conversation it belongs to (see `conversationKey`); null when none is shown. */
	of: string | null;
}

export const useShownGoal = create<Shown>(() => ({ goal: null, of: null }));

/**
 * What names a conversation: the process that holds it, else the file it is in. A conversation of the terminal has a
 * file, a running one may have only a process; the file of a running one is its own.
 */
export function conversationKey(file: string | null, live: LiveState | undefined): string | null {
	const liveId = live && !live.info.exited ? live.info.liveId : null;
	if (liveId) return `live:${liveId}`;
	if (file) return `file:${file}`;
	return null;
}

/**
 * The conversation a view shows: the process it names, else the one running its file (as the chat view finds it), and
 * the file it is in.
 */
export function conversationOfView(view: View): { file: string | null; live: LiveState | undefined } {
	if (view.kind !== "chat") return { file: null, live: undefined };
	const live = (view.liveId ? useApp.getState().lives[view.liveId] : undefined) ?? liveFor(view.file);
	return { file: live?.info.sessionFile ?? view.file, live };
}

/**
 * What the conversation on screen holds, as the chat view worked it out: the goal, and the conversation it belongs to.
 * A goal that is not one omp holds (one that ended) is none.
 */
export function showGoal(goal: Goal | null, of: string | null): void {
	const held = goalHeld(goal) ? goal : null;
	const state = useShownGoal.getState();
	if (state.goal === held && state.of === of) return;
	useShownGoal.setState({ goal: held, of });
}

/**
 * Take the answer back when the page leaves that conversation. A conversation that has been left is not the one on
 * screen, so its answer is none; an answer of another conversation (the one shown in the meantime) is left alone.
 */
export function clearGoal(of: string | null): void {
	const state = useShownGoal.getState();
	if (state.of !== of) return;
	useShownGoal.setState({ goal: null, of: null });
}
