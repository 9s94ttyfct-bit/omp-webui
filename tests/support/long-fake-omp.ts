#!/usr/bin/env bun
/**
 * A scripted stand-in for `omp --mode rpc-ui` that can stream for hours of omp's time in minutes of ours, for the
 * long-run harness (`scripts/long-run.ts`). No model is called: a prompt that starts with `@@fake {json}` runs the
 * script the JSON describes (see `Script`); any other prompt runs a short default one.
 *
 * What it keeps faithful to omp, because the page's cost depends on it:
 * - the conversation's entries are the session file's (`--resume`), `get_entries` answers `{ since }` incrementally and a
 *   turn's messages are appended to memory and to the file as they end, with omp's entry kinds and sizes;
 * - frames have the shapes recorded in tests/fixtures/delta-frames.jsonl (delta projection), plus the tool, turn and
 *   subagent frames a goal run sends;
 * - `prompt` answers at once and the turn goes on in the background; `abort_and_restore_queue` withdraws the queue.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Script {
	/** Assistant steps (each: thinking, text, one tool call, its result) before the final answer. */
	steps?: number;
	/** Wall-clock milliseconds one step takes. */
	stepMs?: number;
	/** `text_delta` frames per step. */
	textDeltas?: number;
	/** `thinking_delta` frames per step. */
	thinkingDeltas?: number;
	/** `tool_execution_update` frames per tool call. */
	toolUpdates?: number;
	/** Bytes of a tool result. */
	toolBytes?: number;
	/** Every this many steps the tool is a `task` that runs `subagents` subagents. 0: never. */
	subagentEvery?: number;
	subagents?: number;
	/** Message updates each subagent streams while its task runs. */
	subagentUpdates?: number;
	/** Every this many steps the agent gets a reminder of its own (a developer message, as goal mode does). 0: never. */
	reminderEvery?: number;
	/** The run begins with a message of the agent's own (a goal continuing) instead of the user's prompt, so a turn that goes on stays one turn. */
	asAgent?: boolean;
}

const DEFAULTS: Required<Script> = {
	steps: 2,
	stepMs: 300,
	textDeltas: 24,
	thinkingDeltas: 12,
	toolUpdates: 3,
	toolBytes: 4000,
	subagentEvery: 0,
	subagents: 3,
	subagentUpdates: 30,
	reminderEvery: 0,
	asAgent: false,
};

const argv = process.argv.slice(2);
if (!argv.includes("--mode")) {
	console.log("fake-omp 0.0.0");
	process.exit(0);
}
const resumeAt = argv.indexOf("--resume");
const resumed = resumeAt >= 0 ? argv[resumeAt + 1] : null;
const sessionId = resumed?.match(/_([0-9a-f-]{36})\.jsonl$/)?.[1] ?? crypto.randomUUID();
const agentDir = process.env.PI_CODING_AGENT_DIR ?? "/tmp";
const sessionFile =
	resumed ??
	join(
		agentDir,
		"sessions",
		process.cwd().replaceAll("/", "-"),
		`${new Date().toISOString().replaceAll(":", "-").replace(".", "-")}_${sessionId}.jsonl`,
	);

type Entry = { id: string; parentId: string | null; type: string; timestamp: string; [k: string]: unknown };
const entries: Entry[] = [];
let headerWritten = false;
if (resumed && existsSync(resumed)) {
	headerWritten = true;
	for (const line of readFileSync(resumed, "utf8").split("\n")) {
		if (!line) continue;
		const e = JSON.parse(line) as Entry;
		if (typeof e.id === "string" && e.type !== "session" && e.type !== "title") entries.push(e);
	}
}
let leaf: string | null = entries.at(-1)?.id ?? null;

// omp's transport: a frame over `MAX_FRAME` goes out as `rpc_chunk` lines once the server negotiated protocol 2, and a
// frame over `MAX_REASSEMBLED` is sent with its arrays cut short (omp's own tiers: "items elided for RPC frame").
const MAX_FRAME = 1_048_576;
const MAX_REASSEMBLED = 67_108_864;
const CHUNK_BYTES = 512 * 1024;
let protocol2 = false;
let chunkSeq = 0;

/** What omp sends for a frame too large to reassemble: arrays keep their first `limit` items. */
function elided(value: unknown, limit: number): unknown {
	if (Array.isArray(value)) {
		const kept = value.slice(0, limit).map((v) => elided(v, limit));
		return value.length > limit ? [...kept, `…[${value.length - limit} items elided for RPC frame]`] : kept;
	}
	if (value && typeof value === "object")
		return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, elided(v, limit)]));
	return value;
}

