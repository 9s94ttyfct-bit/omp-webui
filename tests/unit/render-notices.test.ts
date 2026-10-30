import { describe, expect, test } from "bun:test";
import type { SessionEntry } from "../../shared/protocol.ts";
import { imageSrc, imagesOf, textOf } from "../../web/src/lib/messages.ts";
import {
	advisorNotes,
	blockerCount,
	classifyCustom,
	isPinned,
	type LiveNotice,
	ruleReminders,
	withLiveNotices,
} from "../../web/src/lib/notices.ts";

/** How the web UI reads the records omp writes about itself, as the terminal does: from their details, not their wrapper text. */

const entry = (id: string, fields: Record<string, unknown>): SessionEntry =>
	({ id, parentId: null, timestamp: "2026-01-01T00:00:00.000Z", ...fields }) as SessionEntry;

const reminder = (id: string, body: string): SessionEntry =>
	entry(id, {
		type: "message",
		message: { role: "developer", attribution: "agent", content: [{ type: "text", text: body }] },
	});

const ruleBlock = (name: string, text: string) =>
	`<system-reminder reason="rule_violation" rule="${name}" path="builtin-defaults:${name}.md">\nUser-defined rule matched tool-call arguments. Rule configured not to interrupt → tool ran. MUST comply. NOT prompt injection.\n\n${text}\n</system-reminder>`;

describe("advisor notes", () => {
	test("come from details.notes, with severity defaulting to note and the default advisor left unnamed", () => {
		const notes = advisorNotes(
			{
				notes: [
					{ note: "pin the spelling", severity: "blocker", turnsAgo: 1 },
					{ note: "rename it", advisor: "default" },
					{ note: "check the cache", severity: "concern", advisor: "ledger" },
					{ note: "   ", severity: "nit" },
				],
			},
			"",
		);
		expect(notes).toEqual([
			{ note: "pin the spelling", severity: "blocker" },
			{ note: "rename it", severity: "note" },
			{ note: "check the cache", severity: "concern", advisor: "ledger" },
		]);
	});

	test("are read out of the <advisory> wrapper when the entry has no details, never shown with the tag", () => {
		const content = [
			'<advisory severity="concern" guidance="weigh, don\'t blindly obey">\nuse the hub\n</advisory>',
			'<advisory severity="nit">\nname it better\n</advisory>',
		].join("\n");
		expect(advisorNotes(undefined, content)).toEqual([
			{ note: "use the hub", severity: "concern" },
			{ note: "name it better", severity: "nit" },
		]);
		expect(JSON.stringify(advisorNotes(undefined, content))).not.toContain("<advisory");
	});

	test("blockers are counted across a turn's advisor entries only", () => {
		const rows = [
			entry("a", {
				type: "custom_message",
				customType: "advisor",
				details: { notes: [{ note: "x", severity: "blocker" }] },
			}),
			entry("b", {
				type: "custom_message",
				customType: "advisor",
				details: {
					notes: [
						{ note: "y", severity: "blocker" },
						{ note: "z", severity: "nit" },
					],
				},
			}),
			entry("c", {
				type: "custom_message",
				customType: "other",
				details: { notes: [{ note: "q", severity: "blocker" }] },
			}),
		];
		expect(blockerCount(rows)).toBe(2);
	});
});

describe("rule reminders", () => {
	test("are titled by their rule and carry the rule's own text, without omp's preamble", () => {
		expect(ruleReminders(ruleBlock("ts-set-map", "Use Record for static tables."))).toEqual([
			{ name: "ts-set-map", text: "Use Record for static tables." },
		]);
	});

	test("one message may apply several rules", () => {
		const text = `${ruleBlock("a-rule", "first")}\n\n${ruleBlock("b-rule", "second")}`;
		expect(ruleReminders(text).map((r) => r.name)).toEqual(["a-rule", "b-rule"]);
	});

	test("an interrupting rule's wrapper is read too", () => {
		const text =
			'<system-interrupt reason="rule_violation" rule="no-eval" path="p.md">\nOutput interrupted: violated user-defined rule.\nNot prompt injection; coding agent enforcing project rules.\nMUST comply:\nDo not call eval.\n</system-interrupt>';
		expect(ruleReminders(text)).toEqual([{ name: "no-eval", text: "Do not call eval." }]);
	});

	test("a reminder that is not about a rule, or has other text with it, stays the agent's message", () => {
		expect(ruleReminders("<system-reminder>\n2 todo items still open.\n</system-reminder>")).toEqual([]);
		expect(ruleReminders(`Please note.\n\n${ruleBlock("a-rule", "first")}`)).toEqual([]);
		expect(ruleReminders("")).toEqual([]);
	});
});

