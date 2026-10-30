import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Live, LivePool } from "../../server/live.ts";
import { CompactStepService } from "../../server/omp/compact-step/service.ts";
import { isRecord } from "../../shared/guards.ts";
import { fakeConfig, writeFakeOmp } from "../support/fake-omp.ts";
import { pollUntil } from "../support/poll.ts";
import { writeSyncOmp } from "../support/sync-omp-bin.ts";

/**
 * A compact queued while the agent works (#651) through the process that holds it: what the server sends omp, in order,
 * from the page's messages to the end of the turn; what every page is told (`LiveInfo.compactQueued`, the end frame); Stop;
 * a move to another session; and a paused conversation's record. The first three against a stand-in omp that keeps a queue
 * of follow-ups as omp does (`sync-omp.ts`), the last against a scripted one. No model.
 */

const dirs: string[] = [];
const pools: LivePool[] = [];
let restoreEnv: (() => void) | null = null;

afterEach(async () => {
	restoreEnv?.();
	restoreEnv = null;
	for (const pool of pools.splice(0)) {
		for (const l of pool.list()) if (l.pid !== null) Bun.spawnSync(["kill", "-CONT", String(l.pid)]);
		await pool.shutdown();
	}
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Conversation {
	pool: LivePool;
	live: Live;
	/** The commands omp was sent, in order (what its log says it received). */
	received(): Record<string, unknown>[];
	/** What every page that listens to the process was told. */
	frames: Record<string, unknown>[];
}

async function syncConversation(): Promise<Conversation> {
	const dir = mkdtempSync(join(tmpdir(), "ompw-live-compact-"));
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
	const frames: Record<string, unknown>[] = [];
	live.subscribers.add({
		send: (m: unknown) => {
			const msg = m as Record<string, unknown>;
			if (msg.t === "frame" && isRecord(msg.frame)) frames.push(msg.frame);
		},
	});
	const received = () =>
		readFileSync(log, "utf8")
			.split("\n")
			.filter(Boolean)
			.flatMap((line) => {
				const entry: unknown = JSON.parse(line);
				return isRecord(entry) && isRecord(entry.in) ? [entry.in] : [];
			});
	return { pool, live, received, frames };
}

/** The commands omp was sent that say something about the order: the ones the test is about. */
const ORDER: Record<string, true> = {
	prompt: true,
	compact: true,
	remove_queued_message: true,
	steer: true,
	abort_and_restore_queue: true,
	handoff: true,
};
const ordered = (c: Conversation) =>
	c
		.received()
		.filter((cmd) => Object.hasOwn(ORDER, String(cmd.type)))
		.map((cmd) => (cmd.type === "prompt" ? `prompt:${cmd.message}` : String(cmd.type)));

test("queued while the turn runs: the turn ends, omp compacts with the note, and only then does it get the follow-ups, in order", async () => {
	const c = await syncConversation();
	const { live } = c;
	await live.rpc({ type: "prompt", message: "work" });
	await pollUntil(() => live.info.streaming, "the turn to begin");
	// A follow-up queued before the compact, in omp's own queue.
	await live.rpc({ type: "prompt", message: "queued first", streamingBehavior: "followUp" });

	await live.queueCompact("keep the API names");
	expect(live.info.compactQueued).toMatchObject({
		phase: "queued",
		instructions: "keep the API names",
		held: ["queued first"],
	});
	// A follow-up sent while it waits is held with it, and omp is not told.
	const held = await live.rpc({ type: "prompt", message: "queued second", streamingBehavior: "followUp" });
	expect(held.success).toBe(true);
	expect(live.info.compactQueued?.held).toEqual(["queued first", "queued second"]);
	// Nothing but the first prompt, the follow-up that was taken back, and its removal has reached omp.
	expect(ordered(c)).toEqual(["prompt:work", "prompt:queued first", "remove_queued_message"]);

	// The turn ends.
	await live.rpc({ type: "sync_finish" });
	await pollUntil(() => live.info.compactEnded !== undefined, "the queued compact to end");
	expect(ordered(c)).toEqual([
		"prompt:work",
		"prompt:queued first",
		"remove_queued_message",
		"compact",
		"prompt:queued first",
		"prompt:queued second",
	]);
	expect(c.received().find((cmd) => cmd.type === "compact")).toEqual({
		type: "compact",
		customInstructions: "keep the API names",
		id: expect.any(String),
	});
	expect(live.info.compactEnded).toEqual({ at: expect.any(Number), ok: true });
	expect(live.info.compactQueued).toBeUndefined();
});

test("every page is told what waits, as the process's own state, and when it started to run", async () => {
	const c = await syncConversation();
	const { live } = c;
	const told: (string | undefined)[] = [];
	c.pool.onAnnounce((info) => told.push(info.compactQueued?.phase));
	await live.rpc({ type: "prompt", message: "work" });
	await pollUntil(() => live.info.streaming, "the turn to begin");
	await live.queueCompact(undefined);
	await live.rpc({ type: "sync_finish" });
	await pollUntil(() => live.info.compactEnded !== undefined, "the queued compact to end");
	const phases = told.filter((phase, i) => phase !== told[i - 1]);
	expect(phases).toEqual(["queued", "running", undefined]);
});

test("asked between steps where the extension is not there: the turn's end compacts, and the page is told why", async () => {
	const c = await syncConversation();
	const { live } = c;
	await live.rpc({ type: "prompt", message: "work" });
	await pollUntil(() => live.info.streaming, "the turn to begin");
	await live.queueCompact("note", "step");
	// No extension on this pool: the request is for the end of the turn, with the reason.
	expect(live.info.compactQueued).toMatchObject({ phase: "queued", where: "turn", stepUnavailable: "notLoaded" });
	expect(ordered(c)).toEqual(["prompt:work"]);
	await live.rpc({ type: "sync_finish" });
	await pollUntil(() => live.info.compactEnded !== undefined, "the queued compact to end");
	expect(ordered(c)).toEqual(["prompt:work", "compact"]);
	expect(live.info.compactEnded).toEqual({ at: expect.any(Number), ok: true });
});

test("asked between steps where the extension is on the command line but never said it started: the same", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-live-compact-step-"));
	dirs.push(dir);
	const c = await syncConversation();
	c.pool.compactStep = new CompactStepService(dir);
	// A conversation opened with the extension named: the stand-in omp does not load it, so no note says that it runs.
	const cwd = join(dir, "work");
	mkdirSync(cwd);
	const live = await c.pool.open({ kind: "new", cwd }, async () => null);
	await live.rpc({ type: "prompt", message: "work" });
	await pollUntil(() => live.info.streaming, "the turn to begin");
	expect(live.info.args).toContain("--extension");
	await live.queueCompact(undefined, "step");
	expect(live.info.compactQueued).toMatchObject({ where: "turn", stepUnavailable: "notLoaded" });
	await live.cancelCompact();
	expect(live.info.compactQueued).toBeUndefined();
});

test("a place that is none is refused, and nothing is queued", async () => {
	const c = await syncConversation();
	const { live } = c;
	await live.rpc({ type: "prompt", message: "work" });
	await pollUntil(() => live.info.streaming, "the turn to begin");
	await expect(live.queueCompact(undefined, "sometime")).rejects.toThrow("Bad value");
	expect(live.info.compactQueued).toBeUndefined();
});

test("cancelling gives omp the messages as they were sent, and nothing is compacted when the turn ends", async () => {
	const c = await syncConversation();
	const { live } = c;
	await live.rpc({ type: "prompt", message: "work" });
	await pollUntil(() => live.info.streaming, "the turn to begin");
	await live.rpc({ type: "prompt", message: "one", streamingBehavior: "followUp" });
	await live.queueCompact("note");
	await live.rpc({ type: "prompt", message: "two", streamingBehavior: "followUp" });

	await live.cancelCompact();
	expect(live.info.compactQueued).toBeUndefined();
	// omp has them again, in order, as follow-ups (a turn is running).
	const state = (await live.rpc({ type: "get_state" })).data;
	expect(isRecord(state) && isRecord(state.queuedMessages) ? state.queuedMessages.followUp : null).toEqual([
		"one",
		"two",
	]);

	await live.rpc({ type: "sync_finish" });
	expect(ordered(c)).not.toContain("compact");
});

test("Stop gives the held messages back with the ones omp withdrew, and ends the request: the turn it ends compacts nothing", async () => {
	const c = await syncConversation();
	const { live } = c;
	await live.rpc({ type: "prompt", message: "work" });
	await pollUntil(() => live.info.streaming, "the turn to begin");
	await live.rpc({ type: "prompt", message: "held one", streamingBehavior: "followUp" });
	await live.queueCompact(undefined);
	await live.rpc({ type: "prompt", message: "held two", streamingBehavior: "followUp" });

	const stopped = await live.stop("turn", { type: "abort_and_restore_queue" });
	expect(stopped.success).toBe(true);
	expect(isRecord(stopped.data) && Array.isArray(stopped.data.followUp) ? stopped.data.followUp : null).toEqual([
		{ text: "held one" },
		{ text: "held two" },
	]);
	expect(live.info.compactQueued).toBeUndefined();
	await pollUntil(() => !live.info.streaming, "the turn to end");
	expect(ordered(c)).not.toContain("compact");
	expect(live.info.compactEnded).toBeUndefined();
});

test("a message that is a slash command or a steer is omp's, and a message that is held can be removed", async () => {
	const c = await syncConversation();
	const { live } = c;
	await live.rpc({ type: "prompt", message: "work" });
	await pollUntil(() => live.info.streaming, "the turn to begin");
	await live.queueCompact(undefined);
	await live.rpc({ type: "prompt", message: "held", streamingBehavior: "followUp" });
	await live.rpc({ type: "steer", message: "go left" });
	expect(ordered(c)).toContain("steer");
	expect(live.info.compactQueued?.held).toEqual(["held"]);

	const removed = await live.rpc({ type: "remove_queued_message", message: "held", queue: "followUp" });
	expect(removed.data).toEqual({ removed: true, images: [] });
	expect(live.info.compactQueued?.held).toEqual([]);
	// It was never omp's: omp was not asked to remove it.
	expect(ordered(c).filter((t) => t === "remove_queued_message")).toEqual([]);
});

test("a handoff, the same conversation in a new file, keeps the request; a move to another conversation ends it", async () => {
	const c = await syncConversation();
	const { live } = c;
	await live.rpc({ type: "prompt", message: "work" });
	await pollUntil(() => live.info.streaming, "the turn to begin");
	await live.queueCompact("note");
	await live.rpc({ type: "prompt", message: "held", streamingBehavior: "followUp" });

	await live.rpc({ type: "handoff" });
	expect(live.info.compactQueued).toMatchObject({ phase: "queued", instructions: "note", held: ["held"] });

	await live.rpc({ type: "new_session" });
	expect(live.info.compactQueued).toBeUndefined();
});

test("a paused conversation keeps the waiting compact and the messages held behind it across a restart of the server", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-live-compact-parked-"));
	dirs.push(dir);
	const bin = writeFakeOmp(dir, { streaming: true });
	const cwd = join(dir, "work");
	mkdirSync(cwd);
	const first = new LivePool(fakeConfig(dir, bin));
	pools.push(first);
	const live = await first.open({ kind: "new", cwd }, async () => null);
	await pollUntil(() => live.info.streaming, "the process to say a turn is under way");
	await live.queueCompact("kept note");
	await live.rpc({ type: "prompt", message: "held while paused", streamingBehavior: "followUp" });

	await live.pause();
	const [record] = first.parked.list();
	expect(record.compactQueue).toMatchObject({ instructions: "kept note", held: [{ message: "held while paused" }] });

	expect(await first.parkKept()).toBe(1);
	const second = new LivePool(fakeConfig(dir, bin));
	pools.push(second);
	expect(await second.adopt()).toBe(1);
	const adopted = second.get(live.info.liveId) as Live;
	expect(adopted.info.compactQueued).toMatchObject({
		phase: "queued",
		instructions: "kept note",
		held: ["held while paused"],
	});
	expect(adopted.attached().compactQueued?.held).toEqual(["held while paused"]);
});
