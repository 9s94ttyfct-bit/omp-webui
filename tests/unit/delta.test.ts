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

/**
 * omp 18.13.2 and later add to the delta projection (`packages/coding-agent/src/modes/rpc/rpc-session-events.ts`): `start`
 * carries the whole message as it begins again, a text or thinking `*_start` / `*_end` carries its block without the text
 * (`block`), and `image_end` carries the image (`content`). The frames below are built the way that file builds them.
 */
describe("delta message updates of omp 18.13.2 (audit A-005)", () => {
	const update = (ev: Record<string, unknown>): OmpFrame => ({
		type: "message_update",
		assistantMessageEvent: ev,
		message: { role: "assistant" },
		messageId: "m1",
	});
	const fold = (list: Record<string, unknown>[]): AgentMessage => {
		let s: LiveState = initialLive(info);
		s = applyFrame(s, { type: "message_start", message: { role: "assistant", content: [] }, messageId: "m1" });
		for (const ev of list) s = applyFrame(s, update(ev));
		return s.overlay.find((o) => o.messageId === "m1")?.message as AgentMessage;
	};

	test("a message that begins again within the turn drops what the abandoned attempt wrote", () => {
		const m = fold([
			{ type: "text_start", contentIndex: 0, block: { type: "text" } },
			{ type: "text_delta", contentIndex: 0, delta: "a first attempt" },
			{ type: "text_start", contentIndex: 1, block: { type: "text" } },
			{ type: "text_delta", contentIndex: 1, delta: "and more of it" },
			{ type: "start", message: { role: "assistant", content: [] } },
			{ type: "text_start", contentIndex: 0, block: { type: "text" } },
			{ type: "text_delta", contentIndex: 0, delta: "the answer" },
		]);
		expect(blocks(m).map((b) => b.text)).toEqual(["the answer"]);
	});

	test("thinking omp marks as narration streams as answer text, its flag kept from start to end", () => {
		const m = fold([
			{ type: "thinking_start", contentIndex: 0, block: { type: "thinking", thinking: "", narration: true } },
			{ type: "thinking_delta", contentIndex: 0, delta: "Looking at " },
			{ type: "thinking_delta", contentIndex: 0, delta: "the file." },
		]);
		expect(blocks(m)).toEqual([{ type: "thinking", thinking: "Looking at the file.", narration: true }]);
		const ended = fold([
			{ type: "thinking_start", contentIndex: 0, block: { type: "thinking", thinking: "" } },
			{ type: "thinking_delta", contentIndex: 0, delta: "Looking" },
			{
				type: "thinking_end",
				contentIndex: 0,
				content: "Looking at the file.",
				block: { type: "thinking", thinkingSignature: "sig", narration: true },
			},
		]);
		// Fields the page does not read (the signature) are kept as omp sent them.
		expect(blocks(ended) as unknown[]).toEqual([
			{ type: "thinking", thinking: "Looking at the file.", thinkingSignature: "sig", narration: true },
		]);
	});

	test("a text block's end merges what omp says of it; an image is there at its end, not only at message_end", () => {
		const m = fold([
			{ type: "text_start", contentIndex: 0, block: { type: "text", text: "" } },
			{ type: "text_delta", contentIndex: 0, delta: "Here" },
			{ type: "text_end", contentIndex: 0, content: "Here it is.", block: { type: "text", textSignature: "t1" } },
			{ type: "image_end", contentIndex: 1, content: { type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" } },
		]);
		expect(blocks(m) as unknown[]).toEqual([
			{ type: "text", text: "Here it is.", textSignature: "t1" },
			{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
		]);
	});

	test("an older omp's frames (no block, no message on start) build the same text as before", () => {
		const m = fold([
			{ type: "start" },
			{ type: "text_start", contentIndex: 0 },
			{ type: "text_delta", contentIndex: 0, delta: "plain" },
			{ type: "text_end", contentIndex: 0, content: "plain text" },
		]);
		expect(blocks(m)).toEqual([{ type: "text", text: "plain text" }]);
	});
});
