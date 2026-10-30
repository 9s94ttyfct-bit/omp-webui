import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { FIXTURE_CWD } from "./fixtures.ts";
import { type OwnSession, SUBAGENT_START } from "./subagent-fixtures.ts";

/**
 * What omp records of a subagent's assignment, for specs of how the web UI shows it (no model call). The shapes follow
 * what omp 18.12 writes: the task call's arguments (`context` for every subagent of the call, `tasks[]` with `name`,
 * `agent` and `task`), its result (`details.progress[]` with the id omp gave each subagent and the `assignment` and
 * rendered `task` it sent), and the subagent's transcript, which opens with a `session_init` record holding the system
 * prompt blocks as sent and the first user message. The words are made up.
 */

export type Entry = Record<string, unknown>;

/** What the parent wrote once for every subagent of the call: Markdown with a heading, a list, code, and raw HTML that must stay text. */
export const CONTEXT = [
	"# Goal",
	"Widen the **parser** in `src/parser.ts` without changing its callers.",
	"",
	"# Contract",
	"- `parse(text)` keeps its signature",
	"- errors name the line",
	"",
	'<img src="x" onerror="window.__assignmentPwned = 1"> SHARED-CONTRACT-MARKER',
].join("\n");

/** A task long enough that the view cuts it: three sections of a dozen lines. */
export const LONG_TASK = [
	"# Target",
	"Worktree `/tmp/alpha`, branch `r1/alpha`.",
	"",
	"# Change",
	...Array.from({ length: 14 }, (_, i) => `- step ${i + 1}: adjust the parser rule number ${i + 1}`),
	"",
	"| rule | before | after |",
	"| --- | --- | --- |",
	"| `parse` | 10 | 12 |",
	"",
	"# Acceptance",
	"ALPHA-ACCEPTANCE-MARKER: every rule has a test.",
].join("\n");

export const SHORT_TASK = "Read `docs/parser.md` and list what it gets wrong.\n\nBETA-TASK-MARKER";

export const UNNAMED_TASK = "Count the rules of the grammar.";

/** The id omp gave the spawn the call did not name. */
export const UNNAMED_ID = "FuzzyOtter";

/** The arguments of a batch `task` call, as the model writes them. */
export const TASK_ARGS = {
	context: CONTEXT,
	tasks: [
		{ name: "Alpha", agent: "explore", task: LONG_TASK },
		{ name: "Beta", task: SHORT_TASK },
		{ task: UNNAMED_TASK },
	],
};

/** The lead omp's user prompt puts before every task. */
export const promptOf = (task: string) => `Complete assignment thoroughly:\n\n${task}`;

/** The result details of a call whose subagents run in the background, with the id of each. */
export const TASK_DETAILS = {
	projectAgentsDir: null,
	results: [],
	totalDurationMs: 12,
	progress: [
		{ index: 0, id: "Alpha", agent: "explore", status: "pending", task: promptOf(LONG_TASK), assignment: LONG_TASK },
		{ index: 1, id: "Beta", agent: "task", status: "pending", task: promptOf(SHORT_TASK), assignment: SHORT_TASK },
		{
			index: 2,
			id: UNNAMED_ID,
			agent: "task",
			status: "pending",
			task: promptOf(UNNAMED_TASK),
			assignment: UNNAMED_TASK,
		},
	],
	async: { state: "running", jobId: "Alpha", type: "task" },
};

export const SPAWNED_TEXT = `Spawned 3 background agents using task.\n- \`Alpha\` (job \`Alpha\`)\n- \`Beta\` (job \`Beta\`)\n- \`${UNNAMED_ID}\` (job \`${UNNAMED_ID}\`)`;

/**
 * The block omp appends to a subagent's system prompt, rendered from its template: the agent's role, the `§ Context`
 * section when the parent gave one, then the sections every subagent has.
 */
export function subagentBlock(context: string | undefined): string {
	return [
		"§ Role\nWorker agent: delegated tasks.\n\n<directives>\n- MUST finish assigned work only.\n</directives>\n",
		context === undefined ? "" : `§ Context\n${context}\n`,
		"§ Coop\nYou are operating on a piece of work assigned to you by the main agent.\n",
		"§ Completion\nCall yield when the assignment is done.\n",
	].join("\n");
}

const at = Date.parse(SUBAGENT_START);

/** The records a subagent's transcript opens with, in the order omp writes them: its models, then `session_init`. */
export function initRecords(id: string, task: string, context: string | undefined): Entry[] {
	const base = { timestamp: SUBAGENT_START, runtime: { version: "18.12.3" } };
	return [
		{ type: "model_change", id: `${id}-m1`, parentId: null, ...base, model: "anthropic/claude-haiku-5-5" },
		{ type: "thinking_level_change", id: `${id}-t1`, parentId: `${id}-m1`, ...base, thinkingLevel: "off" },
		{
			type: "session_init",
			id: `${id}-init`,
			parentId: `${id}-t1`,
			...base,
			systemPrompt: ["RFC 2119 keywords: MUST, SHOULD.", "<project-context></project-context>", subagentBlock(context)],
			task: promptOf(task),
			tools: ["read", "bash"],
			agent: "task",
			resolvedModel: "anthropic/claude-haiku-5-5",
		},
	];
}

