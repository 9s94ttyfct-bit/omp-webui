import { expect, test } from "bun:test";
import {
	activePreset,
	currentRoles,
	formatSelector,
	type ModelPreset,
	nextPreset,
	normalizeRoles,
	parsePresetEntry,
	parseSelector,
	presetNameProblem,
	presetPatternProblem,
	projectOverrides,
	roleKeyProblem,
	selectorProblem,
} from "../../shared/model-config.ts";

/**
 * The rules the web UI shares with omp for model roles and presets (omp's own `/modelpreset` code is the
 * reference): which names and selectors are accepted, which entries omp can apply, and which preset omp
 * counts as active. Pure functions; no omp process.
 */

const preset = (
	name: string,
	roles: Record<string, string>,
	defaultThinkingLevel?: ModelPreset["defaultThinkingLevel"],
	extra: Partial<ModelPreset> = {},
): ModelPreset => ({ name, roles, defaultThinkingLevel, source: "global", ...extra });

test("preset names: a letter, then letters, digits, - or _ (omp's rule), at most 64 characters", () => {
	for (const ok of ["fast", "Deep-2", "a_b", "x", "A1", "a".repeat(64)]) expect(presetNameProblem(ok)).toBeNull();
	expect(presetNameProblem("")).toBe("empty");
	expect(presetNameProblem("   ")).toBe("empty");
	for (const bad of ["1a", "-a", "_a", "a b", "a.b", "é", "a/b", "a\nb", "__proto__"]) {
		expect(presetNameProblem(bad)).toBe("invalid");
	}
	expect(presetNameProblem("a".repeat(65))).toBe("tooLong");
});

test("an existing preset's name is held to omp's pattern only: omp has no length cap", () => {
	expect(presetPatternProblem("a".repeat(70))).toBeNull();
	expect(presetNameProblem("a".repeat(70))).toBe("tooLong");
	expect(presetPatternProblem("")).toBe("empty");
	for (const bad of ["1a", "a b", "a\nb", "é"]) expect(presetPatternProblem(bad)).toBe("invalid");
});

test("role keys: a letter, then letters, digits, - or _, at most 32 characters", () => {
	for (const ok of ["default", "smol", "my-role", "Role_2", "web"]) expect(roleKeyProblem(ok)).toBeNull();
	expect(roleKeyProblem("")).toBe("empty");
	for (const bad of ["1x", "a b", "a.b", "__proto__", "a/b"]) expect(roleKeyProblem(bad)).toBe("invalid");
	expect(roleKeyProblem("a".repeat(33))).toBe("tooLong");
});

test("a role value is any selector omp understands: ids, fallback lists, aliases; not blanks or control characters", () => {
	for (const ok of [
		"anthropic/claude-sonnet-5-5",
		"anthropic/claude-sonnet-5-5:high",
		"openrouter/meta-llama/llama-3.3-70b-instruct:free",
		"pi/slow",
		"anthropic/claude-haiku-5-5, openai/gpt-5",
		"anthropic/claude-*",
		"web/exa",
	]) {
		expect(selectorProblem(ok)).toBeNull();
	}
	expect(selectorProblem("")).toBe("empty");
	expect(selectorProblem("  \t")).toBe("empty");
	expect(selectorProblem("a/b\nc/d")).toBe("invalid");
	expect(selectorProblem("a/b\u0000")).toBe("invalid");
	expect(selectorProblem("x".repeat(513))).toBe("tooLong");
});

test("a plain selector splits into provider, id and thinking level, and joins back", () => {
	expect(parseSelector("anthropic/claude-sonnet-5-5:high")).toEqual({
		provider: "anthropic",
		id: "claude-sonnet-5-5",
		level: "high",
	});
	expect(parseSelector("anthropic/claude-sonnet-5-5")).toEqual({ provider: "anthropic", id: "claude-sonnet-5-5" });
	// A suffix that is not a thinking level belongs to the id.
	expect(parseSelector("openrouter/meta-llama/llama-3.3-70b-instruct:free")).toEqual({
		provider: "openrouter",
		id: "meta-llama/llama-3.3-70b-instruct:free",
	});
	expect(parseSelector("anthropic/claude-opus-5-5:max")?.level).toBe("max");
	expect(parseSelector("anthropic/claude-opus-5-5:auto")?.level).toBe("auto");
	expect(parseSelector("anthropic/claude-opus-5-5:off")?.level).toBe("off");
	for (const s of ["anthropic/claude-sonnet-5-5:high", "anthropic/claude-sonnet-5-5", "web/exa"]) {
		const parsed = parseSelector(s);
		expect(parsed && formatSelector(parsed)).toBe(s);
	}
});

