import { expect, test } from "bun:test";
import { activeFirst, activePreset, type ModelPreset } from "../../shared/model-config.ts";

/** The order of the preset lists: the active one first, the others as they were (pure; no omp, no page). */

const SONNET = "anthropic/claude-sonnet-5-5";
const HAIKU = "anthropic/claude-haiku-5-5";

const preset = (name: string, roles: Record<string, string>, extra: Partial<ModelPreset> = {}): ModelPreset => ({
	name,
	roles,
	source: "global",
	...extra,
});
const names = (list: readonly { name: string }[]) => list.map((p) => p.name);

test("the active preset moves to the top and the others keep their order", () => {
	const list = [preset("a", {}), preset("b", {}), preset("c", {}), preset("d", {})];
	expect(names(activeFirst(list, "c"))).toEqual(["c", "a", "b", "d"]);
	expect(names(activeFirst(list, "d"))).toEqual(["d", "a", "b", "c"]);
});

test("nothing moves when the active preset is already first, there is none, or it is not in the list", () => {
	const list = [preset("a", {}), preset("b", {})];
	expect(names(activeFirst(list, "a"))).toEqual(["a", "b"]);
	expect(names(activeFirst(list, null))).toEqual(["a", "b"]);
	expect(names(activeFirst(list, undefined))).toEqual(["a", "b"]);
	expect(names(activeFirst(list, "gone"))).toEqual(["a", "b"]);
	expect(names(activeFirst([], "a"))).toEqual([]);
});

test("the input list is left as it was", () => {
	const list = [preset("a", {}), preset("b", {})];
	activeFirst(list, "b");
	expect(names(list)).toEqual(["a", "b"]);
});

test("ordering follows activePreset: roles and thinking level decide, the chosen preset only breaks a tie, a non-match is never first", () => {
	const cfg = {
		roles: { default: SONNET },
		defaultThinkingLevel: "high",
		presets: [
			preset("alpha", { default: HAIKU }),
			preset("beta", { default: SONNET }, { agentModelOverrides: { scout: HAIKU } }),
			preset("gamma", { default: SONNET }, { agentModelOverrides: { scout: SONNET } }),
			preset("delta", { default: SONNET }, { defaultThinkingLevel: "low" }),
		],
	};
	// beta and gamma match the roles; by name beta is the active one…
	expect(activePreset(cfg)).toBe("beta");
	expect(names(activeFirst(cfg.presets, activePreset(cfg)))).toEqual(["beta", "alpha", "gamma", "delta"]);
	// …unless the conversation was switched to gamma, which then leads.
	expect(activePreset(cfg, undefined, "gamma")).toBe("gamma");
	expect(names(activeFirst(cfg.presets, activePreset(cfg, undefined, "gamma")))).toEqual([
		"gamma",
		"alpha",
		"beta",
		"delta",
	]);
	// A chosen preset that does not match (alpha, on another model; delta, on another level) is not made active.
	for (const chosen of ["alpha", "delta"]) {
		expect(activePreset(cfg, undefined, chosen)).toBe("beta");
		expect(names(activeFirst(cfg.presets, activePreset(cfg, undefined, chosen)))[0]).toBe("beta");
	}
	// No match at all: the list is as it is.
	const none = { ...cfg, roles: { default: "x/y" } };
	expect(activePreset(none)).toBeNull();
	expect(names(activeFirst(none.presets, activePreset(none)))).toEqual(["alpha", "beta", "gamma", "delta"]);
});
