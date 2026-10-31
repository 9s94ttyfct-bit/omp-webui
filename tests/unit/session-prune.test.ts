import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pruneSessions, sessionEntries } from "../support/session-prune.ts";

/**
 * A worker-scoped e2e server keeps the conversations it started with and the current spec file's, no others (#7, A-025):
 * what an earlier file wrote is taken away at the next file's first test, the fixtures stay, written to or not.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-session-prune-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("what the server did not start with goes, folders and all; the fixtures stay", () => {
	const agentDir = join(root, "agent");
	const bucket = join(agentDir, "sessions", "-tmp-fixture");
	mkdirSync(bucket, { recursive: true });
	writeFileSync(join(bucket, "alpha.jsonl"), "{}\n");
	const seeded = sessionEntries(agentDir);

	// A spec file wrote 250 conversations, one with a subagent's folder, in the fixture project and in a project of its own,
	// and added to a fixture.
	for (let i = 0; i < 250; i++) writeFileSync(join(bucket, `spec-${i}.jsonl`), "{}\n");
	mkdirSync(join(bucket, "spec-0"));
	writeFileSync(join(bucket, "spec-0", "sub.jsonl"), "{}\n");
	mkdirSync(join(agentDir, "sessions", "-tmp-own-project"));
	writeFileSync(join(agentDir, "sessions", "-tmp-own-project", "own.jsonl"), "{}\n");
	writeFileSync(join(bucket, "alpha.jsonl"), "{}\n{}\n");

	expect(pruneSessions(agentDir, seeded)).toBeGreaterThanOrEqual(252);
	expect([...sessionEntries(agentDir)].sort()).toEqual([...seeded].sort());
	expect(existsSync(join(bucket, "alpha.jsonl"))).toBe(true);
	// Nothing more to take away.
	expect(pruneSessions(agentDir, seeded)).toBe(0);
});
