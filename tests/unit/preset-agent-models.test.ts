import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProcessOverlay } from "../../server/omp/approval.ts";
import {
	activePreset,
	type ConversationModels,
	clearedAgents,
	type ModelPreset,
	parseConversationModels,
	parsePresetEntry,
	switchedModels,
} from "../../shared/model-config.ts";

/**
 * The rules for the subagent models a preset carries (omp's `task.agentModelOverrides`): how an entry is read, what a
 * conversation runs on once switched, which configured agents it does without, when a preset is the active one, and
 * what the conversation's overlay says. Pure functions and one temp file: no omp, no model.
 */

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "ompw-preset-agents-"));
	dirs.push(dir);
	return dir;
}

const SONNET = "anthropic/claude-sonnet-5-5";
const HAIKU = "anthropic/claude-haiku-5-5";

test("an entry's `agentModelOverrides` is read leniently: omp does not read the key, so a bad value costs only itself", () => {
	const modelRoles = { default: SONNET };
	expect(parsePresetEntry({ modelRoles, agentModelOverrides: { reviewer: HAIKU, scout: `${SONNET}:low` } })).toEqual({
		roles: modelRoles,
		agentModelOverrides: { reviewer: HAIKU, scout: `${SONNET}:low` },
	});
	// A list is a fallback list, as for a role; blanks and what is no selector are dropped.
	expect(
		parsePresetEntry({
			modelRoles,
			agentModelOverrides: { a: [HAIKU, SONNET], b: "  ", c: 5, d: [], e: [HAIKU, ""], f: null, g: "x/y" },
		}),
	).toEqual({ roles: modelRoles, agentModelOverrides: { a: `${HAIKU},${SONNET}`, g: "x/y" } });
	// None left, or not a mapping at all, is no key: the preset leaves the subagent models alone.
	for (const agentModelOverrides of [{}, { a: "" }, [], "x", 5, null, undefined]) {
		expect(parsePresetEntry({ modelRoles, agentModelOverrides })).toEqual({ roles: modelRoles });
	}
	// It does not make an entry malformed, and does not rescue one.
	expect(parsePresetEntry({ modelRoles: { default: "" }, agentModelOverrides: { a: HAIKU } })).toMatch(
		/not a model selector/,
	);
	expect(parsePresetEntry({ agentModelOverrides: { a: HAIKU } })).toMatch(/modelRoles/);
	expect(
		parsePresetEntry({ modelRoles, defaultThinkingLevel: "low", agentModelOverrides: { a: HAIKU }, note: 1 }),
	).toEqual({
		roles: modelRoles,
		defaultThinkingLevel: "low",
		agentModelOverrides: { a: HAIKU },
	});
	// A key named like an object's own property stays an ordinary entry.
	const proto = JSON.parse('{"__proto__": "x/y", "task": "a/b"}');
	const read = parsePresetEntry({ modelRoles, agentModelOverrides: proto });
	expect(typeof read === "string" ? {} : Object.keys(read.agentModelOverrides ?? {})).toEqual(["__proto__", "task"]);
});

test("a conversation's models round-trip with their subagent models, and one from an older server has none", () => {
	const models: ConversationModels = {
		preset: "deep",
		roles: { default: SONNET },
		defaultThinkingLevel: "high",
		agentModelOverrides: { reviewer: HAIKU },
	};
	expect(parseConversationModels(JSON.parse(JSON.stringify(models)))).toEqual(models);
	const older = { preset: "deep", roles: { default: SONNET } };
	expect(parseConversationModels(older)).toEqual(older);
	// Damaged agents are dropped; the roles and the preset stay.
	expect(parseConversationModels({ ...older, agentModelOverrides: { reviewer: 5 } })).toEqual(older);
	expect(parseConversationModels({ ...older, agentModelOverrides: "x" })).toEqual(older);
});

