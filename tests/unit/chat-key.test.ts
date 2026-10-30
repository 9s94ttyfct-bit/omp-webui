import { expect, test } from "bun:test";
import { type ChatKey, nextChatKey } from "../../web/src/lib/chat-key.ts";

const step = (prev: ChatKey | null, file: string | null, liveId: string | null, leaf?: string) =>
	nextChatKey(prev, { kind: "chat", file, liveId, leaf });

test("resuming a conversation (file → file + process) keeps the page", () => {
	const a = step(null, "/s/a.jsonl", null);
	expect(step(a, "/s/a.jsonl", "L1").key).toBe(a.key);
});

test("a new chat gaining its file (process → process + file) keeps the page", () => {
	const a = step(null, null, "L1");
	expect(step(a, "/s/a.jsonl", "L1").key).toBe(a.key);
});

test("another conversation, process or branch leaf remounts", () => {
	const a = step(null, "/s/a.jsonl", "L1");
	expect(step(a, "/s/b.jsonl", null).key).not.toBe(a.key);
	expect(step(a, null, "L2").key).not.toBe(a.key);
	expect(step(a, "/s/a.jsonl", "L1", "e9").key).not.toBe(a.key);
});

test("a conversation whose process moved to a new session file (branch, fork) keeps the page", () => {
	const a = step(null, "/s/a.jsonl", null);
	const moved = nextChatKey(a, { kind: "chat", file: "/s/b.jsonl", liveId: "L1", from: "/s/a.jsonl" });
	expect(moved.key).toBe(a.key);
	// and stays the same page on the renders that follow
	expect(step(moved, "/s/b.jsonl", "L1").key).toBe(a.key);
	// `from` only continues the page it names
	expect(nextChatKey(a, { kind: "chat", file: "/s/b.jsonl", liveId: "L1", from: "/s/x.jsonl" }).key).not.toBe(a.key);
});
