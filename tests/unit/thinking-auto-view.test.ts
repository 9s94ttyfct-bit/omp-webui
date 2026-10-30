import "./browser-globals.ts";
import { describe, expect, test } from "bun:test";
import type { LiveInfo } from "../../shared/protocol.ts";
import { sessionOf } from "../../web/src/lib/model-config.ts";
import { levelsFor, selectedThinking, startedOnAuto, withAuto } from "../../web/src/lib/models.ts";
import { statusItems } from "../../web/src/lib/status-line.ts";
import { initialLive, type LiveState } from "../../web/src/store/live.ts";

/**
 * What the composer's thinking switcher, the status line and the presets show for omp's `auto` level. omp reports the
 * level `auto` resolved to as the conversation's level (`get_state.thinkingLevel`) and never offers `auto` among the
 * levels it lists: the page has to add it, and to say `auto` when that is what the conversation is set to.
 */

const info: LiveInfo = {
	liveId: "L1",
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
};
const model = { id: "claude-opus-5-5", name: "Opus 5.5", provider: "anthropic", reasoning: true };
const state = (thinkingLevel: string) =>
	({
		isStreaming: false,
		isCompacting: false,
		steeringMode: "",
		followUpMode: "",
		interruptMode: "",
		messageCount: 0,
		queuedMessageCount: 0,
		thinkingLevel,
		model,
	}) as LiveState["state"];
const live = (over: Partial<LiveState>): LiveState => ({ ...initialLive(info), ...over });

describe("the levels offered", () => {
	test("`auto` comes after `off`, as in the terminal UI, when the model thinks", () => {
		expect(withAuto(["off", "low", "medium", "high"], model)).toEqual(["off", "auto", "low", "medium", "high"]);
	});

	test("a model that cannot think, or whose levels omp has not verified, gets no `auto`", () => {
		expect(withAuto(["off"], { ...model, reasoning: false })).toEqual(["off"]);
		expect(withAuto(["off", "high"], { ...model, thinking: { unverified: true } })).toEqual(["off", "high"]);
	});

	test("`auto` is not listed twice", () => {
		expect(withAuto(["off", "auto", "low"], model)).toEqual(["off", "auto", "low"]);
	});

	test("the levels of the catalog (no omp running) are offered with it too", () => {
		expect(withAuto(levelsFor(model, [model]), model)).toContain("auto");
	});
});

describe("what a conversation is set to", () => {
	test("a live process that announced `auto` is on `auto`, with the level it resolved to as the hint", () => {
		expect(selectedThinking(live({ thinking: "auto", state: state("high") }))).toEqual({
			selected: "auto",
			resolved: "high",
		});
	});

	test("a resumed conversation (omp says nothing on resume) is on what its journal says: `auto`", () => {
		expect(selectedThinking(live({ state: state("high") }), "auto")).toEqual({ selected: "auto", resolved: "high" });
	});

	test("a journal level other than `auto` does not override the level omp reports", () => {
		expect(selectedThinking(live({ state: state("low") }), "high")).toEqual({ selected: "low" });
	});

	test("an explicit pick after `auto` wins over the journal's `auto`", () => {
		expect(selectedThinking(live({ thinking: "medium", state: state("medium") }), "auto")).toEqual({
			selected: "medium",
		});
	});

	test("with no process, the journal's level is what is shown", () => {
		expect(selectedThinking(undefined, "auto")).toEqual({ selected: "auto" });
		expect(selectedThinking(undefined, "high")).toEqual({ selected: "high" });
		expect(selectedThinking(undefined)).toEqual({});
	});
});

