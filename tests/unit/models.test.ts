import { expect, test } from "bun:test";
import { modelLabel, sharedLabels } from "../../web/src/lib/models.ts";

/** A model is listed under its name, or its id when it has none; names several models share get their ids shown. */

const haiku = { provider: "anthropic", id: "claude-haiku-4-5", name: "Claude Haiku 4.5" };
const haikuDated = { provider: "anthropic", id: "claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" };
const sonnet = { provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" };

test("a model without a name is listed under its id", () => {
	expect(modelLabel(haiku)).toBe("Claude Haiku 4.5");
	expect(modelLabel({ provider: "local", id: "tiny" })).toBe("tiny");
});

test("only names that more than one model carries are shared", () => {
	expect([...sharedLabels([haiku, sonnet, haikuDated])]).toEqual(["Claude Haiku 4.5"]);
	expect(sharedLabels([haiku, sonnet]).size).toBe(0);
	expect(sharedLabels([]).size).toBe(0);
});

test("a name is shared across providers, not just within one", () => {
	const other = { provider: "openrouter", id: "anthropic/claude-sonnet-4-5", name: "Claude Sonnet 4.5" };
	expect([...sharedLabels([sonnet, other])]).toEqual(["Claude Sonnet 4.5"]);
});
