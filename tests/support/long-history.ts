import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_BUCKET, FIXTURE_CWD } from "./fixtures.ts";

/**
 * Conversations for the specs of a long history: files of hundreds of turns, and forks of them made the way omp makes them
 * (the path from the root copied up to the fork point, entry ids kept, then the fork's own entries). No model is called.
 */

const at = (minute: number) => new Date(Date.UTC(2026, 0, 8, 0, minute)).toISOString();
const usage = { input: 5, output: 7, cacheRead: 100, cacheWrite: 10, totalTokens: 122, cost: { total: 0.0001 } };

export interface LongConversation {
	file: string;
	id: string;
	turns: number;
}

export const promptText = (t: number) => `Long history turn ${t}: what does item ${t} do?`;
export const answerText = (t: number) => `History answer ${t}: item ${t} is fine.`;

/** Turn `t`: a prompt, an assistant step that runs a tool, its result, and the answer. Entries are `u<t>`, `a<t>x`, `r<t>`, `a<t>y`. */
export function turnLines(
	t: number,
	parent: string | null,
	prompt = promptText(t),
): { lines: Record<string, unknown>[]; last: string } {
	const m = t * 4;
	const lines = [
		{
			type: "message",
			id: `u${t}`,
			parentId: parent,
			timestamp: at(m),
			message: {
				role: "user",
				content: [{ type: "text", text: prompt }],
				attribution: "user",
				timestamp: Date.parse(at(m)),
			},
		},
		{
			type: "message",
			id: `a${t}x`,
			parentId: `u${t}`,
			timestamp: at(m + 1),
			message: {
				role: "assistant",
				content: [
					{ type: "thinking", thinking: `Looking at item ${t}.` },
					{ type: "toolCall", id: `call${t}`, name: "bash", arguments: { command: `echo item ${t}`, i: `Check ${t}` } },
				],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-5-5",
				usage,
				stopReason: "toolUse",
				timestamp: Date.parse(at(m + 1)),
			},
		},
		{
			type: "message",
			id: `r${t}`,
			parentId: `a${t}x`,
			timestamp: at(m + 2),
			message: {
				role: "toolResult",
				toolCallId: `call${t}`,
				toolName: "bash",
				content: [{ type: "text", text: `item ${t}\n` }],
				isError: false,
				timestamp: Date.parse(at(m + 2)),
			},
		},
		{
			type: "message",
			id: `a${t}y`,
			parentId: `r${t}`,
			timestamp: at(m + 3),
			message: {
				role: "assistant",
				content: [{ type: "text", text: `${answerText(t)}\n\n- first point about ${t}\n- second point about ${t}\n` }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-5-5",
				usage,
				stopReason: "stop",
				timestamp: Date.parse(at(m + 3)),
			},
		},
	];
	return { lines, last: `a${t}y` };
}

const write = (file: string, lines: Record<string, unknown>[]) => {
	mkdirSync(join(file, ".."), { recursive: true });
	writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
};

/** A conversation of `turns` turns (four entries each) in the fixture project of `agentDir`. `id` makes its file name. */
export function writeLongConversation(
	agentDir: string,
	opts: { id: string; turns: number; prompt?: (t: number) => string; title?: string },
): LongConversation {
	const file = join(agentDir, "sessions", FIXTURE_BUCKET, `2026-01-08T00-00-00-000Z_${opts.id}.jsonl`);
	const lines: Record<string, unknown>[] = [
		{
			type: "session",
			version: 3,
			id: opts.id,
			timestamp: at(0),
			cwd: FIXTURE_CWD,
			...(opts.title ? { title: opts.title } : {}),
		},
	];
	let parent: string | null = null;
	for (let t = 0; t < opts.turns; t++) {
		const made = turnLines(t, parent, opts.prompt?.(t));
		lines.push(...made.lines);
		parent = made.last;
	}
	write(file, lines);
	return { file, id: opts.id, turns: opts.turns };
}

/** A conversation of agent turns that run long (`writeLongTurns`), with the ids of its entries in the order of its path. */
export interface LongTurns extends LongConversation {
	path: string[];
}

/** The prompt, the answer and the ids of a conversation of agent turns that run long (`writeLongTurns`). */
export const longPrompt = (t: number) => `Long run ${t}: keep going until it is done`;
export const longAnswer = (t: number) => `Long run ${t} is done.`;
/** The id of step `k` of turn `t`: the assistant message that calls a tool, and (with an `r`) its result. */
export const stepId = (t: number, k: number, kind: "s" | "r" = "s") => `${kind}${t}_${k}`;

/**
 * A conversation of agent turns that run long, as a goal run or a long autonomous task writes them: each turn has a prompt,
 * `steps` assistant steps that each run a tool (`stepId`), and an answer. `steps[t]` is the number of steps of turn `t`; a
 * turn of hundreds of steps is longer than the window the server answers, so a window cuts it (before an assistant message).
 * Entry ids are `u<t>`, `s<t>_<k>`, `r<t>_<k>`, `f<t>`; the path is returned in order.
 */
export function writeLongTurns(agentDir: string, opts: { id: string; steps: number[]; title?: string }): LongTurns {
	const file = join(agentDir, "sessions", FIXTURE_BUCKET, `2026-01-08T00-00-00-000Z_${opts.id}.jsonl`);
	const lines: Record<string, unknown>[] = [
		{
			type: "session",
			version: 3,
			id: opts.id,
			timestamp: at(0),
			cwd: FIXTURE_CWD,
			...(opts.title ? { title: opts.title } : {}),
		},
	];
	const path: string[] = [];
	let parent: string | null = null;
	let n = 0;
	const add = (id: string, message: Record<string, unknown>) => {
		n++;
		lines.push({
			type: "message",
			id,
			parentId: parent,
			timestamp: at(n),
			message: { ...message, timestamp: Date.parse(at(n)) },
		});
		path.push(id);
		parent = id;
	};
	const assistant = (content: unknown[], stopReason: string) => ({
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-haiku-5-5",
		usage,
		stopReason,
	});
	for (const [t, steps] of opts.steps.entries()) {
		add(`u${t}`, { role: "user", content: [{ type: "text", text: longPrompt(t) }], attribution: "user" });
		for (let k = 0; k < steps; k++) {
			const call = `call${t}_${k}`;
			add(
				stepId(t, k),
				assistant(
					[{ type: "toolCall", id: call, name: "bash", arguments: { command: `echo ${t} ${k}`, i: `Step ${k}` } }],
					"toolUse",
				),
			);
			add(stepId(t, k, "r"), {
				role: "toolResult",
				toolCallId: call,
				toolName: "bash",
				content: [{ type: "text", text: `${t} ${k}\n` }],
				isError: false,
			});
		}
		add(`f${t}`, assistant([{ type: "text", text: longAnswer(t) }], "stop"));
	}
	write(file, lines);
	return { file, id: opts.id, turns: opts.steps.length, path };
}

/**
 * What omp's "edit a prompt" writes: a new file whose header names `source` as its parent, the path to the entry before turn
 * `atTurn`'s prompt copied, and a prompt of its own (`v<atTurn>`, another version of `u<atTurn>`) with an answer (`b<atTurn>`).
 */
export function writeFork(
	agentDir: string,
	source: LongConversation,
	opts: { id: string; atTurn: number; text: string; reply: string; title: string },
): LongConversation {
	const lines = readFileSync(source.file, "utf8")
		.trimEnd()
		.split("\n")
		.map((l) => JSON.parse(l) as Record<string, unknown>);
	const cut = lines.findIndex((l) => l.id === `u${opts.atTurn}`);
	if (cut < 0) throw new Error(`no turn ${opts.atTurn} in ${source.file}`);
	const parent = lines[cut - 1]?.id as string;
	const copied = lines.slice(0, cut);
	// The fork is written after everything the source holds: its entries are the newest of the family.
	const m = source.turns * 4 + 5;
	copied[0] = { ...copied[0], id: opts.id, parentSession: source.file, timestamp: at(m), title: opts.title };
	const prompt = {
		type: "message",
		id: `v${opts.atTurn}`,
		parentId: parent,
		timestamp: at(m),
		message: {
			role: "user",
			content: [{ type: "text", text: opts.text }],
			attribution: "user",
			timestamp: Date.parse(at(m)),
		},
	};
	const reply = {
		type: "message",
		id: `b${opts.atTurn}`,
		parentId: `v${opts.atTurn}`,
		timestamp: at(m + 1),
		message: {
			role: "assistant",
			content: [{ type: "text", text: opts.reply }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-haiku-5-5",
			usage,
			stopReason: "stop",
			timestamp: Date.parse(at(m + 1)),
		},
	};
	const file = join(agentDir, "sessions", FIXTURE_BUCKET, `2026-01-08T00-30-00-000Z_${opts.id}.jsonl`);
	write(file, [...copied, prompt, reply]);
	return { file, id: opts.id, turns: opts.atTurn + 1 };
}
