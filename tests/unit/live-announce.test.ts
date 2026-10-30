import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Live, LivePool, settingFrame } from "../../server/live.ts";
import { isRecord } from "../../shared/guards.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
import { writeFakeHostOmp } from "../support/fake-host-omp.ts";
import { fakeConfig } from "../support/fake-omp.ts";

/**
 * What the server says to every page that no frame could: when a process starts or ends a turn, asks, or is answered
 * (`LiveInfo.streaming`, `asking`, `continuing`, #592), and what a settings command did, which omp announces nothing
 * about (`settingFrame`, #593). Against a scripted omp, no model, with no page listening to the process.
 */

const dirs: string[] = [];
const pools: LivePool[] = [];

afterEach(async () => {
	for (const pool of pools.splice(0)) await pool.shutdown();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A process, and what every page was told of it (a copy of its info at each announcement). */
async function start(): Promise<{ live: Live; told: LiveInfo[] }> {
	const dir = mkdtempSync(join(tmpdir(), "ompw-live-announce-"));
	dirs.push(dir);
	const log = join(dir, "log");
	writeFileSync(log, "");
	const pool = new LivePool(fakeConfig(dir, writeFakeHostOmp(dir, log, {})), null, null, null);
	pools.push(pool);
	const told: LiveInfo[] = [];
	const live = await pool.open({ kind: "new", cwd: tmpdir() }, async () => tmpdir());
	pool.onAnnounce((info) => told.push({ ...info }));
	return { live, told };
}

/** Let the event loop turn (no wall-clock wait) until `condition` holds; the scripted omp answers within a few turns. */
async function until(condition: () => boolean): Promise<void> {
	const deadline = performance.now() + 10_000;
	while (!condition()) {
		if (performance.now() > deadline) throw new Error("the condition never held");
		const turn = Promise.withResolvers<void>();
		setImmediate(turn.resolve);
		await turn.promise;
	}
}

/** A tab that listens: every frame the server sent it. */
function tab(live: Live) {
	const frames: Record<string, unknown>[] = [];
	live.subscribers.add({
		send: (m: unknown) => {
			const msg = m as Record<string, unknown>;
			if (msg.t === "frame" && isRecord(msg.frame)) frames.push(msg.frame);
		},
	});
	return frames;
}

const ask = (id: string) => ({
	type: "extension_ui_request",
	id,
	method: "select",
	title: "Allow tool: bash\necho hi",
	options: ["Allow once", "Deny"],
});

test("every page is told a turn started, once, and that it ended, though no frame of it reaches them", async () => {
	const { live, told } = await start();
	const progress = { type: "queue_update", steering: [], followUp: [] };
	await live.rpc({ type: "emit_frames", frames: [{ type: "agent_start" }, progress, progress, progress] });
	await until(() => told.some((i) => i.streaming));
	// Frames that say nothing new about the work are not announced.
	await live.rpc({ type: "emit_frames", frames: [progress, progress, { type: "agent_end", isTerminal: true }] });
	await until(() => told.at(-1)?.streaming === false);
	expect(told.map((i) => i.streaming)).toEqual([true, false]);
});

test("every page is told a dialog waits, and that it was answered", async () => {
	const { live, told } = await start();
	await live.rpc({ type: "emit_frames", frames: [ask("q1")] });
	await until(() => told.some((i) => i.asking === true));
	expect(live.info.asking).toBe(true);
	live.respondUI({ id: "q1", value: "Allow once" });
	await until(() => told.at(-1)?.asking === undefined);
	expect(live.info).not.toHaveProperty("asking");
});

test("a dialog omp withdraws (its turn was stopped) is told as answered too", async () => {
	const { live, told } = await start();
	await live.rpc({ type: "emit_frames", frames: [ask("q2")] });
	await until(() => told.at(-1)?.asking === true);
	await live.rpc({
		type: "emit_frames",
		frames: [{ type: "extension_ui_request", method: "cancel", id: "c2", targetId: "q2" }],
	});
	await until(() => told.at(-1)?.asking === undefined);
});

test("a goal's run between two turns is told as going on, until omp says it is settled", async () => {
	const { live, told } = await start();
	const goal = { id: "g", objective: "x", status: "active" };
	await live.rpc({
		type: "emit_frames",
		frames: [{ type: "goal_updated", goal }, { type: "agent_start" }],
	});
	await until(() => told.at(-1)?.streaming === true);
	expect(told.at(-1)).not.toHaveProperty("continuing");
	await live.rpc({ type: "emit_frames", frames: [{ type: "agent_end", isTerminal: true }] });
	await until(() => told.at(-1)?.continuing === true);
	expect(told.at(-1)?.streaming).toBe(false);
	// The next turn starts: it is working, not between.
	await live.rpc({ type: "emit_frames", frames: [{ type: "agent_start" }] });
	await until(() => told.at(-1)?.streaming === true);
	expect(told.at(-1)).not.toHaveProperty("continuing");
	await live.rpc({
		type: "emit_frames",
		frames: [{ type: "agent_end", isTerminal: true }, { type: "session_settled" }],
	});
	await until(() => told.at(-1)?.streaming === false && told.at(-1)?.continuing === undefined);
});

test("a turn omp says is not its last is still work: pages are told it goes on, and not that it ended", async () => {
	const { live, told } = await start();
	await live.rpc({ type: "emit_frames", frames: [{ type: "agent_start" }] });
	await until(() => told.some((i) => i.streaming));
	await live.rpc({ type: "emit_frames", frames: [{ type: "agent_end", isTerminal: false }] });
	await until(() => told.at(-1)?.continuing === true);
	expect(told.at(-1)?.streaming).toBe(false);
	// The next turn starts, and the last one ends and settles it.
	await live.rpc({ type: "emit_frames", frames: [{ type: "agent_start" }] });
	await until(() => told.at(-1)?.streaming === true);
	expect(told.at(-1)).not.toHaveProperty("continuing");
	await live.rpc({
		type: "emit_frames",
		frames: [{ type: "agent_end", isTerminal: true }, { type: "session_settled" }],
	});
	await until(() => told.at(-1)?.streaming === false);
	expect(told.at(-1)).not.toHaveProperty("continuing");
});

test("a run told as going on is told as over once omp's own state says it is settled, though no session_settled frame came", async () => {
	const { live, told } = await start();
	const goal = { id: "g", objective: "x", status: "active" };
	await live.rpc({
		type: "emit_frames",
		frames: [{ type: "goal_updated", goal }, { type: "agent_start" }, { type: "agent_end", isTerminal: true }],
	});
	await until(() => told.at(-1)?.continuing === true);
	// Not settled yet: a state that says a goal turn is about to start changes nothing.
	await live.rpc({ type: "answer_next_with", command: "get_state", state: { isSettled: false }, frames: [] });
	await live.refreshState();
	expect(told.at(-1)?.continuing).toBe(true);
	// omp says it is settled (the frame that says so never reaches the server): the run is over.
	await live.rpc({ type: "answer_next_with", command: "get_state", state: { isSettled: true }, frames: [] });
	await live.refreshState();
	expect(live.info).not.toHaveProperty("continuing");
	expect(told.at(-1)).not.toHaveProperty("continuing");
	// The same for a turn omp said was not its last.
	await live.rpc({ type: "emit_frames", frames: [{ type: "agent_start" }, { type: "agent_end", isTerminal: false }] });
	await until(() => told.at(-1)?.continuing === true);
	await live.rpc({ type: "answer_next_with", command: "get_state", state: { isSettled: true }, frames: [] });
	await live.refreshState();
	expect(told.at(-1)).not.toHaveProperty("continuing");
});

test("what omp held when it answered `get_state` does not undo the frame that follows the answer", async () => {
	const { live, told } = await start();
	// omp answers the next `get_state` and starts a turn in the same write: the answer and `agent_start` are read together.
	await live.rpc({ type: "answer_next_with", command: "get_state", frames: [{ type: "agent_start" }] });
	await live.refreshState();
	// The answer says no turn is running, as it was when omp gave it; the turn that began after it is what is going on.
	expect(live.info.streaming).toBe(true);
	expect(told.at(-1)?.streaming).toBe(true);
	expect(told.map((i) => i.streaming)).toEqual([true]);
});

test("a goal that ended right after omp answered `get_state` is not held again by the answer, so the run is not told as going on", async () => {
	const { live, told } = await start();
	const goal = { id: "g", objective: "x", status: "active" };
	await live.rpc({
		type: "emit_frames",
		frames: [{ type: "goal_updated", goal }, { type: "agent_start" }, { type: "agent_end", isTerminal: true }],
	});
	await until(() => told.at(-1)?.continuing === true);
	// omp answers while the goal is active, and the goal ends in the next line it writes.
	await live.rpc({
		type: "answer_next_with",
		command: "get_state",
		state: { goal: { enabled: true, mode: "goal", goal } },
		frames: [{ type: "goal_updated", goal: { ...goal, status: "complete" } }],
	});
	await live.refreshState();
	expect(live.info).not.toHaveProperty("continuing");
	expect(told.at(-1)).not.toHaveProperty("continuing");
});

test("a turn that ends with no goal is not between turns", async () => {
	const { live, told } = await start();
	await live.rpc({
		type: "emit_frames",
		frames: [{ type: "agent_start" }, { type: "agent_end", isTerminal: true }],
	});
	await until(() => told.some((i) => i.streaming) && told.at(-1)?.streaming === false);
	expect(told.some((i) => i.continuing)).toBe(false);
});

test("omp sends no frame for a setting it takes, so every page that listens is told what changed", async () => {
	const { live } = await start();
	const frames = tab(live);
	await live.rpc({ type: "set_thinking_level", level: "low" });
	await live.rpc({ type: "set_steering_mode", mode: "all" });
	await live.rpc({ type: "set_auto_compaction", enabled: false });
	expect(frames).toEqual([
		{ type: "thinking_level_changed", thinkingLevel: "low" },
		{ type: "settings_changed", settings: { steeringMode: "all" } },
		{ type: "settings_changed", settings: { autoCompactionEnabled: false } },
	]);
});

test("a command that changes nothing about the conversation's settings is told to nobody", async () => {
	const { live } = await start();
	const frames = tab(live);
	await live.rpc({ type: "get_state" });
	await live.rpc({ type: "get_available_models" });
	await live.rpc({ type: "set_thinking_level" });
	expect(frames).toEqual([]);
});

test("what each settings command changed is named by the field omp's state has for it", () => {
	const thinking = (level: unknown) => settingFrame({ type: "set_thinking_level", level }, undefined);
	expect(thinking("high")).toEqual({ type: "thinking_level_changed", thinkingLevel: "high" });
	// `auto` is the conversation's selector, and what it resolves to is read from the state.
	expect(thinking("auto")).toEqual({ type: "thinking_level_changed", thinkingLevel: "auto", configured: "auto" });
	expect(thinking(undefined)).toBeNull();
	expect(settingFrame({ type: "set_follow_up_mode", mode: "all" }, undefined)).toEqual({
		type: "settings_changed",
		settings: { followUpMode: "all" },
	});
	expect(settingFrame({ type: "set_interrupt_mode", mode: "wait" }, undefined)).toEqual({
		type: "settings_changed",
		settings: { interruptMode: "wait" },
	});
	expect(settingFrame({ type: "set_slow_mode", enabled: true }, undefined)).toEqual({
		type: "settings_changed",
		settings: { slowModeEnabled: true },
	});
	expect(settingFrame({ type: "set_session_name", name: "Ship it" }, undefined)).toEqual({
		type: "settings_changed",
		settings: { sessionName: "Ship it" },
	});
	// omp says whether fast mode is in effect (a model with no fast mode: off); that is what the pages show.
	expect(settingFrame({ type: "set_fast_mode", enabled: true }, { enabled: true, active: false })).toEqual({
		type: "settings_changed",
		settings: { fastModeEnabled: true, fastModeActive: false },
	});
	expect(settingFrame({ type: "set_fast_mode", enabled: true }, undefined)).toEqual({
		type: "settings_changed",
		settings: { fastModeEnabled: true },
	});
	expect(settingFrame({ type: "set_steering_mode" }, undefined)).toBeNull();
	// The ones omp does announce, and the ones the server keeps in the process's info, are not told twice.
	expect(settingFrame({ type: "set_model", provider: "a", modelId: "b" }, undefined)).toBeNull();
	expect(settingFrame({ type: "set_auto_retry", enabled: true }, undefined)).toBeNull();
});
