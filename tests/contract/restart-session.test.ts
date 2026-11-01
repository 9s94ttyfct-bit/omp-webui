import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Live, LivePool } from "../../server/live.ts";
import { sessionKey } from "../../server/omp/approval.ts";
import { RESTART_TIMINGS, RestartCoordinator } from "../../server/omp/restart/coordinator.ts";
import { RestartService } from "../../server/omp/restart/install.ts";
import { RestartStore } from "../../server/omp/restart/store.ts";
import { capabilities } from "../../server/platform/capabilities.ts";
import { platform } from "../../server/platform/index.ts";
import { isRecord } from "../../shared/guards.ts";
import { RESTART_TOOL } from "../../shared/restart.ts";
import { type FakeOmpOptions, fakeConfig, writeFakeOmp } from "../support/fake-omp.ts";
import { has } from "../support/needs.ts";
import { pollUntil } from "../support/poll.ts";

/**
 * `restart_session` (`shared/restart.ts`) against the server's own pool and a scripted omp: the agent's call becomes a
 * request, the restart is made when the main agent's turn ends (not when the conversation is idle), the process and
 * everything it started end — a thread that spins inside omp, a background job that keeps the session unsettled, a tool in
 * a session of its own that would otherwise be orphaned — and the conversation goes on in a new process that is sent the
 * agent's `continue_with` exactly once. A refusal is told to the agent instead; the limit holds across a server's restart;
 * and a server that stopped between two steps finishes the restart, sending the message once and not at all when omp has
 * it already. No model.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-restart-"));
const pools: LivePool[] = [];
/** Processes a failing test may leave behind. */
const strays = new Set<number>();

afterAll(async () => {
	for (const pool of pools.splice(0)) await pool.shutdown(200, 200);
	for (const pid of strays) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// gone, as it should be
		}
	}
	rmSync(root, { recursive: true, force: true });
});

/** Short steps: a scripted omp needs no time to end. */
const FAST = { ...RESTART_TIMINGS, abortMs: 500, closeMs: 300, termMs: 500, killMs: 3_000, reopenMs: [200] };

/** A server's pool on `dir` (a new one: the server that started again) with restarts, and a conversation's session file. */
function world(options: FakeOmpOptions = {}, dir = mkdtempSync(join(root, "w-"))) {
	const prompts = join(dir, "prompts.log");
	const bin = writeFakeOmp(dir, { prompts: { log: prompts, write: true }, ...options });
	const file = join(dir, "session.jsonl");
	if (!existsSync(file)) writeFileSync(file, `${JSON.stringify({ type: "session", cwd: dir })}\n`);
	const pool = new LivePool(fakeConfig(dir, bin), null, null, null, 2000);
	pools.push(pool);
	const coordinator = new RestartCoordinator(new RestartService(dir), pool);
	coordinator.timings = FAST;
	pool.restarts = coordinator;
	const open = async (): Promise<Live> => {
		const live = await pool.open({ kind: "resume", sessionFile: file }, async () => dir);
		if (live.info.pid !== null) strays.add(live.info.pid);
		return live;
	};
	return { dir, file, key: sessionKey(file), prompts, pool, coordinator, store: coordinator.service.store, open };
}

/** What reached omp as prompts, in order. */
const sent = (prompts: string): string[] =>
	existsSync(prompts)
		? readFileSync(prompts, "utf8")
				.split("\n")
				.filter(Boolean)
				.map((line) => {
					const entry: unknown = JSON.parse(line);
					return isRecord(entry) ? String(entry.message) : "";
				})
		: [];

/** A call of the tool, as omp reports it: its start (with the arguments) and its end. */
const call = (args: Record<string, unknown>, id = "c1", isError = false) => [
	{ type: "tool_execution_start", toolCallId: id, toolName: RESTART_TOOL, args },
	{
		type: "tool_execution_end",
		toolCallId: id,
		toolName: RESTART_TOOL,
		result: { content: [{ type: "text", text: "ok" }] },
		isError,
	},
];
const ARGS = {
	reason: "bash calls hang",
	continue_with: "Check whether the build finished, then go on with the notes.",
};

const emit = async (live: Live, frames: Record<string, unknown>[]) => {
	await live.rpc({ type: "emit_frames", frames });
};

/** The only request of the world. */
const only = (store: RestartStore) => {
	const all = store.list();
	expect(all).toHaveLength(1);
	return all[0] as NonNullable<(typeof all)[number]>;
};

