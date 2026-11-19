import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilities } from "../../server/platform/capabilities.ts";

/**
 * Where the macOS app's pop-outs go when its server stopped on its own and came back on another port (#378): each shows its
 * page again at the new address (`PopOutWindows.serverMoved`, with `movedPageURL` of macos/navigation.swift), where before
 * only the main window followed and the pop-outs stayed on a port nothing answers. Compiled with the `swiftc` the app is
 * built with; no window (the pop-outs' own windows are macos-popout.test.ts, `bun run test:gui`).
 */

const here = import.meta.dir;
const dir = mkdtempSync(join(tmpdir(), "ompw-navigation-"));
const harness = join(dir, "navigation-harness");
const mac = capabilities.appShell && Bun.which("swiftc") !== null;

let report: Record<string, string | null>;

beforeAll(() => {
	if (!mac) return;
	const built = Bun.spawnSync(
		[
			"swiftc",
			"-O",
			"-swift-version",
			"5",
			join(here, "../../macos/navigation.swift"),
			join(here, "../support/swift/navigation/main.swift"),
			"-o",
			harness,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (built.exitCode !== 0) throw new Error(`swiftc failed:\n${built.stderr.toString()}`);
	const run = Bun.spawnSync([harness], { stdout: "pipe", stderr: "pipe" });
	if (run.exitCode !== 0) throw new Error(`harness exited ${run.exitCode}: ${run.stderr.toString()}`);
	report = JSON.parse(run.stdout.toString());
}, 180_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test.skipIf(!mac)("a page of the old server is the same page at the new port, its path, query and hash kept", () => {
	expect(report.popOut).toBe("http://127.0.0.1:7879/?popout#/s/%2Ftmp%2Fa.jsonl/agent/Scout");
	expect(report.browser).toBe("http://127.0.0.1:7879/?popout#/live/L1/browser");
	expect(report.pathAndQuery).toBe("http://127.0.0.1:7879/api/meta?x=1&y=2");
});

test.skipIf(!mac)("anything that is not a page of the old server is left where it is", () => {
	for (const key of ["alreadyMoved", "otherPort", "otherHost", "otherScheme", "blank", "none", "samePort"]) {
		expect(report[key], key).toBeNull();
	}
});
