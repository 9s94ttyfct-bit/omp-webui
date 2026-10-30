import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEntry } from "../../shared/protocol.ts";
import { FIXTURE_CWD } from "./fixtures.ts";

/**
 * Hand-made messages in the shape omp saves them, for specs of how a conversation reads (what a finished turn folds,
 * how a tool call that nobody answers looks) and the session file to open them from. Nothing here touches the web
 * modules, so unit specs and Playwright specs both use it.
 */

const START = Date.UTC(2026, 0, 20, 10, 0, 0);

/** A message entry. `n` is its place in time: seconds after a fixed start, for the entry and for the message's own `timestamp` (ms). */
export function entry(id: string, parentId: string | null, n: number, message: Record<string, unknown>): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(START + n * 1000).toISOString(),
		message: { ...message, timestamp: START + n * 1000 },
	};
}

export function user(id: string, parent: string | null, n: number, text: string): SessionEntry {
	return entry(id, parent, n, { role: "user", content: [{ type: "text", text }], attribution: "user" });
}

/** An assistant step: its text and tool calls (`calls`: id → tool name), and how it ended. */
export function assistant(
	id: string,
	parent: string | null,
	n: number,
	o: { text?: string; calls?: Record<string, string>; stopReason?: string; errorMessage?: string; extra?: object } = {},
): SessionEntry {
	const content: Record<string, unknown>[] = [];
	if (o.text) content.push({ type: "text", text: o.text });
	for (const [callId, name] of Object.entries(o.calls ?? {}))
		content.push({ type: "toolCall", id: callId, name, arguments: { command: `run ${callId}` } });
	return entry(id, parent, n, {
		role: "assistant",
		content,
		provider: "anthropic",
		model: "claude-haiku-5-5",
		stopReason: o.stopReason ?? (o.calls ? "toolUse" : "stop"),
		...(o.errorMessage ? { errorMessage: o.errorMessage } : {}),
		...(o.extra ?? {}),
	});
}

export function result(
	id: string,
	parent: string | null,
	n: number,
	callId: string,
	text: string,
	isError = false,
): SessionEntry {
	return entry(id, parent, n, {
		role: "toolResult",
		toolCallId: callId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError,
	});
}

/**
 * A conversation of the spec's own made of `entries`, in the fixture folder, titled `title`; `n` (1–255) makes the file and
 * session id unique. Returns the file's path. Call before `page.goto`.
 */
export function writeEntries(agentDir: string, n: number, title: string, entries: SessionEntry[]): string {
	const hex = n.toString(16).padStart(2, "0");
	const id = `01a00000-0000-7000-8000-0000000078${hex}`;
	const lines: Record<string, unknown>[] = [
		{ type: "session", version: 3, id, timestamp: new Date(START).toISOString(), cwd: FIXTURE_CWD },
		{ type: "title_change", id: "title000", parentId: null, timestamp: new Date(START).toISOString(), title },
		...entries,
	];
	const bucket = join(agentDir, "sessions", FIXTURE_CWD.replaceAll("/", "-"));
	mkdirSync(bucket, { recursive: true });
	const file = join(bucket, `2026-01-20T10-${hex}-00-000Z_${id}.jsonl`);
	writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
	const at = Date.now() / 1000 + n;
	utimesSync(file, at, at);
	return file;
}
