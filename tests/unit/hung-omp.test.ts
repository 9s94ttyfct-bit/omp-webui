import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportSession } from "../../server/export.ts";
import { LivePool } from "../../server/live.ts";
import { configuredApprovalMode, configuredUsageWait, configureUsageWait } from "../../server/omp/approval.ts";
import { cliHelp, cliInventory, ompVersion, resetCliInventory } from "../../server/omp/cli.ts";
import { probeOmp } from "../../server/omp/install.ts";
import { runJson } from "../../server/omp/loaded.ts";
import { absentModels } from "../../server/omp/model-config.ts";
import { availableModels } from "../../server/omp/models.ts";
import { writeOverlay } from "../../server/omp/overlay.ts";
import { RunTimeout, run } from "../../server/omp/run.ts";
import { forgetStats, keepStatsIn, keptStats, ompStats } from "../../server/omp/stats.ts";
import { providerUsage } from "../../server/omp/usage.ts";
import { SessionActions } from "../../server/sessions/actions.ts";
import { fakeConfig } from "../support/fake-omp.ts";
import { pollUntil, processExists } from "../support/poll.ts";

/**
 * Every command the server runs to ask omp something has a time limit (#319): an omp that stops answering hangs the one
 * feature that asked. Fake omps that hang (a shell script, or a Bun script that never says it is ready), limits of a
 * second. A limit runs from the start of the command, and the fake has to get to its first line before it:
 * on a machine whose cores are all taken that is not the few milliseconds it is alone, and a limit shorter than that
 * kills the fake before it has recorded anything, so that there is nothing left to show. That a limit ends its command
 * is not timed: the fakes hang for ten minutes, and a limit that ended nothing fails the test by the test's own timeout.
 *
 * What a fake has recorded is therefore waited for, never assumed: a command that is asked again until the fake has
 * got to its first line is a command that is asked about, and the limit that ends it is the one under test (#499).
 */

const LIMIT = 1000;
let dir: string;
const strays = new Set<number>();

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompw-hung-"));
	forgetStats();
	resetCliInventory();
});
afterEach(() => {
	for (const pid of strays) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
	strays.clear();
	rmSync(dir, { recursive: true, force: true });
});

/** An omp whose helper commands (everything but `--version`) record their pid in `pids`, start a child, and hang. */
function hungOmp(): { bin: string; pids: () => number[]; calls: () => string[] } {
	const bin = join(dir, "omp");
	writeFileSync(
		bin,
		`#!/bin/sh
echo "$*" >> "${dir}/calls"
case "$1" in
  --version) [ -e "${dir}/healthy" ] && echo "omp/18.12.2" && exit 0 ;;
esac
echo $$ >> "${dir}/pids"
sleep 600 &
echo $! >> "${dir}/pids"
wait
`,
	);
	chmodSync(bin, 0o755);
	const read = (name: string): string[] =>
		existsSync(join(dir, name)) ? readFileSync(join(dir, name), "utf8").split("\n").filter(Boolean) : [];
	return {
		bin,
		pids: () => {
			const pids = read("pids").map(Number);
			for (const pid of pids) strays.add(pid);
			return pids;
		},
		calls: () => read("calls"),
	};
}

/** Whether every one of `pids` is gone. */
const allGone = (pids: number[]): boolean => pids.every((p) => !processExists(p));

/**
 * Whether the fake omp has recorded a call that starts with `prefix`. A limit runs from the start of the command, and
 * on a machine whose cores are all taken the fake may not have got to its first line before the limit ends it: the
 * wait is for the recording, not for a moment (#499).
 */
async function recorded(omp: { calls: () => string[] }, prefix: string): Promise<void> {
	await pollUntil(() => omp.calls().some((c) => c.startsWith(prefix)), `the fake omp to record a ${prefix} call`);
}

/**
 * Ask `what` until the fake omp has recorded a call that starts with `prefix`, and return what it answered. A limit
 * runs from the start of the command, and on a machine whose cores are all taken the fake may not get to its first
 * line before the limit ends it — so the first attempt may end a command that never ran. The attempt that matters is
 * the one whose command the fake did start: the wait is for the recording, and the limit under test is the one that
 * ends a command that is running (#499).
 */