test("aliases, fallback lists, globs and bare names are not plain selectors", () => {
	// `pi/<role>` is omp's alias for another role's model, not a provider.
	for (const s of ["pi/slow", "slow", "claude-sonnet-5-5", "a/b,c/d", "anthropic/claude-*", "", "/x", "a/"]) {
		expect(parseSelector(s)).toBeNull();
	}
});

test("roles are read like omp reads them: strings, fallback arrays joined, everything else dropped, any role name kept", () => {
	expect(
		normalizeRoles({
			default: "anthropic/claude-haiku-5-5:low",
			slow: ["anthropic/claude-opus-5-5", "openai/gpt-5"],
			junk: 5,
			empty: "",
			blank: "   ",
			nested: { a: 1 },
			"my.role": "x/y",
			"3d": "x/z",
			list: [1, 2],
		}),
	).toEqual({
		default: "anthropic/claude-haiku-5-5:low",
		slow: "anthropic/claude-opus-5-5,openai/gpt-5",
		"my.role": "x/y",
		"3d": "x/z",
	});
	expect(normalizeRoles(null)).toEqual({});
	expect(normalizeRoles("x")).toEqual({});
	expect(normalizeRoles([1])).toEqual({});
	// A key like `__proto__` stays an ordinary entry (a hand-edited config can hold one).
	const odd = normalizeRoles(JSON.parse('{"__proto__": "x/y"}'));
	expect(Object.keys(odd)).toEqual(["__proto__"]);
	expect(Object.getPrototypeOf(odd)).toBe(Object.prototype);
});

test("a preset entry is usable when omp could apply it: roles are non-empty strings, the level a real default level", () => {
	expect(parsePresetEntry({ modelRoles: { default: "a/b" }, defaultThinkingLevel: "high" })).toEqual({
		roles: { default: "a/b" },
		defaultThinkingLevel: "high",
	});
	expect(parsePresetEntry({ modelRoles: { default: "a/b" } })).toEqual({ roles: { default: "a/b" } });
	expect(parsePresetEntry({ modelRoles: {}, defaultThinkingLevel: "auto" })).toEqual({
		roles: {},
		defaultThinkingLevel: "auto",
	});
	// Each of these is what omp reports as malformed.
	for (const bad of [null, 5, "x", [], {}, { modelRoles: "x" }, { modelRoles: [] }]) {
		expect(typeof parsePresetEntry(bad)).toBe("string");
	}
	expect(parsePresetEntry({ modelRoles: { default: "" } })).toMatch(/default/);
	expect(parsePresetEntry({ modelRoles: { default: 5 } })).toMatch(/default/);
	expect(parsePresetEntry({ modelRoles: { default: "a/b" }, defaultThinkingLevel: "off" })).toMatch(/thinking/);
	expect(parsePresetEntry({ modelRoles: { default: "a/b" }, defaultThinkingLevel: 3 })).toMatch(/thinking/);
});

test("a preset's role names are not checked, as omp does not check them: `my.role`, `3d`, long names, `__proto__`", () => {
	const long = "a".repeat(40);
	const roles = { default: "a/b", "my.role": "x/y", "3d": "x/z", [long]: "x/w" };
	expect(parsePresetEntry({ modelRoles: roles })).toEqual({ roles });
	const proto = parsePresetEntry(JSON.parse('{"modelRoles": {"__proto__": "x/y"}}'));
	expect(typeof proto).toBe("object");
	if (typeof proto === "object") expect(Object.keys(proto.roles)).toEqual(["__proto__"]);
	// Still malformed for what omp refuses: a role without a selector.
	expect(parsePresetEntry({ modelRoles: { "my.role": "" } })).toMatch(/my\.role/);
});

test("omp's active preset: the same roles with the same values, and the same default thinking level when the preset sets one", () => {
	const roles = { default: "a/fast:low", smol: "a/fast" };
	const presets = [preset("deep", { default: "a/deep:high" }, "high"), preset("fast", roles, "low")];
	expect(activePreset({ roles, defaultThinkingLevel: "low", presets })).toBe("fast");
	// The preset's thinking level counts only when it sets one.
	expect(activePreset({ roles, defaultThinkingLevel: "high", presets })).toBeNull();
	expect(activePreset({ roles, defaultThinkingLevel: "high", presets: [preset("fast", roles)] })).toBe("fast");
	// A role the preset lacks, or a different value, or an extra preset role: not the same configuration.
	expect(activePreset({ roles: { ...roles, plan: "a/x" }, defaultThinkingLevel: "low", presets })).toBeNull();
	expect(
		activePreset({ roles: { default: "a/other:low", smol: "a/fast" }, defaultThinkingLevel: "low", presets }),
	).toBeNull();
	expect(activePreset({ roles: { default: "a/fast:low" }, defaultThinkingLevel: "low", presets })).toBeNull();
});

