import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LivePool } from "../../server/live.ts";
import { processTree } from "../../server/omp/process-tree.ts";
import type { Resumed } from "../../server/omp/resumed.ts";
import { type FakeOmpOptions, fakeConfig, writeFakeOmp } from "../support/fake-omp.ts";

/** How the pool opens a session file: one omp process per file, however many opens ask for it. */

const dirs: string[] = [];
const pools: LivePool[] = [];
/** Tool processes a failing test may leave behind. */
const strays: number[] = [];

afterEach(async () => {
	for (const pid of strays.splice(0)) Bun.spawnSync(["kill", "-KILL", String(pid)], { stderr: "ignore" });
	for (const pool of pools.splice(0)) await pool.shutdown();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/**
 * A pool of fake omp processes and functions opening a session file, or a new chat, in it. `finishMs`: how long the pool
 * waits for a closed omp to end before it refuses to open its file again.
 */
function setup(options: FakeOmpOptions, finishMs?: number) {
	const dir = mkdtempSync(join(tmpdir(), "ompw-pool-"));
	dirs.push(dir);
	const pool = new LivePool(fakeConfig(dir, writeFakeOmp(dir, options)), null, null, null, finishMs);
	pools.push(pool);
	const sessionFile = join(dir, "session.jsonl");
	writeFileSync(sessionFile, "");
	const resume = (model?: string) => pool.open({ kind: "resume", sessionFile, model }, async () => dir);
	const newChat = (cwd = dir, args?: string[]) => pool.open({ kind: "new", cwd, args }, async () => null);
	return { pool, dir, resume, newChat, sessionFile };
}

/** One event-loop turn (no wall-clock wait). */
async function turn(): Promise<void> {
	const next = Promise.withResolvers<void>();
	setImmediate(next.resolve);
	await next.promise;
}

async function until(condition: () => boolean): Promise<void> {
	while (!condition()) await turn();
}

/** Whether a process exists (a zombie counts until its parent collects it). */
const exists = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

/**
 * Wait for a process to be gone; false when it is still there after `ms`. A tool omp started is a
 * grandchild of this process: its exit is not an event we can await, so the process table is polled.
 */
async function vanished(pid: number, ms = 15_000): Promise<boolean> {
	const deadline = Date.now() + ms;
	while (exists(pid)) {
		if (Date.now() > deadline) return false;
		await Bun.sleep(20);
	}
	return true;
}

test("a resume still starting is bound to its file, and a second open of it joins instead of spawning", async () => {
	// `get_state` is never answered: the process stays "starting", not yet knowing its session file.
	const { pool, resume, sessionFile } = setup({ holdState: true });

	const first = resume();
	await until(() => pool.list().length > 0);
	expect(pool.list().map((l) => l.sessionFile)).toEqual([realpathSync(sessionFile)]);

	// Another tab, or a double click, opens the same file meanwhile.
	const second = resume();
	const both = Promise.allSettled([first, second]);
	for (let i = 0; i < 3; i++) await turn();
	expect(pool.list().length).toBe(1);

	// Closing the pool ends the one process; both opens fail with its exit.
	await pool.shutdown();
	const results = await both;
	expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
	expect(String((results[1] as PromiseRejectedResult).reason)).toBe(
		String((results[0] as PromiseRejectedResult).reason),
	);
});

test("a failed resume is not remembered: the next open of the file starts afresh", async () => {
	const { pool, resume } = setup({ failWhenArgs: ["bad/model"] });

	const failed = await Promise.allSettled([resume("bad/model"), resume("bad/model")]);
	expect(failed.map((r) => r.status)).toEqual(["rejected", "rejected"]);
	expect(String((failed[0] as PromiseRejectedResult).reason)).toContain("Could not restore model bad/model");
	expect(pool.list()).toEqual([]);

	const live = await resume();
	expect(live.info.exited).toBe(false);
	expect(pool.list().length).toBe(1);
	// Once started, further opens return the same process.
	expect(await resume()).toBe(live);
});

test("an omp killed by a signal tells every page which signal, and no made-up exit code", async () => {
	const { newChat } = setup({});
	const live = await newChat();
	const sent: Record<string, unknown>[] = [];
	live.subscribers.add({ send: (msg) => sent.push(msg as Record<string, unknown>) });
	process.kill(live.info.pid as number, "SIGKILL");
	await until(() => sent.some((m) => m.t === "live_exit"));
	expect(sent.find((m) => m.t === "live_exit")).toEqual({
		t: "live_exit",
		liveId: live.info.liveId,
		code: null,
		signal: "SIGKILL",
		stderr: "",
		by: "omp",
	});
});

// ------------------------------------------------------------------ new chats

test("a new chat takes over a process nobody watches or has used, instead of starting another", async () => {
	const { pool, newChat } = setup({});
	const first = await newChat();
	// Reloading the page five times in a row: each load opens a new chat again.
	for (let reload = 0; reload < 4; reload++) expect(await newChat()).toBe(first);
	expect(pool.list().map((l) => l.liveId)).toEqual([first.info.liveId]);
});

test("looking at a process does not use it up, so a reloaded page still finds it", async () => {
	const { pool, newChat } = setup({});
	const first = await newChat();
	// What a New chat page asks omp while it waits.
	for (const command of [
		{ type: "get_state" },
		{ type: "get_entries" },
		{ type: "get_available_commands" },
		{ type: "get_available_models" },
		{ type: "goal", op: "get" },
		{ type: "predict_word", text: "hel", cursor: 3 },
	])
		await first.rpc(command);
	expect(await newChat()).toBe(first);
	expect(pool.list().length).toBe(1);
});

test("a process that was used is never handed to a new chat", async () => {
	const { newChat } = setup({});
	const prompted = await newChat();
	await prompted.rpc({ type: "prompt", message: "hello" });
	const next = await newChat();
	expect(next).not.toBe(prompted);

	// Anything but a plain look counts as use: a command, a settings change, a goal.
	for (const command of [{ type: "bash", command: "true" }, { type: "set_model" }, { type: "goal", op: "create" }]) {
		const used = await newChat();
		await used.rpc(command);
		expect(await newChat()).not.toBe(used);
	}
	// (No count: the pool itself closes idle processes beyond its spare allowance.)
});

test("a process somebody watches, or that is not the same folder and options, is left alone", async () => {
	const { pool, dir, newChat } = setup({});
	const first = await newChat();

	const watcher = { send() {} };
	first.subscribers.add(watcher);
	const second = await newChat();
	expect(second).not.toBe(first);
	first.subscribers.delete(watcher);

	// Same process once nobody watches it; a different option or folder starts a new one.
	expect(await newChat()).toBe(second);
	const other = await newChat(dir, ["--no-session"]);
	expect(other).not.toBe(second);
	expect(other.info.args).toContain("--no-session");
	expect(await newChat(dir, ["--no-session"])).toBe(other);
	const elsewhere = await newChat(tmpdir());
	expect(elsewhere).not.toBe(second);
	expect(elsewhere.info.cwd).toBe(tmpdir());
	expect(pool.list().length).toBe(4);
});

test("a process that is still starting, closing or gone is not taken over", async () => {
	// Still starting: `get_state` is never answered, so two pages opening at once get a process each.
	const starting = setup({ holdState: true });
	const both = Promise.allSettled([starting.newChat(), starting.newChat()]);
	await until(() => starting.pool.list().length === 2);
	await starting.pool.shutdown();
	expect((await both).map((r) => r.status)).toEqual(["rejected", "rejected"]);

	const { newChat } = setup({});
	const closing = await newChat();
	closing.client.close();
	const afterClose = await newChat();
	expect(afterClose).not.toBe(closing);
	await closing.client.whenExited;
	expect(await newChat()).toBe(afterClose);
});

test("a conversation that was resumed is never taken over by a new chat, whatever its folder", async () => {
	const { pool, newChat, resume } = setup({});
	const resumed = await resume();
	const chat = await newChat(resumed.info.cwd);
	expect(chat).not.toBe(resumed);
	expect(pool.list().length).toBe(2);
});

// ------------------------------------------------------------------ busy

test("the process list says which processes are busy, and a finished command ends it", async () => {
	// `bash` is held: like omp running a `!command`, it replies only when the command ends.
	const { pool, newChat } = setup({ hold: ["bash"] });
	const live = await newChat();
	expect(pool.list().map((l) => l.busy)).toEqual([false]);

	const running = live.rpc({ type: "bash", command: "sleep 300" });
	running.catch(() => {});
	expect(pool.list().map((l) => l.busy)).toEqual([true]);

	await pool.shutdown(100, 100);
	await running.catch(() => {});
	expect(pool.list()).toEqual([]);
});

// ------------------------------------------------------------------ shutdown

test("shutdown stops a working process at once instead of waiting for a closed stdin it ignores", async () => {
	const { pool, newChat } = setup({ hold: ["bash"], ignoreClose: true });
	const live = await newChat();
	const pid = live.info.pid as number;
	live.rpc({ type: "bash", command: "sleep 300" }).catch(() => {});
	expect(live.busy).toBe(true);

	// A grace of a minute against a test that is given 20 s: how fast the process goes is not timed (that depends on
	// what else the machine is running), but a shutdown that waited for the grace would not end inside the test.
	await pool.shutdown(60_000);
	expect(await vanished(pid)).toBe(true);
}, 20_000);

test("shutdown gives an idle process the time to finish writing, then stops it", async () => {
	const { pool, newChat } = setup({ ignoreClose: true });
	const live = await newChat();
	const pid = live.info.pid as number;

	const started = performance.now();
	await pool.shutdown(400, 400);
	expect(performance.now() - started).toBeGreaterThanOrEqual(400);
	expect(await vanished(pid)).toBe(true);
});

test("shutdown kills a process that ignores both its closed stdin and SIGTERM, with everything it started", async () => {
	// The tool shares omp's process group: the group goes down with it.
	const { pool, newChat } = setup({ ignoreClose: true, ignoreTerm: true, tool: true });
	const live = await newChat();
	const pid = live.info.pid as number;
	const tool = (await processTree(pid)).find((p) => p !== pid) as number;
	expect(tool).toBeGreaterThan(0);
	strays.push(tool);

	await pool.shutdown(100, 100);
	expect(await vanished(pid)).toBe(true);
	expect(await vanished(tool)).toBe(true);
});

test("shutdown also kills a tool that runs in a session of its own, as omp's tools do", async () => {
	const { pool, newChat } = setup({ ignoreClose: true, ignoreTerm: true, tool: true, toolDetached: true });
	const live = await newChat();
	const pid = live.info.pid as number;
	const tool = (await processTree(pid)).find((p) => p !== pid) as number;
	expect(tool).toBeGreaterThan(0);
	strays.push(tool);

	await pool.shutdown(100, 100);
	expect(await vanished(pid)).toBe(true);
	expect(await vanished(tool)).toBe(true);
});

test("a pool that is shutting down opens nothing new", async () => {
	const { pool, newChat, resume } = setup({});
	const stopping = pool.shutdown();
	await expect(newChat()).rejects.toThrow(/shutting down/);
	await expect(resume()).rejects.toThrow(/shutting down/);
	await stopping;
	expect(pool.list()).toEqual([]);
});

// ------------------------------------------------------------------ one omp at a time on a session file

test("a conversation closed while its omp keeps running is refused, not opened again on a second omp (#354)", async () => {
	// omp ignores the closed stdin, as one that is working does until its turn is over.
	const { pool, resume } = setup({ ignoreClose: true }, 300);
	const first = await resume();
	await first.end();

	const started = performance.now();
	await expect(resume()).rejects.toThrow("still finishing");
	// It waited for the first omp before it refused, and never started another.
	expect(performance.now() - started).toBeGreaterThanOrEqual(250);
	expect(first.client.running).toBe(true);
	expect(pool.list().map((l) => l.liveId)).toEqual([first.info.liveId]);
});

test("a conversation closed while its omp is still writing is opened again once that omp has ended (#354)", async () => {
	const { resume } = setup({ slowClose: 400 }, 10_000);
	const first = await resume();
	const pid = first.info.pid as number;
	await first.end();

	const second = await resume();
	expect(second).not.toBe(first);
	expect(second.info.pid).not.toBe(pid);
	// Never two at once: the first was gone when the second was started.
	expect(first.client.running).toBe(false);
	expect(exists(pid)).toBe(false);
});

test("a terminal and a restart are refused while the closed omp has not ended (#354)", async () => {
	const { pool, resume, sessionFile } = setup({ ignoreClose: true }, 300);
	const live = await resume();
	await expect(pool.release({ by: "file", file: sessionFile })).rejects.toThrow("still finishing");
	expect(live.client.running).toBe(true);
	await expect(pool.endIfIdle(live)).rejects.toThrow("still finishing");
	expect(live.client.running).toBe(true);
});

test("release closes the conversations a terminal's omp could open: by file, by id prefix, by folder (#385)", async () => {
	const { pool, dir, resume, sessionFile } = setup({});
	const elsewhere = mkdtempSync(join(tmpdir(), "ompw-pool-elsewhere-"));
	dirs.push(elsewhere);
	const cases: [string, Resumed, boolean][] = [
		["another id", { by: "id", prefix: "other" }, false],
		["another folder", { by: "folder", cwd: elsewhere }, false],
		["another file", { by: "file", file: join(dir, "other.jsonl") }, false],
		// The fake names its session `fake`.
		["its id", { by: "id", prefix: "fa" }, true],
		["its folder", { by: "folder", cwd: dir }, true],
		["its file", { by: "file", file: sessionFile }, true],
	];
	for (const [what, resumed, closes] of cases) {
		const live = await resume();
		await pool.release(resumed);
		expect([what, live.client.running]).toEqual([what, !closes]);
	}
});

test("release closes nothing while one conversation a terminal could open is busy (#385)", async () => {
	const { pool, dir, newChat } = setup({ hold: ["bash"] });
	const idle = await newChat();
	// Used, so that the next new chat is a process of its own and not this one taken over.
	await idle.rpc({ type: "prompt", message: "hello" });
	const busy = await newChat();
	// Held for good: it ends with the pool, which fails it.
	busy.rpc({ type: "bash", command: "sleep 1" }).catch(() => {});
	await until(() => busy.busy);
	// Both are in the folder `--continue` runs in; one is working: the terminal waits, and the idle one is left alone.
	await expect(pool.release({ by: "folder", cwd: dir })).rejects.toThrow("This conversation is working");
	expect(idle.client.closing).toBe(false);
	expect(busy.client.closing).toBe(false);
});
