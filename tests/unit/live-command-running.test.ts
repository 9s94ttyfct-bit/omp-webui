import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LivePool } from "../../server/live.ts";
import { ApprovalStore } from "../../server/omp/approval.ts";
import { awakeWorking } from "../../server/sleep.ts";
import { factsOf, workCounts, working } from "../../shared/attention.ts";
import { writeFakeHostOmp } from "../support/fake-host-omp.ts";
import { fakeConfig } from "../support/fake-omp.ts";
import { removeScratch } from "../support/scratch.ts";
import { setTempDir } from "../support/tmp.ts";

/**
 * A `!command` a page sent is work (#389): omp starts no turn for it, so `streaming` stays false, but the process's info says
 * it runs (`LiveInfo.commandRunning`) for as long as omp has not answered it, and everything that reads whether a
 * conversation works (the sidebar's dot, the menu bar's count, keep-awake, the Finished notification) counts it.
 */

const dirs: string[] = [];
const pools: LivePool[] = [];
afterEach(async () => {
	for (const pool of pools.splice(0)) await pool.shutdown();
	for (const d of dirs.splice(0)) removeScratch(d);
});
const sharedTmp = process.env.TMPDIR;
let ownTmp = "";
beforeAll(() => {
	ownTmp = mkdtempSync(join(tmpdir(), "ompw-command-running-tmp-"));
	setTempDir(ownTmp);
});
afterAll(() => {
	if (sharedTmp === undefined) delete process.env.TMPDIR;
	else setTempDir(sharedTmp);
	removeScratch(ownTmp);
});

test("a running !command is said in the process's info, and counts as work until omp answers it (#389)", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-command-running-"));
	dirs.push(dir);
	const log = join(dir, "log");
	writeFileSync(log, "");
	const bin = writeFakeHostOmp(dir, log, { configured: "write" });
	const pool = new LivePool(fakeConfig(dir, bin), null, null, new ApprovalStore(bin, dir, 0));
	pools.push(pool);
	const told: boolean[] = [];
	pool.onAnnounce((info) => told.push(info.commandRunning === true));
	const live = await pool.open({ kind: "new", cwd: dir }, async () => dir);

	// The fake omp answers a `bash` that starts with `hold` only when it is let go, as omp answers a !command when it exits.
	const ran = live.rpc({ type: "bash", command: "hold on" });
	expect(live.info.commandRunning).toBe(true);
	expect(told.at(-1)).toBe(true);
	const info = { ...live.info, pausedAt: null };
	expect(working(factsOf(info))).toBe(true);
	expect(workCounts([info])).toEqual({ working: 1, asking: 0 });
	expect(awakeWorking(info)).toBe(true);

	await live.rpc({ type: "release_bash" });
	await ran;
	expect(live.info.commandRunning).toBeUndefined();
	expect(told.at(-1)).toBe(false);
	expect(working(factsOf(live.info))).toBe(false);
});
