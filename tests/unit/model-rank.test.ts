import { describe, expect, test } from "bun:test";
import { aliasesOf, matchModel, rankModels } from "../../web/src/lib/model-rank.ts";

/**
 * The model picker's search: what a model answers to (its name, its provider, its id and the names people call it), and
 * the order the list comes in once something is typed or loved.
 */

const models = [
	{ provider: "anthropic", id: "claude-opus-4-1", name: "Claude Opus 4.1" },
	{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
	{ provider: "anthropic", id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
	{ provider: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat" },
	{ provider: "deepseek", id: "deepseek-reasoner" },
	{ provider: "openai", id: "gpt-5", name: "GPT-5" },
];

const names = (list: { model: { name?: string; id: string } }[]) => list.map((r) => r.model.name ?? r.model.id);
const key = (m: { provider: string; id: string }) => `${m.provider}/${m.id}`;
/** The model at `i` (written out: a spec of a fixed list, and the list is what it is). */
const at = (i: number) => models[i] as (typeof models)[number];

describe("what a model answers to", () => {
	test("its name, its provider and its id", () => {
		expect(matchModel(at(1), "sonnet")).not.toBeNull();
		expect(matchModel(at(1), "anthropic")).not.toBeNull();
		expect(matchModel(at(1), "sonnet45")).not.toBeNull();
	});

	test("the names people use for it: `ds` for deepseek, `gpt` for openai", () => {
		expect(names(rankModels(models, "ds"))[0]).toBe("DeepSeek Chat");
		expect(names(rankModels(models, "gpt"))).toEqual(["GPT-5"]);
		expect(names(rankModels(models, "opus"))).toEqual(["Claude Opus 4.1"]);
	});

	test("a family name finds every model of it", () => {
		expect(names(rankModels(models, "haiku"))).toEqual(["Claude Haiku 4.5"]);
		expect(names(rankModels(models, "claude")).sort()).toEqual([
			"Claude Haiku 4.5",
			"Claude Opus 4.1",
			"Claude Sonnet 4.5",
		]);
	});

	test("a dated snapshot answers to its family's name too", () => {
		const snapshot = { provider: "anthropic", id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" };
		expect(aliasesOf(snapshot)).toContain("claude-haiku-4-5");
		expect(matchModel(snapshot, "haiku45")).not.toBeNull();
	});

	test("a model with no name is found by its id", () => {
		expect(names(rankModels(models, "reasoner"))).toEqual(["deepseek-reasoner"]);
	});

	test("the match says where it was in the name, the provider or the id", () => {
		expect(matchModel(at(1), "sonnet")?.positions.label).toHaveLength(6);
		expect(matchModel(at(1), "anthropic")?.positions.provider).toHaveLength(9);
		// A dated snapshot's date is in its id, not in the name a person reads.
		expect(matchModel(at(2), "20251001")?.positions.id).toHaveLength(8);
		// A model with no name of its own is drawn by its id, so its match marks the label.
		expect(matchModel(at(4), "reason")?.positions.label).toHaveLength(6);
		// An alias is not drawn in the row, so it marks nothing.
		expect(matchModel(at(3), "ds")?.positions).toEqual({ label: [], provider: [], id: [] });
	});

	test("a query nothing answers is nothing", () => {
		expect(rankModels(models, "zzzz")).toEqual([]);
	});
});

describe("the order the list comes in", () => {
	test("with nothing typed: loved, then recent, then the rest, each model once", () => {
		const listed = rankModels(models, "", {
			loved: [key(at(3))],
			recent: [key(at(5)), key(at(0))],
		});
		expect(names(listed)).toEqual([
			"DeepSeek Chat",
			"GPT-5",
			"Claude Opus 4.1",
			"Claude Sonnet 4.5",
			"Claude Haiku 4.5",
			"deepseek-reasoner",
		]);
	});

	test("a loved model that is recent is listed once, at its loved place", () => {
		const listed = rankModels(models, "", { loved: [key(at(5))], recent: [key(at(5))] });
		expect(listed.filter((r) => r.model === models[5])).toHaveLength(1);
		expect(listed[0]?.model).toBe(at(5));
	});

	test("a query ranks the best match first, whatever the loved and recent order", () => {
		const listed = rankModels(models, "sonnet", { loved: [key(at(5))] });
		expect(names(listed)[0]).toBe("Claude Sonnet 4.5");
		// A loved model that does not match is not listed at all.
		expect(listed.map((r) => r.model)).not.toContain(at(5));
	});

	test("among equal matches, loved and recent models come first", () => {
		const listed = rankModels(models, "claude", { loved: [key(at(2))] });
		expect(names(listed)[0]).toBe("Claude Haiku 4.5");
	});

	test("every scored match outranks nothing at all", () => {
		for (const r of rankModels(models, "claude")) expect(r.score).toBeGreaterThan(0);
	});
});
