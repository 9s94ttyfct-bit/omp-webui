import { expect, test } from "bun:test";
import type { LiveInfo, OmpFrame, SessionEntry } from "../../shared/protocol.ts";
import { textOf } from "../../web/src/lib/messages.ts";
import { applyFrame, initialLive, type LiveState } from "../../web/src/store/live.ts";

/** What the chat shows of omp's own announcements (rules, fallbacks, IRC messages), folded from the frames omp sends. */

const info: LiveInfo = {
	liveId: "L1",
	pid: 1,
	cwd: "/",
	sessionFile: null,
	sessionId: null,
	args: [],
	startedAt: 0,
	streaming: false,
	exited: false,
	subscribers: 1,
	pausedAt: null,
	mode: "full",
};

const fold = (frames: OmpFrame[], from: LiveState = initialLive(info)): LiveState => frames.reduce(applyFrame, from);

const saved = (id: string): SessionEntry => ({
	type: "message",
	id,
	parentId: null,
	timestamp: "2026-01-01T00:00:00.000Z",
	message: { role: "user", content: "hi" },
});

const ttsr = (...rules: Record<string, unknown>[]): OmpFrame => ({ type: "ttsr_triggered", rules });

test("a rule omp applies is a notice with its description, else its text", () => {
	const s = fold([
		ttsr({ name: "ts-set-map", description: "Prefer Record." }),
		ttsr({ name: "other", content: "  Body.  " }),
	]);
	// Both arrived with nothing between them: one row.
	expect(s.notices).toHaveLength(1);
	expect(s.notices[0]).toMatchObject({
		kind: "rules",
		rules: [
			{ name: "ts-set-map", text: "Prefer Record." },
			{ name: "other", text: "Body." },
		],
	});
});

test("a rule announced again, or with no name, adds nothing", () => {
	const s = fold([
		ttsr({ name: "a", content: "x" }),
		ttsr({ name: "a", content: "x" }),
		ttsr({ description: "nameless" }),
	]);
	expect(s.notices).toHaveLength(1);
	expect(s.notices[0]).toMatchObject({ rules: [{ name: "a" }] });
	expect(fold([{ type: "ttsr_triggered" }]).notices).toEqual([]);
});

test("a rule that comes after something else in the chat is a row of its own", () => {
	const first = fold([ttsr({ name: "a", content: "x" })]);
	const next = fold([ttsr({ name: "b", content: "y" })], { ...first, entries: [saved("e1")] });
	expect(next.notices.map((n) => n.kind === "rules" && n.rules.map((r) => r.name))).toEqual([["a"], ["b"]]);
	// Each knows the last saved entry at its time: that is where it belongs.
	expect(next.notices.map((n) => n.after)).toEqual([null, "e1"]);
});

test("a fallback and its success are notices with the reason omp gave", () => {
	const s = fold([
		{ type: "retry_fallback_applied", from: "a/one", to: "b/two", role: "default", reason: " Request rejected. " },
		{ type: "retry_fallback_succeeded", model: "b/two", role: "default" },
		{ type: "retry_fallback_applied", role: "default" },
	]);
	expect(s.notices).toMatchObject([
		{ kind: "fallback", from: "a/one", to: "b/two", role: "default", reason: "Request rejected." },
		{ kind: "fallbackDone", model: "b/two", role: "default" },
	]);
});

test("an IRC message is a card once, however often omp announces it; other custom messages are not cards", () => {
	const message = {
		role: "custom",
		customType: "irc:relay",
		details: { from: "A", to: "B", body: "hi" },
		timestamp: 7,
	};
	const s = fold([
		{ type: "irc_message", message },
		{ type: "irc_message", message },
		{ type: "irc_message", message: { role: "custom", customType: "advisor", timestamp: 8 } },
		{ type: "irc_message" },
	]);
	expect(s.notices).toHaveLength(1);
	expect(s.notices[0]).toMatchObject({ kind: "irc", message: { customType: "irc:relay" } });
});

test("a process that runs for days keeps the latest notices only", () => {
	const frames = Array.from({ length: 60 }, (_, i): OmpFrame => ({ type: "retry_fallback_succeeded", model: `m${i}` }));
	const s = fold(frames);
	expect(s.notices).toHaveLength(40);
	expect(s.notices[0]).toMatchObject({ seq: 21, model: "m20" });
	expect(s.notices.at(-1)).toMatchObject({ seq: 60, model: "m59" });
});

test("a narration block is only known to be one when its message ends: the delta stream carries no flag", () => {
	const id = "m1";
	const during = fold([
		{ type: "message_start", messageId: id, message: { role: "assistant", content: [] } },
		{
			type: "message_update",
			messageId: id,
			message: { role: "assistant" },
			assistantMessageEvent: { type: "thinking_start", contentIndex: 0 },
		},
		{
			type: "message_update",
			messageId: id,
			message: { role: "assistant" },
			assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Checking the config." },
		},
		{
			type: "message_update",
			messageId: id,
			message: { role: "assistant" },
			assistantMessageEvent: { type: "thinking_end", contentIndex: 0, content: "Checking the config." },
		},
	]);
	const streamed = during.overlay[0].message;
	expect(streamed.content).toEqual([{ type: "thinking", thinking: "Checking the config." }]);
	expect(textOf(streamed)).toBe("");

	const ended = fold(
		[
			{
				type: "message_end",
				messageId: id,
				message: {
					role: "assistant",
					content: [{ type: "thinking", thinking: "Checking the config.", narration: true }],
				},
			},
		],
		during,
	);
	expect(ended.overlay).toHaveLength(1);
	expect(ended.overlay[0].ended).toBe(true);
	expect(textOf(ended.overlay[0].message)).toBe("Checking the config.");
});