/** The conversation after `session_init`: the task as the first user message, and a reply. */
export function conversationRecords(id: string, task: string, reply: string): Entry[] {
	return [
		{
			type: "message",
			id: `${id}-u1`,
			parentId: `${id}-init`,
			timestamp: SUBAGENT_START,
			message: { role: "user", content: [{ type: "text", text: promptOf(task) }], attribution: "agent", timestamp: at },
		},
		{
			type: "message",
			id: `${id}-a1`,
			parentId: `${id}-u1`,
			timestamp: SUBAGENT_START,
			message: {
				role: "assistant",
				content: [{ type: "text", text: reply }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-5-5",
				usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { total: 0.001 } },
				stopReason: "stop",
				timestamp: at + 1,
			},
		},
	];
}

/** Write a subagent's transcript as omp does: a header, `session_init`, the task, and a reply. */
export function writeAssignedTranscript(file: string, id: string, task: string, context: string | undefined): void {
	mkdirSync(dirname(file), { recursive: true });
	const lines = [
		{ type: "session", version: 3, id: `sub-${id}`, timestamp: SUBAGENT_START, cwd: FIXTURE_CWD },
		...initRecords(id, task, context),
		...conversationRecords(id, task, `${id} finished the work.`),
	];
	writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

/**
 * A subagent's transcript with a long work record after its assignment: enough messages that the view of it has to
 * scroll, which is when the assignment has to stay in view. The replies are the subagent's own words, so the spec can
 * tell them from the task it was given.
 */
export function writeLongAssignedTranscript(
	file: string,
	id: string,
	task: string,
	context: string | undefined,
	replies = 40,
): void {
	mkdirSync(dirname(file), { recursive: true });
	const lines: Entry[] = [
		{ type: "session", version: 3, id: `sub-${id}`, timestamp: SUBAGENT_START, cwd: FIXTURE_CWD },
		...initRecords(id, task, context),
	];
	// The task as the subagent received it, then a reply for each step.
	lines.push(...conversationRecords(id, task, ""));
	let parent = `${id}-a1`;
	for (let i = 0; i < replies; i++) {
		const at = Date.parse(SUBAGENT_START) + i + 2;
		lines.push({
			type: "message",
			id: `${id}-w${i}`,
			parentId: parent,
			timestamp: SUBAGENT_START,
			message: {
				role: "assistant",
				content: [{ type: "text", text: `WORK-STEP-${i}: ${"the parser rule holds. ".repeat(12)}` }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-5-5",
				usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { total: 0.001 } },
				stopReason: "stop",
				timestamp: at,
			},
		});
		parent = `${id}-w${i}`;
	}
	writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

/**
 * The turn of a conversation in which the agent starts the subagents of `TASK_ARGS`: the prompt, the call, and its
 * result with the ids. Chained after `parentId`; returns the entries.
 */
export function taskTurn(tag: string, parentId: string | null, toolCallId: string): Entry[] {
	const e = (n: number) => `${tag}${String(n).padStart(4, "0")}`;
	const model = { api: "anthropic-messages", provider: "anthropic", model: "claude-haiku-5-5" };
	return [
		{
			type: "message",
			id: e(1),
			parentId,
			timestamp: SUBAGENT_START,
			message: { role: "user", content: [{ type: "text", text: "Send scouts" }], attribution: "user", timestamp: at },
		},
		{
			type: "message",
			id: e(2),
			parentId: e(1),
			timestamp: SUBAGENT_START,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: toolCallId, name: "task", arguments: TASK_ARGS }],
				...model,
				stopReason: "toolUse",
				timestamp: at + 1,
			},
		},
		{
			type: "message",
			id: e(3),
			parentId: e(2),
			timestamp: SUBAGENT_START,
			message: {
				role: "toolResult",
				toolCallId,
				toolName: "task",
				content: [{ type: "text", text: SPAWNED_TEXT }],
				details: TASK_DETAILS,
				isError: false,
				timestamp: at + 2,
			},
		},
		{
			type: "message",
			id: e(4),
			parentId: e(3),
			timestamp: SUBAGENT_START,
			message: {
				role: "assistant",
				content: [{ type: "text", text: "The scouts are on their way." }],
				...model,
				stopReason: "stop",
				timestamp: at + 3,
			},
		},
	];
}

/** Append the turn of `taskTurn` to a conversation of the spec's own (`sessionWithSubagents`, made with `n`). */
export function appendTaskTurn(own: OwnSession, n: number, toolCallId: string): void {
	const hex = n.toString(16).padStart(2, "0");
	const entries = taskTurn(`t${hex}`, `s${hex}000002`, toolCallId);
	appendFileSync(own.file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
}
