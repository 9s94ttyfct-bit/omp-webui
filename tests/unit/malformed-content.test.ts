import "./browser-globals.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as Tooltip from "@radix-ui/react-tooltip";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { SessionEntry, SessionFileData } from "../../shared/protocol.ts";
import { AgentTurnBlock } from "../../web/src/components/AgentTurn.tsx";
import { EntryNote, MessageRow } from "../../web/src/components/Message.tsx";
import { buildFamily, FamilyBuilder } from "../../web/src/lib/family.ts";
import {
	type AgentMessage,
	blocks,
	type ContentBlock,
	contentBlock,
	isVisible,
	messageOf,
	textOf,
	UNKNOWN_BLOCK,
} from "../../web/src/lib/messages.ts";
import { classifyCustom, contentText, withLiveNotices } from "../../web/src/lib/notices.ts";
import { promptsOf } from "../../web/src/lib/recall.ts";
import { sumEntries, usageByModel } from "../../web/src/lib/totals.ts";
import { PathTracker, pathTo } from "../../web/src/lib/tree.ts";
import { activeMs, liveTurn, stepStats, unsavedSteps } from "../../web/src/lib/turn-stats.ts";
import { type Segment, Segmenter, segmentTranscript } from "../../web/src/lib/turns.ts";
import { conversation, SHAPES, TEXT } from "../support/malformed-content.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * A session file says whatever it says: a hand edit, an interrupted write, another version of omp or another tool wrote
 * it. A `null` in a message's `content` used to throw in the turn builder, outside every row, and the chat page was
 * replaced by the Reload screen for good (the line is in the file). Whatever a content block is, the pipeline reads
 * around it, never throws, and what it derives going on from where it was is what it derives from the start.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const FILE = "/x/malformed.jsonl";
const NO_FILES: SessionFileData[] = [];

/** A segment as it reads: what the page draws from it. */
function shape(s: Segment) {
	return s.kind === "prompt"
		? ["prompt", s.entry.id]
		: ["turn", s.turn.rows.map((e) => e.id), s.turn.entries.map((e) => e.id), [...s.turn.toolIds].sort()];
}

/** Everything the page derives from the entries that reads message content, going on from where it was. */
class Page {
	readonly builder = new FamilyBuilder();
	readonly tracker = new PathTracker();
	readonly segmenter = new Segmenter();

	update(entries: SessionEntry[]) {
		const fam = this.builder.update(NO_FILES, FILE, entries);
		const leaf = fam.headOf.get(FILE) ?? null;
		const path = this.tracker.path(fam.idx, leaf);
		const segments = this.segmenter.update(path, fam.idx, [], []);
		return { fam, path, segments, ...derived(path, entries, leaf) };
	}
}

/** What does not depend on how the entries came in. */
function derived(path: SessionEntry[], entries: SessionEntry[], leaf: string | null) {
	const tally = liveTurn([...entries], leaf).tally;
	return {
		usage: sumEntries([...entries]),
		worked: activeMs([...entries]),
		byModel: usageByModel([...entries]),
		prompts: promptsOf([...path]),
		texts: path.map((e) => {
			const m = messageOf(e);
			return m ? [e.id, textOf(m), blocks(m).length] : [e.id];
		}),
		steps: path.map((e) => {
			const m = messageOf(e);
			return m ? stepStats(m, e.timestamp) : null;
		}),
		figures: tally.figures(unsavedSteps(tally.started, [])),
	};
}

/** The same, from the start. */
function fromStart(entries: SessionEntry[]) {
	const copy = [...entries];
	const fam = buildFamily([], FILE, copy);
	const leaf = fam.headOf.get(FILE) ?? null;
	const path = pathTo(fam.idx, leaf);
	const rows = withLiveNotices(path, [], []).filter(isVisible);
	return { fam, path, segments: segmentTranscript(rows, fam.idx), ...derived(path, copy, leaf) };
}

/** `value` read as a block, compared to what it should read as. */
const reads = (value: unknown, want: Record<string, unknown>) =>
	expect(contentBlock(value) as unknown as Record<string, unknown>).toEqual(want);