test("switching to a preset: its subagent models replace the conversation's, and a preset that sets none leaves them", () => {
	const had: ConversationModels = {
		preset: "review",
		roles: { default: HAIKU },
		agentModelOverrides: { reviewer: SONNET, scout: HAIKU },
	};
	const withAgents: ConversationModels = {
		preset: "other",
		roles: { default: SONNET },
		agentModelOverrides: { task: HAIKU },
	};
	const without: ConversationModels = { preset: "plain", roles: { default: SONNET } };

	// Replaced, not merged: the conversation has the preset's agents and no other.
	expect(switchedModels(had, withAgents)).toEqual(withAgents);
	// None in the preset: the roles and level are the preset's, the subagent models what the conversation had.
	expect(switchedModels(had, without)).toEqual({ ...without, agentModelOverrides: had.agentModelOverrides });
	// Nothing to keep: the preset is what the conversation runs on, as it is.
	expect(switchedModels(null, without)).toEqual(without);
	expect(switchedModels(undefined, withAgents)).toEqual(withAgents);
	expect(switchedModels({ preset: "a", roles: {} }, without)).toEqual(without);
	// Again to a preset with none: still kept.
	expect(switchedModels(switchedModels(had, without), { preset: "third", roles: {} }).agentModelOverrides).toEqual(
		had.agentModelOverrides,
	);
	// Nothing is changed in what it was given.
	expect(had.agentModelOverrides).toEqual({ reviewer: SONNET, scout: HAIKU });
});

test("a conversation without subagent models of its own does without none of the configuration's; with them, it does without the rest", () => {
	const configured = { reviewer: HAIKU, scout: HAIKU, sonic: SONNET };
	expect(clearedAgents(configured, { agentModelOverrides: undefined })).toEqual([]);
	expect(clearedAgents(configured, { agentModelOverrides: { reviewer: SONNET } })).toEqual(["scout", "sonic"]);
	expect(clearedAgents(configured, { agentModelOverrides: { reviewer: SONNET, scout: HAIKU, sonic: HAIKU } })).toEqual(
		[],
	);
	// An agent only the preset has is not the configuration's to clear.
	expect(clearedAgents({}, { agentModelOverrides: { task: HAIKU } })).toEqual([]);
});

function preset(name: string, extra: Partial<ModelPreset> = {}): ModelPreset {
	return { name, roles: { default: SONNET }, source: "global", ...extra };
}

test("which preset is active follows the roles and thinking level only, as omp's does: subagent models take no part", () => {
	const withAgents = preset("fast", { agentModelOverrides: { reviewer: HAIKU } });
	const cfg = { roles: { default: SONNET }, defaultThinkingLevel: "high", presets: [withAgents, preset("plain")] };
	// Same roles, so the first by name, whatever either carries and wherever the config's subagent models stand.
	expect(activePreset(cfg)).toBe("fast");
	expect(activePreset({ ...cfg, presets: [preset("plain"), withAgents] })).toBe("fast");
	expect(activePreset({ ...cfg, presets: [withAgents] })).toBe("fast");
	// Roles that differ still decide, as on main.
	expect(activePreset({ ...cfg, roles: { default: HAIKU } })).toBeNull();
	expect(activePreset({ ...cfg, presets: [preset("p", { roles: { default: SONNET, smol: HAIKU } })] })).toBeNull();
});

test("twins: presets that differ only in their subagent models; Settings shows the first by name, a conversation the one it was switched to", () => {
	const review = preset("review", { agentModelOverrides: { reviewer: HAIKU } });
	const plain = preset("plain");
	const cfg = { roles: { default: SONNET }, defaultThinkingLevel: "high", presets: [review, plain] };
	// Settings: `plain` applied writes the roles and leaves the subagent models (`review`'s reviewer) where they were: the badge
	// is still on `plain`, as omp's rule has it, not on `review` for the agents that happen to be there.
	expect(activePreset(cfg)).toBe("plain");
	// Composer: a conversation switched review → plain keeps review's subagent models and is on `plain`.
	expect(activePreset(cfg, undefined, "plain")).toBe("plain");
	expect(activePreset(cfg, undefined, "review")).toBe("review");

	// Where the name order would pick the other one, the conversation's own choice still shows.
	const first = {
		...cfg,
		presets: [preset("a-review", { agentModelOverrides: { reviewer: HAIKU } }), preset("b-plain")],
	};
	expect(activePreset(first)).toBe("a-review");
	expect(activePreset(first, undefined, "b-plain")).toBe("b-plain");
	expect(activePreset(first, { model: SONNET, thinking: "high" }, "b-plain")).toBe("b-plain");

	// The choice never makes a preset active that does not match: a preset that is gone, one with a problem, and one whose
	// roles are not the conversation's (a picker moved the model).
	expect(activePreset(first, undefined, "gone")).toBe("a-review");
	const broken = { ...first, presets: [...first.presets, preset("c-broken", { problem: "it is not a mapping" })] };
	expect(activePreset(broken, undefined, "c-broken")).toBe("a-review");
	expect(activePreset(first, { model: HAIKU, thinking: "high" }, "b-plain")).toBeNull();
});