describe("the agent's restart", () => {
	test.skipIf(!has.notWindowsYet)(
		"a wedged process is ended with all it started when the turn ends, and the conversation goes on in a new process told once",
		async () => {
			const w = world();
			const live = await w.open();
			const ompPid = live.info.pid as number;
			// A thread that spins inside omp, a tool in a session of its own and one in omp's group.
			const pidsFile = join(w.dir, "wedge.json");
			await live.rpc({ type: "wedge", file: pidsFile });
			await pollUntil(() => existsSync(pidsFile), "the wedge");
			const { children } = JSON.parse(readFileSync(pidsFile, "utf8")) as { children: number[] };
			for (const pid of children) strays.add(pid);
			const before = await platform.proc.identities([ompPid, ...children]);
			expect(before.size).toBe(3);
			// A background job keeps the session unsettled: the conversation is never idle, and the restart does not wait for that.
			await live.rpc({ type: "set_state", state: { hasPendingAsyncWork: true } });

			await emit(live, [{ type: "agent_start" }, ...call(ARGS)]);
			await pollUntil(() => live.info.restartPending !== undefined, "the request");
			const record = only(w.store);
			expect(record).toMatchObject({ by: "agent", state: "requested", reason: ARGS.reason, force: false });
			// Nothing happens before the turn ends: an absence, which no event announces, so it is looked at a moment later.
			await Bun.sleep(300);
			expect(live.info.exited).toBe(false);
			expect(w.store.get(record.id)?.state).toBe("requested");

			await emit(live, [{ type: "agent_end", messages: [] }]);
			await pollUntil(() => w.store.get(record.id)?.state === "delivered", "the restart", 30_000);

			// omp (and the thread inside it) and both tools are gone: none of the listed processes is still the one listed.
			const after = await platform.proc.identities([ompPid, ...children]);
			for (const [pid, identity] of before) expect(after.get(pid)).not.toBe(identity);
			expect(live.info.exited).toBe(true);
			// The spinning thread kept omp alive past its closed stdin: it took a signal to end it.
			expect(w.pool.exitOf(live.info.liveId)?.exit).toMatchObject({
				by: "server",
				reason: "agentRestart",
				signal: "SIGTERM",
			});
			// The conversation runs in a new process on the same file.
			const next = w.pool.liveOfFile(w.file);
			expect(next).toBeDefined();
			expect(next?.info.liveId).not.toBe(live.info.liveId);
			expect(next?.info.pid).not.toBe(ompPid);
			if (next?.info.pid) strays.add(next.info.pid);
			expect(w.store.get(record.id)?.newLiveId).toBe(next?.info.liveId);
			// Told once, with the request's id and the agent's own words; the session file has it. Still once a moment later
			// (nothing sends it again): the second look is the point of the wait.
			await Bun.sleep(500);
			const told = sent(w.prompts).filter((m) => m.includes(record.id));
			expect(told).toHaveLength(1);
			expect(told[0]).toStartWith(`[omp-webui restart ${record.id}] Restarted by the agent: bash calls hang`);
			expect(told[0]).toContain(ARGS.continue_with);
			expect(told[0]).toContain("it is not from the person");
			expect(readFileSync(w.file, "utf8")).toContain(record.id);
			// Nothing of the old process's notes is left on the new one.
			expect(next?.info.restartPending).toBeUndefined();
		},
		60_000,
	);

	test("a call the extension refused is no request", async () => {
		const w = world();
		const live = await w.open();
		await emit(live, [{ type: "agent_start" }, ...call(ARGS, "c1", true), { type: "agent_end", messages: [] }]);
		// An absence (no request, no restart): looked at after the frames had time to be handled.
		await Bun.sleep(500);
		expect(w.store.list()).toEqual([]);
		expect(live.info.exited).toBe(false);
	}, 30_000);

	test("a turn that does not end is aborted when its time is up, and the restart is made", async () => {
		const w = world();
		w.coordinator.timings = { ...FAST, turnEndMs: 300 };
		const live = await w.open();
		await emit(live, [{ type: "agent_start" }, ...call(ARGS)]);
		const record = await (async () => {
			await pollUntil(() => w.store.list().length === 1, "the request");
			return only(w.store);
		})();
		await pollUntil(() => w.store.get(record.id)?.state === "delivered", "the restart", 30_000);
		expect(live.info.exited).toBe(true);
		const next = w.pool.liveOfFile(w.file);
		if (next?.info.pid) strays.add(next.info.pid);
		expect(sent(w.prompts).filter((m) => m.includes(record.id))).toHaveLength(1);
	}, 60_000);
});

