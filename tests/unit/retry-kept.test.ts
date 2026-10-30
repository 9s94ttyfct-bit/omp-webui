import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Live, LivePool } from "../../server/live.ts";
import type { LiveInfo, LiveRetry } from "../../shared/protocol.ts";
import { USAGE_LIMIT_FLAG } from "../../shared/retry.ts";
import { fakeConfig, writeFakeOmp } from "../support/fake-omp.ts";
import { pollUntil, processExists } from "../support/poll.ts";

/**
 * A conversation whose omp sleeps through a provider's usage limit outlives the server: the timer that retries the turn
 * is omp's, so omp has to be there at the reset. It is held behind its relay, written down when the wait begins (a
 * server that crashes leaves the record too), taken over running by the next server, and let go when the wait is over.
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

const wait = (errorId: number) => ({
	type: "auto_retry_start",
	attempt: 1,
	maxAttempts: 10,
	delayMs: 3_600_000,
	errorMessage: "You have reached your usage limit.",
	errorId,
});
const usageLimitWait = wait(USAGE_LIMIT_FLAG);

const emit = (live: Live, ...frames: Record<string, unknown>[]) =>
	live.rpc({ type: "emit_frames", frames }, { user: live.info.pausedAt !== null });

/** A pool whose omp reports a turn in progress, as the real one does for the whole backoff. */
async function start(options: { streaming: boolean } = { streaming: true }) {
	const dir = mkdtempSync(join(tmpdir(), "ompw-retry-kept-"));
	dirs.push(dir);
	const bin = writeFakeOmp(dir, options);
	const cwd = join(dir, "work");
	mkdirSync(cwd);
	const pool = () => {
		const made = new LivePool(fakeConfig(dir, bin));
		pools.push(made);
		return made;
	};
	const first = pool();
	const live = await first.open({ kind: "new", cwd }, async () => null);
	return { first, live, next: pool };
}

/** Whether a process is stopped (SIGSTOP: a paused conversation's omp). */
const stopped = (pid: number | null): boolean =>
	Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
		.stdout.toString()
		.trim()
		.startsWith("T");

test("a usage-limit wait is written down when it begins, adopted running by the next server, and let go when omp starts the retried turn", async () => {
	const { first, live, next } = await start();
	await emit(live, { type: "agent_start" }, usageLimitWait);
	const held: LiveRetry = { ...(live.info.retry as LiveRetry) };
	expect(held).toMatchObject({ attempt: 1, delayMs: 3_600_000, usageLimit: true, resumed: false });

	// Written down when it begins, as a conversation that is not paused: whichever server comes next can take it, a
	// crash included.
	await pollUntil(() => first.parked.list().length === 1, "the wait to be written down");
	expect(live.kept).toBe(true);
	expect(first.parked.list().map((r) => ({ pausedAt: r.pausedAt, retry: r.retry, owner: r.owner !== null }))).toEqual([
		{ pausedAt: null, retry: held, owner: true },
	]);

	// The server goes, the conversation stays: omp is not frozen, its timer is the point.
	expect(await first.parkKept()).toBe(1);
	const second = next();
	const announced: LiveInfo[] = [];
	second.onAnnounce((info) => announced.push(info));
	expect(await second.adopt()).toBe(1);

	const adopted = second.get(live.info.liveId) as Live;
	expect(adopted.info.pausedAt).toBeNull();
	expect(stopped(adopted.info.pid)).toBe(false);
	// The wait is the one omp announced, the tabs are told of it, and the conversation counts as working: not reaped, not closed for.
	expect(adopted.info.retry).toEqual(held);
	expect(announced.some((i) => i.liveId === adopted.info.liveId && i.retry?.startedAt === held.startedAt)).toBe(true);
	expect(adopted.holding).toBe("working");
	expect(adopted.kept).toBe(true);
	// Nothing is refused to a conversation that runs: no "paused", whatever the page asks.
	expect((await adopted.rpc({ type: "get_state" })).success).toBe(true);

	// omp's own timer fired while this server ran: the wait is over, and there is nothing to keep it for.
	await emit(adopted, { type: "agent_start" });
	expect(adopted.info.retry?.resumed).toBe(true);
	expect(adopted.kept).toBe(false);
	await pollUntil(() => second.parked.list().length === 0, "the record to go with the wait");
});

