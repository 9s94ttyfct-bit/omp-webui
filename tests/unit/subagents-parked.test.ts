import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Live, LivePool } from "../../server/live.ts";
import { fakeConfig, writeFakeOmp } from "../support/fake-omp.ts";

/**
 * A frozen omp cannot be asked which subagents run, and a page that was not there when the conversation was paused has
 * no frame that says so: the transcripts on disk say every subagent is over. So the server asks omp for its registry just
 * before it freezes it, tells a page that attaches to the paused conversation (`attached`), and writes it into the record,
 * so that the next server, which finds omp frozen, can tell it too (#598).
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

const scout = {
	id: "Scout",
	agent: "explore",
	index: 0,
	status: "running",
	parentToolCallId: "call_task",
	progress: { id: "Scout", status: "running", toolCount: 3, durationMs: 4000 },
};

async function conversation(
	options: Parameters<typeof writeFakeOmp>[1] = {},
): Promise<{ dir: string; bin: string; cwd: string }> {
	const dir = mkdtempSync(join(tmpdir(), "ompw-subagents-parked-"));
	dirs.push(dir);
	const bin = writeFakeOmp(dir, options);
	const cwd = join(dir, "work");
	mkdirSync(cwd);
	return { dir, bin, cwd };
}

const list = (live: Live, ...subagents: Record<string, unknown>[]) =>
	live.rpc({ type: "set_state", state: { subagents } });

test("a running conversation says nothing of its subagents on attach, a paused one says what omp listed when it was frozen, and a resumed one says nothing again", async () => {
	const { dir, bin, cwd } = await conversation();
	const pool = new LivePool(fakeConfig(dir, bin));
	pools.push(pool);
	const live = await pool.open({ kind: "new", cwd }, async () => null);
	await list(live, scout);
	expect(live.attached().subagents).toBeUndefined();

	await live.pause();
	expect(live.attached().subagents).toEqual([scout]);
	expect(pool.parked.list().map((r) => r.subagents)).toEqual([[scout]]);

	await live.resume();
	expect(live.attached().subagents).toBeUndefined();
	expect(pool.parked.list().every((r) => r.subagents === undefined)).toBe(true);
});

test("a paused conversation keeps its subagents across a restart of the server", async () => {
	const { dir, bin, cwd } = await conversation();
	const first = new LivePool(fakeConfig(dir, bin));
	pools.push(first);
	const live = await first.open({ kind: "new", cwd }, async () => null);
	await list(live, scout);
	await live.pause();

	// The server goes, the conversation stays; the next one finds omp frozen, and cannot ask it.
	expect(await first.parkKept()).toBe(1);
	const second = new LivePool(fakeConfig(dir, bin));
	pools.push(second);
	expect(await second.adopt()).toBe(1);
	const adopted = second.get(live.info.liveId) as Live;
	expect(adopted.info.pausedAt).not.toBeNull();
	expect(adopted.attached().subagents).toEqual([scout]);

	// Resumed by the next server: omp runs, the registry is omp's to say again.
	await adopted.resume();
	expect(adopted.attached().subagents).toBeUndefined();
	expect(second.parked.list().every((r) => r.subagents === undefined)).toBe(true);
});

test("a conversation with no subagents running is paused with none to tell", async () => {
	const { dir, bin, cwd } = await conversation();
	const pool = new LivePool(fakeConfig(dir, bin));
	pools.push(pool);
	const live = await pool.open({ kind: "new", cwd }, async () => null);
	await live.pause();
	expect(live.attached().subagents).toEqual([]);
});

// Real time: omp is given 2 s to list its subagents before it is frozen, which is what is under test.
test("an omp that does not list its subagents is frozen all the same, and tells none", async () => {
	const { dir, bin, cwd } = await conversation({ hold: ["get_subagents"] });
	const pool = new LivePool(fakeConfig(dir, bin));
	pools.push(pool);
	const live = await pool.open({ kind: "new", cwd }, async () => null);
	await live.pause();
	expect(live.info.pausedAt).not.toBeNull();
	expect(live.attached().subagents).toBeUndefined();
	expect(pool.parked.list().every((r) => r.subagents === undefined)).toBe(true);
});