describe("a process started with `--thinking auto`", () => {
	const started = (over: Partial<LiveState> = {}) =>
		({ ...initialLive({ ...info, args: ["--thinking", "auto"] }), state: state("high"), ...over }) as LiveState;

	test("is on `auto` for a page that has heard nothing and has no journal entry", () => {
		expect(selectedThinking(started())).toEqual({ selected: "auto", resolved: "high" });
		expect(selectedThinking({ ...initialLive({ ...info, args: ["--thinking=auto"] }), state: state("high") })).toEqual({
			selected: "auto",
			resolved: "high",
		});
	});

	test("is on the level picked since, for a page loaded afterwards: the journal outranks how it was started", () => {
		// What omp journals for an explicit pick, and the level it then reports.
		expect(selectedThinking(started({ state: state("low") }), "low")).toEqual({ selected: "low" });
	});

	test("is on the level a frame this page heard announced, whatever the journal or the launch say", () => {
		expect(selectedThinking(started({ thinking: "low", state: state("low") }), "auto")).toEqual({ selected: "low" });
	});

	test("a preset saved from it after a pick stores that level, not `auto`", () => {
		const reloaded = started({ state: state("low") });
		expect(sessionOf(reloaded, { thinking: "low" }).thinking).toBe("low");
	});

	test("another level on the command line, or none, is not `auto`", () => {
		const other = { ...initialLive({ ...info, args: ["--thinking=high"] }), state: state("high") };
		expect(selectedThinking(other)).toEqual({ selected: "high" });
	});
});

describe("a process that starts on `auto` without being told on its command line", () => {
	// What omp reads at start: the default role's selector (`:level`), else `defaultThinkingLevel`; `--thinking` beats both.
	const config = (defaultRole: string, level?: string) => ({
		roles: { default: defaultRole },
		defaultThinkingLevel: level,
	});

	test("the default role's selector says `auto`", () => {
		expect(startedOnAuto([], config("anthropic/claude-opus-5-5:auto", "high"))).toBe(true);
	});

	test("`defaultThinkingLevel: auto` says it when the selector names no level", () => {
		expect(startedOnAuto([], config("anthropic/claude-opus-5-5", "auto"))).toBe(true);
		expect(startedOnAuto([], config("pi/smol", "auto"))).toBe(true);
	});

	test("a level on the selector outranks `defaultThinkingLevel`, and `--thinking` outranks both", () => {
		expect(startedOnAuto([], config("anthropic/claude-opus-5-5:high", "auto"))).toBe(false);
		expect(startedOnAuto(["--thinking", "high"], config("anthropic/claude-opus-5-5:auto", "auto"))).toBe(false);
		expect(startedOnAuto(["--thinking=auto"], config("anthropic/claude-opus-5-5:high", "high"))).toBe(true);
	});

	test("`--model` with an `:auto` selector says it", () => {
		expect(startedOnAuto(["--model", "anthropic/claude-opus-5-5:auto"], config("a/b", "high"))).toBe(true);
	});

	test("nothing says it: no config loaded yet, or a config on a level", () => {
		expect(startedOnAuto([], null)).toBe(false);
		expect(startedOnAuto([], config("a/b", "high"))).toBe(false);
	});

	test("the conversation is shown as `auto` with the level omp resolved it to, however it got there", () => {
		const cfg = config("anthropic/claude-opus-5-5", "auto");
		expect(selectedThinking(live({ state: state("high") }), undefined, cfg)).toEqual({
			selected: "auto",
			resolved: "high",
		});
		expect(sessionOf(live({ state: state("high") }), undefined, cfg).thinking).toBe("auto");
		expect(statusItems(live({ state: state("high") }), 0, null, 0, undefined, cfg).model).toEqual({
			name: "Opus 5.5",
			thinking: "auto",
			resolved: "high",
		});
	});

	test("what was announced or journaled since outranks the config it started on", () => {
		const cfg = config("anthropic/claude-opus-5-5", "auto");
		expect(selectedThinking(live({ thinking: "low", state: state("low") }), undefined, cfg)).toEqual({
			selected: "low",
		});
		expect(selectedThinking(live({ state: state("low") }), "low", cfg)).toEqual({ selected: "low" });
	});
});

describe("where `auto` shows", () => {
	test("the status line says `auto` and the level it resolved to", () => {
		const items = statusItems(live({ thinking: "auto", state: state("high") }), 0, null, 0);
		expect(items.model).toEqual({ name: "Opus 5.5", thinking: "auto", resolved: "high" });
	});

	test("a preset saved from the conversation keeps `auto` rather than the level it resolved to", () => {
		expect(sessionOf(live({ thinking: "auto", state: state("high") })).thinking).toBe("auto");
	});
});
