import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Live, LivePool } from "../../server/live.ts";
import type { Goal } from "../../shared/goal.ts";
import { fakeConfig, writeFakeOmp } from "../support/fake-omp.ts";
import { pollUntil } from "../support/poll.ts";

/**
 * A frozen omp cannot be asked for its goal, so the server keeps the one it last heard of (from `goal_updated` and from
 * `get_state`), tells a page that opens or attaches (`attached`), and writes it into the record of a paused conversation,
 * so that the next server, which finds omp frozen, can tell it too (#384). Without it the page shows the goal its
 * transcript leaves, where an active goal reads as paused.
 */

const dirs: string[] = [];
const pools: LivePool[] = [];

afterEach(async () => {
	for (const pool of pools.splice(0)) {
		// A process left frozen would never read the closed stdin.
		for (const l of pool.list()) if (l.pid !== null) Bun.spawnSync(["kill", "-CONT", String(l.pid)]);
		await pool.shutdown();
	}
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const goal = (extra: Partial<Goal> = {}): Goal => ({
	id: "g1",
	objective: "Ship it",
	status: "active",
	tokensUsed: 12,
	timeUsedSeconds: 3,
	createdAt: 1,
	updatedAt: 2,
	...extra,
});

const updated = (g: Goal | null) => ({
	type: "goal_updated",
	goal: g,
	state: { enabled: true, mode: "active", goal: g },
});

const emit = (live: Live, ...frames: Record<string, unknown>[]) =>
	live.rpc({ type: "emit_frames", frames }, { user: live.info.pausedAt !== null });

async function conversation(): Promise<{ dir: string; bin: string; cwd: string }> {
	const dir = mkdtempSync(join(tmpdir(), "ompw-goal-parked-"));
	dirs.push(dir);
	const bin = writeFakeOmp(dir);
	const cwd = join(dir, "work");
	mkdirSync(cwd);
	return { dir, bin, cwd };
}

test("the goal the server heard of is what open and attach reply with, until omp says there is none", async () => {
	const { dir, bin, cwd } = await conversation();
	const pool = new LivePool(fakeConfig(dir, bin));
	pools.push(pool);
	const live = await pool.open({ kind: "new", cwd }, async () => null);
	expect(live.attached().goal).toBeUndefined();

	// Every `goal_updated` frame says it, tokens included.
	await emit(live, updated(goal()));
	await pollUntil(() => live.attached().goal !== undefined, "the server to hear of the goal");
	expect(live.attached().goal).toEqual(goal());
	await emit(live, updated(goal({ tokensUsed: 40, status: "paused" })));
	await pollUntil(() => live.attached().goal?.tokensUsed === 40, "the server to hear of the next update");
	expect(live.attached().goal?.status).toBe("paused");
	// What the reply carries beside the goal is the process's own announcement.
	expect(live.attached()).toMatchObject({ ...live.info, goal: { id: "g1" } });

	// A goal that ended (complete, dropped) is not one omp holds.
	await emit(live, updated(goal({ status: "complete" })));
	await pollUntil(() => live.attached().goal === undefined, "the server to drop a goal that ended");
});

test("omp's state says the goal too: goal mode's state holds it, and a state with none ends it", async () => {
	const { dir, bin, cwd } = await conversation();
	const pool = new LivePool(fakeConfig(dir, bin));
	pools.push(pool);
	const live = await pool.open({ kind: "new", cwd }, async () => null);
	// A state that does not mention goal mode (an omp without it) says nothing about the goal.
	await emit(live, updated(goal()));
	await pollUntil(() => live.attached().goal !== undefined, "the server to hear of the goal");
	await live.refreshState();
	expect(live.attached().goal).toEqual(goal());

	// A conversation reopened with a goal omp restored (paused) has no frame that says so: `get_state` does.
	await live.rpc({
		type: "set_state",
		state: { goal: { enabled: false, mode: "active", goal: goal({ status: "paused" }) } },
	});
	await live.refreshState();
	expect(live.attached().goal).toEqual(goal({ status: "paused" }));

	await live.rpc({ type: "set_state", state: { goal: null } });
	await live.refreshState();
	expect(live.attached().goal).toBeUndefined();
});

test("a paused conversation keeps its goal across a restart of the server, and a change made while it is paused is recorded", async () => {
	const { dir, bin, cwd } = await conversation();
	const first = new LivePool(fakeConfig(dir, bin));
	pools.push(first);
	const live = await first.open({ kind: "new", cwd }, async () => null);
	await emit(live, updated(goal()));
	await pollUntil(() => live.attached().goal !== undefined, "the server to hear of the goal");

	await live.pause();
	expect(first.parked.list().map((r) => r.goal)).toEqual([goal()]);

	// The server goes, the conversation stays; the next one finds omp frozen, and cannot ask it.
	expect(await first.parkKept()).toBe(1);
	const second = new LivePool(fakeConfig(dir, bin));
	pools.push(second);
	expect(await second.adopt()).toBe(1);
	const adopted = second.get(live.info.liveId) as Live;
	expect(adopted.info.pausedAt).not.toBeNull();
	expect(adopted.attached().goal).toEqual(goal());

	// omp runs for a user's action and the goal changes: the record says so, and so does the reply.
	await emit(adopted, updated(goal({ status: "paused", tokensUsed: 50 })));
	await pollUntil(
		() => second.parked.list().every((r) => r.goal?.status === "paused"),
		"the record to follow the goal",
	);
	expect(adopted.attached().goal).toEqual(goal({ status: "paused", tokensUsed: 50 }));
	await emit(adopted, updated(goal({ status: "dropped" })));
	await pollUntil(() => second.parked.list().every((r) => r.goal === undefined), "the record to drop the goal");
	expect(adopted.attached().goal).toBeUndefined();
});

test("the record of a paused conversation is written again when the file was taken, but not while an import is writing", async () => {
	const { dir, bin, cwd } = await conversation();
	const pool = new LivePool(fakeConfig(dir, bin));
	pools.push(pool);
	const live = await pool.open({ kind: "new", cwd }, async () => null);
	await live.pause();
	const file = join(dir, "parked", `${live.info.liveId}.json`);
	expect(existsSync(file)).toBe(true);

	// An import (Move to another computer) is writing the files conversations run on: the record is the import's to replace,
	// and the server does not write its own over what it puts there.
	pool.setHold(() => true);
	expect(pool.importing).toBe(true);
	writeFileSync(file, JSON.stringify({ version: 1, liveId: live.info.liveId, imported: true }));
	pool.syncRisk();
	expect(JSON.parse(readFileSync(file, "utf8")).imported).toBe(true);

	// The import has ended: the file is not the server's record, and the next look writes it again.
	pool.setHold(() => false);
	expect(pool.importing).toBe(false);
	pool.syncRisk();
	expect(JSON.parse(readFileSync(file, "utf8")).imported).toBeUndefined();
	expect(pool.parked.list().map((r) => r.liveId)).toEqual([live.info.liveId]);
	await live.resume();
});
