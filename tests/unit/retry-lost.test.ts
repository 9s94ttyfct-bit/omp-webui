import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Live, LivePool, type Subscriber } from "../../server/live.ts";
import { fakeConfig, writeFakeOmp } from "../support/fake-omp.ts";
import { pollUntil } from "../support/poll.ts";

/**
 * omp 18.12 can lose a retry wait it announced: when the failures of two turns overlap (two messages queued during a
 * usage-limit wait, then `abort_retry` runs them one after another), the second failure's handler resets the counter
 * the first one's sleep checks when it ends, so at the reset `agent.continue` is skipped (`should-continue-false`):
 * no request, and no `auto_retry_end`. Measured against the real omp 18.12.2 (the frames below are the ones it sent).
 * The server must not hold a wait that omp does not keep, and the page's Cancel, Stop and Retry now must end one that
 * is left: a countdown, a busy conversation and buttons that do nothing are what the user saw as "Retrying…" for hours.
 */

const dirs: string[] = [];
const pools: LivePool[] = [];

afterEach(async () => {
	for (const pool of pools.splice(0)) await pool.shutdown();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function conversation(): Promise<Live> {
	const dir = mkdtempSync(join(tmpdir(), "ompw-retrylost-"));
	dirs.push(dir);
	const pool = new LivePool(fakeConfig(dir, writeFakeOmp(dir)));
	pools.push(pool);
	const cwd = join(dir, "work");
	mkdirSync(cwd);
	return pool.open({ kind: "new", cwd }, async () => null);
}

const frames = (live: Live, ...list: Record<string, unknown>[]) => live.rpc({ type: "emit_frames", frames: list });
/** What omp announced for a usage-limit wait (`errorId` 659456: the usage-limit flag among the others a 429 sets). */
const wait = (attempt: number, delayMs = 130_000) => ({
	type: "auto_retry_start",
	attempt,
	maxAttempts: 10,
	delayMs,
	errorId: 659_456,
	errorMessage: "429 You have reached your usage limit.",
});
const ended = (attempt: number, finalError = "Retry cancelled") => ({
	type: "auto_retry_end",
	success: false,
	attempt,
	finalError,
});

/** The frames a tab is sent. */
function tab(live: Live): Record<string, unknown>[] {
	const seen: Record<string, unknown>[] = [];
	const sub: Subscriber = {
		send: (msg) => {
			const m = msg as { t?: string; frame?: Record<string, unknown> };
			if (m.t === "frame" && m.frame) seen.push(m.frame);
		},
	};
	live.subscribers.add(sub);
	return seen;
}

test("the frames omp 18.12.2 sent when it lost the retry leave no wait held: it said it was idle before it announced one", async () => {
	const live = await conversation();
	await frames(live, wait(1, 139_952));
	expect(live.info.retry).toMatchObject({ attempt: 1, delayMs: 139_952, usageLimit: true });
	expect(live.busy).toBe(true);

	// abort_retry cancels the wait; the two queued messages start one after another and fail one after another.
	await frames(
		live,
		ended(1),
		{ type: "agent_end", isTerminal: false, messages: [] },
		{ type: "agent_start" },
		wait(1, 131_321),
		{ type: "agent_start" },
		ended(2, "429 You have reached your usage limit. retry-after-ms=131321"),
		{ type: "agent_end", isTerminal: true, messages: [] },
		{ type: "session_settled" },
		wait(0, 130_895),
	);
	expect(live.info.retry).toBeUndefined();
	expect(live.busy).toBe(false);
});

test("omp reporting itself idle ends a wait it did not end, and a wait announced after a turn started is held", async () => {
	const live = await conversation();
	await frames(live, { type: "agent_start" }, { type: "agent_end", messages: [] }, wait(1));
	expect(live.busy).toBe(true);
	await frames(live, { type: "session_settled" });
	expect(live.info.retry).toBeUndefined();
	expect(live.busy).toBe(false);

	// A turn that fails after that waits as usual.
	await frames(live, { type: "agent_start" }, { type: "agent_end", messages: [] }, wait(1));
	expect(live.info.retry).toMatchObject({ attempt: 1 });
	expect(live.busy).toBe(true);
});

test("a wait omp lost is ended by Cancel, by Retry now and by Stop; one omp ends itself, or replaces, is left to omp", async () => {
	const [cancelled, retried, stopped, announced, replaced] = await Promise.all([
		conversation(),
		conversation(),
		conversation(),
		conversation(),
		conversation(),
	]);
	const lives = [cancelled, retried, stopped, announced, replaced];
	const sent = lives.map(tab);
	for (const live of lives) await frames(live, wait(1));

	// omp answers each command and, having lost the wait, says nothing more.
	const stop = stopped.rpc({ type: "abort" });
	const cancel = cancelled.rpc({ type: "abort_retry" });
	const retry = retried.retryNow();
	// omp's own `auto_retry_end` after its answer: nothing for the server to add.
	await announced.rpc({ type: "abort_retry" });
	await frames(announced, ended(1));
	// A newer wait that omp announces after the answer is omp's, not the one the command ended.
	await replaced.rpc({ type: "abort_retry" });
	await frames(replaced, ended(1), { type: "agent_start" }, wait(2, 99_000));

	expect((await stop).success).toBe(true);
	expect((await cancel).success).toBe(true);
	await retry;
	// The omp that never says it is over has it said for it, once it has had time to.
	await pollUntil(
		() => [cancelled, retried, stopped].every((l) => l.info.retry === undefined),
		"the lost waits to end",
		30_000,
	);
	for (const i of [0, 1, 2]) {
		expect(sent[i].filter((f) => f.type === "auto_retry_end")).toEqual([
			{ type: "auto_retry_end", success: false, attempt: 1, finalError: "Retry cancelled" },
		]);
		expect(lives[i].busy).toBe(false);
	}

	// That the server ends nothing more is seen by letting its own window (5 s, `RETRY_ABORT_MS`) pass: no event marks the
	// timer that does not act, and a fake clock does not move the real pipes the frames come through.
	await Bun.sleep(5_500);
	expect(announced.info.retry).toBeUndefined();
	expect(sent[3].filter((f) => f.type === "auto_retry_end")).toEqual([ended(1)]);
	expect(replaced.info.retry).toMatchObject({ attempt: 2, delayMs: 99_000 });
	expect(sent[4].filter((f) => f.type === "auto_retry_end")).toEqual([ended(1)]);
	expect(replaced.busy).toBe(true);
}, 60_000);
