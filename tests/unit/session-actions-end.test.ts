import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LivePool } from "../../server/live.ts";
import { SessionActions } from "../../server/sessions/actions.ts";
import { fakeConfig, writeFakeOmp } from "../support/fake-omp.ts";

/**
 * A rename runs through a short-lived omp of the server's own, which holds the conversation's write lease while it lives.
 * The rename answers once that omp has ended, not once it has answered: a delete asked right after it would otherwise find
 * the lease held by a process that is not the pool's, take it for a terminal's and refuse (seen on a slow CI runner).
 */

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompw-actions-end-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

test("a rename answers once its short-lived omp has ended, not once it has answered", async () => {
	// It takes a while to end once its stdin closes, as omp does writing its last entries.
	const bin = writeFakeOmp(dir, { slowClose: 1500 });
	const cfg = fakeConfig(dir, bin);
	const actions = new SessionActions(cfg, new LivePool(cfg));
	const started = Date.now();
	await actions.rename({ file: join(dir, "s.jsonl"), id: "01a00000-0000-7000-8000-00000000b2b2", cwd: dir }, "title");
	expect(Date.now() - started).toBeGreaterThanOrEqual(1500);
	// No process runs the fake any more.
	expect(Bun.spawnSync(["pgrep", "-f", bin]).stdout.toString().trim()).toBe("");
});
