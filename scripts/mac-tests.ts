/**
 * The unit and contract tests that only a Mac runs (`bun run test:mac`), run by scripts/release-local.ts before the live
 * tests. CI runs every one of these files on Linux, where what they test of macOS skips: the Swift harnesses of the app's
 * shell (`macos-*`), signing, the disk image and the updater's install steps, and the cases of the server that take
 * macOS's own answer (folders, the host's readings, sleep). Without this step those cases ran only when someone ran the
 * whole suite on a Mac by hand.
 *
 * `MAC_TESTS` is the list, read from the tests themselves: a test file whose cases only a Mac runs gates them on a
 * capability macOS has and Linux has not (`MAC_ONLY`: `capabilities.appShell`, `appUpdate`, `openFiles`, `keepAwake`,
 * `gpuLoad`), as `capabilities.x`, `has.x` or a file's `// needs: x` line (tests/support/needs.ts, which Linux's shards
 * leave out), or, for a case about the system itself rather than a feature (BSD's `stat`, `~/Library`), on the darwin
 * adapter by its id (`platform.id === "darwin"`). tests/unit/mac-tests.test.ts holds the tests to that: none asks
 * `process.platform`. The tests that open real windows (`OMPW_GUI_TESTS=1`, tests/support/gui-tests.ts) still skip here:
 * they take the focus of whoever uses the Mac, and stay `bun run test:gui`, by hand.
 *
 * It refuses to run where one of `MAC_ONLY` is off or without `swiftc` (the Xcode command line tools), since the harness
 * tests would all skip and the step would pass having proved nothing.
 */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import { capabilities, capabilitiesFor } from "../server/platform/capabilities.ts";
import type { Capability } from "../shared/platform.ts";
import { killTree, onShutdown } from "./lib/shutdown.ts";
import { gateTestCommand } from "./lib/test-workers.ts";

const ROOT = join(import.meta.dirname, "..");

const mac = capabilitiesFor("darwin");
const linux = capabilitiesFor("linux");
/** The capabilities macOS has and Linux, where CI runs the suite, has not: what CI's run of a test file skips. */
export const MAC_ONLY = (Object.keys(mac) as Capability[]).filter((c) => mac[c] && !linux[c]);

/** A gate of a case only a Mac runs: a capability of `MAC_ONLY` (in code or a `// needs:` line), or the darwin adapter by its id. */
const MAC_GATE = new RegExp(
	`\\b(?:capabilities|has)\\.(?:${MAC_ONLY.join("|")})\\b|^// needs: .*\\b(?:${MAC_ONLY.join("|")})\\b|\\bplatform\\.id\\s*[!=]==?\\s*["']darwin["']`,
	"m",
);

/** The test files under `root`'s tests/ with cases that run only on macOS, relative to the checkout, sorted. */
export function macTests(root = ROOT): string[] {
	return readdirSync(join(root, "tests"), { recursive: true, encoding: "utf8" })
		.filter((name) => /\.test\.tsx?$/.test(name))
		.map((name) => `tests/${name.split("\\").join("/")}`)
		.filter((file) => MAC_GATE.test(readFileSync(join(root, file), "utf8")))
		.sort();
}

/** The test files with cases that run only on macOS, relative to the checkout. */
export const MAC_TESTS = macTests();

if (import.meta.main) {
	if (MAC_ONLY.some((c) => !capabilities[c])) {
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
	// Half the cores at most (scripts/lib/test-workers.ts): the Mac that runs this is usually in use (#1).
	const [bin, ...args] = gateTestCommand(["--timeout", "30000", ...MAC_TESTS.map((file) => `./${file}`)], env);
	console.log(`$ ${bin} ${args.join(" ")}`);
	const child = spawn(bin, args, { cwd: root, env, stdio: "inherit" });
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
