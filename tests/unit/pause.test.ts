import { afterEach, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Live, LivePool } from "../../server/live.ts";
import { processTree } from "../../server/omp/process-tree.ts";
import { errorInfoOf } from "../../shared/error-info.ts";
import { type FakeOmpOptions, fakeConfig, writeFakeOmp } from "../support/fake-omp.ts";
import { pollUntil } from "../support/poll.ts";

/**
 * Pause freezes omp and everything under it with SIGSTOP. A process that vanishes mid-pause, or a
 * failing `ps`, must never leave omp frozen with nothing to resume it (a scripted fake omp that has
 * one child process, like a running tool).
 */

const dirs: string[] = [];
const pools: LivePool[] = [];
/** Puts the real `ps` back (see `slowPs`). */
let restorePath: (() => void) | null = null;

afterEach(async () => {
	restorePath?.();
	restorePath = null;
	for (const pool of pools.splice(0)) {
		// A process left frozen would never read the closed stdin.
		for (const l of pool.list()) if (l.pid !== null) Bun.spawnSync(["kill", "-CONT", String(l.pid)]);
		await pool.shutdown();
	}
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function openFake(options: FakeOmpOptions = {}): Promise<Live> {
	const dir = mkdtempSync(join(tmpdir(), "ompw-pause-"));
	dirs.push(dir);
	const pool = new LivePool(fakeConfig(dir, writeFakeOmp(dir, { tool: true, ...options })));
	pools.push(pool);
	return pool.open({ kind: "new", cwd: dir }, async () => null);
}

/** Every process under omp, omp itself first. */
const tree = (live: Live): Promise<number[]> => processTree(live.info.pid as number);
/** Whether every one of `pids` is stopped. */
const frozen = (pids: number[]): boolean => pids.every((p) => stat(p).startsWith("T"));

/** `ps` STAT of a process; "T" = stopped. */
function stat(pid: number): string {
	return Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
		.stdout.toString()
		.trim();
}

test("a child that exits between the process listing and SIGSTOP does not leave omp frozen", async () => {
	const live = await openFake();
	const pid = live.info.pid as number;
	const tool = (await processTree(pid)).find((p) => p !== pid) as number;
	expect(tool).toBeGreaterThan(0);

	// The listing still shows the child, but it is gone when the signal arrives.
	const realKill = process.kill;
	const kill = spyOn(process, "kill").mockImplementation(((target: number, signal?: string | number) => {
		if (target === tool && signal === "SIGSTOP") throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
		return realKill.call(process, target, signal);
	}) as typeof process.kill);
	try {
		await live.pause();
	} finally {
		kill.mockRestore();
	}

	// omp is stopped, and the pause is recorded, so resume() can unfreeze it.
	expect(live.info.pausedAt).not.toBeNull();
	expect(stat(pid)).toStartWith("T");
	await live.resume();
	expect(live.info.pausedAt).toBeNull();
	expect(stat(pid)).not.toStartWith("T");
	expect((await live.rpc({ type: "get_state" })).success).toBe(true);
});

test("when the process tree cannot be listed, pause fails and omp keeps running", async () => {
	const live = await openFake();
	const pid = live.info.pid as number;

	// No `ps` to run: the system cannot list the processes.
	const empty = mkdtempSync(join(tmpdir(), "ompw-pause-"));
	dirs.push(empty);
	const path = process.env.PATH;
	process.env.PATH = empty;
	try {
		await expect(live.pause()).rejects.toThrow();
	} finally {
		process.env.PATH = path;
	}

	expect(live.info.pausedAt).toBeNull();
	expect(stat(pid).startsWith("T")).toBe(false);
	expect((await live.rpc({ type: "get_state" })).success).toBe(true);
});

/**
 * Put a `ps` in front of the real one that is slow and can be held up, as one is when the machine is busy (a build, a
 * test run). Listing every process (`-A`) takes 0.3 s while the file `slow` is in `dir`. The listing whose number (counted
 * from now) is in the file `hold` waits for the file `release` and then 0.3 s more: the time a caller that does not
 * wait for it has to act in. Listing one process is as fast as ever.
 */
function slowPs(dir: string): { slow: string; hold: string; release: string } {
	const bin = join(dir, "bin");
	mkdirSync(bin);
	const files = { slow: join(dir, "slow"), hold: join(dir, "hold"), release: join(dir, "release") };
	const count = join(dir, "listings");
	writeFileSync(
		join(bin, "ps"),
		`#!/bin/sh
case "$*" in *-A*)
  n=$(( $(cat ${count} 2>/dev/null || echo 0) + 1 )); echo $n > ${count}
  [ -e ${files.slow} ] && /bin/sleep 0.3
  [ "$n" = "$(cat ${files.hold} 2>/dev/null)" ] && { while [ ! -e ${files.release} ]; do /bin/sleep 0.02; done; /bin/sleep 0.3; }
esac
exec /bin/ps "$@"
`,
	);
	chmodSync(join(bin, "ps"), 0o755);
	const path = process.env.PATH;
	process.env.PATH = `${bin}:${path}`;
	restorePath = () => {
		process.env.PATH = path;
	};
	return files;
}

/** How many times a timer fires while `job` runs: a server that stands still for it fires none until it is over. */
async function ticksDuring(job: () => Promise<unknown>): Promise<number> {
	let ticks = 0;
	const timer = setInterval(() => ticks++, 10);
	try {
		await job();
	} finally {
		clearInterval(timer);
	}
	return ticks;
}

// What omp has started is listed from the system, which takes 30 ms idle and over 100 ms on a busy machine: time every
// conversation's streaming and every tab wait for if the server stands still for it (#355).

test("pausing, an action on a paused conversation and resuming list the processes without stopping the server: its timers keep running", async () => {
	const live = await openFake();
	const dir = mkdtempSync(join(tmpdir(), "ompw-slowps-"));
	dirs.push(dir);
	writeFileSync(slowPs(dir).slow, "");

	expect(await ticksDuring(() => live.pause())).toBeGreaterThan(5);
	expect(live.info.pausedAt).not.toBeNull();
	// The thaw, and the freeze after it, each list the processes.
	expect(
		await ticksDuring(() => live.rpc({ type: "set_thinking_level", level: "low" }, { user: true })),
	).toBeGreaterThan(10);
	expect(await ticksDuring(() => live.resume())).toBeGreaterThan(5);
	expect(live.info.pausedAt).toBeNull();
});

test("a Pause and a Resume asked for one right behind the other happen in that order: omp ends up running, with nothing frozen", async () => {
	const live = await openFake();
	const pids = await tree(live);

	const paused = live.pause();
	const resumed = live.resume();
	await Promise.all([paused, resumed]);

	expect(live.info.pausedAt).toBeNull();
	expect(pids.some((p) => stat(p).startsWith("T"))).toBe(false);
	expect(pools.at(-1)?.parked.list()).toEqual([]);
	expect((await live.rpc({ type: "get_state" })).success).toBe(true);
});

// The page sends a Resume and then the Stop or the prompt that goes with it without waiting for the answer, and the other
// way round for a Pause: what comes behind one finds the conversation as that left it.

test("a command sent right behind a Resume finds the conversation running, and one behind a Pause finds it paused", async () => {
	const live = await openFake();
	await live.pause();

	const resumed = live.resume();
	// Neither waits for the Resume, as the page's do not; a conversation still paused would refuse both.
	const [running] = await Promise.all([live.rpc({ type: "get_state" }), live.command("/tools")]);
	await resumed;
	expect(running.success).toBe(true);

	const paused = live.pause();
	expect(await live.rpc({ type: "get_state" })).toMatchObject({ success: false, code: "paused" });
	await paused;
});

test("a Resume that arrives while the processes are listed to freeze omp again wins: no tool is stopped under the omp that runs", async () => {
	const live = await openFake();
	const pid = live.info.pid as number;
	const pids = await tree(live);
	await live.pause();
	const dir = mkdtempSync(join(tmpdir(), "ompw-slowps-"));
	dirs.push(dir);
	const ps = slowPs(dir);
	// The thaw of the action below lists the processes (1st), the freeze after it does again (2nd): that one is held.
	writeFileSync(ps.hold, "2");

	const action = live.rpc({ type: "set_thinking_level", level: "low" }, { user: true });
	await thawed(live);
	// The answer is in, omp is stopped again, and the system has not yet said what runs under it.
	await pollUntil(() => stat(pid).startsWith("T"), "omp to be stopped again");
	const resumed = live.resume();
	// A Resume that does not wait for the freeze lists the processes (the 3rd listing is as fast as ever) and is done
	// long before the held listing is.
	writeFileSync(ps.release, "");
	await Promise.all([action, resumed]);

	expect(live.info.pausedAt).toBeNull();
	expect(pids.some((p) => stat(p).startsWith("T"))).toBe(false);
	expect((await live.rpc({ type: "get_state" })).success).toBe(true);
});

// A user's action on a paused conversation (a click on a picker, a goal button, Compact…) briefly runs omp, then
// freezes it again: the conversation stays paused, as far as the user and the process tree can tell.

/** Wait until omp runs again: an action's thaw has begun. */
const thawed = (live: Live) =>
	pollUntil(() => !stat(live.info.pid as number).startsWith("T"), "omp to run for the user's action");

test("a user's action on a paused conversation is answered; omp and its tool are frozen again, still paused", async () => {
	const live = await openFake();
	const pids = await tree(live);
	await live.pause();
	const pausedAt = live.info.pausedAt;

	const reply = await live.rpc({ type: "set_thinking_level", level: "low" }, { user: true });

	expect(reply.success).toBe(true);
	expect(live.info.pausedAt).toBe(pausedAt);
	expect(pids.length).toBeGreaterThan(1);
	expect(frozen(pids)).toBe(true);
});

test("a background read is still refused while paused, and never runs omp", async () => {
	const live = await openFake();
	await live.pause();
	const signals: (string | number | undefined)[] = [];
	const realKill = process.kill;
	const kill = spyOn(process, "kill").mockImplementation(((target: number, signal?: string | number) => {
		signals.push(signal);
		return realKill.call(process, target, signal);
	}) as typeof process.kill);
	try {
		for (const type of ["get_state", "get_entries", "get_session_stats", "get_btw_history"])
			expect(await live.rpc({ type })).toMatchObject({ success: false, code: "paused" });
	} finally {
		kill.mockRestore();
	}
	expect(signals).toEqual([]);
	expect(frozen(await tree(live))).toBe(true);
});

test("while a user's action has omp running, what the page asks in reply (a state refresh) is answered too", async () => {
	const live = await openFake({ delay: { compact: 400 } });
	await live.pause();
	const compacting = live.rpc({ type: "compact" }, { user: true });
	await thawed(live);

	expect((await live.rpc({ type: "get_state" })).success).toBe(true);

	expect((await compacting).success).toBe(true);
	expect(await live.rpc({ type: "get_state" })).toMatchObject({ success: false, code: "paused" });
	expect(frozen(await tree(live))).toBe(true);
});

test("two actions at once share one thaw: omp is frozen again when the last one is answered", async () => {
	const live = await openFake({ delay: { compact: 400 } });
	const pids = await tree(live);
	await live.pause();
	const slow = live.rpc({ type: "compact" }, { user: true });
	await thawed(live);

	expect((await live.rpc({ type: "set_fast_mode", enabled: true }, { user: true })).success).toBe(true);
	// The compaction is still running: the quick action did not freeze it.
	expect(pids.some((p) => stat(p).startsWith("T"))).toBe(false);

	expect((await slow).success).toBe(true);
	expect(frozen(pids)).toBe(true);
	expect(live.info.pausedAt).not.toBeNull();
});

test("a tool omp started while it ran is frozen again with the rest", async () => {
	const live = await openFake({ spawnOn: "set_model" });
	const before = await tree(live);
	await live.pause();

	await live.rpc({ type: "set_model", provider: "p", modelId: "m" }, { user: true });

	const after = await tree(live);
	expect(after.length).toBe(before.length + 1);
	expect(frozen(after)).toBe(true);
});

test("a Resume that arrives while an action runs wins: omp is not frozen again", async () => {
	const live = await openFake({ delay: { compact: 400 } });
	const pids = await tree(live);
	await live.pause();
	const compacting = live.rpc({ type: "compact" }, { user: true });
	await thawed(live);

	await live.resume();
	expect(live.info.pausedAt).toBeNull();
	expect((await compacting).success).toBe(true);

	expect(live.info.pausedAt).toBeNull();
	expect(pids.some((p) => stat(p).startsWith("T"))).toBe(false);
});

test("omp ending while an action runs leaves nothing frozen, and the action fails with the exit", async () => {
	const live = await openFake({ delay: { compact: 600 } });
	await live.pause();
	const compacting = live.rpc({ type: "compact" }, { user: true });
	compacting.catch(() => {});
	await thawed(live);

	live.client.kill("SIGKILL");

	await expect(compacting).rejects.toThrow(/exited/);
	expect(live.info.pausedAt).toBeNull();
});

test("a builtin command the server runs for the user works on a paused conversation; without the user, it does not", async () => {
	const live = await openFake();
	const pids = await tree(live);
	await live.pause();

	await expect(live.command("/tools")).rejects.toThrow(/paused/);
	expect(frozen(pids)).toBe(true);

	await live.command("/tools", { user: true });
	expect(live.info.pausedAt).not.toBeNull();
	expect(frozen(pids)).toBe(true);
});

// omp starts the retried turn the moment its backoff timer is due, which is as soon as omp runs, and nothing stops that:
// a user's action that thaws a conversation paused in a backoff whose end is here would make the provider request.

const backoff = (delayMs: number) => ({
	type: "auto_retry_start",
	attempt: 1,
	maxAttempts: 3,
	delayMs,
	errorMessage: "429",
});
const emit = (live: Live, ...frames: Record<string, unknown>[]) => live.rpc({ type: "emit_frames", frames });

test("an action on a conversation paused in a retry wait whose end is here is refused, and never runs omp; Resume is what runs it", async () => {
	const live = await openFake();
	const pids = await tree(live);
	await emit(live, backoff(1000));
	await live.pause();
	const signals: (string | number | undefined)[] = [];
	const realKill = process.kill;
	const kill = spyOn(process, "kill").mockImplementation(((target: number, signal?: string | number) => {
		signals.push(signal);
		return realKill.call(process, target, signal);
	}) as typeof process.kill);
	try {
		const reply = await live.rpc({ type: "set_thinking_level", level: "low" }, { user: true });
		// A code the page words in its own language (中文 included), besides the English sentence.
		expect(reply).toMatchObject({ success: false, code: "pausedRetryDue" });
		expect(reply.error).toContain("Resume it");
		// The same for what the server runs for a click (a builtin command, the sidebar's rename).
		await expect(live.command("/tools", { user: true })).rejects.toThrow(/wait is over/);
		await expect(live.whileRunning(async () => "renamed")).rejects.toThrow(/Resume it/);
		expect(errorInfoOf(await live.whileRunning(async () => "renamed").catch((e) => e))).toEqual({
			code: "pausedRetryDue",
			params: {},
		});
	} finally {
		kill.mockRestore();
	}
	expect(signals).toEqual([]);
	expect(frozen(pids)).toBe(true);
	expect(live.info.pausedAt).not.toBeNull();
	expect(live.info.retry).toMatchObject({ resumed: false });

	await live.resume();
	expect(stat(live.info.pid as number)).not.toStartWith("T");
	expect((await live.rpc({ type: "get_state" })).success).toBe(true);
});

test("a retry wait that is far from over does not stop an action: omp runs for it and is frozen again, still waiting", async () => {
	const live = await openFake();
	const pids = await tree(live);
	await emit(live, backoff(3_600_000));
	await live.pause();

	expect((await live.rpc({ type: "set_thinking_level", level: "low" }, { user: true })).success).toBe(true);
	await live.command("/tools", { user: true });
	expect(await live.whileRunning(async () => "renamed")).toBe("renamed");
	expect(frozen(pids)).toBe(true);
	expect(live.info.retry).toMatchObject({ delayMs: 3_600_000, resumed: false });

	// Not even half a minute off is close enough to matter: an action takes seconds at most.
	const near = await openFake();
	await emit(near, backoff(30_000));
	await near.pause();
	expect((await near.rpc({ type: "set_thinking_level", level: "low" }, { user: true })).success).toBe(true);
});

test("a retry whose turn is already running holds nothing back: there is no wait left for the thaw to end", async () => {
	const live = await openFake();
	await emit(live, backoff(1000), { type: "agent_start" });
	expect(live.info.retry?.resumed).toBe(true);
	await live.pause();

	expect((await live.rpc({ type: "set_thinking_level", level: "low" }, { user: true })).success).toBe(true);
	expect(live.info.pausedAt).not.toBeNull();
});

test("a conversation that is being closed is not paused: nothing is frozen or recorded for it (#318)", async () => {
	// omp works (its prompt is never answered) and ignores a closed stdin meanwhile, so it is still there once closed.
	const live = await openFake({ hold: ["prompt"], ignoreClose: true });
	const pid = live.info.pid as number;
	void live.rpc({ type: "prompt", message: "go" }).catch(() => {});
	await pollUntil(() => live.busy, "omp to be working");
	live.client.close();
	expect(live.client.closing).toBe(true);

	await expect(live.pause()).rejects.toThrow("This conversation is not running");
	expect(live.info.pausedAt).toBeNull();
	expect(stat(pid).startsWith("T")).toBe(false);
	// Nothing was written down for a later server to find.
	expect(pools.at(-1)?.parked.list()).toEqual([]);
});
