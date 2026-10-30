import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Live, LivePool } from "../../server/live.ts";
import { sleepAftermath, workingIds } from "../../server/sleep.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
import { fakeConfig, writeFakeOmp } from "../support/fake-omp.ts";

/**
 * What a sleep says in a conversation (#647): the note the process carries (`LiveInfo.slept`, which every page is told
 * with the rest of what the server says of it), and the second line the server fills in from what omp did next — with a
 * scripted omp and a clock no test can move, so nothing here waits for a real sleep.
 */

const dirs: string[] = [];
const pools: LivePool[] = [];

afterEach(async () => {
	for (const pool of pools.splice(0)) await pool.shutdown();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function start(): Promise<{ live: Live; pool: LivePool }> {
	const dir = mkdtempSync(join(tmpdir(), "ompw-sleep-"));
	dirs.push(dir);
	const pool = new LivePool(fakeConfig(dir, writeFakeOmp(dir, {})), null, null, null);
	// The watching of what followed a sleep is a minute in the server: seconds here, so that the end of it can be seen.
	pool.sleepFollowMs = 200;
	pools.push(pool);
	const live = await pool.open({ kind: "new", cwd: tmpdir() }, async () => tmpdir());
	return { live, pool };
}

/** Every page's view of the process, as the server announced it: the last announcement is what a page shows. */
function announcements(pool: LivePool) {
	const told: LiveInfo[] = [];
	pool.onAnnounce((info) => told.push({ ...info }));
	return told;
}

/** Let the event loop turn until `condition` holds; the scripted omp answers within a few turns. */
async function until(condition: () => boolean): Promise<void> {
	const deadline = performance.now() + 10_000;
	while (!condition()) {
		if (performance.now() > deadline) throw new Error("the condition never held");
		const turn = Promise.withResolvers<void>();
		setImmediate(turn.resolve);
		await turn.promise;
	}
}

const FROM = 1_700_000_000_000;
const TO = FROM + 45 * 60_000;

test("a conversation the sleep caught carries its window, and says what omp did next in the same note", async () => {
	const { live, pool } = await start();
	const told = announcements(pool);
	expect(pool.noteSleep(FROM, TO, [live.info.liveId])).toBe(1);
	await until(() => told.some((i) => i.slept !== undefined));
	expect(told.at(-1)?.slept).toEqual({ from: FROM, to: TO });

	// omp retried the turn by itself: the note's second line says so, on the same note.
	await live.rpc({
		type: "emit_frames",
		frames: [{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorId: "overloaded" }],
	});
	await until(() => told.at(-1)?.slept?.followed === "retried");
	expect(told.at(-1)?.slept).toEqual({ from: FROM, to: TO, followed: "retried" });
	// Said once: a second retry of the same sleep changes nothing more.
	const seen = told.length;
	await live.rpc({
		type: "emit_frames",
		frames: [{ type: "auto_retry_start", attempt: 2, maxAttempts: 3, delayMs: 4000, errorId: "overloaded" }],
	});
	await Bun.sleep(50);
	expect(told.at(-1)?.slept?.followed).toBe("retried");
	expect(told.length).toBeGreaterThanOrEqual(seen);
});

test("a turn that ended with an error is what a sleep cut says next", async () => {
	const { live, pool } = await start();
	const told = announcements(pool);
	pool.noteSleep(FROM, TO, [live.info.liveId]);
	await until(() => told.at(-1)?.slept !== undefined);
	await live.rpc({
		type: "emit_frames",
		frames: [
			{
				type: "message_end",
				messageId: "m1",
				message: { role: "assistant", content: [], stopReason: "error", errorMessage: "stream cut" },
			},
		],
	});
	await until(() => told.at(-1)?.slept?.followed === "error");
});

test("a tool out of time on the way back is said, and a frame that says nothing of the turn adds no line", async () => {
	const { live, pool } = await start();
	const told = announcements(pool);
	pool.noteSleep(FROM, TO, [live.info.liveId]);
	await until(() => told.at(-1)?.slept !== undefined);
	// Something that is no answer to the sleep: the note stands as it is.
	await live.rpc({ type: "emit_frames", frames: [{ type: "queue_update", steering: [], followUp: [] }] });
	await Bun.sleep(50);
	expect(told.at(-1)?.slept?.followed).toBeUndefined();
	await live.rpc({
		type: "emit_frames",
		frames: [
			{
				type: "tool_execution_end",
				toolCallId: "t1",
				toolName: "bash",
				isError: true,
				result: { content: [{ type: "text", text: "Command timed out after 120s" }] },
			},
		],
	});
	await until(() => told.at(-1)?.slept?.followed === "toolTimeout");
});

test("a conversation that is gone by the time the wake is seen is not one the note is said in", async () => {
	const { live, pool } = await start();
	const told = announcements(pool);
	expect(pool.noteSleep(FROM, TO, ["no-such-live"])).toBe(0);
	expect(pool.noteSleep(FROM, TO, [live.info.liveId])).toBe(1);
	await until(() => told.at(-1)?.slept !== undefined);
});

test("a second sleep replaces the first: the note is the window the machine was last away in", async () => {
	const { live, pool } = await start();
	const told = announcements(pool);
	pool.noteSleep(FROM, TO, [live.info.liveId]);
	await until(() => told.at(-1)?.slept !== undefined);
	const later = TO + 60 * 60_000;
	pool.noteSleep(TO, later, [live.info.liveId]);
	await until(() => told.at(-1)?.slept?.to === later);
	expect(told.at(-1)?.slept).toEqual({ from: TO, to: later });
});

test("the note stays after the minute of watching: only the watching ends", async () => {
	const { live, pool } = await start();
	const told = announcements(pool);
	pool.noteSleep(FROM, TO, [live.info.liveId]);
	await until(() => told.at(-1)?.slept !== undefined);
	// The window is over: the note is still there, just no longer added to.
	await Bun.sleep(500);
	expect(live.info.slept).toEqual({ from: FROM, to: TO });
	// What a page that attaches now is told (`Live.attached`, which is `info`): the line is there for someone who comes
	// back from an hour and a half away, which is who it is for.
	expect(live.attached().slept).toEqual({ from: FROM, to: TO });
	await live.rpc({
		type: "emit_frames",
		frames: [{ type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 2000, errorId: "overloaded" }],
	});
	await Bun.sleep(100);
	expect(live.info.slept).toEqual({ from: FROM, to: TO });
});

test("a conversation that turns again has no sleep note: the line goes with the turn it was about", async () => {
	const { live, pool } = await start();
	const told = announcements(pool);
	pool.noteSleep(FROM, TO, [live.info.liveId]);
	await until(() => told.at(-1)?.slept !== undefined);
	await live.rpc({ type: "emit_frames", frames: [{ type: "agent_start" }] });
	await until(() => live.info.slept === undefined);
	expect(live.attached().slept).toBeUndefined();
});

test("a process that ended has no sleep note, and its watch is over", async () => {
	const { live, pool } = await start();
	pool.noteSleep(FROM, TO, [live.info.liveId]);
	await until(() => live.info.slept !== undefined);
	await live.end();
	await until(() => live.info.exited);
	expect(live.info.slept).toBeUndefined();
});

test("what a frame says followed a sleep: the retry, the error, the tool out of time, and nothing else", () => {
	expect(sleepAftermath({ type: "auto_retry_start" })).toBe("retried");
	expect(sleepAftermath({ type: "message_end", message: { stopReason: "error" } })).toBe("error");
	expect(sleepAftermath({ type: "message_end", message: { stopReason: "stop" } })).toBeNull();
	expect(sleepAftermath({ type: "message_end" })).toBeNull();
	// A tool that failed for its own reasons is no timeout, and one that timed out says so in either shape of result.
	expect(sleepAftermath({ type: "tool_execution_end", isError: true, result: "boom" })).toBeNull();
	expect(sleepAftermath({ type: "tool_execution_end", isError: true, result: "Timeout after 30s" })).toBe(
		"toolTimeout",
	);
	expect(
		sleepAftermath({
			type: "tool_execution_end",
			isError: true,
			result: { content: [{ type: "text", text: "deadline exceeded" }] },
		}),
	).toBe("toolTimeout");
	// A tool that succeeded quickly is not one that ran out of time, whatever it printed.
	expect(sleepAftermath({ type: "tool_execution_end", isError: false, result: "timed out" })).toBeNull();
	expect(sleepAftermath({ type: "queue_update" })).toBeNull();
});

test("a working conversation is what the sleep names, and one waiting for an answer is not", async () => {
	const { live, pool } = await start();
	const infos = (): LiveInfo[] => pool.list();
	// Idle: nothing counts it.
	expect(workingIds(infos())).toEqual([]);
	await live.rpc({ type: "emit_frames", frames: [{ type: "agent_start" }] });
	await until(() => infos()[0]?.streaming === true);
	expect(workingIds(infos())).toEqual([live.info.liveId]);
	// A dialog waiting for the person is not working: nothing of its own was cut by the sleep.
	await live.rpc({
		type: "emit_frames",
		frames: [{ type: "extension_ui_request", id: "d1", method: "confirm", title: "Run it?" }],
	});
	await until(() => infos()[0]?.asking === true);
	expect(workingIds(infos())).toEqual([]);
});
