import { working } from "@shared/attention.ts";
import { type Goal, goalHeld } from "@shared/goal.ts";
import {
	type GoalProposal,
	goalObjective,
	hostResult,
	INTERVIEW_LANGUAGES,
	interviewPrompt,
	PROPOSAL_RESULTS,
	PROPOSE_GOAL_TOOL,
	parseInterviewPrompt,
	proposeGoalTool,
} from "@shared/guided-goal.ts";
import { useEffect, useRef } from "react";
import { t, useLang } from "../i18n/index.ts";
import { answerDialog, continueConversation, noteGoal, refreshState, useApp } from "../store/app.ts";
import type { LiveState } from "../store/live.ts";
import { summarizeTodos } from "./todos.ts";
import { socket } from "./ws.ts";

/**
 * Goal mode from the page: set directly, or by letting omp interview the user first (shared/guided-goal.ts).
 * A guided interview is the conversation holding the `propose_goal` host tool; it ends by confirmation, by
 * cancelling, or by setting the goal directly, and each of them takes the tool away again (and the opening message,
 * if omp has not started on it yet).
 */

/** Why an active goal is not being worked on: omp stopped continuing it after a turn that did nothing new, or every open todo is blocked. */
export type GoalWait = "idle" | "blocked";

/**
 * Whether an active goal waits for the user. omp starts no further turn for a goal after one without new tool activity,
 * or while every open todo is blocked (rpc.md), and then waits with the goal still active. That is known when no turn runs
 * or is about to (`working`) and omp has said it is settled (`session_settled`, or its state when the page attached):
 * until then the goal may be about to go on (a goal just created or resumed starts its turn a moment later), and the page
 * must not claim it has stopped.
 */
export function goalWait(live: LiveState | undefined): GoalWait | null {
	if (live?.goal?.status !== "active" || working(live) || !live.settled) return null;
	const todos = summarizeTodos(live.state?.todoPhases);
	return todos.blocked > 0 && !todos.current ? "blocked" : "idle";
}

/**
 * The goal rpc: omp keeps working until the objective is done or the budget is spent. Leaves any interview alone.
 * Creating it sets omp to work on it, which a paused conversation cannot: it is continued for that, and says so.
 */
async function sendGoal(liveId: string, objective: string, budget?: number): Promise<void> {
	if (await continueConversation(liveId)) useApp.getState().toast("info", t("panel.goalResumedToStart"));
	await socket.rpc(liveId, { type: "goal", op: "create", objective, ...(budget ? { token_budget: budget } : {}) });
}

export type GoalOp = "pause" | "resume" | "drop";

/**
 * Pause, resume or drop the goal for the user's click (a paused conversation answers it). The goal changes by a
 * `goal_updated` frame, except where nothing changes: `resume` on a goal that is already active sends none, and the
 * answer is what omp holds, which is shown.
 */
export async function goalOp(liveId: string, op: GoalOp): Promise<void> {
	const answer = await socket.act<{ goal?: Goal | null }>(liveId, { type: "goal", op });
	const held = answer?.goal;
	if (goalHeld(held)) noteGoal(liveId, held);
}

/**
 * Start goal mode with this objective now. An interview open in the conversation is over once the goal exists: the
 * tool goes, and a proposal still waiting for the user's decision is answered (the model must not wait for it).
 */
export async function createGoal(liveId: string, objective: string, budget?: number): Promise<void> {
	await sendGoal(liveId, objective, budget);
	const live = useApp.getState().lives[liveId];
	if (!live || !guidedGoalActive(live)) return;
	const proposal = pendingProposal(live);
	if (proposal) answerDialog(liveId, { id: proposal.id, ...hostResult(PROPOSAL_RESULTS.replaced(objective)) });
	// The goal exists whether or not the tool could be taken away: that failing is not the goal's.
	await dropInterview(live).catch(() => {});
}

/** Whether omp is interviewing the user in this conversation: the tool that ends the interview is registered. */
export function guidedGoalActive(live: LiveState | undefined): boolean {
	return Boolean(live?.state?.dumpTools?.some((t) => t.name === PROPOSE_GOAL_TOOL));
}

/** The proposal waiting for the user's decision in this conversation, if the model has made one. */
export function pendingProposal(live: LiveState | undefined) {
	return live?.uiRequests.find((r) => r.method === "propose_goal");
}

