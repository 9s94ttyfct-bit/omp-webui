import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveInfo, OmpFrame } from "../../shared/protocol.ts";
import { type AgentMessage, blocks } from "../../web/src/lib/messages.ts";
import { applyFrame, initialLive, type LiveState } from "../../web/src/store/live.ts";

/**
 * Frames recorded from a real `omp --mode rpc-ui` run with
 * `set_event_filter … messageUpdates: "delta"` (thinking + bash tool call + text).
 */
const frames: OmpFrame[] = readFileSync(join(import.meta.dir, "../fixtures/delta-frames.jsonl"), "utf8")
	.trim()
	.split("\n")
	.map((l) => JSON.parse(l));

const info: LiveInfo = {
	liveId: "L1",
	pid: 1,
	cwd: "/",
	sessionFile: null,
	sessionId: null,
	args: [],
	startedAt: 0,
	streaming: true,
	exited: false,
	subscribers: 1,
	pausedAt: null,
	mode: "full",
};

const normalize = (m: AgentMessage) =>
	blocks(m).map((b) => ({
		type: b.type,
		text: b.text,
		thinking: b.thinking,
		id: b.id,
		name: b.name,
		arguments: b.arguments,
	}));

describe("delta message updates", () => {
	test("replaying deltas rebuilds exactly the message omp reports at message_end", () => {
		const ends = frames.filter((f) => f.type === "message_end");
		expect(ends.length).toBeGreaterThan(1);
		let s: LiveState = initialLive(info);
		for (const f of frames) if (f.type !== "message_end") s = applyFrame(s, f);
		for (const end of ends) {
			const built = s.overlay.find((o) => o.messageId === end.messageId);
			const final = end.message as AgentMessage;
			if (final.role !== "assistant") continue;
			expect(built, String(end.messageId)).toBeDefined();
			expect(normalize(built?.message as AgentMessage)).toEqual(normalize(final));
		}
	});

	test("every intermediate text is a prefix of the final text (no dropped or reordered deltas)", () => {
		let s: LiveState = initialLive(info);
		const seen = new Map<string, string[]>();
		for (const f of frames) {
			if (f.type === "message_end") continue;
			s = applyFrame(s, f);
			for (const o of s.overlay) {
				const text = blocks(o.message)
					.filter((b) => b.type === "text")
					.map((b) => b.text)
					.join("");
				seen.set(o.messageId, [...(seen.get(o.messageId) ?? []), text]);
			}
		}
		for (const end of frames.filter((f) => f.type === "message_end")) {
			const finalText = blocks(end.message as AgentMessage)
				.filter((b) => b.type === "text")
				.map((b) => b.text)
				.join("");
			for (const t of seen.get(String(end.messageId)) ?? []) expect(finalText.startsWith(t)).toBe(true);
		}
	});
});