function out(o: unknown): void {
	let json = JSON.stringify(o);
	if (json.length < MAX_FRAME / 2) return void process.stdout.write(`${json}\n`);
	let bytes = Buffer.byteLength(json, "utf8");
	for (let limit = 512; bytes > MAX_REASSEMBLED && limit >= 1; limit = Math.floor(limit / 2)) {
		json = JSON.stringify(elided(o, limit));
		bytes = Buffer.byteLength(json, "utf8");
	}
	if (!protocol2 || bytes <= MAX_FRAME) return void process.stdout.write(`${json}\n`);
	const raw = Buffer.from(json, "utf8");
	const count = Math.ceil(bytes / CHUNK_BYTES);
	const chunkId = `c${++chunkSeq}`;
	for (let index = 0; index < count; index++) {
		const data = raw.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString("base64");
		process.stdout.write(`${JSON.stringify({ type: "rpc_chunk", chunkId, index, count, byteLength: bytes, data })}\n`);
	}
}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ deterministic content
let seed = 0x9e3779b1 ^ Number.parseInt(sessionId.slice(0, 8), 16);
const rnd = () => {
	seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
	return seed / 0x100000000;
};
const hex = (n: number) => Array.from({ length: n }, () => Math.floor(rnd() * 16).toString(16)).join("");
const syllables = [
	"ka",
	"to",
	"ri",
	"mel",
	"dun",
	"sa",
	"ve",
	"lo",
	"pan",
	"gri",
	"ox",
	"ne",
	"ba",
	"tur",
	"qui",
	"zen",
];
const vocabulary = Array.from({ length: 1500 }, () =>
	Array.from({ length: 1 + Math.floor(rnd() * 3) }, () => syllables[Math.floor(rnd() * syllables.length)]).join(""),
);
const words = (n: number) =>
	Array.from({ length: n }, () => vocabulary[Math.floor(rnd() * vocabulary.length)]).join(" ");
/** Prose with the odd list and code block: what the markdown renderer has to chew on. */
const prose = (chars: number) => {
	let s = "";
	while (s.length < chars) {
		const r = rnd();
		if (r < 0.12)
			s += `\n\n\`\`\`ts\nconst ${words(1)} = ${words(1)}(${words(2).replace(" ", ", ")});\nreturn ${words(1)};\n\`\`\`\n\n`;
		else if (r < 0.25) s += `\n- ${words(6)}\n- ${words(5)}\n- \`${words(1)}\` ${words(4)}\n\n`;
		else s += `${words(10 + Math.floor(rnd() * 12))}. `;
	}
	return s.slice(0, chars);
};
const toolText = (bytes: number) => {
	const lines: string[] = [];
	let size = 0;
	while (size < bytes) {
		const l = `${words(3)}: ${words(8)} (${Math.floor(rnd() * 9999)})`;
		lines.push(l);
		size += l.length + 1;
	}
	return lines.join("\n");
};
const now = () => new Date().toISOString();
const usage = () => ({
	input: 2,
	output: 100 + Math.floor(rnd() * 400),
	cacheRead: 60000 + Math.floor(rnd() * 20000),
	cacheWrite: 200,
	totalTokens: 70000,
	cost: { input: 0.00001, output: 0.002, cacheRead: 0.03, cacheWrite: 0.004, total: 0.036 },
});

// ------------------------------------------------------------------ session file
/** What omp has not written yet: a new conversation's file appears with its first assistant message, not before. */
const unwritten: Entry[] = [];
function persist(e: Omit<Entry, "id" | "parentId" | "timestamp"> & Partial<Entry>): Entry {
	const entry: Entry = {
		...e,
		id: hex(8),
		parentId: leaf,
		timestamp: now(),
		runtime: { version: "18.12.2" },
	} as Entry;
	entries.push(entry);
	leaf = entry.id;
	if (!headerWritten) {
		if ((entry.message as { role?: string } | undefined)?.role !== "assistant") {
			unwritten.push(entry);
			return entry;
		}
		mkdirSync(dirname(sessionFile), { recursive: true });
		const header = { type: "session", version: 3, id: sessionId, timestamp: now(), cwd: process.cwd() };
		writeFileSync(sessionFile, `${JSON.stringify(header)}\n`);
		headerWritten = true;
		for (const held of unwritten.splice(0)) appendFileSync(sessionFile, `${JSON.stringify(held)}\n`);
	}
	appendFileSync(sessionFile, `${JSON.stringify(entry)}\n`);
	return entry;
}

