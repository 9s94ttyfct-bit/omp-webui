import "./browser-globals.ts";
import { afterAll, afterEach, beforeAll, beforeEach, expect, type Mock, spyOn, test } from "bun:test";
import {
	activePreset,
	type ConversationModels,
	type ModelConfig,
	type ModelPreset,
} from "../../shared/model-config.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
import {
	conversationConfig,
	conversationSnapshot,
	describePreset,
	describeSelector,
	sessionOf,
	switchPreset,
} from "../../web/src/lib/model-config.ts";
import { ReplyError, socket } from "../../web/src/lib/ws.ts";
import { useApp } from "../../web/src/store/app.ts";
import { initialLive } from "../../web/src/store/live.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * How the web UI switches a conversation to a preset (a `model_preset` request the server answers with the
 * process's info, which carries the preset), which roles a conversation then shows, and how it words a preset.
 */

beforeAll(installGlobals);
afterAll(restoreGlobals);

const info = (liveId: string): LiveInfo => ({
	liveId,
	pid: 1,
	cwd: "/work",
	sessionFile: null,
	sessionId: null,
	args: [],
	startedAt: 0,
	streaming: false,
	exited: false,
	subscribers: 1,
	pausedAt: null,
	mode: "full",
});

const deep: ConversationModels = { preset: "deep", roles: { default: "anthropic/claude-sonnet-5-5:high" } };

let request: Mock<typeof socket.request>;
let act: Mock<typeof socket.act>;

/** The server's answer to the request: the process's info, with the preset it now runs. */
function server(models: ConversationModels): void {
	request.mockImplementation((async (msg: { liveId: string }) => ({
		...info(msg.liveId),
		models,
	})) as typeof socket.request);
}

beforeEach(() => {
	request = spyOn(socket, "request");
	act = spyOn(socket, "act");
	useApp.setState({ lives: { L1: initialLive(info("L1")) }, toasts: [] });
});
afterEach(() => {
	request.mockRestore();
	act.mockRestore();
});

test("a switch asks the server for that conversation's preset and shows what it answers, with no prompt", async () => {
	server(deep);
	await switchPreset("L1", "deep");
	expect(request).toHaveBeenCalledTimes(1);
	expect(request).toHaveBeenCalledWith({ t: "model_preset", liveId: "L1", name: "deep" });
	expect(act).not.toHaveBeenCalled();
	expect(useApp.getState().lives.L1.info.models).toEqual(deep);
});

test("a switch changes only the conversation it was made in", async () => {
	useApp.setState((s) => ({ lives: { ...s.lives, L2: initialLive(info("L2")) } }));
	server(deep);
	await switchPreset("L1", "deep");
	expect(useApp.getState().lives.L2.info.models).toBeUndefined();
});

test("a refusal is the server's own words, and leaves the conversation as it was", async () => {
	request.mockRejectedValue(new ReplyError("Preset “x” can't be applied: default model `nope/none` is not available"));
	await expect(switchPreset("L1", "x")).rejects.toThrow("can't be applied: default model `nope/none`");
	expect(useApp.getState().lives.L1.info.models).toBeUndefined();
});

test("only names omp itself accepts are sent", async () => {
	server(deep);
	for (const name of ["", "a b", "a\n/rename x", "-x", "x;y", "é"]) {
		await expect(switchPreset("L1", name)).rejects.toThrow();
	}
	expect(request).not.toHaveBeenCalled();
});

test("a preset already in the config is switched to by omp's name pattern, whatever its length", async () => {
	const long = `deep-${"x".repeat(65)}`;
	expect(long.length).toBe(70);
	server({ ...deep, preset: long });
	await switchPreset("L1", long);
	expect(request).toHaveBeenCalledWith({ t: "model_preset", liveId: "L1", name: long });
});

