import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Live, LivePool, refusal, surplus } from "../../server/live.ts";
import { fakeConfig, writeFakeOmp } from "../support/fake-omp.ts";
import { pollUntil } from "../support/poll.ts";

/**
 * omp's own word on whether it is done (`get_state`: `isSettled`, `hasPendingAsyncWork`, `isCompacting`; the frames
 * `auto_compaction_start`/`_end` and `session_settled`) decides whether a process is busy, not only the turn it is in:
 * a background job can wake the agent after it yielded, and closing the process (reaping it as idle, the terminal's
 * hand-off, a restart, an update) would end the job. A scripted omp reports; time is moved by handing the reaper a
 * later "now".
 */

const dirs: string[] = [];
const pools: LivePool[] = [];

afterEach(async () => {
	for (const pool of pools.splice(0)) await pool.shutdown();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function conversation(): Promise<{ pool: LivePool; live: Live }> {
	const dir = mkdtempSync(join(tmpdir(), "ompw-unsettled-"));
	dirs.push(dir);
	const pool = new LivePool(fakeConfig(dir, writeFakeOmp(dir)));
	pools.push(pool);
	const cwd = join(dir, "work");
	mkdirSync(cwd);
	return { pool, live: await pool.open({ kind: "new", cwd }, async () => null) };
}

const frames = (live: Live, ...list: Record<string, unknown>[]) => live.rpc({ type: "emit_frames", frames: list });
const reports = (live: Live, state: Record<string, unknown>) => live.rpc({ type: "set_state", state });
/** The conversation's turn ends, as omp announces it; what omp reports with `get_state` meanwhile is what `reports` set. */
const turnEnds = (live: Live) => frames(live, { type: "agent_start" }, { type: "agent_end", messages: [] });
/** Every `get_state` asked so far has been answered and taken in (answers come in order). */
const caughtUp = (live: Live) => live.rpc({ type: "get_state" });

const reapableAfter = (live: Live, later: number) => surplus([live], live.lastActivity + later).includes(live);
const DAY = 24 * 3_600_000;

const WORKING: [string, Record<string, unknown>][] = [
	["the session is not settled", { isSettled: false }],
	["a background job is pending", { hasPendingAsyncWork: true }],
	["omp is compacting", { isCompacting: true }],
];

for (const [what, state] of WORKING) {
	test(`omp says ${what} after its turn ended: the conversation is busy, so it is not reaped, released or restarted`, async () => {
		const { pool, live } = await conversation();
		await reports(live, state);
		await turnEnds(live);
		await pollUntil(() => live.busy, "the conversation to count as busy");

		expect(live.info.streaming).toBe(false);
		expect(live.holding).toBe("working");
		expect(pool.list()[0]).toMatchObject({ busy: true, holding: "working" });
		expect(live.pristine).toBe(false);
		expect(reapableAfter(live, DAY)).toBe(false);
		// What an MCP restart and the terminal's hand-off ask, and what makes an omp update wait.
		expect(await pool.endIfIdle(live)).toBe("working");
		await expect(pool.release({ by: "file", file: live.info.sessionFile as string })).rejects.toThrow(
			refusal("working"),
		);
		expect(live.client.running).toBe(true);
	});
}

test("once omp reports the session settled the conversation is idle again, and the reaper may close it", async () => {
	const { live } = await conversation();
	await reports(live, { isSettled: false, hasPendingAsyncWork: true });
	await turnEnds(live);
	await pollUntil(() => live.busy, "the conversation to count as busy");

	// The background job is over and nothing woke the agent: omp says the session is settled.
	await reports(live, { isSettled: true, hasPendingAsyncWork: false });
	await frames(live, { type: "session_settled" });
	await pollUntil(() => !live.busy, "the conversation to be idle");
	expect(reapableAfter(live, DAY)).toBe(true);
});

test("an automatic compaction after the turn is busy from its first frame to its last", async () => {
	const { live } = await conversation();
	await turnEnds(live);
	await caughtUp(live);
	expect(live.busy).toBe(false);

	await frames(live, { type: "auto_compaction_start", reason: "threshold", action: "context-full" });
	expect(live.busy).toBe(true);
	expect(reapableAfter(live, DAY)).toBe(false);

	await frames(live, { type: "auto_compaction_end", aborted: false, willRetry: false });
	await caughtUp(live);
	expect(live.busy).toBe(false);
});

test("an omp that reports nothing of this (an older one) is idle after its turn, as before", async () => {
	const { live } = await conversation();
	await turnEnds(live);
	await caughtUp(live);
	expect(live.busy).toBe(false);
	expect(reapableAfter(live, DAY)).toBe(true);
});
