import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Live, LivePool } from "../../server/live.ts";
import { fakeConfig, writeFakeOmp } from "../support/fake-omp.ts";

/**
 * How a process ended has to outlive the process: the idle reaper closes the processes nobody watches, and the
 * `live_exit` frame that says how one ended reaches only the subscribers — so it reaches nobody. A page that asks
 * about the process afterwards is told only that it is gone, and blames the server for a process that crashed on its
 * own (#515).
 *
 * The server therefore keeps the end of each recently ended process, and hands it to a page that asks about the
 * process. The record is bounded: the oldest ends are dropped, and a page that asks about one whose end has been
 * dropped is told the process is no longer running, without saying who ended it.
 */

const dirs: string[] = [];
const pools: LivePool[] = [];

afterEach(async () => {
	for (const pool of pools.splice(0)) await pool.shutdown();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A pool of scripted omp processes, and the ways a process can end. `startingMs` is 0, so the idle reaper does not
 * wait for a process to grow old before it closes it: the test need not wait for a clock.
 */
async function setup() {
	const dir = mkdtempSync(join(tmpdir(), "ompw-exit-record-"));
	dirs.push(dir);
	const pool = new LivePool(fakeConfig(dir, writeFakeOmp(dir, {})), null, null, null, 2000, undefined, undefined, 0);
	pools.push(pool);
	/** A process of its own, in a folder of its own (a New chat in a folder reuses the process there). */
	const open = async (): Promise<Live> => {
		const cwd = join(dir, `w${Math.random().toString(36).slice(2)}`);
		mkdirSync(cwd, { recursive: true });
		return pool.open({ kind: "new", cwd }, async () => null);
	};
	return { pool, open };
}

/** Wait for a condition, without a fixed delay: the pool ends a process on its own schedule. */
async function until(condition: () => boolean): Promise<void> {
	for (let i = 0; i < 200 && !condition(); i++) await Bun.sleep(25);
}

test("a process the idle reaper closed is remembered as the server's doing, with the reason", async () => {
	const { pool, open } = await setup();
	// Five unwatched processes: the reaper keeps the four most recently active and closes the rest.
	const lives: Live[] = [];
	for (let i = 0; i < 5; i++) lives.push(await open());
	// The oldest is the one that is surplus: the reaper keeps the four most recently active.
	const reaped = lives[0];
	// Nobody watches it, and it is not busy: the reaper's own condition.
	pool.announce(reaped);
	await until(() => reaped.info.exited);

	const ended = pool.exitOf(reaped.info.liveId);
	expect(ended?.exit).toMatchObject({ by: "server", reason: "idle" });
	// The end is kept with what the process was, so that a page can show the conversation it was.
	expect(ended?.info.sessionFile).toBe(reaped.info.sessionFile);
});

test("a process that ended on its own is remembered as omp's own end, not the server's", async () => {
	const { pool, open } = await setup();
	const live = await open();
	// The process is killed from outside: it ends on its own, and the server did not ask for it.
	process.kill(live.info.pid as number, "SIGKILL");
	await until(() => live.info.exited);

	const ended = pool.exitOf(live.info.liveId);
	expect(ended?.exit).toMatchObject({ by: "omp", code: null, signal: "SIGKILL" });
	expect(ended?.exit).not.toHaveProperty("reason");
});

test("a process the server ended is remembered as the server's doing, with the reason", async () => {
	const { pool, open } = await setup();
	const live = await open();
	await live.end("closed");
	await until(() => live.info.exited);

	expect(pool.exitOf(live.info.liveId)?.exit).toMatchObject({ by: "server", reason: "closed" });
});

test("a process the server does not remember is not said to have ended by anyone", async () => {
	const { pool, open } = await setup();
	const live = await open();
	// The end is forgotten: the server was restarted, or the record was dropped.
	pool.forget(live);
	expect(pool.exitOf(live.info.liveId)).toBeNull();
	// The listing holds only the processes that run: an ended one is gone, and the listing has always said so.
	expect(pool.list().some((l) => l.liveId === live.info.liveId)).toBe(false);
});