test("when several presets match, the first by name is active, and presets omp cannot apply never are", () => {
	const roles = { default: "a/m" };
	const presets = [
		preset("zed", roles),
		preset("alpha", roles),
		preset("broken", {}, undefined, { problem: "it is not a mapping" }),
	];
	expect(activePreset({ roles, defaultThinkingLevel: "high", presets })).toBe("alpha");
	expect(activePreset({ roles: {}, defaultThinkingLevel: "high", presets })).toBeNull();
	expect(activePreset({ roles, defaultThinkingLevel: "high", presets: [] })).toBeNull();
});

test("for a conversation, a preset that differs only in its default role is active when the conversation runs that model", () => {
	const global = { default: "a/opus:high", smol: "a/haiku" };
	const presets = [
		preset("main", global),
		preset("sonnet", { default: "a/sonnet:high", smol: "a/haiku" }),
		preset("other", { default: "a/sonnet:high", smol: "a/else" }),
	];
	const cfg = { roles: global, defaultThinkingLevel: "high", presets };
	// On the configured model, the configured preset.
	expect(activePreset(cfg, { model: "a/opus", thinking: "high" })).toBe("main");
	// The conversation was moved to another model: the preset saved from that state is the one that matches.
	expect(activePreset(cfg, { model: "a/sonnet", thinking: "high" })).toBe("sonnet");
	// A model no preset names: Custom, even though the configured preset's other roles match.
	expect(activePreset(cfg, { model: "a/mystery", thinking: "high" })).toBeNull();
	// Without a conversation the answer is omp's own.
	expect(activePreset(cfg)).toBe("main");
});

test("a role the selector cannot name (an alias) falls back to omp's comparison", () => {
	const roles = { default: "pi/slow", smol: "a/haiku" };
	const cfg = { roles, defaultThinkingLevel: "high", presets: [preset("p", roles)] };
	expect(activePreset(cfg, { model: "a/whatever", thinking: "high" })).toBe("p");
	expect(
		activePreset({ ...cfg, presets: [preset("p", { default: "pi/other", smol: "a/haiku" })] }, { model: "a/x" }),
	).toBeNull();
});

test("among presets that match a conversation, the one whose thinking level it runs wins; else the first by name", () => {
	const roles = { default: "a/m:high" };
	const presets = [preset("a-low", { default: "a/m:low" }), preset("b-high", { default: "a/m:high" })];
	const cfg = { roles, defaultThinkingLevel: "high", presets };
	expect(activePreset(cfg, { model: "a/m", thinking: "low" })).toBe("a-low");
	expect(activePreset(cfg, { model: "a/m", thinking: "high" })).toBe("b-high");
	// The thinking level is changed by hand to something no preset has: still a preset on that model, the first.
	expect(activePreset(cfg, { model: "a/m", thinking: "medium" })).toBe("a-low");
});

test("cycling goes through the usable presets in order, wrapping, and starts at the first from Custom", () => {
	const presets = [
		preset("a", { default: "x/1" }),
		preset("b", { default: "x/2" }, undefined, { problem: "bad" }),
		preset("c", { default: "x/3" }),
	];
	expect(nextPreset(presets, null)?.name).toBe("a");
	expect(nextPreset(presets, "a")?.name).toBe("c");
	expect(nextPreset(presets, "c")?.name).toBe("a");
	expect(nextPreset(presets, "a", -1)?.name).toBe("c");
	expect(nextPreset(presets, null, -1)?.name).toBe("c");
	expect(nextPreset(presets, "missing")?.name).toBe("a");
	expect(nextPreset([], null)).toBeNull();
	expect(nextPreset([preset("b", {}, undefined, { problem: "bad" })], null)).toBeNull();
});

