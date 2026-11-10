import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listedTests, listSuite, readTimings, TIMINGS } from "../../scripts/e2e-shard.ts";
import { readBunTimings } from "../../scripts/test-shard.ts";

/**
 * CI splits its suites between runners by the time each part took (`tests/e2e/timings.json`, `.bun-test-timings.json`). A
 * part with no time weighs as a usual one, and a time whose part is gone weighs nothing but says the file is stale: either
 * way the shares drift apart, and every refresh then reorders the runners' files, which is what brings order-dependent
 * leaks to light at random (A-027). So a test added, renamed or removed comes with its time.
 */

const root = join(import.meta.dir, "..", "..");

// The list is the same on every system, and Linux and macOS check it. Listing loads every spec, which takes ~26 s on CI's
// Windows runners and now and then more than a minute (#33): there it would only add a timeout to no purpose.
test.skipIf(process.platform === "win32")(
	"every end-to-end test has a time in tests/e2e/timings.json, and every time there names a test",
	() => {
		const listed = listedTests(listSuite().suites).map((t) => t.key);
		const timings = readTimings(readFileSync(TIMINGS, "utf8"));
		const known = new Set(listed);
		// Time a test with a run of its own and `bun scripts/e2e-timings.ts <its JSON report>` (`OMPW_E2E_JSON=<file>`).
		expect(listed.filter((key) => timings[key] === undefined)).toEqual([]);
		// A renamed or removed test: `bun scripts/e2e-timings.ts` drops what names no test.
		expect(Object.keys(timings).filter((key) => !known.has(key))).toEqual([]);
	},
	60_000,
);

test("every unit and contract test file has a time in .bun-test-timings.json, and every time there names a file", () => {
	const files: string[] = [];
	for (const dir of ["tests/unit", "tests/contract"])
		for (const file of new Bun.Glob("**/*.test.{ts,tsx}").scanSync({ cwd: join(root, dir) }))
			files.push(`${dir}/${file}`);
	const timings = readBunTimings(readFileSync(join(root, ".bun-test-timings.json"), "utf8"));
	const present = new Set(files);
	// Time a file with `bun test --timings=.bun-test-timings.json --update-timings <file>`.
	expect(files.filter((file) => timings[file] === undefined).sort()).toEqual([]);
	expect(Object.keys(timings).filter((file) => !present.has(file))).toEqual([]);
});
