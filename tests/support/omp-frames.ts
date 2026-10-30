/**
 * The frames omp 18.12 prints, in the shapes it prints them (those recorded in `tests/fixtures/delta-frames.jsonl` and
 * the specs that push frames by hand), for a test that conducts an omp (`sync-omp.ts`, see `two-pages.ts`).
 */

export type Frame = Record<string, unknown> & { type: string };

const assistant = (content: unknown[], stopReason = "stop") => ({
	role: "assistant",
	content,
	api: "anthropic-messages",
	provider: "anthropic",
	model: "claude-opus-5-5",
	usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { total: 0.001 } },
	stopReason,
	timestamp: Date.now(),
});

const update = (messageId: string, assistantMessageEvent: Record<string, unknown>): Frame => ({
	type: "message_update",
	messageId,
	message: { role: "assistant" },
	assistantMessageEvent,
});

/** The assistant message `id` begins. */
export const messageStart = (id: string): Frame => ({
	type: "message_start",
	messageId: id,
	message: { role: "assistant", content: [] },
});

/** A block of the message streams in: `kind` is `thinking` or `text`, `index` its place in the message's content. */
export function block(id: string, kind: "thinking" | "text", index: number, parts: string[]): Frame[] {
	return [
		update(id, { type: `${kind}_start`, contentIndex: index }),
		...parts.map((delta) => update(id, { type: `${kind}_delta`, contentIndex: index, delta })),
		update(id, { type: `${kind}_end`, contentIndex: index, content: parts.join("") }),
	];
}

/** The tool call the message makes is complete. */
export const toolCall = (id: string, index: number, call: { id: string; name: string; arguments: unknown }): Frame =>
	update(id, { type: "toolcall_end", contentIndex: index, toolCall: { type: "toolCall", ...call } });

/** The message ends with `content`: what omp writes to the conversation's file. */
export const messageEnd = (id: string, content: unknown[], stopReason = "stop"): Frame => ({
	type: "message_end",
	messageId: id,
	message: assistant(content, stopReason),
});

export const toolStart = (toolCallId: string, toolName: string, args: unknown): Frame => ({
	type: "tool_execution_start",
	toolCallId,
	toolName,
	args,
	intent: "Working",
});

/** What a running tool has printed so far (the whole of it, as omp sends it). */
export const toolUpdate = (toolCallId: string, toolName: string, text: string): Frame => ({
	type: "tool_execution_update",
	toolCallId,
	toolName,
	partialResult: { content: [{ type: "text", text }] },
});

export const toolEnd = (toolCallId: string, toolName: string, text: string, isError = false): Frame => ({
	type: "tool_execution_end",
	toolCallId,
	toolName,
	result: { content: [{ type: "text", text }] },
	isError,
});

/** The result message of a tool, which omp writes to the file. */
export const toolResultMessage = (id: string, toolCallId: string, toolName: string, text: string): Frame => ({
	type: "message_end",
	messageId: id,
	message: {
		role: "toolResult",
		toolCallId,
		toolName,
		content: [{ type: "text", text }],
		details: {},
		isError: false,
		timestamp: Date.now(),
	},
});

/** A subagent of the `task` call `parentToolCallId` starts. */
export const subagentStarted = (id: string, parentToolCallId: string, index: number, assignment: string): Frame => ({
	type: "subagent_lifecycle",
	payload: {
		id,
		agent: "explore",
		index,
		description: `probe ${id}`,
		assignment,
		parentToolCallId,
		status: "started",
	},
});

export const subagentEnded = (id: string): Frame => ({
	type: "subagent_lifecycle",
	payload: { id, agent: "explore", status: "completed" },
});

/** The subagent's own reply grows by `delta`; `text` is all of it so far. */
export const subagentText = (id: string, delta: string, text: string): Frame => ({
	type: "subagent_event",
	payload: {
		id,
		event: {
			type: "message_update",
			assistantMessageEvent: {
				type: "text_delta",
				contentIndex: 0,
				delta,
				partial: { ...assistant([{ type: "text", text }], "toolUse"), model: "claude-haiku-5-5" },
			},
		},
	},
});

export const subagentProgress = (id: string, index: number, toolCount: number): Frame => ({
	type: "subagent_progress",
	payload: {
		index,
		agent: "explore",
		task: `probe ${id}`,
		progress: { id, status: "running", toolCount, durationMs: toolCount * 100, tokens: toolCount * 50 },
	},
});

/** omp asks before it runs a tool: a select titled `Allow tool: …`, the details on the lines after. */
export const approval = (id: string, tool: string, details: string): Frame => ({
	type: "extension_ui_request",
	id,
	method: "select",
	title: `Allow tool: ${tool}\n${details}`,
	options: ["Allow once", "Deny"],
});

/** omp asks the user to confirm something. */
export const confirm = (id: string, title: string, message: string): Frame => ({
	type: "extension_ui_request",
	id,
	method: "confirm",
	title,
	message,
});

/** omp asks for a line of text (`editor`: a longer text). */
export const input = (id: string, title: string, method: "input" | "editor" = "input"): Frame => ({
	type: "extension_ui_request",
	id,
	method,
	title,
	placeholder: "type here",
});

/** omp's `ask` tool: questions with options, answered together. */
export const ask = (id: string, questions: { id: string; question: string; options: string[] }[]): Frame => ({
	type: "extension_ui_request",
	id,
	method: "ask",
	questions: questions.map((q) => ({ ...q, options: q.options.map((label) => ({ label })) })),
});

/** An extension's status line (`setStatus`); no text takes it away. */
export const status = (key: string, text?: string): Frame => ({
	type: "extension_ui_request",
	id: `status-${key}`,
	method: "setStatus",
	statusKey: key,
	...(text === undefined ? {} : { statusText: text }),
});

/** omp compacts the context by itself. */
export const compactionStart = (reason = "threshold", action = "context-full"): Frame => ({
	type: "auto_compaction_start",
	reason,
	action,
});

export const compactionEnd = (action = "context-full"): Frame => ({
	type: "auto_compaction_end",
	action,
	result: { tokensBefore: 180_000 },
	aborted: false,
	willRetry: false,
});

export const agentStart = (): Frame => ({ type: "agent_start" });
export const agentEnd = (): Frame => ({ type: "agent_end", messages: [], isTerminal: true });
export const sessionSettled = (): Frame => ({ type: "session_settled" });

export const goalUpdated = (goal: Record<string, unknown> | null): Frame => ({ type: "goal_updated", goal });

/** omp backs off before it retries a failed turn; `errorId` is the failure's flags (`0x80000`: a provider's usage limit). */
export const retryStart = (
	attempt: number,
	maxAttempts: number,
	delayMs: number,
	message: string,
	errorId = 0,
): Frame => ({
	type: "auto_retry_start",
	attempt,
	maxAttempts,
	delayMs,
	errorMessage: message,
	errorId,
});
