import type { LiveState } from "../store/live.ts";

/**
 * omp is replying, running a `!command` or waiting to retry. Edit, Regenerate and Branch move the conversation to a
 * new session file and then send a prompt: while omp is busy the move succeeds, the prompt is refused ("Agent is
 * already processing"), and the reply that is still coming lands in the new, empty file without its prompt.
 */
export function conversationBusy(
	live: Pick<LiveState, "streaming" | "retry"> | undefined,
	bash: readonly unknown[],
): boolean {
	return Boolean(live?.streaming) || live?.retry?.phase === "waiting" || bash.length > 0;
}