test("a preset saved from a conversation is active for it even when the config has no default role", () => {
	const cfg = { roles: { smol: "a/haiku" }, defaultThinkingLevel: "high" };
	const saved = preset("mine", { smol: "a/haiku", default: "a/sonnet:high" });
	expect(activePreset({ ...cfg, presets: [saved] }, { model: "a/sonnet", thinking: "high" })).toBe("mine");
	expect(activePreset({ ...cfg, presets: [saved] }, { model: "a/other", thinking: "high" })).toBeNull();
	// omp's own comparison needs the same roles, the default included.
	expect(activePreset({ ...cfg, presets: [saved] })).toBeNull();
});

test("'save current' keeps the configured roles, except that the default follows what the conversation runs", () => {
	const cfg = { roles: { default: "a/opus:high", smol: "a/haiku" }, defaultThinkingLevel: "high" };
	// Nothing to follow, or nothing different: the configured selector stays as the user wrote it.
	expect(currentRoles(cfg)).toEqual(cfg.roles);
	expect(currentRoles(cfg, {})).toEqual(cfg.roles);
	expect(currentRoles(cfg, { model: "a/opus", thinking: "high" })).toEqual(cfg.roles);
	expect(currentRoles(cfg, { model: "a/opus" })).toEqual(cfg.roles);
	// The model picker moved the conversation to another model, the thinking picker changed its level.
	expect(currentRoles(cfg, { model: "a/sonnet", thinking: "medium" })).toEqual({
		default: "a/sonnet:medium",
		smol: "a/haiku",
	});
	expect(currentRoles(cfg, { model: "a/opus", thinking: "low" })).toEqual({ default: "a/opus:low", smol: "a/haiku" });
	expect(currentRoles(cfg, { model: "a/sonnet" })).toEqual({ default: "a/sonnet:high", smol: "a/haiku" });
	expect(currentRoles(cfg, { model: "a/opus", thinking: "off" }).default).toBe("a/opus:off");
	// A selector without a level takes the default thinking level as its own.
	const plain = { roles: { default: "a/opus" }, defaultThinkingLevel: "high" };
	expect(currentRoles(plain, { model: "a/opus", thinking: "high" })).toEqual(plain.roles);
	expect(currentRoles(plain, { model: "a/opus", thinking: "low" })).toEqual({ default: "a/opus:low" });
	// A default that is an alias or a list cannot be compared with a model: it stays.
	const alias = { roles: { default: "pi/slow", smol: "a/haiku" }, defaultThinkingLevel: "high" };
	expect(currentRoles(alias, { model: "a/sonnet", thinking: "low" })).toEqual(alias.roles);
	// With no default role at all, the conversation's model becomes it.
	expect(
		currentRoles({ roles: { smol: "a/haiku" }, defaultThinkingLevel: "high" }, { model: "a/sonnet", thinking: "low" }),
	).toEqual({
		smol: "a/haiku",
		default: "a/sonnet:low",
	});
	// The input is never modified.
	expect(cfg.roles).toEqual({ default: "a/opus:high", smol: "a/haiku" });
});

test("a role named `__proto__` stays an ordinary role, also when the default role is written", () => {
	const roles = JSON.parse('{"__proto__": "foo/bar", "default": "a/opus:high"}');
	const cfg = { roles, defaultThinkingLevel: "high" };
	const saved = currentRoles(cfg, { model: "a/sonnet", thinking: "low" });
	expect(Object.keys(saved)).toEqual(["__proto__", "default"]);
	expect(Object.getOwnPropertyDescriptor(saved, "__proto__")?.value).toBe("foo/bar");
	expect(saved.default).toBe("a/sonnet:low");
	expect(Object.getPrototypeOf(saved)).toBe(Object.prototype);
});

test("a project's overrides: the roles it sets that the global config does not, or sets to another model, and its thinking level", () => {
	const global = { roles: { default: "a/fast:low", smol: "a/fast:minimal" }, defaultThinkingLevel: "high" };
	const project = {
		// `default` is global's, `smol` is the project's own, `plan` only the project has.
		roles: { default: "a/fast:low", smol: "a/fast:high", plan: "a/deep" },
		defaultThinkingLevel: "high",
	};
	expect(projectOverrides(global, project)).toEqual({ roles: { smol: "a/fast:high", plan: "a/deep" } });
	expect(projectOverrides(global, { ...project, defaultThinkingLevel: "low" })).toEqual({
		roles: { smol: "a/fast:high", plan: "a/deep" },
		defaultThinkingLevel: "low",
	});
	// A project that changes nothing overrides nothing.
	expect(projectOverrides(global, global)).toEqual({ roles: {} });
});