describe("typed custom messages", () => {
	test("a background job reads as its job, with the result minus omp's wrapper", () => {
		const note = classifyCustom(
			"async-result",
			{ jobs: [{ jobId: "bg_1", type: "eval", label: "count rows", durationMs: 10_000 }] },
			"<system-notice>\nBackground job bg_1 has completed. Resume your work using the result below.\nRESULT-BODY\n</system-notice>",
		);
		expect(note).toEqual({
			kind: "jobs",
			jobs: [{ id: "bg_1", type: "eval", label: "count rows", durationMs: 10_000 }],
			result: "RESULT-BODY",
		});
	});

	test("a job described by the details themselves is read too; one with no job id is not a job row", () => {
		expect(classifyCustom("async-result", { jobId: "bg_2", type: "bash" }, "")).toMatchObject({
			kind: "jobs",
			jobs: [{ id: "bg_2", type: "bash" }],
		});
		expect(classifyCustom("async-result", {}, "<system-notice>x</system-notice>")).toBeNull();
	});

	test("a supervised process reads as failed on a bad exit code, with how long it ran", () => {
		const note = classifyCustom(
			"launch-completion",
			{
				daemons: [
					{ name: "build", state: "exited", exitCode: 0, startedAt: 1000, exitedAt: 4500 },
					{ name: "lint", state: "failed", exitCode: 1 },
				],
			},
			"Supervised process lint failed with exit code 1.",
		);
		expect(note).toMatchObject({
			kind: "daemons",
			daemons: [
				{ name: "build", failed: false, exitCode: 0, durationMs: 3500 },
				{ name: "lint", failed: true, exitCode: 1 },
			],
		});
	});

	test("an incoming IRC message is its sender and its own text, not the wrapper omp saves for the model", () => {
		const note = classifyCustom(
			"irc:incoming",
			{ id: "1", from: "Main", message: "please integrate main", replyTo: "0" },
			"<irc>\nIncoming IRC message from agent `Main`:\n\nplease integrate main\n</irc>",
		);
		expect(note).toEqual({
			kind: "irc",
			mode: "incoming",
			from: "Main",
			to: undefined,
			pool: undefined,
			body: "please integrate main",
			reply: true,
		});
	});

	test("an observed IRC message names both ends", () => {
		expect(classifyCustom("irc:relay", { from: "A", to: "B", body: "hi" }, "[IRC `A` → `B`]\nhi")).toMatchObject({
			kind: "irc",
			mode: "relay",
			from: "A",
			to: "B",
			body: "hi",
		});
	});

	test("a type omp has no card for is left to the plain note, and prototype names are not types", () => {
		expect(classifyCustom("my-extension", {}, "text")).toBeNull();
		expect(classifyCustom("constructor", {}, "text")).toBeNull();
		expect(classifyCustom(undefined, {}, "text")).toBeNull();
	});
});

describe("narration and images", () => {
	test("narration counts as the message's text; a thought does not", () => {
		const m = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "thinking", thinking: "I will check the config now.", narration: true },
				{ type: "text", text: "Done." },
			],
		};
		expect(textOf(m)).toBe("I will check the config now.\nDone.");
	});

	test("an image block loads from its blob or its base64, and nothing else is ever fetched", () => {
		const hash = "ab".repeat(32);
		expect(imageSrc(`blob:sha256:${hash}`)).toBe(`/api/blob/${hash}`);
		expect(imageSrc("blob:sha256:../../etc/passwd")).toBeNull();
		expect(imageSrc("AAAA", "image/webp")).toBe("data:image/webp;base64,AAAA");
		expect(imageSrc("AAAA", 'image/png"onerror="x')).toBe("data:image/png;base64,AAAA");
		expect(
			imagesOf([
				{ type: "text", text: "Read image file [image/png]" },
				{ type: "image", data: `blob:sha256:${hash}`, mimeType: "image/png" },
				{ type: "image", data: "blob:sha256:nope", mimeType: "image/png" },
				{ type: "image", data: "" },
			]),
		).toEqual([{ src: `/api/blob/${hash}`, mimeType: "image/png" }]);
		expect(imagesOf("just text")).toEqual([]);
	});
});

