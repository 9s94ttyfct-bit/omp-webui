import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { has } from "../support/needs.ts";
import { pruneSessions, sessionEntries } from "../support/session-prune.ts";

/**
 * A worker-scoped e2e server keeps the conversations it started with and the current spec file's, no others (#7, A-025):
 * what an earlier file wrote is taken away at the next file's first test, the fixtures stay, written to or not, and what
 * the next file wrote before that test (its `beforeAll`) stays too (A-036).
 */

const root = mkdtempSync(join(tmpdir(), "ompw-session-prune-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** An agent folder with one fixture conversation; what it holds then is what the server started with. */
function started(name: string) {
	const agentDir = join(root, name);
	const bucket = join(agentDir, "sessions", "-tmp-fixture");
	mkdirSync(bucket, { recursive: true });
	writeFileSync(join(bucket, "alpha.jsonl"), "{}\n");
	return { agentDir, bucket, seeded: sessionEntries(agentDir) };
}

/** A spec file wrote 250 conversations, one with a subagent's folder, in the fixture project and in a project of its own. */
function earlierFile(agentDir: string, bucket: string) {
	for (let i = 0; i < 250; i++) writeFileSync(join(bucket, `spec-${i}.jsonl`), "{}\n");
	mkdirSync(join(bucket, "spec-0"));
	writeFileSync(join(bucket, "spec-0", "sub.jsonl"), "{}\n");
	mkdirSync(join(agentDir, "sessions", "-tmp-own-project"));
	writeFileSync(join(agentDir, "sessions", "-tmp-own-project", "own.jsonl"), "{}\n");
	// And added to a fixture.
	writeFileSync(join(bucket, "alpha.jsonl"), "{}\n{}\n");
}

test("what the earlier file left goes, folders and all; the fixtures stay", () => {
	const { agentDir, bucket, seeded } = started("agent");
	earlierFile(agentDir, bucket);
	const left = sessionEntries(agentDir);

	expect(pruneSessions(agentDir, seeded, left)).toBeGreaterThanOrEqual(253);
	expect([...sessionEntries(agentDir)].sort()).toEqual([...seeded].sort());
	expect(existsSync(join(bucket, "alpha.jsonl"))).toBe(true);
	// Nothing more to take away.
	expect(pruneSessions(agentDir, seeded, left)).toBe(0);
});

test.skipIf(!has.notWindowsYet)(
	"what the next file wrote before its first test (a beforeAll) stays, in a folder the earlier file made too (A-036)",
	() => {
		const { agentDir, bucket, seeded } = started("agent-before-all");
		earlierFile(agentDir, bucket);
		// The earlier file's last test has ended; then the next file's beforeAll writes, in the fixture project and in the
		// project folder the earlier file had made, before its first test (where the prune runs).
		const left = sessionEntries(agentDir);
		writeFileSync(join(bucket, "next-0.jsonl"), "{}\n");
		writeFileSync(join(agentDir, "sessions", "-tmp-own-project", "next-1.jsonl"), "{}\n");

		pruneSessions(agentDir, seeded, left);
		expect([...sessionEntries(agentDir)].sort()).toEqual(
			[...seeded, "-tmp-fixture/next-0.jsonl", "-tmp-own-project", "-tmp-own-project/next-1.jsonl"].sort(),
		);
	},
);
