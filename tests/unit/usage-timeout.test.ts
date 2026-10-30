import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerUsage } from "../../server/omp/usage.ts";
import { pollUntil, processExists } from "../support/poll.ts";

/**
 * `omp usage` that never answers must not hold the quota pill hostage: the run is killed and rejected after its
 * timeout, and a forced refresh does not wait for a run that is stuck. The stub is a real child process, so the
 * timeout here is the real one, just short.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-usage-timeout-"));
const stub = join(root, "omp-stub");
const hang = `${stub}.hang`;
const pids = `${stub}.pids`;
const report = { provider: "stub", limits: [] };

beforeAll(() => {
	// While the marker file exists the stub records its pid and sleeps; without it, it answers at once.
	writeFileSync(
		stub,
		`#!/bin/sh\nif [ -e "${hang}" ]; then echo $$ >> "${pids}"; exec sleep 60; fi\necho '${JSON.stringify({ reports: [report] })}'\n`,
	);
	chmodSync(stub, 0o755);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
// What a test left (a failed one before it removed them) is not for the next: a stub that hangs, and the pids it recorded.
afterEach(() => {
	rmSync(hang, { force: true });
	rmSync(pids, { force: true });
});

const recorded = (): number[] =>
	existsSync(pids) ? readFileSync(pids, "utf8").split("\n").filter(Boolean).map(Number) : [];

// The stub is a shell script that has to get to its first line before the limit ends it: with every core taken that
// takes longer than the few milliseconds it does alone, so the limit is not a short one. That the limit ends the run is
// not timed: the stub hangs for a minute, and a limit that ended nothing fails the test by the test's own timeout.
test("a run that never answers is killed and rejected after the timeout", async () => {
	writeFileSync(hang, "");
	await expect(providerUsage(stub, "stalled", false, 2000)).rejects.toThrow("no answer");
	const [pid] = recorded() as [number];
	expect(pid).toBeGreaterThan(0);
	await pollUntil(() => !processExists(pid), "the stuck omp usage process to be killed");
});

test("after a timeout the next call starts a new run instead of joining the dead one", async () => {
	expect(await providerUsage(stub, "stalled")).toEqual([report]);
});

test("force does not reuse a run that is stuck", async () => {
	writeFileSync(hang, "");
	const stuck = providerUsage(stub, "forced", false, 30_000);
	const stuckResult = stuck.then(
		() => "answered",
		() => "rejected",
	);
	await pollUntil(() => recorded().length === 1, "the stuck run to start");
	// Plain calls still share the stuck run (they would have answered at once had they run the stub) ...
	const joined = providerUsage(stub, "forced", false, 30_000).then(
		() => "answered",
		() => "rejected",
	);
	rmSync(hang);
	// ... a forced one runs on its own and answers.
	expect(await providerUsage(stub, "forced", true)).toEqual([report]);
	// What it found is what the next plain call is given, not a rerun.
	rmSync(stub);
	expect(await providerUsage(stub, "forced")).toEqual([report]);
	// The superseded run is bounded by its timeout; end it here instead of waiting for that.
	for (const pid of recorded()) process.kill(pid, "SIGKILL");
	expect(await stuckResult).toBe("rejected");
	expect(await joined).toBe("rejected");
});