// ------------------------------------------------------------------ the turn
let streaming = false;
let aborted = false;
const queue = { steering: [] as string[], followUp: [] as string[] };
let messageSeq = 0;
const messageId = () => `msg-${sessionId.slice(0, 4)}-${++messageSeq}`;
const queueUpdate = () =>
	out({ type: "queue_update", steering: queue.steering, followUp: queue.followUp, liveSteered: 0 });

/** Spread `n` frames over `ms`: calls `emit(i)` for each, on a schedule that does not drift. */
async function spread(n: number, ms: number, emit: (i: number) => void): Promise<void> {
	const start = performance.now();
	for (let i = 0; i < n && !aborted; i++) {
		emit(i);
		const due = start + ((i + 1) * ms) / n;
		const wait = due - performance.now();
		if (wait > 1) await sleep(wait);
	}
}

function chunks(text: string, n: number): string[] {
	const size = Math.max(1, Math.ceil(text.length / n));
	const parts: string[] = [];
	for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
	return parts;
}

async function assistantStep(s: Required<Script>, step: number, last: boolean): Promise<void> {
	const id = messageId();
	const phase = (share: number) => s.stepMs * share;
	const thinking = words(40);
	const text = prose(last ? 900 : 380);
	const toolId = `toolu_${hex(20)}`;
	const subagentStep = !last && s.subagentEvery > 0 && step % s.subagentEvery === s.subagentEvery - 1;
	const toolName = last ? null : subagentStep ? "task" : step % 3 === 0 ? "read" : step % 3 === 1 ? "edit" : "bash";
	const args =
		toolName === "task"
			? {
					tasks: Array.from({ length: s.subagents }, (_, i) => ({
						id: `Sub${step}x${i}`,
						description: `probe ${i}`,
						assignment: words(20),
					})),
				}
			: toolName === "bash"
				? { command: `rg -n ${words(1)} src | head -40`, i: "Searching" }
				: { path: `src/${words(1)}.ts`, i: "Looking" };
	const content: Record<string, unknown>[] = [
		{ type: "thinking", thinking, thinkingSignature: hex(1100) },
		{ type: "text", text },
	];
	if (toolName) content.push({ type: "toolCall", id: toolId, name: toolName, arguments: args, intent: "Working" });
	const message = {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-opus-4-8",
		usage: usage(),
		stopReason: last ? "stop" : "toolUse",
		timestamp: Date.now(),
	};
	const mid = { type: "message_update", messageId: id, message: { role: "assistant" } };
	out({ type: "message_start", messageId: id, message: { role: "assistant", content: [] } });
	out({ ...mid, assistantMessageEvent: { type: "thinking_start", contentIndex: 0 } });
	await spread(s.thinkingDeltas, phase(0.3), (i) =>
		out({
			...mid,
			assistantMessageEvent: {
				type: "thinking_delta",
				contentIndex: 0,
				delta: chunks(thinking, s.thinkingDeltas)[i] ?? "",
			},
		}),
	);
	out({ ...mid, assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: thinking } });
	out({ ...mid, assistantMessageEvent: { type: "text_start", contentIndex: 1 } });
	const textParts = chunks(text, s.textDeltas);
	await spread(s.textDeltas, phase(last ? 0.5 : 0.3), (i) =>
		out({ ...mid, assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: textParts[i] ?? "" } }),
	);
	out({ ...mid, assistantMessageEvent: { type: "text_end", contentIndex: 1, content: text } });
	if (toolName) {
		out({ ...mid, assistantMessageEvent: { type: "toolcall_start", contentIndex: 2 } });
		const json = JSON.stringify(args);
		const parts = chunks(json, 4);
		await spread(4, phase(0.05), (i) =>
			out({ ...mid, assistantMessageEvent: { type: "toolcall_delta", contentIndex: 2, delta: parts[i] } }),
		);
		out({
			...mid,
			assistantMessageEvent: {
				type: "toolcall_end",
				contentIndex: 2,
				toolCall: { type: "toolCall", id: toolId, name: toolName, arguments: args },
			},
		});
	}
	out({ type: "message_end", messageId: id, message });
	persist({ type: "message", message });
	if (!toolName || aborted) return;

	// The tool runs.
	out({ type: "tool_execution_start", toolCallId: toolId, toolName, args, intent: "Working" });
	persist({
		type: "custom",
		customType: "tool_execution_start",
		data: { toolCallId: toolId, toolName, startedAt: now() },
	});
	let result = toolText(s.toolBytes);
	if (subagentStep)
		await runSubagents(
			s,
			step,
			toolId,
			args as { tasks: { id: string; description: string; assignment: string }[] },
			phase(0.55),
		);
	else {
		await spread(s.toolUpdates, phase(0.35), (i) =>
			out({
				type: "tool_execution_update",
				toolCallId: toolId,
				toolName,
				partialResult: {
					content: [{ type: "text", text: result.slice(0, ((i + 1) * result.length) / s.toolUpdates) }],
				},
			}),
		);
	}
	if (aborted) result = "Aborted";
	const toolResult = {
		role: "toolResult",
		toolCallId: toolId,
		toolName,
		content: [{ type: "text", text: result }],
		details: { wallTimeMs: 12 },
		isError: false,
		timestamp: Date.now(),
	};
	out({
		type: "tool_execution_end",
		toolCallId: toolId,
		toolName,
		result: { content: toolResult.content },
		isError: false,
	});
	const rid = messageId();
	out({ type: "message_start", messageId: rid, message: toolResult });
	out({ type: "message_end", messageId: rid, message: toolResult });
	persist({ type: "message", message: toolResult });
	// omp records a mode change now and then, and its own notes.
	if (step % 4 !== 0)
		persist({
			type: "mode_change",
			mode: "goal",
			data: {
				goal: { id: "g1", objective: words(30), status: "active", tokensUsed: step * 900, timeUsedSeconds: step * 5 },
			},
		});
	out({ type: "turn_end", message: { role: "assistant" }, toolResults: [] });
}