test("a conversation on a local server is never switched: its agent directory has no presets", async () => {
	useApp.setState({
		lives: { L1: initialLive({ ...info("L1"), mode: "light", lightModels: "local" }) },
	});
	server(deep);
	await expect(switchPreset("L1", "deep")).rejects.toThrow(/local server/i);
	expect(request).not.toHaveBeenCalled();
});

const fast: ModelPreset = {
	name: "fast",
	roles: { default: "anthropic/claude-haiku-5-5:low", smol: "anthropic/claude-haiku-5-5" },
	defaultThinkingLevel: "low",
	source: "global",
};
const deepPreset: ModelPreset = {
	name: "deep",
	roles: { default: "anthropic/claude-sonnet-5-5:high" },
	defaultThinkingLevel: "high",
	source: "global",
};
/** The global config is on `fast`. */
const globalConfig: ModelConfig = {
	roles: fast.roles,
	agentModelOverrides: {},
	defaultThinkingLevel: "low",
	roleStorage: "global",
	presets: [fast, deepPreset],
	active: "fast",
};

test("a conversation never switched shows the global config", () => {
	expect(conversationConfig(globalConfig, null)).toEqual(globalConfig);
	expect(conversationConfig(globalConfig, undefined)).toEqual(globalConfig);
	expect(activePreset(conversationConfig(globalConfig, null))).toBe("fast");
});

test("a switched conversation shows its own roles and level, and the preset is active there, not in the global config", () => {
	const mine = conversationConfig(globalConfig, { ...deep, defaultThinkingLevel: "high" });
	expect(mine.roles).toEqual(deep.roles);
	expect(mine.defaultThinkingLevel).toBe("high");
	expect(mine.presets).toEqual(globalConfig.presets);
	expect(activePreset(mine)).toBe("deep");
	// The global config is untouched.
	expect(activePreset(globalConfig)).toBe("fast");
	expect(globalConfig.roles).toEqual(fast.roles);
});

test("a preset without a thinking level of its own leaves the global level", () => {
	expect(conversationConfig(globalConfig, deep).defaultThinkingLevel).toBe("low");
});

test("'Set as default' and 'Save current' store the conversation's roles and level, not the global config's", () => {
	const mine = conversationConfig(globalConfig, { ...deep, defaultThinkingLevel: "high" });
	expect(conversationSnapshot(mine, { model: "anthropic/claude-sonnet-5-5", thinking: "high" })).toEqual({
		roles: deep.roles,
		defaultThinkingLevel: "high",
		agentModelOverrides: {},
	});
	// The default role follows the model the conversation runs when a picker moved it.
	expect(conversationSnapshot(mine, { model: "anthropic/claude-opus-5-5", thinking: "high" }).roles).toEqual({
		default: "anthropic/claude-opus-5-5:high",
	});
	// A conversation never switched stores the global roles; a level that is not a default level is left out.
	expect(conversationSnapshot(globalConfig).roles).toEqual(fast.roles);
	expect(conversationSnapshot({ ...globalConfig, defaultThinkingLevel: "off" }).defaultThinkingLevel).toBeUndefined();
});