describe("refusals: told to the agent, nothing ended", () => {
	test("a dialog that waits for the person", async () => {
		const w = world();
		const live = await w.open();
		await emit(live, [
			{ type: "agent_start" },
			...call(ARGS),
			{ type: "extension_ui_request", id: "d1", method: "select", title: "Pick one", options: ["a", "b"] },
			{ type: "agent_end", messages: [] },
		]);
		await pollUntil(() => sent(w.prompts).length > 0, "the refusal");
		// The record says the agent was told once the message has been taken: after the prompt went out, not with it.
		await pollUntil(() => only(w.store).notified === true, "the refusal's record");
		const record = only(w.store);
		expect(record).toMatchObject({ state: "refused", refusal: "asking", notified: true });
		expect(sent(w.prompts)[0]).toStartWith(`[omp-webui restart-refused ${record.id} asking] Restart refused:`);
		expect(live.info.exited).toBe(false);
		expect(live.info.restartPending).toBeUndefined();
	}, 30_000);

	test("running subagents, unless the call says force", async () => {
		const w = world();
		const live = await w.open();
		await live.rpc({ type: "set_state", state: { subagents: [{ id: "s1", status: "running" }] } });
		await emit(live, [{ type: "agent_start" }, ...call(ARGS), { type: "agent_end", messages: [] }]);
		await pollUntil(() => sent(w.prompts).length > 0, "the refusal");
		expect(only(w.store)).toMatchObject({ state: "refused", refusal: "subagents" });
		expect(sent(w.prompts)[0]).toContain("force: true");
		expect(live.info.exited).toBe(false);

		// Again, with force: the subagents end with the process.
		await emit(live, [
			{ type: "agent_start" },
			...call({ ...ARGS, force: true }, "c2"),
			{ type: "agent_end", messages: [] },
		]);
		await pollUntil(() => w.store.list().some((r) => r.state === "delivered"), "the restart", 30_000);
		expect(live.info.exited).toBe(true);
		const next = w.pool.liveOfFile(w.file);
		if (next?.info.pid) strays.add(next.info.pid);
	}, 60_000);

	test.skipIf(!capabilities.pauseResume)(
		"a paused conversation: the pages say so at once, and the agent is told when it runs again",
		async () => {
			const w = world();
			w.coordinator.timings = { ...FAST, turnEndMs: 400 };
			const live = await w.open();
			await emit(live, [{ type: "agent_start" }, ...call(ARGS)]);
			await pollUntil(() => w.store.list().length === 1, "the request");
			await live.pause();
			await pollUntil(() => live.info.restartRefused !== undefined, "the refusal");
			expect(only(w.store)).toMatchObject({ state: "refused", refusal: "paused" });
			expect(live.info.restartRefused).toMatchObject({ why: "paused", reason: ARGS.reason });
			// A frozen omp is sent nothing.
			expect(sent(w.prompts)).toEqual([]);
			await live.resume();
			await pollUntil(() => sent(w.prompts).length > 0, "the refusal told");
			expect(sent(w.prompts)[0]).toContain("restart-refused");
			expect(sent(w.prompts)[0]).toContain(" paused] ");
			expect(live.info.restartRefused).toBeUndefined();
			expect(live.info.exited).toBe(false);
		},
		30_000,
	);
});

describe("the limit", () => {
	test("three restarts in the last hour: the next call is refused, and the limit is read back by the next server", async () => {
		const w = world();
		for (let i = 0; i < 3; i++) {
			const r = w.store.create({
				by: "agent",
				liveId: `Lold${i}`,
				session: w.key,
				cwd: w.dir,
				mode: "full",
				reason: "earlier",
				continueWith: "go on",
				force: false,
				state: "requested",
			});
			w.store.move(r.id, "restarting");
			w.store.move(r.id, "resumed");
			w.store.move(r.id, "delivered");
		}
		// The person's own restarts and refused requests do not count; a server that starts again reads the same limit.
		expect(new RestartStore(w.dir).blockedUntil(w.key)).toBeGreaterThan(Date.now() + 59 * 60_000);
		const live = await w.open();
		// The extension reads the limit from the file the server wrote for the process.
		const limit = JSON.parse(readFileSync(w.coordinator.service.fileFor(live.info.liveId), "utf8"));
		expect(limit.blockedUntil).toBeGreaterThan(Date.now());
		// A call that got past it anyway (the file was written after) is refused by the server.
		await emit(live, [{ type: "agent_start" }, ...call(ARGS), { type: "agent_end", messages: [] }]);
		await pollUntil(() => sent(w.prompts).length > 0, "the refusal");
		expect(sent(w.prompts)[0]).toContain(" rateLimit] ");
		expect(w.store.list().filter((r) => r.state === "refused")).toHaveLength(1);
		// An absence (no restart): looked at after the refusal had time to be followed by anything else.
		await Bun.sleep(300);
		expect(live.info.exited).toBe(false);
	}, 30_000);

	test("the third restart of the hour writes the limit before the fourth call can be made", async () => {
		const w = world();
		for (let i = 0; i < 2; i++) {
			const r = w.store.create({
				by: "agent",
				liveId: `Lold${i}`,
				session: w.key,
				cwd: w.dir,
				mode: "full",
				reason: "earlier",
				continueWith: "go on",
				force: false,
				state: "requested",
			});
			w.store.move(r.id, "failed", { error: "test" });
		}
		const live = await w.open();
		const file = w.coordinator.service.fileFor(live.info.liveId);
		expect(JSON.parse(readFileSync(file, "utf8")).blockedUntil).toBeNull();
		await emit(live, [{ type: "agent_start" }, ...call(ARGS)]);
		await pollUntil(() => JSON.parse(readFileSync(file, "utf8")).blockedUntil !== null, "the limit");
		expect(JSON.parse(readFileSync(file, "utf8")).blockedUntil).toBeGreaterThan(Date.now());
	}, 30_000);
});