async function runSubagents(
	s: Required<Script>,
	step: number,
	parentToolCallId: string,
	args: { tasks: { id: string; description: string; assignment: string }[] },
	ms: number,
): Promise<void> {
	for (const [index, t] of args.tasks.entries()) {
		out({
			type: "subagent_lifecycle",
			payload: {
				id: t.id,
				agent: "explore",
				index,
				description: t.description,
				assignment: t.assignment,
				parentToolCallId,
				sessionFile: `${sessionFile.replace(/\.jsonl$/, "")}/${t.id}.jsonl`,
				status: "started",
			},
		});
	}
	await spread(s.subagentUpdates, ms, (i) => {
		for (const [index, t] of args.tasks.entries()) {
			const text = words(5 + i);
			const partial = {
				role: "assistant",
				content: [{ type: "text", text }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-5-5",
				usage: usage(),
				stopReason: "toolUse",
				timestamp: Date.now(),
			};
			out({
				type: "subagent_event",
				payload: {
					id: t.id,
					event: {
						type: "message_update",
						assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "x", partial },
					},
				},
			});
			if (i % 6 === 0) {
				const toolCallId = `sub-${t.id}-${i}`;
				out({
					type: "subagent_event",
					payload: {
						id: t.id,
						event: { type: "tool_execution_start", toolCallId, toolName: "read", args: { path: `a/${i}.ts` } },
					},
				});
				out({
					type: "subagent_event",
					payload: {
						id: t.id,
						event: {
							type: "tool_execution_end",
							toolCallId,
							toolName: "read",
							result: { content: [{ type: "text", text: toolText(600) }] },
						},
					},
				});
			}
			if (i % 10 === 0)
				out({
					type: "subagent_progress",
					payload: {
						index,
						agent: "explore",
						task: t.description,
						progress: {
							id: t.id,
							status: "running",
							toolCount: i,
							durationMs: i * 100,
							tokens: i * 50,
							recentTools: [],
							recentOutput: [],
						},
					},
				});
		}
	});
	for (const t of args.tasks)
		out({ type: "subagent_lifecycle", payload: { id: t.id, agent: "explore", status: "completed" } });
	void step;
}

async function runTurn(prompt: string): Promise<void> {
	streaming = true;
	aborted = false;
	const marker = prompt.startsWith("@@fake ") ? prompt.slice(7) : null;
	const script = { ...DEFAULTS, ...(marker ? (JSON.parse(marker) as Script) : {}) };
	const user = script.asAgent
		? {
				role: "developer",
				content: [{ type: "text", text: "Goal continues." }],
				attribution: "agent",
				timestamp: Date.now(),
				synthetic: true,
			}
		: {
				role: "user",
				content: [{ type: "text", text: marker ? "(scripted run)" : prompt }],
				attribution: "user",
				timestamp: Date.now(),
			};
	out({ type: "agent_start" });
	const uid = messageId();
	out({ type: "message_start", messageId: uid, message: user });
	out({ type: "message_end", messageId: uid, message: user });
	persist({ type: "message", message: user });
	for (let step = 0; step < script.steps && !aborted; step++) {
		if (script.reminderEvery > 0 && step > 0 && step % script.reminderEvery === 0) {
			const reminder = {
				role: "developer",
				content: [{ type: "text", text: `Goal reminder: ${words(30)}` }],
				attribution: "agent",
				timestamp: Date.now(),
				synthetic: true,
			};
			const rid = messageId();
			out({ type: "message_start", messageId: rid, message: reminder });
			out({ type: "message_end", messageId: rid, message: reminder });
			persist({ type: "message", message: reminder });
		}
		await assistantStep(script, step, false);
	}
	if (!aborted) await assistantStep(script, script.steps, true);
	streaming = false;
	out({ type: "agent_end", messages: [], isTerminal: true });
	out({ type: "session_settled" });
	const next = queue.steering.shift() ?? queue.followUp.shift();
	if (next !== undefined) {
		queueUpdate();
		void runTurn(next);
	}
}

