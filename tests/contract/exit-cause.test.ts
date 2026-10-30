import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LivePool } from "../../server/live.ts";
import type { ServerMessage } from "../../shared/protocol.ts";
import { type FakeOmpOptions, fakeConfig, writeFakeOmp } from "../support/fake-omp.ts";

/**
 * Who ended a conversation's omp, and why: the page must be able to tell an end the server asked for (the idle
 * reaper, a Close, a restart, the terminal hand-off, the server going away) from an omp that ended on its own
 * (a crash, a signal, an exit of its own). Before this, both came as `live_exit {code: 0}` and the page showed the
 * same banner for a reaped process as for a crashed one, so a conversation whose process the server had closed was
 * read as a fault of omp's (#472).
 *
 * A scripted omp stands in for the real one: it answers what the server asks and ends when its stdin closes, as omp
 * does. No model call.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-exit-cause-"));
const pools: LivePool[] = [];

afterAll(async () => {
	for (const pool of pools.splice(0)) await pool.shutdown();
	rmSync(root, { recursive: true, force: true });
});

/** A pool of one scripted omp, and the exits it tells the page about. */
async function setup(options: FakeOmpOptions = {}) {
	const dir = mkdtempSync(join(root, "w-"));
	const pool = new LivePool(fakeConfig(dir, writeFakeOmp(dir, options)), null, null, null, 2000);
	pools.push(pool);
	const live = await pool.open({ kind: "new", cwd: dir }, async () => null);
	const exits: ServerMessage[] = [];
	const original = live.broadcast.bind(live);
	(live as unknown as { broadcast: (m: unknown) => void }).broadcast = (m: unknown) => {
		const msg = m as ServerMessage;
		if (msg.t === "live_exit") exits.push(msg);
		original(m);
	};
	// The process is as old as the reaper needs it to be, and idle: it is what the reaper closes.
	const aged = live as unknown as { lastActivity: number; info: { startedAt: number } };
	aged.lastActivity = Date.now() - 60 * 60_000;
	aged.info.startedAt = Date.now() - 60 * 60_000;
	return { pool, live, exits };
}

/** The exit the page was told about, or null. */
const exitOf = (exits: ServerMessage[]) => {
	const found = exits.find((e) => e.t === "live_exit");
	return found && found.t === "live_exit" ? found : null;
};

test("the idle reaper says it closed the process, and why", async () => {
	const { pool, exits } = await setup();
	(pool as unknown as { reap(): void }).reap();
	await Bun.sleep(1000);
	const exit = exitOf(exits);
	expect(exit).not.toBeNull();
	expect(exit).toMatchObject({ by: "server", reason: "idle" });
}, 30_000);

test("a Close says the user closed the process", async () => {
	const { live, exits } = await setup();
	await live.end();
	await Bun.sleep(500);
	expect(exitOf(exits)).toMatchObject({ by: "server", reason: "closed" });
}, 30_000);

test("a process that ends on its own is not blamed on the server", async () => {
	const { live, exits } = await setup();
	// The process is killed from outside: it ends on its own, and the server did not ask for it.
	process.kill(live.info.pid as number, "SIGKILL");
	await Bun.sleep(1000);
	const exit = exitOf(exits);
	expect(exit).not.toBeNull();
	expect(exit).toMatchObject({ by: "omp", code: null, signal: "SIGKILL" });
	expect(exit && "reason" in exit ? exit.reason : undefined).toBeUndefined();
}, 30_000);

test("a restart says the process was ended to be started again", async () => {
	const { pool, live, exits } = await setup();
	await pool.endIfIdle(live);
	await Bun.sleep(500);
	expect(exitOf(exits)).toMatchObject({ by: "server", reason: "restarted" });
}, 30_000);

test("the server going away says so", async () => {
	const { pool, exits } = await setup();
	await pool.shutdown();
	await Bun.sleep(500);
	expect(exitOf(exits)).toMatchObject({ by: "server", reason: "server" });
}, 30_000);