test("a conversation shows its own subagent models once it has some, else the config's; 'Save current' and the active preset follow", () => {
	const HAIKU = "anthropic/claude-haiku-5-5";
	const SONNET = "anthropic/claude-sonnet-5-5";
	const config: ModelConfig = { ...globalConfig, agentModelOverrides: { scout: HAIKU } };
	// Never switched, or switched to a preset that sets none: the config's.
	expect(conversationConfig(config, null).agentModelOverrides).toEqual({ scout: HAIKU });
	expect(conversationConfig(config, deep).agentModelOverrides).toEqual({ scout: HAIKU });

	// Switched to one that sets some: exactly those, whatever the config has.
	const reviewing: ConversationModels = { ...deep, agentModelOverrides: { reviewer: SONNET } };
	const mine = conversationConfig(config, reviewing);
	expect(mine.agentModelOverrides).toEqual({ reviewer: SONNET });
	expect(
		conversationSnapshot(mine, { model: "anthropic/claude-sonnet-5-5", thinking: "high" }).agentModelOverrides,
	).toEqual({
		reviewer: SONNET,
	});
	expect(conversationSnapshot(conversationConfig(config, null)).agentModelOverrides).toEqual({ scout: HAIKU });

	// Two presets with the same roles: the first by name is active, as omp has it, unless the conversation was switched to
	// the other one (what the composer's menu passes as `chosen`).
	const presets: ModelPreset[] = [
		{ ...deepPreset, name: "a-review", agentModelOverrides: { reviewer: SONNET } },
		{ ...deepPreset, name: "b-scout", agentModelOverrides: { scout: HAIKU } },
	];
	const both: ModelConfig = { ...config, roles: deepPreset.roles, defaultThinkingLevel: "high", presets };
	const sonnet = { model: SONNET, thinking: "high" };
	const toScout: ConversationModels = { ...deep, preset: "b-scout", agentModelOverrides: { scout: HAIKU } };
	expect(activePreset(conversationConfig(both, null), sonnet)).toBe("a-review");
	expect(activePreset(conversationConfig(both, toScout), sonnet, toScout.preset)).toBe("b-scout");
	expect(activePreset(conversationConfig(both, reviewing), sonnet, "a-review")).toBe("a-review");
});

test("a conversation's model and thinking level are read from its state", () => {
	expect(sessionOf(undefined)).toEqual({ model: undefined, thinking: undefined });
	const live = initialLive(info("L1"));
	expect(sessionOf(live)).toEqual({ model: undefined, thinking: undefined });
	const withState = {
		...live,
		state: { model: { provider: "anthropic", id: "claude-haiku-5-5" }, thinkingLevel: "low" },
	} as unknown as typeof live;
	expect(sessionOf(withState)).toEqual({ model: "anthropic/claude-haiku-5-5", thinking: "low" });
});

const sonnet = { provider: "anthropic", id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" };
const preset = (
	roles: Record<string, string>,
	defaultThinkingLevel?: ModelPreset["defaultThinkingLevel"],
): ModelPreset => ({
	name: "p",
	roles,
	defaultThinkingLevel,
	source: "global",
});

test("a selector is shown as the model's name and thinking level; ids until the names are known", () => {
	expect(describeSelector("anthropic/claude-sonnet-5-5:high", [sonnet])).toBe("Claude Sonnet 5.5 · high");
	expect(describeSelector("anthropic/claude-sonnet-5-5", [sonnet])).toBe("Claude Sonnet 5.5");
	expect(describeSelector("anthropic/claude-sonnet-5-5:high", null)).toBe("claude-sonnet-5-5 · high");
	expect(describeSelector("anthropic/other", [sonnet])).toBe("other");
	// What is not one model stays as written.
	expect(describeSelector("pi/slow", [sonnet])).toBe("pi/slow");
	expect(describeSelector("a/b,c/d", null)).toBe("a/b,c/d");
});

test("a preset is summarised by its default model, its thinking level, and how many other roles it sets", () => {
	expect(describePreset(preset({ default: "anthropic/claude-sonnet-5-5:high" }), [sonnet])).toBe(
		"Claude Sonnet 5.5 · high",
	);
	expect(
		describePreset(preset({ default: "anthropic/claude-sonnet-5-5:high", smol: "a/b", slow: "a/c" }), [sonnet]),
	).toBe("Claude Sonnet 5.5 · high · +2 more");
	// The preset's own level shows when the selector has none; the selector's wins when it has one.
	expect(describePreset(preset({ default: "anthropic/claude-sonnet-5-5" }, "medium"), [sonnet])).toBe(
		"Claude Sonnet 5.5 · medium",
	);
	expect(describePreset(preset({ default: "anthropic/claude-sonnet-5-5:low" }, "medium"), [sonnet])).toBe(
		"Claude Sonnet 5.5 · low",
	);
	expect(describePreset(preset({ smol: "a/b" }), null)).toBe("No default model · +1 more");
});