test("a wait that ended while no server was there is not shown by the one that takes the conversation over", async () => {
	// omp reports a turn in progress for the whole backoff; this one reports none, as one whose retry is over.
	const { first, live, next } = await start({ streaming: false });
	await emit(live, { type: "agent_start" }, usageLimitWait);
	expect(live.info.retry).toBeDefined();
	await pollUntil(() => first.parked.list().length === 1, "the wait to be written down");
	expect(await first.parkKept()).toBe(1);

	const second = next();
	expect(await second.adopt()).toBe(1);
	const adopted = second.get(live.info.liveId) as Live;
	expect(adopted.info.retry).toBeUndefined();
	expect(adopted.holding).toBeNull();
	// Nothing is left to keep: the process is let go, and the next server finds no record.
	expect(adopted.kept).toBe(false);
	await pollUntil(() => second.parked.list().length === 0, "the record to go");
});

test("a backoff that is not a usage limit is not kept: it is minutes at most, and ends with the server like any turn", async () => {
	const { first, live } = await start();
	await emit(live, { type: "agent_start" }, wait(0));
	expect(live.info.retry).toMatchObject({ usageLimit: false, resumed: false });
	expect(live.kept).toBe(false);
	expect(first.parked.list()).toEqual([]);
	expect(await first.parkKept()).toBe(0);
});

test("pausing a waiting conversation and resuming it keeps the wait; closing it lets the process go", async () => {
	const { first, live } = await start();
	await emit(live, { type: "agent_start" }, usageLimitWait);
	await pollUntil(() => first.parked.list().length === 1, "the wait to be written down");
	expect(first.parked.list().map((r) => r.pausedAt)).toEqual([null]);

	await live.pause();
	expect(first.parked.list().map((r) => r.pausedAt !== null)).toEqual([true]);

	// The pause is over, the wait is not: the record stays, and says so.
	await live.resume();
	expect(live.kept).toBe(true);
	expect(first.parked.list().map((r) => r.pausedAt)).toEqual([null]);

	await live.end();
	expect(live.kept).toBe(false);
	expect(first.parked.list()).toEqual([]);
});

test("closing a conversation paused in a usage-limit wait ends its omp frozen: it is never let run, so a wait that is over cannot start the retried turn", async () => {
	const { first, live } = await start();
	await emit(live, { type: "agent_start" }, usageLimitWait);
	await pollUntil(() => first.parked.list().length === 1, "the wait to be written down");
	await live.pause();
	const pid = live.info.pid as number;
	expect(stopped(pid)).toBe(true);
	// omp's sleep runs on while it is frozen: whatever lets it run (a SIGCONT, then a closed stdin and a SIGTERM it has
	// yet to handle) lets the retried turn start first. What the server sends it is what says it never ran.
	const sent: (string | number | undefined)[] = [];
	const kill = process.kill;
	process.kill = ((target: number, signal?: string | number) => {
		if (Math.abs(target) === pid) sent.push(signal);
		return kill.call(process, target, signal);
	}) as typeof process.kill;
	try {
		await live.end();
		await pollUntil(() => live.info.exited, "the paused omp to end");
	} finally {
		process.kill = kill;
	}
	expect(sent).not.toContain("SIGCONT");
	expect(sent).toContain("SIGKILL");
	expect(processExists(pid)).toBe(false);
	expect(first.parked.list()).toEqual([]);
});

test("ending what outlives the server stops a waiting conversation's omp: it would sleep through the limit and retry for nobody", async () => {
	const { first, live } = await start();
	await emit(live, { type: "agent_start" }, usageLimitWait);
	await pollUntil(() => first.parked.list().length === 1, "the wait to be written down");
	const pid = live.info.pid as number;
	expect(await first.endKept()).toBe(1);
	await pollUntil(() => live.info.exited, "the waiting omp to end");
	expect(Bun.spawnSync(["kill", "-0", String(pid)]).exitCode).not.toBe(0);
	expect(first.parked.list()).toEqual([]);
});