async function untilRecorded<T>(omp: { calls: () => string[] }, prefix: string, what: () => Promise<T>): Promise<T> {
	for (;;) {
		let answered: T | undefined;
		let failed: unknown;
		try {
			answered = await what();
		} catch (e) {
			failed = e;
		}
		if (omp.calls().some((c) => c.startsWith(prefix))) {
			if (failed !== undefined) throw failed;
			return answered as T;
		}
		// The command was killed before the fake recorded it: it is asked again, and the recording is waited for.
		await Bun.sleep(50);
	}
}

test("run: output and exit status come back; a command that takes too long is killed with what it started", async () => {
	const ok = await run(["sh", "-c", "echo out; echo err >&2; exit 3"], { timeoutMs: 5000 });
	expect(ok).toEqual({ code: 3, stdout: "out\n", stderr: "err\n" });

	const pidFile = join(dir, "pids");
	// What the limit ends is not waited for: the command sleeps for ten minutes, and the test's own timeout is far shorter.
	const hung = run(["sh", "-c", `echo $$ >> ${pidFile}; sleep 600 & echo $! >> ${pidFile}; wait`], {
		timeoutMs: LIMIT,
	});
	await expect(hung).rejects.toBeInstanceOf(RunTimeout);
	const pids = readFileSync(pidFile, "utf8").split("\n").filter(Boolean).map(Number);
	for (const pid of pids) strays.add(pid);
	expect(pids).toHaveLength(2);
	// The shell and the sleep it started: the group is gone.
	await pollUntil(() => allGone(pids), "the command and its child to be gone");
});

test("omp stats: requests that come while a run is under way share it, and a run that hangs is killed", async () => {
	const omp = hungOmp();
	const first = ompStats(omp.bin, false, LIMIT);
	const second = ompStats(omp.bin, true, LIMIT);
	const third = ompStats(omp.bin, false, LIMIT);
	const outcomes = await Promise.allSettled([first, second, third]);
	expect(outcomes.map((o) => o.status)).toEqual(["rejected", "rejected", "rejected"]);
	// One omp, not one per request. The run is asked again until the fake has recorded it: a limit that ends the
	// command before the fake got to its first line ends a command that never ran (#499).
	await recorded(omp, "stats");
	await pollUntil(() => allGone(omp.pids()), "the hung omp stats to be gone");
	expect(omp.calls().filter((c) => c.startsWith("stats"))).toHaveLength(1);
	// The next request starts a new run (nothing stays stuck).
	await expect(ompStats(omp.bin, false, LIMIT)).rejects.toBeInstanceOf(RunTimeout);
	expect(omp.calls().filter((c) => c.startsWith("stats"))).toHaveLength(2);
});

test("omp stats: an answer is kept for a while, and a failure is not", async () => {
	const bin = join(dir, "omp");
	writeFileSync(bin, `#!/bin/sh\necho "x" >> "${dir}/runs"\necho '{"n":1}'\n`);
	chmodSync(bin, 0o755);
	expect(await ompStats(bin, false, 5000)).toBe('{"n":1}\n');
	expect(await ompStats(bin, false, 5000)).toBe('{"n":1}\n');
	expect(readFileSync(join(dir, "runs"), "utf8").split("\n").filter(Boolean)).toHaveLength(1);
	await ompStats(bin, true, 5000);
	expect(readFileSync(join(dir, "runs"), "utf8").split("\n").filter(Boolean)).toHaveLength(2);
});

test("omp stats: a page is answered at once from the copy kept on disk while a run brings it up to date (#690)", async () => {
	const bin = join(dir, "omp");
	writeFileSync(bin, `#!/bin/sh\necho "x" >> "${dir}/runs"\necho '{"n":2}'\n`);
	chmodSync(bin, 0o755);
	const kept = join(dir, "omp-stats.json");
	keepStatsIn(kept);
	// Nothing kept yet: the page waits for a run.
	expect(keptStats(bin, 5000)).toBeNull();
	// What a server that ran before left (a restart forgets the one in memory).
	writeFileSync(kept, '{"n":1}');
	const first = keptStats(bin, 5000);
	expect(first).toMatchObject({ body: '{"n":1}', refreshing: true });
	// The page's wait joins the run that answer started: one run, and its answer is kept for the next start.
	expect(await ompStats(bin, false, 5000)).toBe('{"n":2}\n');
	expect(readFileSync(join(dir, "runs"), "utf8").split("\n").filter(Boolean)).toHaveLength(1);
	expect(readFileSync(kept, "utf8")).toBe('{"n":2}\n');
	expect(keptStats(bin, 5000)).toMatchObject({ body: '{"n":2}\n', refreshing: false });
	// A copy that is not whole JSON is no answer.
	forgetStats();
	keepStatsIn(kept);
	writeFileSync(kept, '{"n":');
	expect(keptStats(bin, 5000)).toBeNull();
});

