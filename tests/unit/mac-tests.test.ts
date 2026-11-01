import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { MAC_ONLY, MAC_TESTS } from "../../scripts/mac-tests.ts";

/**
 * `MAC_TESTS` (scripts/mac-tests.ts) is what the release runs on its Mac before the live tests, since CI's Linux skips
 * what these files test of macOS. It is read from the tests: a case only a Mac runs gates on a capability macOS has and
 * Linux has not, or on the darwin adapter's id. A file that asked `process.platform` instead would be left out of that
 * step without anyone seeing it, so none may.
 */

const root = join(import.meta.dir, "..", "..");
const MAC_GUARD = /process\.platform\s*[!=]==?\s*["']darwin["']|["']darwin["']\s*[!=]==?\s*process\.platform/;

function testFiles(dir: string): string[] {
	return readdirSync(dir, { recursive: true, encoding: "utf8" })
		.filter((name) => /\.(test|spec)\.tsx?$/.test(name))
		.map((name) => relative(root, join(dir, name)));
}

test("no test asks process.platform whether it runs on macOS: it asks a capability, which the macOS step finds", () => {
	const guarded = testFiles(join(root, "tests")).filter((file) =>
		MAC_GUARD.test(readFileSync(join(root, file), "utf8")),
	);
	expect(guarded).toEqual([]);
});

test("the capabilities that make a test the macOS step's are the ones macOS has and Linux has not", () => {
	expect([...MAC_ONLY].sort()).toEqual(["appShell", "appUpdate", "gpuLoad", "keepAwake", "openFiles"]);
});

test("the list holds the app shell's harnesses, the updater's, signing, and the server's macOS answers, each once", () => {
	for (const file of [
		"tests/unit/macos-remote.test.ts",
		"tests/unit/macos-window-frame.test.ts",
		"tests/unit/update-service.test.ts",
		"tests/unit/signing-identity.test.ts",
		"tests/unit/files.test.ts",
		"tests/contract/btw-model.test.ts",
		"tests/contract/folder.test.ts",
		"tests/contract/host.test.ts",
		"tests/contract/sleep.test.ts",
	])
		expect(MAC_TESTS).toContain(file);
	// Nothing that runs the same everywhere: the adapter's own tests ask every system's rules on any one.
	expect(MAC_TESTS).not.toContain("tests/unit/platform-adapter.test.ts");
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
