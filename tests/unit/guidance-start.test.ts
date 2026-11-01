import { expect, test } from "bun:test";
import { GUIDANCE_MAX } from "../../shared/model-guidance.ts";
import { isValidPref, PREF } from "../../shared/prefs.ts";
import { guidanceToRemember, initialGuidance } from "../../web/src/lib/guidance-start.ts";

/**
 * New chat starts with the guidance the last new chat was started with (v0.17.0 §4): a template by id, text written there,
 * or none; Settings' default until something is remembered, and when the remembered template was deleted since.
 */

const ids = (...list: string[]) => new Set(list);

test("a remembered template is the start, while it exists; deleted since, Settings' default is", () => {
	expect(initialGuidance('{"template":"b"}', "a", ids("a", "b"))).toEqual({ template: "b" });
	expect(initialGuidance('{"template":"b"}', "a", ids("a"))).toEqual({ template: "a" });
	expect(initialGuidance('{"template":"b"}', null, ids("a"))).toBeNull();
	// The templates are not known yet: the id is trusted (the server reads its text).
	expect(initialGuidance('{"template":"b"}', "a", null)).toEqual({ template: "b" });
});

test("remembered text and remembered none are the start; nothing or nonsense remembered is Settings' default", () => {
	expect(initialGuidance('{"text":"Be brief."}', "a", ids("a"))).toEqual({ text: "Be brief." });
	expect(initialGuidance('{"none":true}', "a", ids("a"))).toBeNull();
	expect(initialGuidance(null, "a", ids("a"))).toEqual({ template: "a" });
	expect(initialGuidance(null, null, null)).toBeNull();
	for (const bad of ["", "{", "[]", '{"template":""}', '{"text":""}', '{"none":false}', '{"template":"a b"}'])
		expect(initialGuidance(bad, "a", ids("a"))).toEqual({ template: "a" });
});

test("what a started chat remembers: the template's id over its text, the text, or none", () => {
	expect(guidanceToRemember({ template: "b", text: "what b said" })).toBe('{"template":"b"}');
	expect(guidanceToRemember({ text: "Be brief." })).toBe('{"text":"Be brief."}');
	expect(guidanceToRemember(null)).toBe('{"none":true}');
	expect(guidanceToRemember({ text: "" })).toBe('{"none":true}');
	// Up to what the guidance editor allows.
	const long = guidanceToRemember({ text: "x".repeat(GUIDANCE_MAX + 50) });
	expect(JSON.parse(long).text).toHaveLength(GUIDANCE_MAX);
});

test("the pref takes the three shapes only", () => {
	for (const ok of ['{"template":"b"}', '{"text":"Be brief."}', '{"none":true}'])
		expect(isValidPref(PREF.guidanceLast, ok)).toBe(true);
	for (const bad of ["b", "{}", '{"none":false}', '{"template":"b","text":"x"}', '{"text":""}', "[1]", "{"])
		expect(isValidPref(PREF.guidanceLast, bad)).toBe(false);
	expect(isValidPref(PREF.guidanceLast, JSON.stringify({ text: "x".repeat(GUIDANCE_MAX + 1) }))).toBe(false);
	// Each shape it writes is valid.
	for (const g of [{ template: "b" }, { text: "y".repeat(GUIDANCE_MAX * 2) }, null])
		expect(isValidPref(PREF.guidanceLast, guidanceToRemember(g))).toBe(true);
});