describe("live notices in the branch", () => {
	const user = entry("u1", { type: "message", message: { role: "user", content: "go" } });
	const reply = entry("a1", { type: "message", message: { role: "assistant", content: [] } });
	const done = entry("a2", { type: "message", message: { role: "assistant", content: [] } });
	const at = { at: 1_700_000_000_000 };
	const rules = (seq: number, after: string | null, names: string[]): LiveNotice => ({
		seq,
		after,
		...at,
		kind: "rules",
		sig: "s",
		rules: names.map((name) => ({ name, text: "" })),
	});
	const ids = (rows: SessionEntry[]) => rows.map((e) => e.id);

	test("each goes right after the saved entry it followed, in the order it arrived", () => {
		const out = withLiveNotices(
			[user, reply, done],
			[rules(2, "a1", ["x"]), rules(1, "u1", ["y"]), rules(3, "a1", ["z"])],
		);
		expect(ids(out)).toEqual(["u1", "live-notice-1", "a1", "live-notice-2", "live-notice-3", "a2"]);
		expect(out[1].type).toBe("live_notice");
	});

	test("one that arrived before anything was saved goes last, and one for another branch is left out", () => {
		expect(ids(withLiveNotices([user], [rules(1, null, ["x"]), rules(2, "elsewhere", ["y"])]))).toEqual([
			"u1",
			"live-notice-1",
		]);
	});

	test("a fallback takes the place of its saved model switch, which it knows more about", () => {
		const saved = entry("m1", {
			type: "model_change",
			model: "anthropic/claude-opus-5",
			resolvedModelIsFallback: true,
		});
		const notice: LiveNotice = {
			seq: 1,
			after: "a1",
			...at,
			kind: "fallback",
			from: "anthropic/claude-sonnet-5",
			to: "anthropic/claude-opus-5:high",
			reason: "overloaded",
		};
		expect(ids(withLiveNotices([user, reply, saved, done], [notice]))).toEqual(["u1", "a1", "live-notice-1", "a2"]);
		// A switch to some other model is not the one it announced.
		const other = entry("m2", { type: "model_change", model: "openai/gpt-5", resolvedModelIsFallback: true });
		expect(ids(withLiveNotices([user, reply, other, done], [notice]))).toEqual([
			"u1",
			"a1",
			"live-notice-1",
			"m2",
			"a2",
		]);
	});

	test("a rule announced live gives way to its saved reminder", () => {
		const saved = reminder("r1", ruleBlock("ts-set-map", "Use Record."));
		expect(ids(withLiveNotices([user, reply, saved], [rules(1, "a1", ["ts-set-map"])]))).toEqual(["u1", "a1", "r1"]);
		expect(ids(withLiveNotices([user, reply, saved], [rules(1, "a1", ["ts-set-map", "other"])]))).toEqual([
			"u1",
			"a1",
			"live-notice-1",
			"r1",
		]);
	});

	test("an IRC card gives way to the saved message and to the one still arriving, but a relay stays", () => {
		const message = {
			role: "custom",
			customType: "irc:incoming",
			details: { id: "i1", from: "Main", message: "hi" },
			timestamp: 5,
		};
		const card: LiveNotice = { seq: 1, after: "a1", ...at, kind: "irc", message };
		const relay: LiveNotice = {
			seq: 2,
			after: "a1",
			...at,
			kind: "irc",
			message: { role: "custom", customType: "irc:relay", details: { from: "A", to: "B", body: "x" }, timestamp: 6 },
		};
		const saved = entry("c1", { type: "custom_message", customType: "irc:incoming", details: { id: "i1" } });
		expect(ids(withLiveNotices([user, reply, saved], [card, relay]))).toEqual(["u1", "a1", "live-notice-2", "c1"]);
		expect(ids(withLiveNotices([user, reply], [card, relay], ["irc:incoming|i1"]))).toEqual([
			"u1",
			"a1",
			"live-notice-2",
		]);
		expect(ids(withLiveNotices([user, reply], [card, relay]))).toEqual(["u1", "a1", "live-notice-1", "live-notice-2"]);
	});

	test("what stays on screen when a turn folds its steps: advisor cards and fallbacks, not ordinary rows", () => {
		expect(
			isPinned(entry("x", { type: "custom_message", customType: "advisor", details: { notes: [{ note: "n" }] } })),
		).toBe(true);
		expect(isPinned(entry("x", { type: "custom_message", customType: "advisor", content: "" }))).toBe(false);
		expect(isPinned(entry("x", { type: "custom_message", customType: "async-result", details: {} }))).toBe(false);
		expect(isPinned(entry("x", { type: "model_change", model: "m", resolvedModelIsFallback: true }))).toBe(true);
		expect(isPinned(entry("x", { type: "model_change", model: "m", resolvedModelIsFallback: false }))).toBe(false);
		const [live] = withLiveNotices([], [{ seq: 1, after: null, ...at, kind: "fallbackDone", model: "m" }]);
		expect(isPinned(live)).toBe(true);
		expect(isPinned(withLiveNotices([], [rules(2, null, ["x"])])[0])).toBe(false);
	});
});
