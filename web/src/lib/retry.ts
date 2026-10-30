import type { SessionEntry } from "@shared/protocol.ts";
import type { ToolExec } from "../store/live.ts";
import { type AgentMessage, blocks, messageOf, type ToolResults } from "./messages.ts";

/**
 * How an assistant message left a failure on screen: it errored, or it was interrupted (Stop, a killed process). Null
 * for one that ended well, that a retry got past (`recovered`: a dim note) or that a later reply made moot
 * (`superseded`): those are not what a conversation ends with.
 */
export function unresolvedStop(m: AgentMessage): "error" | "aborted" | null {
	const status = m.retryRecovery?.status;
	if (status === "recovered" || status === "superseded") return null;
	return m.stopReason === "error" || m.stopReason === "aborted" ? m.stopReason : null;
}

/**
 * The entry `/retry` would redo: the failed or interrupted assistant message that ends the conversation. omp
 * ignores the placeholder results it adds for tool calls that never ran, and anything else after the failure (a
 * reply, a prompt, a `!command`) leaves nothing to retry. Entries that are not messages do not count.
 */
export function retryableTail(path: SessionEntry[]): string | null {
	for (let i = path.length - 1; i >= 0; i--) {
		const m = messageOf(path[i]);
		if (!m) continue;
		const details: unknown = m.details;
		if (
			m.role === "toolResult" &&
			typeof details === "object" &&
			details !== null &&
			"__synthetic" in details &&
			details.__synthetic === true
		) {
			continue;
		}
		return m.role === "assistant" && (m.stopReason === "error" || m.stopReason === "aborted") ? path[i].id : null;
	}
	return null;
}

/**
 * The assistant step that ends the conversation with tool calls nobody answered: omp writes a call's result only when the
 * tool ends, so a process killed while a tool ran leaves the call alone, and omp's `/retry` has nothing to redo for it
 * ("Nothing to retry."; omp 18.12). Sending a message goes on from there (omp leaves the unanswered call out of what it
 * sends the model). Results omp added as placeholders count as answers, as in `retryableTail`; a step that failed has its
 * own Retry. Entries that are not messages, and the results of calls that were answered, do not count; neither do
 * calls the attached process executes (`tools`: a tool it runs, or one it finished that the file does not hold yet), as
 * in the turn's own card (#602).
 */
export function interruptedTail(
	path: SessionEntry[],
	results: ToolResults,
	tools: Record<string, ToolExec> = {},
): string | null {
	for (let i = path.length - 1; i >= 0; i--) {
		const m = messageOf(path[i]);
		if (!m || m.role === "toolResult") continue;
		if (m.role !== "assistant" || unresolvedStop(m) !== null) return null;
		return blocks(m).some((b) => b.type === "toolCall" && b.id && !results.get(b.id) && !tools[b.id])
			? path[i].id
			: null;
	}
	return null;
}
