import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Live, LivePool } from "../../server/live.ts";
import { fakeConfig, writeFakeOmp } from "../support/fake-omp.ts";

/**
 * Retry now is single-flight: two clicks at once (a second tab, a double click) are one retry. A second `/retry` on a
 * turn the first already redid is what made omp answer "Wait for the current response…" and the page show an error.
 */

const dirs: string[] = [];
const pools: LivePool[] = [];

afterEach(async () => {
	for (const pool of pools.splice(0)) await pool.shutdown();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

async function conversation(): Promise<Live> {
	const dir = mkdtempSync(join(tmpdir(), "ompw-retrynow-"));
	dirs.push(dir);
	// The retry takes a moment to be accepted, so that a second click arrives while it is under way.
	const pool = new LivePool(fakeConfig(dir, writeFakeOmp(dir, { delay: { prompt: 300 } })));
	pools.push(pool);
	const cwd = join(dir, "work");
	mkdirSync(cwd);
	return pool.open({ kind: "new", cwd }, async () => null);
}

test("two Retry now at once run one retry and share its outcome; a later one is a retry of its own", async () => {
	const live = await conversation();
	const command = spyOn(live, "command");

	const first = live.retryNow();
	const second = live.retryNow();
	expect(second).toBe(first);
	await Promise.all([first, second]);
	expect(command.mock.calls.map((c) => c[0])).toEqual(["/retry"]);

	// Once the first is over, the next click is a new retry.
	await live.retryNow();
	expect(command.mock.calls.map((c) => c[0])).toEqual(["/retry", "/retry"]);
});

test("a Retry now that fails is not kept: the next one runs again", async () => {
	const live = await conversation();
	const command = spyOn(live, "command").mockRejectedValueOnce(new Error("Nothing to retry."));

	const first = live.retryNow();
	const second = live.retryNow();
	await expect(first).rejects.toThrow("Nothing to retry.");
	await expect(second).rejects.toThrow("Nothing to retry.");
	await live.retryNow();
	expect(command).toHaveBeenCalledTimes(2);
});