describe("Force restart", () => {
	test("aborts the turn that runs and restarts the process; no message is sent", async () => {
		const w = world();
		const live = await w.open();
		await emit(live, [{ type: "agent_start" }]);
		await pollUntil(() => live.info.streaming, "the turn");
		const next = await w.coordinator.forceRestart(live);
		if (next.info.pid) strays.add(next.info.pid);
		expect(live.info.exited).toBe(true);
		expect(w.pool.exitOf(live.info.liveId)?.exit).toMatchObject({ by: "server", reason: "forceRestart" });
		expect(next.info.liveId).not.toBe(live.info.liveId);
		expect(next.info.restarted).toMatchObject({ by: "user" });
		expect(only(w.store)).toMatchObject({ by: "user", state: "delivered", continueWith: null });
		expect(sent(w.prompts)).toEqual([]);
	}, 30_000);

	test("makes the restart the agent asked for, with its message", async () => {
		const w = world();
		const live = await w.open();
		await emit(live, [{ type: "agent_start" }, ...call(ARGS)]);
		await pollUntil(() => w.store.list().length === 1, "the request");
		const next = await w.coordinator.forceRestart(live);
		if (next.info.pid) strays.add(next.info.pid);
		const record = only(w.store);
		expect(record).toMatchObject({ by: "agent", state: "delivered", force: true });
		expect(sent(w.prompts).filter((m) => m.includes(record.id))).toHaveLength(1);
	}, 30_000);

	test.skipIf(!capabilities.pauseResume)(
		"a paused conversation is refused",
		async () => {
			const w = world();
			const live = await w.open();
			await live.pause();
			await expect(w.coordinator.forceRestart(live)).rejects.toMatchObject({ code: "restartPaused" });
			await live.resume();
			expect(live.info.exited).toBe(false);
		},
		30_000,
	);
});

describe("a server that stopped between two steps finishes the restart when it starts again", () => {
	/** A request as a server that stopped at `state` left it (its process is gone: its relay ended it with the server). */
	function left(w: ReturnType<typeof world>, state: "requested" | "restarting" | "resumed") {
		const r = w.store.create({
			by: "agent",
			liveId: "Lgone",
			session: w.key,
			cwd: w.dir,
			mode: "full",
			reason: "stuck",
			continueWith: "Look at the build log, then go on.",
			force: false,
			state: "requested",
		});
		if (state !== "requested") w.store.move(r.id, "restarting");
		if (state === "resumed") w.store.move(r.id, "resumed", { newLiveId: "Lgone2" });
		return r.id;
	}

	for (const state of ["requested", "restarting", "resumed"] as const) {
		test(`left ${state}: the conversation is started again and told once`, async () => {
			const first = world();
			const id = left(first, state);
			// The next server, on the same data folder.
			const w = world({}, first.dir);
			await w.coordinator.recover();
			expect(w.store.get(id)?.state).toBe("delivered");
			const live = w.pool.liveOfFile(w.file);
			expect(live).toBeDefined();
			if (live?.info.pid) strays.add(live.info.pid);
			expect(sent(w.prompts).filter((m) => m.includes(id))).toHaveLength(1);
			// And a server that starts after that has nothing left to do.
			const again = world({}, first.dir);
			await again.coordinator.recover();
			expect(sent(w.prompts).filter((m) => m.includes(id))).toHaveLength(1);
		}, 30_000);
	}

	test("left resumed, with the message in the session file already: it is not sent again", async () => {
		const first = world();
		const id = left(first, "resumed");
		// omp took the message and wrote it, and the server stopped before it wrote that down.
		writeFileSync(
			first.file,
			`${readFileSync(first.file, "utf8")}${JSON.stringify({ type: "message", message: { role: "user", content: `[omp-webui restart ${id}] Restarted by the agent: stuck` } })}\n`,
		);
		const w = world({}, first.dir);
		await w.coordinator.recover();
		expect(w.store.get(id)?.state).toBe("delivered");
		const live = w.pool.liveOfFile(w.file);
		if (live?.info.pid) strays.add(live.info.pid);
		expect(live).toBeDefined();
		expect(sent(w.prompts)).toEqual([]);
	}, 30_000);
});
