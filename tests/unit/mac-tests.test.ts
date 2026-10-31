import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { MAC_TESTS } from "../../scripts/mac-tests.ts";

/**
 * `MAC_TESTS` (scripts/mac-tests.ts) is what the release runs on its Mac before the live tests, since CI's Linux skips
 * what these files test of macOS. A file that starts asking for macOS and is not added would be left out of that step
 * without anyone seeing it: the list is every test file that compares `process.platform` with "darwin", and only them.
 */

const root = join(import.meta.dir, "..", "..");
const MAC_GUARD = /process\.platform\s*[!=]==?\s*["']darwin["']|["']darwin["']\s*[!=]==?\s*process\.platform/;

function testFiles(dir: string): string[] {
	return readdirSync(dir, { recursive: true, encoding: "utf8" })
		.filter((name) => /\.test\.tsx?$/.test(name))
		.map((name) => relative(root, join(dir, name)));
}

test("every test file that asks whether it runs on macOS is run by the release's macOS step, and only those", () => {
	const guarded = testFiles(join(root, "tests"))
		.filter((file) => MAC_GUARD.test(readFileSync(join(root, file), "utf8")))
		.sort();
	expect([...MAC_TESTS].sort()).toEqual(guarded);
});

test("the list has no file twice", () => {
	expect(new Set(MAC_TESTS).size).toBe(MAC_TESTS.length);
});

test("the release runs the macOS step before the live tests, and `test:mac` is the script that runs the list", () => {
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
	expect(pkg.scripts["test:mac"]).toContain("scripts/mac-tests.ts");
	const release = readFileSync(join(root, "scripts", "release-local.ts"), "utf8");
	const mac = release.indexOf('"test:mac"');
	expect(mac).toBeGreaterThan(-1);
	expect(mac).toBeLessThan(release.indexOf('"test:live"'));
});
