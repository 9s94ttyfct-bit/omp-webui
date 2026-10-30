import { afterAll, afterEach, beforeAll, beforeEach, expect, setSystemTime, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { providerUsage } from "../../server/omp/usage.ts";

/**
 * The server's cache of a provider's usage. The page looks at the quota every {@link LOOK_MS} while a conversation
 * works, and the server keeps each provider's figures for a little less than that: a look is then answered from the
 * cache, and the figures a page shows are never older than one interval. How many conversations and tabs ask does not
 * change how often `omp usage` runs (#458): one run per provider per interval, and the callers that arrive while it
 * runs share it.
 *
 * The interval is written out here rather than read from the code, so that the test pins what a user sees — the
 * figures are at most half a minute old — and not how the code happens to spell it.
 */

/** The page looks at the quota this often while a conversation works. */
const LOOK_MS = 30_000;

const root = mkdtempSync(join(tmpdir(), "ompw-usage-cache-"));
const stub = join(root, "omp-stub");
const runs = join(root, "omp-stub.runs");
const report = { provider: "stub", limits: [] };

beforeAll(() => {
	// The stub records that it ran, and answers at once.
	writeFileSync(stub, `#!/bin/sh\necho run >> "${runs}"\necho '${JSON.stringify({ reports: [report] })}'\n`);
	chmodSync(stub, 0o755);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => rmSync(runs, { force: true }));
afterEach(() => setSystemTime());

/** How often the stub ran: one line per run. */
const count = (): number => (existsSync(runs) ? readFileSync(runs, "utf8").split("\n").filter(Boolean).length : 0);

test("many callers in one interval share one `omp usage` run", async () => {
	const answers = await Promise.all([
		providerUsage(stub, "shared"),
		providerUsage(stub, "shared"),
		providerUsage(stub, "shared"),
	]);
	for (const a of answers) expect(a).toEqual([report]);
	expect(count()).toBe(1);
});

test("a provider's figures are asked for again within the interval the page looks at", async () => {
	const now = Date.parse("2026-10-20T12:00:00.000Z");
	setSystemTime(new Date(now));
	await providerUsage(stub, "ttl");
	expect(count()).toBe(1);

	// Half an interval later: what is known is what is answered, and nothing runs.
	setSystemTime(new Date(now + LOOK_MS / 2));
	await providerUsage(stub, "ttl");
	expect(count()).toBe(1);

	// Past the interval: the provider is asked again, so the figures are never older than one interval.
	setSystemTime(new Date(now + LOOK_MS + 1000));
	await providerUsage(stub, "ttl");
	expect(count()).toBe(2);
});

test("two providers are asked for on their own", async () => {
	await providerUsage(stub, "one");
	await providerUsage(stub, "two");
	expect(count()).toBe(2);
});