test("the models list: a hung omp fails the call within its limit, and the next call starts afresh", async () => {
	const omp = hungOmp();
	// `--mode rpc-ui` never says ready.
	await expect(availableModels(omp.bin, true, LIMIT, LIMIT)).rejects.toBeInstanceOf(RunTimeout);
	await pollUntil(() => allGone(omp.pids()), "the hung omp to be killed");

	// omp is healthy again: the call is not stuck behind the one that hung.
	const healthy = join(dir, "healthy-omp");
	writeFileSync(
		healthy,
		`#!/usr/bin/env bun
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
out({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] });
let buf = "";
for await (const chunk of Bun.stdin.stream()) {
  buf += new TextDecoder().decode(chunk);
  let nl;
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const cmd = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
    out({ id: cmd.id, type: "response", command: cmd.type, success: true, data: { models: [{ provider: "p", id: "m" }] } });
  }
}
`,
	);
	chmodSync(healthy, 0o755);
	expect(await availableModels(healthy, true, 20_000, 20_000)).toEqual([{ provider: "p", id: "m" }]);
});

test("the overlay the server waits for at start-up: an omp that hangs on `config get` costs the limit, not the server", async () => {
	const omp = hungOmp();
	// Not waiting for the `sleep 600` it hangs on: the limit ends the read, and the overlay is written.
	const file = await writeOverlay(omp.bin, dir, LIMIT);
	// The same overlay as for an omp that has no such setting.
	expect(readFileSync(file, "utf8")).toContain('continuationModes: ["interactive","rpc"]');
	await pollUntil(() => allGone(omp.pids()), "the hung omp to be killed");
});

test("omp's settings: a read that hangs is 'cannot say'; a write that hangs fails", async () => {
	const omp = hungOmp();
	expect(await configuredApprovalMode(omp.bin, undefined, undefined, LIMIT)).toBeNull();
	expect(await configuredUsageWait(omp.bin, undefined, undefined, LIMIT)).toBeNull();
	await expect(configureUsageWait(omp.bin, true, undefined, LIMIT)).rejects.toBeInstanceOf(RunTimeout);
	await pollUntil(() => allGone(omp.pids()), "the hung commands to be killed");
});

test("omp --version and --help: a hang is an error, not a request that never ends", async () => {
	const omp = hungOmp();
	await expect(ompVersion(omp.bin, LIMIT)).rejects.toBeInstanceOf(RunTimeout);
	await expect(cliInventory(omp.bin, LIMIT)).rejects.toBeInstanceOf(RunTimeout);
	await expect(cliHelp(omp.bin, "stats", LIMIT)).rejects.toBeInstanceOf(RunTimeout);
	await pollUntil(() => allGone(omp.pids()), "the hung commands to be killed");
});

test("an export that hangs fails, and leaves nothing of the conversation on disk", async () => {
	const omp = hungOmp();
	const data = join(dir, "data");
	mkdirSync(data, { recursive: true });
	// The export is asked again until the fake omp has recorded it: a limit that ends the command before the fake got
	// to its first line ends a command that never ran, and says nothing about an export that hangs (#499).
	await expect(
		untilRecorded(omp, "--export", () => exportSession(omp.bin, data, join(dir, "s.jsonl"), LIMIT)),
	).rejects.toBeInstanceOf(RunTimeout);
	await pollUntil(() => allGone(omp.pids()), "the hung export to be killed");
	expect(existsSync(join(data, "exports"))).toBe(true);
	expect(omp.calls().some((c) => c.startsWith("--export"))).toBe(true);
	expect(readdirSync(join(data, "exports"))).toEqual([]);
});