const wellFormed = (b: unknown): boolean => {
	if (typeof b !== "object" || b === null || typeof (b as ContentBlock).type !== "string") return false;
	const x = b as ContentBlock;
	return (
		(x.text === undefined || typeof x.text === "string") &&
		(x.thinking === undefined || typeof x.thinking === "string") &&
		(x.narration === undefined || typeof x.narration === "boolean") &&
		(x.redacted === undefined || typeof x.redacted === "boolean") &&
		(x.id === undefined || typeof x.id === "string") &&
		(x.name === undefined || typeof x.name === "string") &&
		(x.arguments === undefined ||
			(typeof x.arguments === "object" && x.arguments !== null && !Array.isArray(x.arguments))) &&
		(x.data === undefined || typeof x.data === "string") &&
		(x.mimeType === undefined || typeof x.mimeType === "string")
	);
};

describe("blocks: every one readable, in the place the file gave it", () => {
	test("a block that is not an object with a string type is one the page does not know, and keeps its place", () => {
		for (const value of [
			null,
			undefined,
			5,
			true,
			"str",
			[],
			[null],
			{},
			{ text: "no type" },
			{ type: 5 },
			{ type: null },
			{ type: {} },
		]) {
			expect(contentBlock(value)).toBe(UNKNOWN_BLOCK);
		}
		const m: AgentMessage = {
			role: "assistant",
			content: [null, TEXT, 5, { type: "toolCall", id: "t1" }] as unknown as ContentBlock[],
		};
		const read = blocks(m);
		expect(read).toHaveLength(4);
		expect(read[0]).toBe(UNKNOWN_BLOCK);
		expect(read[1]).toBe(TEXT as ContentBlock);
		expect(read[2]).toBe(UNKNOWN_BLOCK);
		expect(read[3]).toEqual({ type: "toolCall", id: "t1" });
		expect(textOf(m)).toBe("visible text");
	});

	test("a field of the wrong type is left out, so it reads as absent; the block's other fields stay", () => {
		reads({ type: "text", text: 5 }, { type: "text" });
		reads({ type: "text", text: null }, { type: "text" });
		reads(
			{ type: "thinking", thinking: ["x"], narration: "yes", redacted: true },
			{ type: "thinking", redacted: true },
		);
		reads({ type: "toolCall", id: 5, name: "bash", arguments: "echo hi" }, { type: "toolCall", name: "bash" });
		reads({ type: "toolCall", id: "t1", name: "bash", arguments: [1] }, { type: "toolCall", id: "t1", name: "bash" });
		reads(
			{ type: "image", data: 5, mimeType: "image/png", extra: 1 },
			{ type: "image", mimeType: "image/png", extra: 1 },
		);
		// A type nobody knows is passed on as it is; the prototype's names are not types.
		reads({ type: "redacted_thinking", data: 5 }, { type: "redacted_thinking", data: 5 });
		reads({ type: "__proto__" }, { type: "__proto__" });
		reads({ type: "constructor", text: 5 }, { type: "constructor", text: 5 });
	});

	test("a message that is as it should be is not copied, and what is read once is not read again", () => {
		const content = [TEXT, { type: "toolCall", id: "t1", name: "bash", arguments: { command: "x" } }];
		const m: AgentMessage = { role: "assistant", content };
		expect(blocks(m)).toBe(content as ContentBlock[]);
		for (const block of content) expect(contentBlock(block)).toBe(block as ContentBlock);
		const bad: AgentMessage = { role: "assistant", content: [null, TEXT] as unknown as ContentBlock[] };
		expect(blocks(bad)).toBe(blocks(bad));
		expect(blocks({ role: "assistant", content: "text" })).toEqual([{ type: "text", text: "text" }]);
		for (const content of [null, undefined, 5, {}, true]) {
			expect(blocks({ role: "assistant", content } as unknown as AgentMessage)).toEqual([]);
		}
	});

	for (const [name, s] of Object.entries(SHAPES)) {
		test(`${name}: what the messages of the conversation read as is well formed`, () => {
			for (const e of conversation(s)) {
				const m = messageOf(e);
				if (!m) continue;
				const read = blocks(m);
				expect(read.every(wellFormed)).toBe(true);
				if (Array.isArray(m.content)) expect(read).toHaveLength(m.content.length);
				expect(typeof textOf(m)).toBe("string");
			}
		});
	}
});

