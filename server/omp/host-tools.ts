import type { HostToolDefinition } from "../../shared/guided-goal.ts";

/**
 * Tools the server itself gives one omp process (`set_host_tools`) and answers when omp calls them (`host_tool_call`),
 * with no page in between. They live on that process's own pipe: only the conversation that was given them can call them,
 * and nothing is handed to omp to call the server with, so there is no token that could end up in a tool's arguments or
 * results (both are written to the session file, shown on pages and exported with the conversation).
 *
 * The guided goal's `propose_goal` is the other kind: a tool of the page, answered by the user in the browser.
 */

/** What a served tool answers: text for the model, and whether the call failed (the model sees an error then). */
export interface HostToolResult {
	text: string;
	isError?: boolean;
}

/** One call of a served tool. */
export interface HostToolCall {
	/** The conversation that called it. */
	liveId: string;
	name: string;
	/** The arguments as the model sent them: not checked yet. */
	args: unknown;
	/** Aborted when omp gives the call up (the turn was stopped) and when the conversation ends. */
	signal: AbortSignal;
}

/** What serves the host tools of one conversation. */
export interface HostToolServer {
	/** The tools omp is told of. A call of any other name that this has served is answered with an error. */
	readonly tools: readonly HostToolDefinition[];
	/**
	 * The names among `tools` that only read: omp does not ask the user to allow a call of them, whatever the permission
	 * mode. The others go through omp's tool approval like any tool of its own.
	 */
	readonly readOnly: readonly string[];
	/** Answer a call. Throwing is answering with the error's message. */
	call(call: HostToolCall): Promise<HostToolResult>;
	/** The conversation has ended: nothing will call again. */
	ended(liveId: string): void;
}
