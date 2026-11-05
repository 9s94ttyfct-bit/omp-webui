import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type CpuProfile, selfTimeByNode } from "../../scripts/lib/cpu-profile.ts";

/**
 * The self time of a `.cpuprofile`, as scripts/cpu-summary.ts, scripts/freeze/profile.ts and scripts/open-big.ts report it:
 * `timeDeltas[i]` is the gap before sample `i`, so a sample is charged the time until the next one (the last, the time
 * until the profile's end), as Chrome DevTools charges it, and every tool gives the same table for one profile.
 */

const ROOT = join(import.meta.dir, "..", "..");
const dir = mkdtempSync(join(tmpdir(), "ompw-cpu-profile-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const frame = (functionName: string, url: string, lineNumber: number) => ({ functionName, url, lineNumber });
/** a, then b, then a again: a is in the profile for 100 + 10 ms, b for 1000 ms (times in µs). */
const PROFILE: CpuProfile = {
	nodes: [
		{ id: 1, callFrame: frame("(root)", "", -1), children: [2, 3] },
		{ id: 2, callFrame: frame("a", "/x/a.js", 1) },
		{ id: 3, callFrame: frame("b", "/x/b.js", 4) },
	],
	startTime: 0,
	endTime: 1_115_000,
	samples: [2, 3, 2],
	timeDeltas: [5_000, 100_000, 1_000_000],
};

function run(script: string, ...args: string[]): string {
	const file = join(dir, "p.cpuprofile");
	writeFileSync(file, JSON.stringify(PROFILE));
	const r = Bun.spawnSync([process.execPath, join(ROOT, "scripts", script), file, ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(r.stderr.toString()).toBe("");
	return r.stdout.toString();
}

test("each sample is charged the time until the next one, the last the time until the profile ends", () => {
	expect(selfTimeByNode(PROFILE)).toEqual(
		new Map([
			[2, 110_000],
			[3, 1_000_000],
		]),
	);
	// A profile without its end: the last sample's time is not known, and nothing is made up for it.
	const { endTime: _, ...open } = PROFILE;
	expect(selfTimeByNode(open)).toEqual(
		new Map([
			[2, 100_000],
			[3, 1_000_000],
		]),
	);
});

test("cpu-summary.ts and freeze/profile.ts give one profile the same self times", () => {
	const summary = run("cpu-summary.ts");
	expect(summary).toMatch(/^\s+1000 ms {2}b b\.js:4$/m);
	expect(summary).toMatch(/^\s+110 ms {2}a a\.js:1$/m);
	const freeze = run("freeze/profile.ts", "--top", "15");
	expect(freeze).toMatch(/^\s+1000 ms\s+[\d.]+ % {2}b \/x\/b\.js:5$/m);
	expect(freeze).toMatch(/^\s+110 ms\s+[\d.]+ % {2}a \/x\/a\.js:2$/m);
});
