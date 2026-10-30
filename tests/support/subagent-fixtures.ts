import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { FIXTURE_CWD, writeSimpleSession } from "./fixtures.ts";

/**
 * Conversations with subagent transcripts of their own, for specs that change those files (a subagent that is
 * still writing) or need costs of a known size, without touching the shared fixtures other specs read.
 */

/** Usage of one request worth `n` thousandths of a dollar and `n` input + `n` output tokens. */
export function worth(n: number) {
	return { input: n, output: n, cacheRead: 0, cacheWrite: 0, totalTokens: 2 * n, cost: { total: n / 1000 } };
}

export const SUBAGENT_START = "2026-01-07T01:00:00.000Z";

function call(id: string, n: number) {
	return {
		type: "message",
		id,
		parentId: null,
		timestamp: SUBAGENT_START,
		message: {
			role: "assistant",
			content: [{ type: "text", text: `Worked for ${n}` }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-haiku-5-5",
			usage: worth(n),
			stopReason: "stop",
			timestamp: Date.parse(SUBAGENT_START),
		},
	};
}

/** Write a subagent transcript whose requests are worth `calls` (thousandths of a dollar each). */
export function writeTranscript(file: string, calls: number[], header: Record<string, unknown> = {}): void {
	mkdirSync(dirname(file), { recursive: true });
	const lines = [
		{ type: "session", version: 3, id: `sub-${file.length}`, timestamp: SUBAGENT_START, cwd: FIXTURE_CWD, ...header },
		...calls.map((n, i) => call(`c${i}-${n}`, n)),
	];
	writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

/** One more request, as a running subagent writes them. */
export function appendCall(file: string, n: number): void {
	appendFileSync(file, `${JSON.stringify(call(`late-${Date.now()}-${n}`, n))}\n`);
}

export interface OwnSession {
	file: string;
	/** Where its subagents' transcripts live. */
	artifacts: string;
	/** The path of a subagent's transcript (nested ones are `Parent/Parent.Child`). */
	transcript(id: string): string;
	/**
	 * The path of an advisor's transcript: the conversation's `default` one, or `name`d one, or with `agent` the one
	 * that reviews that subagent (in its directory). omp writes the advisors' requests only there.
	 */
	advisor(name?: string, agent?: string): string;
}

/**
 * A conversation of the spec's own (see `writeSimpleSession`: `n` makes it unique) with one transcript per
 * subagent in `agents`, each worth the listed requests. Its own single request costs $0.012345. It lives in
 * `agentDir` (the e2e server's, unless a spec that runs its own server says so).
 */
export function sessionWithSubagents(
	n: number,
	title: string,
	agents: Record<string, number[]>,
	agentDir = process.env.OMPW_E2E_AGENT_DIR as string,
	cost?: number,
): OwnSession {
	const file = writeSimpleSession(agentDir, n, title, cost);
	const artifacts = file.replace(/\.jsonl$/, "");
	// A nested subagent sits in its parent's own directory, named after it.
	const chain = (id: string) => {
		const parts = id.split(".");
		return parts.map((_, i) => parts.slice(0, i + 1).join("."));
	};
	const transcript = (id: string) => join(artifacts, ...chain(id).slice(0, -1), `${id}.jsonl`);
	const advisor = (name = "default", agent = "") =>
		join(artifacts, ...(agent ? chain(agent) : []), name === "default" ? "__advisor.jsonl" : `__advisor.${name}.jsonl`);
	for (const [id, calls] of Object.entries(agents)) writeTranscript(transcript(id), calls);
	return { file, artifacts, transcript, advisor };
}

/**
 * Append a turn to an own session (`sessionWithSubagents`) in which the agent starts subagents with the task tool:
 * a prompt, the tool call naming each subagent, and its result. The task card in the transcript is what the
 * "View subagents" link belongs to.
 */
export function addTaskTurn(own: OwnSession, n: number, toolCallId: string, ids: string[]): void {
	const hex = n.toString(16).padStart(2, "0");
	const at = Date.parse(SUBAGENT_START);
	const entries = [
		{
			type: "message",
			id: `s${hex}000011`,
			parentId: `s${hex}000002`,
			timestamp: SUBAGENT_START,
			message: { role: "user", content: [{ type: "text", text: "Send scouts" }], attribution: "user", timestamp: at },
		},
		{
			type: "message",
			id: `s${hex}000012`,
			parentId: `s${hex}000011`,
			timestamp: SUBAGENT_START,
			message: {
				role: "assistant",
				content: [
					{
						type: "toolCall",
						id: toolCallId,
						name: "task",
						arguments: { tasks: ids.map((id) => ({ id, assignment: `Work for ${id}` })) },
					},
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-5-5",
				usage: worth(1),
				stopReason: "toolUse",
				timestamp: at + 1,
			},
		},
		{
			type: "message",
			id: `s${hex}000013`,
			parentId: `s${hex}000012`,
			timestamp: SUBAGENT_START,
			message: {
				role: "toolResult",
				toolCallId,
				toolName: "task",
				content: [{ type: "text", text: "Scouts are done." }],
				isError: false,
				timestamp: at + 2,
			},
		},
	];
	appendFileSync(own.file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
}
