import { expect, test } from "bun:test";
import {
	BUILT_IN_IDS,
	DEFAULT_QUICK_PROMPTS,
	parseQuickPrompts,
	QUICK_PROMPTS_MAX,
	restoredQuickPrompts,
	SOFT_STOP_ID,
	serializeQuickPrompts,
} from "../../shared/quick-prompts.ts";

/** The quick prompts as kept in the preferences (#659): what is read back, and what is kept at all. */

const ask = { id: "a", name: "Ask", text: "Any questions?", mode: "followUp", stopAfter: false } as const;
/** A list saved by this version: made with every built-in there is. */
const ALL_SEEN = JSON.stringify(BUILT_IN_IDS);

test("nothing stored, or a value that is not a list, is the defaults: Soft stop first, then the presets", () => {
	for (const v of [null, "not json", "{}"]) {
		expect(parseQuickPrompts(v)).toEqual([...DEFAULT_QUICK_PROMPTS]);
	}
	expect(DEFAULT_QUICK_PROMPTS[0]).toMatchObject({ id: SOFT_STOP_ID, mode: "steer", stopAfter: true });
	// The presets wait for the turn and never stop the session.
	for (const p of DEFAULT_QUICK_PROMPTS.slice(1)) expect(p).toMatchObject({ mode: "followUp", stopAfter: false });
	expect(DEFAULT_QUICK_PROMPTS.find((p) => p.id === "commit-work")?.text).toContain("Do not push");
});

test("a stored list is read in order; what the page does not write, and repeated ids, are left out", () => {
	const stored = JSON.stringify([
		ask,
		{ ...ask, id: "b", mode: "now" },
		{ ...ask, id: "c", name: "  " },
		{ ...ask, id: "d", text: "" },
		{ ...ask, name: "Again" },
		{ id: "e", name: "No flag", text: "x", mode: "steer" },
	]);
	expect(parseQuickPrompts(stored, ALL_SEEN)).toEqual([
		ask,
		{ id: "e", name: "No flag", text: "x", mode: "steer", stopAfter: false },
	]);
	// An empty list is a choice, not the defaults.
	expect(parseQuickPrompts("[]", ALL_SEEN)).toEqual([]);
});

test("a built-in added since a list was saved joins it once; one the person removed stays removed", () => {
	// A list saved by v0.11.17 (no seen list: it knew Soft stop only), which removed Soft stop and added its own.
	const old = JSON.stringify([ask]);
	const merged = parseQuickPrompts(old, null);
	expect(merged.map((p) => p.id)).toEqual(["a", ...BUILT_IN_IDS.filter((id) => id !== SOFT_STOP_ID)]);
	// Saved again by this version (every built-in seen), with a preset removed: it does not come back.
	const kept = serializeQuickPrompts(merged.filter((p) => p.id !== "simplify"));
	expect(parseQuickPrompts(kept, ALL_SEEN).map((p) => p.id)).not.toContain("simplify");
	// A full list has no room for them: nothing is pushed out.
	const full = Array.from({ length: QUICK_PROMPTS_MAX }, (_, i) => ({ ...ask, id: `p${i}` }));
	expect(parseQuickPrompts(JSON.stringify(full), null).map((p) => p.id)).toEqual(full.map((p) => p.id));
	// A built-in the list still has is not added twice.
	const withReview = JSON.stringify([{ ...DEFAULT_QUICK_PROMPTS[1], name: "Mine" }]);
	expect(parseQuickPrompts(withReview, null).filter((p) => p.id === "review-changes")).toHaveLength(1);
});

test("Restore puts the built-ins back as shipped and keeps the person's own prompts", () => {
	const list = [ask, { ...DEFAULT_QUICK_PROMPTS[0], name: "Wrap up" }];
	expect(restoredQuickPrompts(list)).toEqual([...DEFAULT_QUICK_PROMPTS, ask]);
});

test("the list is cut at the most kept", () => {
	const many = Array.from({ length: QUICK_PROMPTS_MAX + 5 }, (_, i) => ({ ...ask, id: `p${i}` }));
	expect(parseQuickPrompts(JSON.stringify(many), ALL_SEEN)).toHaveLength(QUICK_PROMPTS_MAX);
});

test("the defaults as shipped are kept as nothing; any edit is kept and reads back the same", () => {
	expect(serializeQuickPrompts(DEFAULT_QUICK_PROMPTS)).toBeNull();
	const edited = [{ ...DEFAULT_QUICK_PROMPTS[0], name: "Wrap up" }, ask];
	const kept = serializeQuickPrompts(edited as never);
	expect(kept).not.toBeNull();
	expect(parseQuickPrompts(kept, ALL_SEEN)).toEqual(edited);
	expect(serializeQuickPrompts([])).toBe("[]");
});
