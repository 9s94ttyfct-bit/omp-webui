import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * How the macOS shell keeps its server (macos/server.swift): started again when it dies on its own (#373), its last
 * words reported whole and without a data race (#374), stopped without blocking the main thread (#375). Compiled with
 * the `swiftc` the app is built with, a harness (tests/support/swift/supervisor/main.swift) runs the app's supervisor on
 * shell scripts that play the server, with the main queue as the events queue as in the app. The shell's own former
 * code is the control of each measurement that has one: it shows that the measurement sees the bug.
 *
 * The harness is also built with ThreadSanitizer, where there is one, and the supervisor's scenarios run under it:
 * the race of #374 is a race, and a run that happens to read the right text proves little.
 */

const here = import.meta.dir;
const dir = mkdtempSync(join(tmpdir(), "ompw-supervisor-"));
const harness = join(dir, "supervisor-harness");
const tsanHarness = join(dir, "supervisor-harness-tsan");
const mac = process.platform === "darwin" && Bun.which("swiftc") !== null;

async function build(output: string, ...flags: string[]): Promise<boolean> {
	const compiled = Bun.spawn(
		[
			"swiftc",
			"-O",
			...flags,
			"-swift-version",
			"5",
			join(here, "../../macos/server.swift"),
			join(here, "../../macos/serveroutput.swift"),
			join(here, "../support/swift/supervisor/main.swift"),
			"-o",
			output,
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const [err, code] = await Promise.all([new Response(compiled.stderr).text(), compiled.exited]);
	if (code !== 0 && flags.length === 0) throw new Error(`swiftc failed:\n${err}`);
	return code === 0;
}

// The sanitizer's runtime may be missing on a machine that can compile: those tests are skipped, not failed.
const [, tsan] = mac ? await Promise.all([build(harness), build(tsanHarness, "-sanitize=thread")]) : [false, false];
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function run(
	binary: string,
	...args: string[]
): Promise<{ report: Record<string, unknown>; stderr: string; code: number }> {
	const p = Bun.spawn([binary, ...args], { stdout: "pipe", stderr: "pipe" });
	const [out, stderr, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	if (code !== 0 && !stderr.includes("ThreadSanitizer")) throw new Error(`harness exited ${code}: ${stderr}`);
	return { report: out.trim() ? JSON.parse(out.trim().split("\n").pop() as string) : {}, stderr, code };
}

test.skipIf(!mac)(
	"a crashed server's last words are in the failure report: 200 of 200, with the main thread idle or busy",
	async () => {
		const [idle, busy] = await Promise.all([
			run(harness, "last-line", "200"),
			run(harness, "last-line", "200", "busy"),
		]);
		expect(idle.report).toEqual({ runs: 200, missing: 0, wrongExit: 0 });
		expect(busy.report).toEqual({ runs: 200, missing: 0, wrongExit: 0 });
	},
	120_000,
);

test.skipIf(!mac)(
	"the shell's former way (the log read on the exit callback, the output appended on the main queue) loses them (the control)",
	async () => {
		const { report } = await run(harness, "last-line-control", "200", "busy");
		// With the main queue busy, most of the 200 runs lost the last line (162 when this was written); idle, about one in six.
		expect(report.missing as number).toBeGreaterThan(20);
	},
	120_000,
);

test.skipIf(!mac)(
	"a server that dies is started again, with the same environment, and told so each time it is ready",
	async () => {
		const { report } = await run(harness, "restarts");
		expect(report.reachedThree).toBe(true);
		expect(report.events).toEqual(["ready:1", "ready:2", "ready:3"]);
		// The token (and with it the data dir, port and the rest of the launch) is the same for every start.
		expect(report.environments).toEqual(["tok-123", "tok-123", "tok-123"]);
		expect(report.stopOnMain).toBe(true);
		expect(report.stopSeconds as number).toBeLessThan(3);
	},
	60_000,
);

test.skipIf(!mac)(
	"a server that keeps dying ends the restarts: four starts, then the failure with what it printed, then nothing",
	async () => {
		const { report } = await run(harness, "gives-up");
		const events = report.events as string[];
		expect(events.slice(0, 4)).toEqual(["ready:9", "ready:9", "ready:9", "ready:9"]);
		expect(events).toHaveLength(5);
		expect(events[4]).toStartWith("failed:The omp-webui server stopped|Exit code 3.");
		expect(events[4]).toContain("fatal: it never works");
		// A fifth start would have shown within the second the harness waited after the failure.
		expect(report.starts).toBe(4);
	},
	60_000,
);

test.skipIf(!mac)(
	"stops that are far enough apart never add up to a failure: a server that dies every half second runs on",
	async () => {
		const { report } = await run(harness, "window");
		expect(report.reachedSix).toBe(true);
		expect((report.events as string[]).some((e) => e.startsWith("failed:"))).toBe(false);
	},
	60_000,
);

test.skipIf(!mac)(
	"stopping answers when the server is gone, on the main queue, with the main thread free",
	async () => {
		const { report } = await run(harness, "stop-polite");
		expect(report.gone).toBe(true);
		expect(report.stopOnMain).toBe(true);
		expect(report.stopSeconds as number).toBeLessThan(3);
	},
	60_000,
);

test.skipIf(!mac)(
	"a server that ignores SIGTERM is killed at the deadline, and the main thread keeps running meanwhile (#375)",
	async () => {
		const { report } = await run(harness, "stop-stubborn");
		expect(report.gone).toBe(true);
		expect(report.stopOnMain).toBe(true);
		// The deadline is 1.5 s: SIGKILL comes then, and not before.
		expect(report.stopSeconds as number).toBeGreaterThanOrEqual(1.5);
		expect(report.stopSeconds as number).toBeLessThan(6);
		// A 10 ms timer on the main thread never waited for half a second.
		expect(report.worstMainGap as number).toBeLessThan(0.5);
	},
	60_000,
);

test.skipIf(!mac)(
	"the blocking stop the shell had before keeps the main thread from running for the whole wait (the control)",
	async () => {
		const { report } = await run(harness, "stop-control");
		expect(report.worstMainGap as number).toBeGreaterThanOrEqual(1.4);
	},
	60_000,
);

test.skipIf(!mac)(
	"a stop in the gap between the server's death and its restart cancels the restart",
	async () => {
		const { report } = await run(harness, "stop-while-restarting");
		expect(report.starts).toBe(1);
	},
	60_000,
);

test.skipIf(!tsan)(
	"ThreadSanitizer finds no data race in the supervisor (start, crash, restart, give up, stop), and finds the one in the former code (the control)",
	async () => {
		// The scenarios mostly wait for processes: they run side by side.
		const scenarios = [
			["last-line", "200", "busy"],
			// The loss control keeps the shell's order of events but not its unsynchronised access: it measures, it does not race.
			["last-line-control", "200", "busy"],
			["restarts"],
			["gives-up"],
			["stop-stubborn"],
			["stop-while-restarting"],
		];
		const [control, ...runs] = await Promise.all([
			run(tsanHarness, "last-line-race-control", "50"),
			...scenarios.map((scenario) => run(tsanHarness, ...scenario)),
		]);
		expect(control.stderr).toContain("ThreadSanitizer");
		for (const { stderr, code } of runs) {
			expect(stderr).not.toContain("ThreadSanitizer");
			expect(code).toBe(0);
		}
	},
	180_000,
);