const read = (file: string) => Bun.YAML.parse(readFileSync(file, "utf8")) as Record<string, unknown>;

test("an overlay gives a conversation the preset's subagent models, and `null` for the configured agents it does not set", async () => {
	const file = join(scratch(), "L1.yml");
	const roles = { default: SONNET };
	const overlay = new ProcessOverlay(file, null, 0, null, {
		preset: "review",
		roles,
		agentModelOverrides: { reviewer: `${HAIKU}:low`, "odd-agent": "a/b,c/d" },
	});
	// Nothing to clear yet: just the preset's agents, under omp's own key.
	expect(read(file)).toMatchObject({
		modelRoles: roles,
		task: { agentModelOverrides: { reviewer: `${HAIKU}:low`, "odd-agent": "a/b,c/d" } },
	});

	// omp merges the overlay's record into the configuration's: an agent the preset leaves out must be `null` to be gone.
	await overlay.setModels(overlay.models, ["smol"], ["scout", "reviewer", "sonic"]);
	const task = read(file).task as { agentModelOverrides: Record<string, unknown> };
	expect(task.agentModelOverrides).toEqual({
		reviewer: `${HAIKU}:low`,
		"odd-agent": "a/b,c/d",
		scout: null,
		sonic: null,
	});
	expect(read(file).modelRoles).toEqual({ default: SONNET, smol: null });

	// Models without subagent models write no `task` at all: the configuration's apply as they are, with nothing nulled.
	await overlay.setModels({ preset: "plain", roles }, [], ["scout"]);
	expect(Object.hasOwn(read(file), "task")).toBe(false);

	// Back to the global config: nothing of the preset is left.
	await overlay.setModels(null, [], []);
	expect(read(file)).toEqual({ tools: { approval: { propose_goal: "allow" } } });
});

test("an overlay writes agent names and selectors as strings YAML reads back as they are, whatever they look like", () => {
	const file = join(scratch(), "L2.yml");
	const agentModelOverrides = { "1": "true/null", yes: "a: b", "x y": "# c", é: "p/m:max" };
	new ProcessOverlay(file, null, 0, null, { preset: "odd", roles: {}, agentModelOverrides });
	expect((read(file).task as { agentModelOverrides: unknown }).agentModelOverrides).toEqual(agentModelOverrides);
});

test("a setting held under `task` and the subagent models are one `task` mapping: a key written twice would lose the first", async () => {
	const file = join(scratch(), "L3.yml");
	// No `task.*` setting is pinnable today; the overlay must stay right the day one is.
	const pins = { "task.simple": "independent", "task.isolation.mode": "none", "retry.enabled": false };
	const overlay = new ProcessOverlay(
		file,
		null,
		0,
		null,
		{ preset: "review", roles: { default: SONNET }, agentModelOverrides: { reviewer: HAIKU } },
		[],
		pins,
		undefined,
		null,
		["scout"],
	);
	const text = readFileSync(file, "utf8");
	expect(text.match(/^task:/gm)).toHaveLength(1);
	expect(read(file)).toMatchObject({
		retry: { enabled: false },
		task: {
			simple: "independent",
			isolation: { mode: "none" },
			agentModelOverrides: { reviewer: HAIKU, scout: null },
		},
	});

	// Without the preset's agents the pinned settings are all that is under `task`; with none pinned, only the agents.
	await overlay.setModels(null, [], []);
	expect(read(file).task).toEqual({ simple: "independent", isolation: { mode: "none" } });
	const bare = join(scratch(), "L4.yml");
	new ProcessOverlay(bare, null, 0, null, { preset: "review", roles: {}, agentModelOverrides: { reviewer: HAIKU } });
	expect(read(bare).task).toEqual({ agentModelOverrides: { reviewer: HAIKU } });
});