/**
 * Run `onRequest` when "Set a goal" is asked for from outside the page (the palette, the shortcut, the guided-goal
 * bar). A request made before the page opened is not its business.
 */
export function useGoalRequest(onRequest: (mode: "guided" | "direct") => void): void {
	const request = useApp((s) => s.goalRequest);
	const seen = useRef(request?.id ?? 0);
	const latest = useRef(onRequest);
	latest.current = onRequest;
	useEffect(() => {
		if (!request || request.id === seen.current) return;
		seen.current = request.id;
		latest.current(request.mode);
	}, [request]);
}

/** Take the tool away: the interview is over, whichever way it ended. */
export async function endGuidedGoal(liveId: string): Promise<void> {
	await socket.act(liveId, { type: "set_host_tools", tools: [] });
	void refreshState(liveId, true);
}

/**
 * Take the interview away: the tool, and the opening message when omp has not started on it yet because another turn
 * is running (it waits in omp's queue, where it would start an interview nobody can finish). Whether it was still queued.
 */
async function dropInterview(live: LiveState): Promise<boolean> {
	const liveId = live.info.liveId;
	const queued = live.queue.followUp.find((m) => parseInterviewPrompt(m));
	await endGuidedGoal(liveId);
	if (!queued) return false;
	const { removed } = await socket.act<{ removed: boolean }>(liveId, {
		type: "remove_queued_message",
		message: queued,
		queue: "followUp",
	});
	return removed;
}

/** Conversations whose interview is being started: a second start before the first shows up in omp's state is refused too. */
const starting = new Set<string>();

/**
 * Give the model the tool that ends the interview, then ask it to start. A conversation whose turn is still
 * running takes the request after it (`queue`). One interview at a time: a second start is refused.
 */
export async function startGuidedGoal(
	liveId: string,
	rough: string,
	options: { images?: { type: "image"; data: string; mimeType: string }[]; queue?: boolean } = {},
): Promise<void> {
	if (starting.has(liveId) || guidedGoalActive(useApp.getState().lives[liveId]))
		throw new Error(t("panel.guidedActive"));
	starting.add(liveId);
	try {
		await socket.rpc(liveId, { type: "set_host_tools", tools: [proposeGoalTool()] });
		const language = INTERVIEW_LANGUAGES[useLang.getState().lang];
		try {
			await socket.rpc(liveId, {
				type: "prompt",
				message: interviewPrompt(rough, language),
				...(options.images?.length ? { images: options.images } : {}),
				...(options.queue ? { streamingBehavior: "followUp" } : {}),
			});
		} catch (e) {
			// Without its first message there is no interview; the tool would only sit there.
			await endGuidedGoal(liveId).catch(() => {});
			throw e;
		}
		// Until omp's state lists the tool a second start would not see this interview.
		await refreshState(liveId);
	} finally {
		starting.delete(liveId);
	}
}

/**
 * The user confirmed the proposal, possibly edited: the goal is created first (a refusal throws and leaves the
 * proposal open), then the model hears so, and the interview is over.
 */
export async function confirmProposal(liveId: string, callId: string, proposal: GoalProposal): Promise<void> {
	const objective = goalObjective(proposal);
	await sendGoal(liveId, objective, proposal.tokenBudget);
	answerDialog(liveId, { id: callId, ...hostResult(PROPOSAL_RESULTS.confirmed(objective)) });
	await endGuidedGoal(liveId).catch(() => {});
}

/** The user wants the proposal changed: the model gets their words and may ask more, then propose again. */
export function reviseProposal(liveId: string, callId: string, feedback: string): void {
	answerDialog(liveId, { id: callId, ...hostResult(PROPOSAL_RESULTS.revise(feedback)) });
}

/**
 * Stop the interview and leave no goal: an open proposal is declined, and a question or turn under way is stopped,
 * unless the interview is still waiting behind another turn: that work is not the interview's to stop.
 */
export async function cancelGuidedGoal(live: LiveState): Promise<void> {
	const liveId = live.info.liveId;
	const proposal = pendingProposal(live);
	if (proposal) answerDialog(liveId, { id: proposal.id, ...hostResult(PROPOSAL_RESULTS.cancelled) });
	const wasQueued = await dropInterview(live);
	if (!proposal && !wasQueued && live.streaming) await socket.act(liveId, { type: "abort" });
}
