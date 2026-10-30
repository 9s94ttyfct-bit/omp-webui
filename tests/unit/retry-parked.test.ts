import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Live, LivePool } from "../../server/live.ts";
import type { LiveInfo, LiveRetry } from "../../shared/protocol.ts";
import { USAGE_LIMIT_FLAG } from "../../shared/retry.ts";
import { fakeConfig, writeFakeOmp } from "../support/fake-omp.ts";
import { pollUntil } from "../support/poll.ts";

/**
 * A conversation paused while omp backs off before a retry (a usage-limit wait of hours, most of all) is still waiting
 * when the app is quit and opened again: its record carries the wait, the next server announces it on adoption, and a
 * change made while it is paused (a user's action lets omp run for a moment) is written to the record too.
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

const retryStart = {
	type: "auto_retry_start",
	attempt: 2,
	maxAttempts: 5,
	delayMs: 5_400_000,
	errorMessage: "You have reached your usage limit.",
	errorId: USAGE_LIMIT_FLAG,
};

const emit = (live: Live, ...frames: Record<string, unknown>[]) =>
	live.rpc({ type: "emit_frames", frames }, { user: live.info.pausedAt !== null });

test("a paused conversation keeps omp's backoff across a restart of the server, and a change made while it is paused is recorded", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-retry-parked-"));
	dirs.push(dir);
	const bin = writeFakeOmp(dir);
	const cwd = join(dir, "work");
	mkdirSync(cwd);

	const first = new LivePool(fakeConfig(dir, bin));
	pools.push(first);
	const live = await first.open({ kind: "new", cwd }, async () => null);
	await emit(live, { type: "agent_start" }, { type: "agent_end", messages: [] }, retryStart);
	const held: LiveRetry = { ...(live.info.retry as LiveRetry) };
	expect(held).toMatchObject({ attempt: 2, maxAttempts: 5, delayMs: 5_400_000, usageLimit: true, resumed: false });

	await live.pause();
	expect(first.parked.list().map((r) => r.retry)).toEqual([held]);

	// The server goes, the conversation stays; the next one finds it.
	expect(await first.parkKept()).toBe(1);
	const second = new LivePool(fakeConfig(dir, bin));
	pools.push(second);
	const announced: LiveInfo[] = [];
	second.onAnnounce((info) => announced.push(info));
	expect(await second.adopt()).toBe(1);

	const adopted = second.get(live.info.liveId) as Live;
	expect(adopted.info.pausedAt).not.toBeNull();
	// The wait is back: the tabs are told of it, the conversation counts as busy, and Retry now knows to end a backoff.
	expect(adopted.info.retry).toEqual(held);
	expect(announced.some((i) => i.liveId === adopted.info.liveId && i.retry?.startedAt === held.startedAt)).toBe(true);
	expect(adopted.holding).toBe("paused");

	// omp runs for a user's action and ends the retry on its own: the record stops saying it waits.
	await emit(adopted, { type: "auto_retry_end", success: false, attempt: 2, finalError: "Retry cancelled" });
	expect(adopted.info.retry).toBeUndefined();
	await pollUntil(() => second.parked.list().every((r) => r.retry === undefined), "the record to drop the wait");
	expect(second.parked.list()).toHaveLength(1);
});
