/**
 * The unit and contract tests that only a Mac runs (`bun run test:mac`), run by scripts/release-local.ts before the live
 * tests. CI runs every one of these files on Linux, where what they test of macOS skips: the Swift harnesses of the app's
 * shell (`macos-*`), signing, the disk image and the updater's install steps, and the cases of the server that take
 * macOS's own answer (folders, the host's readings, sleep). Without this step those cases ran only when someone ran the
 * whole suite on a Mac by hand.
 *
 * `MAC_TESTS` is the list, by hand. tests/unit/mac-tests.test.ts keeps it whole: every test file under tests/ that
 * compares `process.platform` with "darwin" is in it, and nothing else is. The tests that open real windows
 * (`OMPW_GUI_TESTS=1`, tests/support/gui-tests.ts) still skip here: they take the focus of whoever uses the Mac, and stay
 * `bun run test:gui`, by hand.
 *
 * It refuses to run off macOS or without `swiftc` (the Xcode command line tools), since the harness tests would all skip
 * and the step would pass having proved nothing.
 */
import { spawn } from "node:child_process";
import { constants } from "node:os";
import { join } from "node:path";
import { killTree, onShutdown } from "./lib/shutdown.ts";

/** The test files with cases that run only on macOS, relative to the checkout. */
export const MAC_TESTS = [
	"tests/contract/btw-model.test.ts",
	"tests/contract/folder.test.ts",
	"tests/contract/host.test.ts",
	"tests/contract/sleep.test.ts",
	"tests/contract/update.test.ts",
	"tests/unit/files.test.ts",
	"tests/unit/folder.test.ts",
	"tests/unit/host-gpu-guard.test.ts",
	"tests/unit/host-sampler.test.ts",
	"tests/unit/macos-appshots.test.ts",
	"tests/unit/macos-background.test.ts",
	"tests/unit/macos-drop.test.ts",
	"tests/unit/macos-no-zoom.test.ts",
	"tests/unit/macos-notify.test.ts",
	"tests/unit/macos-output.test.ts",
	"tests/unit/macos-quit.test.ts",
	"tests/unit/macos-remote.test.ts",
	"tests/unit/macos-server.test.ts",
	"tests/unit/macos-shell-events.test.ts",
	"tests/unit/macos-update.test.ts",
	"tests/unit/macos-window-frame.test.ts",
	"tests/unit/signing-identity.test.ts",
	"tests/unit/update-service.test.ts",
	"tests/unit/update-steps.test.ts",
	"tests/unit/update-verify.test.ts",
];

if (import.meta.main) {
	if (process.platform !== "darwin") {
		console.error("These are the tests only macOS runs: run them on a Mac.");
		process.exit(1);
	}
	if (Bun.which("swiftc") === null) {
		console.error(
			"swiftc is missing, so every test of the app's Swift shell would skip: install the Xcode command line tools (xcode-select --install), then run them again.",
		);
		process.exit(1);
	}
	const root = join(import.meta.dir, "..");
	// The windowed tests stay by hand (`bun run test:gui`), whatever the shell this runs from has set.
	const env = { ...process.env };
	delete env.OMPW_GUI_TESTS;
	const child = spawn("bun", ["test", "--parallel", "--timeout", "30000", ...MAC_TESTS.map((file) => `./${file}`)], {
		cwd: root,
		env,
		stdio: "inherit",
	});
	const cleanup = onShutdown(async () => {
		if (child.pid) await killTree(child.pid, 15_000);
	});
	const finished = Promise.withResolvers<number>();
	child.once("error", (error) => {
		console.error(`bun: ${error.message}`);
		finished.resolve(127);
	});
	child.once("exit", (status, signal) => finished.resolve(status ?? 128 + (signal ? constants.signals[signal] : 0)));
	const code = await finished.promise;
	await cleanup();
	process.exit(code);
}
