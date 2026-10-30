import type { SessionEntry } from "../../shared/protocol.ts";

/**
 * Content a session file can hold that omp never writes: a hand edit, an interrupted write, another version of omp or
 * another tool wrote it. One malformed message between good ones; the conversation is the same around every shape.
 */

export const stamp = (n: number) => new Date(Date.UTC(2026, 0, 17, 10, 0, n)).toISOString();
export const TEXT = { type: "text", text: "visible text" };
export const USAGE = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.001 } };

/** What one malformed message holds: the contents of a reply, of a prompt, of a tool result and of two notes. */
export interface Shape {
	/** The assistant message's `content`; the tool calls it makes are `t1` and `t2`. */
	reply?: unknown;
	user?: unknown;
	result?: unknown;
	details?: unknown;
	note?: unknown;
	noteDetails?: unknown;
	usage?: unknown;
}

export const SHAPES: Record<string, Shape> = {
	"null block": { reply: [null, TEXT] },
	"number block": { reply: [5, TEXT] },
	"string block": { reply: ["str", TEXT] },
	"boolean and array blocks": { reply: [true, false, [], [null], [[null]], TEXT] },
	"object without type": { reply: [{}, { text: "no type" }, TEXT] },
	"type that is not a string": {
		reply: [{ type: 5 }, { type: null }, { type: {} }, { type: ["text"], text: "x" }, TEXT],
	},
	"prototype names as types": {
		reply: [{ type: "__proto__" }, { type: "constructor", text: "x" }, { type: "toString" }, TEXT],
	},
	"text that is not text": {
		reply: [
			{ type: "text" },
			{ type: "text", text: 5 },
			{ type: "text", text: null },
			{ type: "text", text: {} },
			{ type: "text", text: [null] },
			TEXT,
		],
	},
	"thinking that is not text": {
		reply: [
			{ type: "thinking" },
			{ type: "thinking", thinking: null },
			{ type: "thinking", thinking: 5, narration: true },
			{ type: "thinking", thinking: ["x"], narration: "yes", redacted: 1 },
			TEXT,
		],
	},
	"tool call with nothing": { reply: [{ type: "toolCall" }, TEXT] },
	"tool call of nulls": {
		reply: [
			{ type: "toolCall", id: 5, name: null, arguments: null },
			{ type: "toolCall", id: null, name: 5, arguments: 5 },
			TEXT,
		],
	},
	"tool call arguments as a string": {
		reply: [
			{ type: "toolCall", id: "t1", name: "bash", arguments: "echo hi" },
			{ type: "toolCall", id: "t2", name: "edit", arguments: [null] },
			TEXT,
		],
		result: [{ type: "text", text: "ok" }],
	},
	"nested nulls in tool calls": {
		reply: [
			{
				type: "toolCall",
				id: "t1",
				name: "task",
				arguments: {
					command: null,
					path: 5,
					intent: {},
					tasks: [null, 5, {}, { id: null, assignment: 5 }, [null]],
					edits: [null, { diff: 5 }],
					content: 5,
					query: [null],
				},
			},
			{
				type: "toolCall",
				id: "t2",
				name: "edit",
				arguments: { path: null, edits: null, input: [null, { path: null }] },
			},
			TEXT,
		],
		result: [{ type: "text", text: "ok" }],
	},
	"edit and write with nulls": {
		reply: [
			{ type: "toolCall", id: "t1", name: "edit", arguments: { path: null, edits: null } },
			{ type: "toolCall", id: "t2", name: "write", arguments: { path: 5, content: null } },
			TEXT,
		],
		result: [null, { type: "text", text: null }, { type: "image", data: null }],
		details: { diff: 5, firstChangedLine: "x", files: [null, 5, {}], diagnostics: [null] },
	},
	"images that are not images": {
		reply: [
			{ type: "image" },
			{ type: "image", data: 5, mimeType: null },
			{ type: "image", data: "blob:sha256:" },
			{ type: "image", data: "blob:sha256:../meta" },
			TEXT,
		],
	},
	"content that is null": { reply: null },
	"content that is a number": { reply: 5 },
	"content that is one block, not a list": { reply: { type: "text", text: "x" } },
	"content that is a string": { reply: "plain string content" },
	"nulls everywhere": {
		reply: [
			null,
			[null, [null]],
			{ type: "toolCall", id: "t1", name: "bash", arguments: { command: [null] } },
			{ type: "text", text: [null] },
			TEXT,
		],
		user: [null, [null], { type: "text", text: [null] }],
		result: [null, [null], { type: "text", text: [null] }],
		details: [null],
		note: [null, { type: "text", text: null }],
		noteDetails: { notes: [null, 5, { note: 5, severity: null }, [null]] },
	},
	"a prompt with bad blocks": { reply: [TEXT], user: [null, 5, "str", { type: "image" }, { type: "text", text: 7 }] },
	"a tool result with bad blocks": {
		reply: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "x" } }, TEXT],
		result: [null, 5, "str", {}, { type: "text", text: null }, { type: "image", data: 5 }, [null]],
	},
	"a tool result that is not a list": {
		reply: [{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "x" } }, TEXT],
		result: 5,
		details: "oops",
	},
	"notes with bad content": {
		reply: [TEXT],
		note: [null, 5, { type: "text", text: 5 }],
		noteDetails: { notes: [null, { note: [null] }], id: 5 },
	},
	"usage and model that are not numbers and text": {
		reply: [TEXT],
		usage: { input: "a", output: null, cacheRead: {}, cost: 5, totalTokens: [] },
	},
	"usage that is not an object": { reply: [TEXT], usage: "x" },
};