test("a rename through an omp that does not say it is ready fails within its limit and kills that omp", async () => {
	const omp = hungOmp();
	const cfg = fakeConfig(dir, omp.bin);
	const actions = new SessionActions(cfg, new LivePool(cfg), LIMIT);
	await expect(
		actions.rename({ file: join(dir, "s.jsonl"), id: "01a00000-0000-7000-8000-00000000a1a1", cwd: dir }, "title"),
	).rejects.toBeInstanceOf(RunTimeout);
	await pollUntil(() => allGone(omp.pids()), "the omp that never became ready to be killed");
});

/** Replace the hung omp by one that answers: omp is healthy again. */
function heal(bin: string, body: string): void {
	writeFileSync(bin, `#!/bin/sh\n${body}\n`);
	chmodSync(bin, 0o755);
}

test("the Loaded dialog's and the toggles' omp commands: a hung `config get` or `plugin list` ends at its limit with its whole group, and the next one runs", async () => {
	const omp = hungOmp();
	// The shell dies at the limit but its `sleep` keeps the pipes: the old pattern then waited for them for ten minutes.
	await expect(runJson(omp.bin, ["config", "get", "x", "--json"], dir, {}, LIMIT)).rejects.toBeInstanceOf(RunTimeout);
	await pollUntil(() => allGone(omp.pids()), "the hung omp and its child to be gone");
	heal(omp.bin, `echo '{"value":["a"]}'`);
	expect(await runJson(omp.bin, ["config", "get", "x", "--json"], dir, {}, LIMIT)).toEqual({ value: ["a"] });
	// What it prints is checked as before: a failure names its stderr, and text that is no JSON is no answer.
	heal(omp.bin, `echo "boom: no" >&2\nexit 3`);
	await expect(runJson(omp.bin, ["plugin", "list", "--json"], dir, {}, LIMIT)).rejects.toThrow("boom: no");
	heal(omp.bin, `echo not json`);
	await expect(runJson(omp.bin, ["plugin", "list", "--json"], dir, {}, LIMIT)).rejects.toThrow("did not print JSON");
});

test("the model settings: a read that hangs ends at its limit and does not hold up the reads and writes queued behind it", async () => {
	const omp = hungOmp();
	const cfg = fakeConfig(dir, omp.bin);
	// `absentModels` stands for every read and write: they all wait their turn in one queue.
	const first = absentModels(cfg, dir, { roles: {} }, LIMIT);
	const second = absentModels(cfg, dir, { roles: { default: "p/m" } }, LIMIT);
	await expect(first).rejects.toBeInstanceOf(RunTimeout);
	await expect(second).rejects.toBeInstanceOf(RunTimeout);
	await pollUntil(() => allGone(omp.pids()), "the hung omp commands and their children to be gone");
	heal(omp.bin, `echo '{"modelRoles":{"value":{"default":"p/m","smol":"p/s"}}}'`);
	expect(await absentModels(cfg, dir, { roles: { default: "p/m" } }, LIMIT)).toEqual({ roles: ["smol"], agents: [] });
});

test("omp --version at start-up: a hang is 'cannot run' at the limit, with the command and what it started gone", async () => {
	const omp = hungOmp();
	// The probe is asked again until the fake omp has recorded it: a limit that ends the command before the fake got
	// to its first line ends a command that never ran, and says nothing about a hung omp (#499).
	const probed = await untilRecorded(omp, "--version", () => probeOmp(omp.bin, { PATH: process.env.PATH }, LIMIT));
	expect(probed.ok).toBe(false);
	if (!probed.ok) expect(probed.error).toContain("no answer");
	await pollUntil(() => allGone(omp.pids()), "the hung omp --version and its child to be gone");
	// An omp that answers is found, and what it sees is the environment it is given, not the server's.
	heal(omp.bin, `echo "omp/$ASKED"`);
	expect(await probeOmp(omp.bin, { PATH: process.env.PATH, ASKED: "18.12.2" }, LIMIT)).toEqual({
		ok: true,
		version: "18.12.2",
	});
});

test("omp usage: a run that hangs is killed with what it started, not only its shell", async () => {
	const omp = hungOmp();
	await expect(providerUsage(omp.bin, "anthropic", true, LIMIT)).rejects.toBeInstanceOf(RunTimeout);
	await pollUntil(() => allGone(omp.pids()), "the hung omp usage and its child to be gone");
});