describe("going on from where it was is starting from the start, whatever the content", () => {
	for (const [name, s] of Object.entries(SHAPES)) {
		test(`${name}: entry by entry, and in pieces, nothing throws and both ways read the same`, () => {
			const entries = conversation(s);
			const calls = ["t1", "t2", "none"];
			// One entry at a time.
			let page = new Page();
			for (let n = 1; n <= entries.length; n++) {
				const now = entries.slice(0, n);
				const got = page.update(now);
				const scratch = fromStart(now);
				expect(got.segments.map(shape)).toEqual(scratch.segments.map(shape));
				expect(got.path.map((e) => e.id)).toEqual(scratch.path.map((e) => e.id));
				for (const key of ["usage", "worked", "byModel", "prompts", "texts", "steps", "figures"] as const) {
					expect({ key, value: got[key] }).toEqual({ key, value: scratch[key] });
				}
				for (const id of calls)
					expect(got.fam.toolResults.get(id)?.toolCallId).toBe(scratch.fam.toolResults.get(id)?.toolCallId);
			}
			// A pull that brings several at once.
			page = new Page();
			for (const n of [2, 4, entries.length]) {
				const now = entries.slice(0, Math.min(n, entries.length));
				expect(page.update(now).segments.map(shape)).toEqual(fromStart(now).segments.map(shape));
			}
		});
	}

	test("the calls of a turn are found whatever else the reply holds", () => {
		const s = SHAPES["nested nulls in tool calls"];
		const segments = fromStart(conversation(s)).segments;
		const turn = segments.find((x) => x.kind === "turn" && x.turn.entries.some((e) => e.id === "a1"));
		expect(turn?.kind === "turn" && [...turn.turn.toolIds].sort()).toEqual(["t1", "t2"]);
		expect(page(conversation(s)).segments.map(shape)).toEqual(segments.map(shape));
	});
});

const page = (entries: SessionEntry[]) => new Page().update(entries);

describe("what is drawn from it", () => {
	const actions = {};
	for (const [name, s] of Object.entries(SHAPES)) {
		test(`${name}: every row of the conversation draws, and the good messages around the bad one are there`, () => {
			const entries = conversation(s);
			const { segments, fam } = fromStart(entries);
			/** What a row draws as (the page's tooltips live in one provider). */
			const draw = (child: ReturnType<typeof createElement>) =>
				renderToString(createElement(Tooltip.Provider, null, child));
			let html = "";
			for (const seg of segments) {
				if (seg.kind === "prompt") {
					const m = messageOf(seg.entry);
					html += draw(
						m
							? createElement(MessageRow, {
									entry: seg.entry,
									message: m,
									toolResults: fam.toolResults,
									tools: {},
									actions,
								})
							: createElement(EntryNote, { entry: seg.entry }),
					);
				} else {
					html += draw(
						createElement(AgentTurnBlock, {
							turn: seg.turn,
							toolResults: fam.toolResults,
							tools: {},
							actions,
							live: false,
						}),
					);
				}
			}
			expect(html).toContain("second reply after");
			expect(html).toContain("second prompt");
			// What can be read of the bad message is shown.
			if (JSON.stringify(s.reply).includes("visible text")) expect(html).toContain("visible text");
		});
	}

	test("notes read around what is wrong with them", () => {
		for (const content of [
			null,
			5,
			{},
			[],
			[null],
			[5, "x"],
			[{ type: "text", text: 5 }],
			[{ type: "text", text: "kept" }],
		]) {
			expect(typeof contentText(content)).toBe("string");
		}
		expect(contentText([null, { type: "text", text: "kept" }, 5, { type: "text", text: null }]).trim()).toBe("kept");
		for (const customType of [
			"advisor",
			"async-result",
			"launch-completion",
			"irc:incoming",
			"irc:relay",
			"other",
			5,
			null,
		]) {
			for (const details of [
				null,
				5,
				"x",
				[],
				[null],
				{},
				{ notes: [null, 5, {}, { note: 5 }, [null]] },
				{ id: 5, from: [null], to: {} },
			]) {
				for (const content of [null, 5, [null], [{ type: "text", text: 5 }], "hello"]) {
					expect(() => classifyCustom(customType, details, content)).not.toThrow();
				}
			}
		}
	});
});
