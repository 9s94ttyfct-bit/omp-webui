import { expect, test } from "bun:test";
import {
	applyPicks,
	type PickIo,
	pickModel,
	pickPreset,
	pickThinking,
	withoutLost,
} from "../../web/src/lib/new-chat-picks.ts";

/**
 * New chat's pickers act on a warm-up process that is replaced when the folder or the options change (#435): what was
 * picked is put on the next one, in the order it was chosen, without setting what the process already runs.
 */

const HAIKU = { provider: "anthropic", modelId: "claude-haiku-5-5" };
const OTHER = { provider: "anthropic", modelId: "claude-haiku-3" };

/**
 * A process that starts on Haiku with `medium` thinking (`startsOn`: what it is set to as a person chose it, which
 * can be `auto`), and records what is set on it.
 */
function fakeOmp(
	options: {
		refuse?: string;
		startsOn?: string;
		afterPreset?: { model?: typeof HAIKU; thinkingLevel?: string };
		/** Another model holds another level than the one the process had. */
		modelResetsLevel?: string;
	} = {},
) {
	const calls: string[] = [];
	let model = HAIKU;
	let thinking = options.startsOn ?? "medium";
	const io: PickIo = {
		async switchPreset(name) {
			calls.push(`preset:${name}`);
			if (options.refuse === "preset") throw new Error("no such preset");
			if (options.afterPreset?.model) model = options.afterPreset.model;
			if (options.afterPreset?.thinkingLevel) thinking = options.afterPreset.thinkingLevel;
		},
		async setModel(m) {
			calls.push(`model:${m.modelId}`);
			if (options.refuse === "model") throw new Error("Model not found");
			model = m;
			if (options.modelResetsLevel) thinking = options.modelResetsLevel;
		},
		async setThinking(level) {
			calls.push(`thinking:${level}`);
			if (options.refuse === "thinking") throw new Error("level not supported");
			thinking = level;
		},
		async running() {
			return { model: { provider: model.provider, id: model.modelId }, thinking };
		},
	};
	return { io, calls };
}

const alive = () => true;

test("a preset comes first, then the model, then the thinking level", async () => {
	const { io, calls } = fakeOmp();
	const picks = pickThinking(pickModel(pickPreset({}, "deep"), OTHER), "high");
	expect(await applyPicks(picks, io, alive)).toEqual([]);
	expect(calls).toEqual(["preset:deep", "model:claude-haiku-3", "thinking:high"]);
});

test("a preset chosen after a model or level voids them: it moved both", () => {
	expect(pickPreset(pickThinking(pickModel({}, OTHER), "high"), "fast")).toEqual({ preset: "fast" });
	expect(pickThinking(pickModel(pickPreset({}, "fast"), OTHER), "low")).toEqual({
		preset: "fast",
		model: OTHER,
		thinking: "low",
	});
});

test("what the process already runs is not set again (it would only add a model-change note)", async () => {
	const { io, calls } = fakeOmp();
	// The model is the process's own; the level is another.
	await applyPicks(pickThinking(pickModel({}, HAIKU), "high"), io, alive);
	expect(calls).toEqual(["thinking:high"]);
	const again = fakeOmp();
	await applyPicks(pickThinking(pickModel({}, HAIKU), "medium"), again.io, alive);
	expect(again.calls).toEqual([]);
});

/**
 * omp reports only the level `auto` resolved to as the conversation's level, so a process on `auto` is never "on" a level
 * a pick of `auto` equals: the pick is judged against what the process is set to, or it is sent to a process that is
 * already on auto (#495).
 */
test("an `auto` pick is not sent to a process that already runs on auto", async () => {
	const { io, calls } = fakeOmp({ startsOn: "auto" });
	expect(await applyPicks(pickThinking({}, "auto"), io, alive)).toEqual([]);
	expect(calls).toEqual([]);
});

test("a level is sent to a process on auto, and `auto` to one on a level", async () => {
	const onAuto = fakeOmp({ startsOn: "auto" });
	await applyPicks(pickThinking({}, "high"), onAuto.io, alive);
	expect(onAuto.calls).toEqual(["thinking:high"]);
	const onLevel = fakeOmp({ startsOn: "high" });
	await applyPicks(pickThinking({}, "auto"), onLevel.io, alive);
	expect(onLevel.calls).toEqual(["thinking:auto"]);
});

test("the level is judged against what the process runs after the model was set, not before", async () => {
	// The preset leaves the process on `high`; the model switch then resets it to `medium`, which is not what was picked.
	const { io, calls } = fakeOmp({ afterPreset: { thinkingLevel: "high" }, modelResetsLevel: "medium" });
	await applyPicks(pickThinking(pickModel(pickPreset({}, "deep"), OTHER), "high"), io, alive);
	expect(calls).toEqual(["preset:deep", "model:claude-haiku-3", "thinking:high"]);
});

test("a pick the process refuses is reported and the others still apply", async () => {
	const { io, calls } = fakeOmp({ refuse: "model" });
	const lost = await applyPicks(pickThinking(pickModel({}, OTHER), "high"), io, alive);
	expect(lost).toEqual([{ pick: "model", what: "anthropic/claude-haiku-3", error: "Model not found" }]);
	expect(calls).toEqual(["model:claude-haiku-3", "thinking:high"]);
	// It is not tried on the next process either: that would fail the same way.
	expect(withoutLost(pickThinking(pickModel({}, OTHER), "high"), lost)).toEqual({ thinking: "high" });
});

test("a refused preset is reported by name", async () => {
	const { io } = fakeOmp({ refuse: "preset" });
	const lost = await applyPicks(pickPreset({}, "gone"), io, alive);
	expect(lost).toEqual([{ pick: "preset", what: "gone", error: "no such preset" }]);
});

test("nothing is set on a process that is no longer wanted", async () => {
	const { io, calls } = fakeOmp();
	let wanted = true;
	const stopping: PickIo = {
		...io,
		async switchPreset(name) {
			await io.switchPreset(name);
			wanted = false;
		},
	};
	const lost = await applyPicks(pickThinking(pickModel(pickPreset({}, "deep"), OTHER), "high"), stopping, () => wanted);
	expect(lost).toEqual([]);
	expect(calls).toEqual(["preset:deep"]);
});

test("with no picks the process is left alone and not even asked", async () => {
	const { io, calls } = fakeOmp();
	let asked = false;
	const asking: PickIo = {
		...io,
		async running() {
			asked = true;
			return null;
		},
	};
	await applyPicks({}, asking, alive);
	expect(calls).toEqual([]);
	expect(asked).toBe(false);
});