const message = (id: string, parentId: string | null, n: number, body: Record<string, unknown>): SessionEntry =>
	({ type: "message", id, parentId, timestamp: stamp(n), message: body }) as unknown as SessionEntry;

/** The conversation a shape makes: a prompt, a reply with calls, their results, two notes, a prompt and a reply. */
export function conversation(s: Shape): SessionEntry[] {
	const rows: SessionEntry[] = [];
	let parent: string | null = null;
	const add = (e: SessionEntry) => {
		rows.push(e);
		parent = e.id;
	};
	add(
		message("u1", null, 1, {
			role: "user",
			content: s.user ?? [{ type: "text", text: "first prompt" }],
			attribution: "user",
		}),
	);
	add(
		message("a1", parent, 2, {
			role: "assistant",
			content: s.reply,
			provider: "anthropic",
			model: "claude-haiku-5-5",
			usage: s.usage ?? USAGE,
			stopReason: "stop",
			timestamp: 2,
		}),
	);
	if (s.result !== undefined || s.details !== undefined) {
		for (const call of ["t1", "t2"]) {
			add(
				message(`r-${call}`, parent, 3, {
					role: "toolResult",
					toolCallId: call,
					toolName: "bash",
					content: s.result,
					details: s.details,
					isError: false,
					timestamp: 3,
				}),
			);
		}
	}
	add({
		type: "custom_message",
		id: "c1",
		parentId: parent,
		timestamp: stamp(4),
		customType: "advisor",
		content: s.note ?? "an advisory",
		display: true,
		details: s.noteDetails ?? { notes: [{ severity: "info", note: "n" }] },
	} as unknown as SessionEntry);
	add({
		type: "custom_message",
		id: "c2",
		parentId: parent,
		timestamp: stamp(5),
		customType: "irc:incoming",
		content: s.note ?? "hello",
		display: true,
		details: { from: "x" },
	} as unknown as SessionEntry);
	add(
		message("u2", parent, 6, { role: "user", content: [{ type: "text", text: "second prompt" }], attribution: "user" }),
	);
	add(
		message("a2", parent, 7, {
			role: "assistant",
			content: [{ type: "text", text: "second reply after" }],
			provider: "anthropic",
			model: "claude-haiku-5-5",
			usage: USAGE,
			stopReason: "stop",
			timestamp: 7,
		}),
	);
	return rows;
}
