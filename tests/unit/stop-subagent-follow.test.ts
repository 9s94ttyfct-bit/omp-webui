import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LivePool } from "../../server/live.ts";
import { STOP_GRACE_MS } from "../../shared/stop.ts";
import { fakeConfig, writeFakeOmp } from "../support/fake-omp.ts";

/**
 * A turn that ended waiting for a subagent (`agent_end` with `isTerminal: false`) is taken up again by omp (18.14) once Stop
 * has cancelled that subagent: omp continues it with what the subagent left. Stop answers only once omp has done that, and
 * the turn it continued is over: answered in between, the conversation went on working behind a Stop that said it was done
 * (CI, on a slow machine: the sweep heard no subagent working before omp's `agent_start` came).
 */

const dirs: string[] = [];
const pools: LivePool[] = [];

afterEach(async () => {
	for (const pool of pools.splice(0)) await pool.shutdown();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("Stop that cancels the subagent a turn waits for answers once omp has continued that turn and it is over", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-stop-follow-"));
	dirs.push(dir);
	const continued = join(dir, "continued");
	// omp continues the turn a while after the cancel: longer than a sweep takes, well within what Stop waits for.
	const bin = writeFakeOmp(dir, {
		onCancelSubagent: {
			frames: [{ type: "agent_start" }, { type: "agent_end", isTerminal: true }],
			afterMs: 300,
			marker: continued,
		},
	});
	const cwd = join(dir, "work");
	mkdirSync(cwd);
	const pool = new LivePool(fakeConfig(dir, bin));
	pools.push(pool);
	const live = await pool.open({ kind: "new", cwd }, async () => null);
	await live.rpc({ type: "set_state", state: { subagents: [{ id: "Scout", status: "running" }] } });
	// The turn that started the subagent is over, and omp says it goes on once the subagent is done.
	await live.rpc({
		type: "emit_frames",
		frames: [{ type: "agent_start" }, { type: "agent_end", isTerminal: false, awaitingAsyncWork: true }],
	});
	expect(live.info.streaming).toBe(false);

	const began = Date.now();
	const stopped = await live.stop("turn", { type: "abort_and_restore_queue" });
	expect(stopped.success).toBe(true);
	expect(Date.now() - began).toBeLessThan(STOP_GRACE_MS);
	// The turn omp continued was heard, and is over: nothing works behind the answer.
	expect(existsSync(continued)).toBe(true);
	expect(live.info.streaming).toBe(false);
	expect(live.info.exited).toBe(false);
});
