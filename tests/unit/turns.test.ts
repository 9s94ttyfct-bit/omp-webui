import { expect, test } from "bun:test";
import type { SessionEntry } from "../../shared/protocol.ts";
import { indexTree } from "../../web/src/lib/tree.ts";
import { segmentTranscript } from "../../web/src/lib/turns.ts";

const msg = (id: string, parentId: string | null, message: Record<string, unknown>) =>
	({ type: "message", id, parentId, timestamp: "2026-01-01T00:00:00.000Z", message }) as unknown as SessionEntry;

test("a command the user ran after a reply is its own row, not a step of the previous turn", () => {
	const rows = [
		msg("u1", null, { role: "user", content: "check" }),
		msg("a1", "u1", { role: "assistant", content: [{ type: "text", text: "done" }] }),
		msg("b1", "a1", { role: "bashExecution", command: "echo hi", output: "hi\n", exitCode: 0 }),
		msg("u2", "b1", { role: "user", content: "next" }),
	];
	const segs = segmentTranscript(rows, indexTree(rows));
	expect(
		segs.map((s) => (s.kind === "prompt" ? `prompt:${s.entry.id}` : `turn:${s.turn.rows.map((r) => r.id)}`)),
	).toEqual(["prompt:u1", "turn:a1", "prompt:b1", "prompt:u2"]);
});

test("agent-injected user messages stay inside the turn", () => {
	const rows = [
		msg("u1", null, { role: "user", content: "go" }),
		msg("a1", "u1", { role: "assistant", content: [] }),
		msg("n1", "a1", { role: "user", content: "reminder", attribution: "agent" }),
		msg("a2", "n1", { role: "assistant", content: [] }),
	];
	const segs = segmentTranscript(rows, indexTree(rows));
	expect(segs.length).toBe(2);
	expect(segs[1].kind === "turn" && segs[1].turn.rows.map((r) => r.id)).toEqual(["a1", "n1", "a2"]);
});
