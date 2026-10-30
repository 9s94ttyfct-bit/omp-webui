import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Live, LivePool, surplus } from "../../server/live.ts";
import { type FakeOmpOptions, fakeConfig, writeFakeOmp } from "../support/fake-omp.ts";

/**
 * omp's own retry backoff (`auto_retry_start` to `auto_retry_end`, which includes waiting for a usage reset) happens
 * between turns, yet the conversation still has a retry to come: it is busy, so the idle reaper leaves it alone.
 * A scripted omp sends the frames; time is moved by handing the reaper a later "now".
 */

const dirs: string[] = [];
const pools: LivePool[] = [];

afterEach(async () => {
	for (const pool of pools.splice(0)) await pool.shutdown();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function conversation(options: FakeOmpOptions = {}): Promise<Live> {
	const dir = mkdtempSync(join(tmpdir(), "ompw-retrybusy-"));
	dirs.push(dir);
	const pool = new LivePool(fakeConfig(dir, writeFakeOmp(dir, options)));
	pools.push(pool);
	const cwd = join(dir, "work");
	mkdirSync(cwd);
	return pool.open({ kind: "new", cwd }, async () => null);
}

const frames = (live: Live, ...list: Record<string, unknown>[]) => live.rpc({ type: "emit_frames", frames: list });
const retryStart = { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 60_000, errorMessage: "429" };

/** Whether the pool would close this unwatched process once `later` ms have passed since it last did anything. */
const reapableAfter = (live: Live, later: number) => surplus([live], live.lastActivity + later).includes(live);
const HOUR = 3_600_000;

test("between auto_retry_start and auto_retry_end the conversation is busy: not reaped however long, not pristine", async () => {
	const live = await conversation();
	expect(live.busy).toBe(false);
	expect(live.pristine).toBe(true);
	expect(reapableAfter(live, HOUR)).toBe(true);

	// omp reports no `session_settled` while it waits to retry (see tests/unit/retry-lost.test.ts for when it does).
	await frames(live, { type: "agent_start" }, { type: "agent_end", messages: [] }, retryStart);
	expect(live.info.streaming).toBe(false);
	expect(live.busy).toBe(true);
	expect(live.pristine).toBe(false);
	expect(reapableAfter(live, HOUR)).toBe(false);
	expect(reapableAfter(live, 24 * HOUR)).toBe(false);

	await frames(live, { type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" });
	expect(live.busy).toBe(false);
	expect(reapableAfter(live, HOUR)).toBe(true);
});

test("the wait is resumed when omp starts the retried turn, announced to the tabs; a turn omp reports in progress meanwhile is not that", async () => {
	// omp says a turn is in progress for the whole backoff (`get_state` `isStreaming`).
	const live = await conversation({ streaming: true });
	const announced: (boolean | undefined)[] = [];
	// What the pages are told of the wait, each time it changes (a turn that starts or ends is announced too, and is no news of it).
	let last: boolean | undefined;
	pools[0].onAnnounce((info) => {
		if (info.liveId !== live.info.liveId || info.retry?.resumed === last) return;
		last = info.retry?.resumed;
		announced.push(last);
	});
	await frames(live, { type: "agent_start" }, { type: "agent_end", messages: [] }, retryStart);
	await live.refreshState();
	expect(live.info.streaming).toBe(true);
	expect(live.info.retry).toMatchObject({ attempt: 1, delayMs: 60_000, resumed: false });

	// The backoff is over and omp runs the retried turn.
	await frames(live, { type: "agent_start" });
	expect(live.info.retry?.resumed).toBe(true);
	// The turn's own end is not the retry's: the wait stays until omp says it is over.
	await frames(live, { type: "agent_end", messages: [] });
	expect(live.info.retry?.resumed).toBe(true);
	expect(announced).toEqual([false, true]);

	await frames(live, { type: "auto_retry_end", success: true, attempt: 1 });
	expect(live.info.retry).toBeUndefined();
	expect(announced.at(-1)).toBeUndefined();

	// A turn that starts with no backoff pending marks nothing.
	await frames(live, { type: "agent_start" });
	expect(live.info.retry).toBeUndefined();
});

test("a retry that succeeds ends the backoff too", async () => {
	const live = await conversation();
	await frames(live, retryStart);
	expect(live.busy).toBe(true);
	await frames(live, { type: "auto_retry_end", success: true, attempt: 1 });
	expect(live.busy).toBe(false);
});

test("a process that exits during the backoff is not busy afterwards", async () => {
	const live = await conversation();
	await frames(live, retryStart);
	expect(live.busy).toBe(true);
	const gone = new Promise<void>((resolve) => {
		pools[0].onAnnounce((info) => {
			if (info.liveId === live.info.liveId && info.exited) resolve();
		});
	});
	live.client.close();
	await gone;
	expect(live.info.exited).toBe(true);
	expect(live.busy).toBe(false);
});
