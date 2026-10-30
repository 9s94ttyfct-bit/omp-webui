import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The macOS shell reads the server's output through `followOutput` (macos/serveroutput.swift). When the server
 * stopped, the handler it used to install never removed itself at the end of the pipe and was called again at once,
 * for ever: the "server stopped" alert kept a whole CPU core busy for as long as it was open (#311). Compiled with the
 * same `swiftc` the app is built with, a small harness runs a server that prints and exits, and measures this
 * process's CPU in the second after. The former handler is its control: it shows that the measurement sees the spin.
 */

const here = import.meta.dir;
const dir = mkdtempSync(join(tmpdir(), "ompw-swift-"));
const harness = join(dir, "output-harness");
const mac = process.platform === "darwin" && Bun.which("swiftc") !== null;

beforeAll(() => {
	if (!mac) return;
	const built = Bun.spawnSync(
		[
			"swiftc",
			"-O",
			"-swift-version",
			"5",
			join(here, "../../macos/serveroutput.swift"),
			join(here, "../support/swift/main.swift"),
			"-o",
			harness,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	if (built.exitCode !== 0) throw new Error(`swiftc failed:\n${built.stderr.toString()}`);
}, 180_000);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Report {
	text: string;
	handlerCleared: boolean;
	callsInQuietSecond: number;
	cpuShare: number;
}

function run(...args: string[]): Report {
	const r = Bun.spawnSync([harness, ...args], { stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`harness exited ${r.exitCode}: ${r.stderr.toString()}`);
	return JSON.parse(r.stdout.toString());
}

test.skipIf(!mac)("after the server exits, the shell's output handler removes itself and the CPU stays idle", () => {
	const report = run();
	// What the server said before it stopped is all there (it goes into the "server stopped" alert).
	expect(report.text).toContain('OMPW_READY {"port":1}');
	expect(report.text).toContain("boom");
	expect(report.handlerCleared).toBe(true);
	expect(report.callsInQuietSecond).toBe(0);
	expect(report.cpuShare).toBeLessThan(0.1);
});

test.skipIf(!mac)("the handler the shell had before spins a core after the server exits (the control)", () => {
	const report = run("control");
	expect(report.handlerCleared).toBe(false);
	// The empty reads are the spin. How much of a core it gets depends on what else runs (the parallel suite): only
	// the fixed handler's share is asserted, as an upper bound.
	expect(report.callsInQuietSecond).toBeGreaterThan(10_000);
});
