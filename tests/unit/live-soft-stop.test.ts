import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Live, LivePool } from "../../server/live.ts";
import { fakeConfig } from "../support/fake-omp.ts";
import { pollUntil } from "../support/poll.ts";
import { writeSyncOmp } from "../support/sync-omp-bin.ts";

/**
 * Soft stop (#658) through the process that holds it: the request waits for the turn to end, then the process is ended
 * and the pages are told why ("softStop"); taken back, the turn's end ends nothing. Against a stand-in omp whose turn ends
 * when it is told to (`sync-omp.ts`). No model.
 */

const dirs: string[] = [];
const pools: LivePool[] = [];
let restoreEnv: (() => void) | null = null;

afterEach(async () => {
	restoreEnv?.();
	restoreEnv = null;
	for (const pool of pools.splice(0)) await pool.shutdown();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function conversation(): Promise<{ pool: LivePool; live: Live }> {
	const dir = mkdtempSync(join(tmpdir(), "ompw-live-soft-stop-"));
	dirs.push(dir);
	const log = join(dir, "omp.log");
	writeFileSync(log, "");
	const before = process.env.FAKE_OMP_LOG;
	process.env.FAKE_OMP_LOG = log;
	restoreEnv = () => {
		if (before === undefined) delete process.env.FAKE_OMP_LOG;
		else process.env.FAKE_OMP_LOG = before;
	};
	const cwd = join(dir, "work");
	mkdirSync(cwd);
	const pool = new LivePool(fakeConfig(dir, writeSyncOmp(dir)));
	pools.push(pool);
	const live = await pool.open({ kind: "new", cwd }, async () => null);
	return { pool, live };
}

test("asked for while the turn runs: the process lives until the turn ends, then is ended for the soft stop", async () => {
	const { pool, live } = await conversation();
	const told: boolean[] = [];
	pool.onAnnounce((info) => told.push(info.softStop !== undefined));
	const exits: Record<string, unknown>[] = [];
	live.subscribers.add({
		send: (m: unknown) => {
			const msg = m as Record<string, unknown>;
			if (msg.t === "live_exit") exits.push(msg);
		},
	});
	await live.rpc({ type: "prompt", message: "write the handoff" });
	await pollUntil(() => live.info.streaming, "the turn to begin");

	live.setSoftStop(true);
	expect(live.info.softStop).toEqual({ at: expect.any(Number) });
	expect(told.at(-1)).toBe(true);
	// Nothing ends while the turn runs.
	await Bun.sleep(150);
	expect(live.info.exited).toBeFalsy();

	await live.rpc({ type: "sync_finish" });
	await pollUntil(() => exits.length > 0, "the process to end after the turn");
	expect(exits[0]).toMatchObject({ by: "server", reason: "softStop" });
	expect(live.info.softStop).toBeUndefined();
});

test("taken back, the turn's end ends nothing", async () => {
	const { live } = await conversation();
	await live.rpc({ type: "prompt", message: "work" });
	await pollUntil(() => live.info.streaming, "the turn to begin");
	live.setSoftStop(true);
	live.setSoftStop(false);
	expect(live.info.softStop).toBeUndefined();
	await live.rpc({ type: "sync_finish" });
	await pollUntil(() => !live.info.streaming, "the turn to end");
	await Bun.sleep(200);
	expect(live.info.exited).toBeFalsy();
});