// ------------------------------------------------------------------ commands
const state = () => ({
	model: {
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8",
		provider: "anthropic",
		reasoning: true,
		contextWindow: 1_000_000,
	},
	thinkingLevel: "high",
	isStreaming: streaming,
	isCompacting: false,
	steeringMode: "one-at-a-time",
	followUpMode: "one-at-a-time",
	interruptMode: "immediate",
	sessionFile,
	sessionId,
	messageCount: entries.filter((e) => e.type === "message").length,
	queuedMessageCount: queue.steering.length + queue.followUp.length,
	queuedMessages: { steering: queue.steering, followUp: queue.followUp, liveSteered: 0 },
	contextUsage: { tokens: 120_000, contextWindow: 1_000_000, percent: 12 },
	dumpTools: [],
});

const trace = process.env.FAKE_OMP_LOG;
function handle(cmd: Record<string, unknown> & { id?: string; type: string }) {
	if (trace) appendFileSync(trace, `${performance.now().toFixed(0)} ${cmd.id} ${cmd.type}\n`);
	const reply = (data: unknown = {}) => out({ id: cmd.id, type: "response", command: cmd.type, success: true, data });
	const fail = (error: string, code?: string) =>
		out({ id: cmd.id, type: "response", command: cmd.type, success: false, error, code });
	switch (cmd.type) {
		case "negotiate_protocol":
			protocol2 = cmd.protocolVersion === 2;
			return reply({ protocolVersion: protocol2 ? 2 : 1 });
		case "get_state":
			return reply(state());
		case "get_entries": {
			if (typeof cmd.since === "string") {
				const at = entries.findIndex((e) => e.id === cmd.since);
				if (at < 0) return fail("unknown since entry", "unknown_since");
				return reply({ entries: entries.slice(at + 1), leafId: leaf });
			}
			return reply({ entries, leafId: leaf });
		}
		case "goal":
			return reply({ goal: null });
		case "get_available_commands":
			return reply({ commands: [] });
		case "get_subagents":
			return reply({ subagents: [] });
		case "prompt": {
			const message = String(cmd.message ?? "");
			if (message === "/rename") {
				reply();
				return out({ type: "command_output", text: "Session renamed: fake" });
			}
			if (streaming) {
				const how = cmd.streamingBehavior;
				if (how !== "followUp" && how !== "steer") return fail("Agent is already processing a prompt.");
				(how === "steer" ? queue.steering : queue.followUp).push(message);
				reply();
				return queueUpdate();
			}
			reply({ agentInvoked: true });
			void runTurn(message);
			return;
		}
		case "steer":
			queue.steering.push(String(cmd.message ?? ""));
			reply();
			return queueUpdate();
		case "abort":
		case "abort_and_restore_queue": {
			aborted = true;
			const withdrawn =
				cmd.type === "abort_and_restore_queue"
					? { steering: queue.steering.map((text) => ({ text })), followUp: queue.followUp.map((text) => ({ text })) }
					: {};
			queue.steering = [];
			queue.followUp = [];
			reply(withdrawn);
			return queueUpdate();
		}
		case "bash":
			setTimeout(() => reply({ exitCode: 0, output: "" }), 150);
			return;
		default:
			return reply({});
	}
}

out({
	type: "ready",
	protocolVersion: 1,
	supportedProtocolVersions: [1, 2],
	maxFrameBytes: MAX_FRAME,
	maxReassembledFrameBytes: MAX_REASSEMBLED,
});
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
	buf += new TextDecoder().decode(chunk);
	for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
		const line = buf.slice(0, nl);
		buf = buf.slice(nl + 1);
		if (line.trim()) handle(JSON.parse(line));
	}
}
aborted = true;
