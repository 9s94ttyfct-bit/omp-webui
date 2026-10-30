import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { descendants, killTree } from "../../scripts/lib/shutdown.ts";
import { processExists, pollUntil as until } from "../support/poll.ts";

/**
 * scripts/lib/shutdown.ts: what a script does when a signal stops it (Bun runs no `finally` and no 'exit' hook then),
 * and how it stops the processes it started. Each case runs a real script as a child and signals it.
 */

const HELPER = join(import.meta.dir, "..", "..", "scripts", "lib", "shutdown.ts");
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompw-shutdown-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Runs `body` in a script that has `onShutdown` and a `mark(text)` that appends to <dir>/marks. */
function script(body: string) {
	const file = join(dir, "script.ts");
	writeFileSync(
		file,
		`import { appendFileSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { onShutdown } from ${JSON.stringify(HELPER)};
const mark = (t: string) => appendFileSync(${JSON.stringify(join(dir, "marks"))}, t + "\\n");
${body}`,
	);
	return Bun.spawn([process.execPath, file], { stdout: "pipe", stderr: "pipe" });
}

const marks = () => (existsSync(join(dir, "marks")) ? readFileSync(join(dir, "marks"), "utf8").trim().split("\n") : []);
const ready = () => until(() => marks().includes("ready"), "the script to start", 10_000);

test("a signal runs the cleanups, the last registered first, and exits 128 + the signal", async () => {
	const proc = script(`
onShutdown(() => mark("first registered"));
onShutdown(async () => { await sleep(50); mark("second registered"); });
try { mark("ready"); await sleep(60_000); } finally { mark("finally (must not run: Bun runs none on a signal)"); }
`);
	await ready();
	proc.kill("SIGTERM");
	expect(await proc.exited).toBe(143);
	expect(marks()).toEqual(["ready", "second registered", "first registered"]);
});

test("SIGINT and SIGHUP are handled too", async () => {
	for (const [signal, code] of [
		["SIGINT", 130],
		["SIGHUP", 129],
	] as const) {
		rmSync(join(dir, "marks"), { force: true });
		const proc = script(`onShutdown(() => mark("cleaned")); mark("ready"); await sleep(60_000);`);
		await ready();
		proc.kill(signal);
		expect(await proc.exited).toBe(code);
		expect(marks()).toEqual(["ready", "cleaned"]);
	}
});

test("a cleanup runs once: a signal during the script's own cleanup waits for it instead of running it again", async () => {
	const proc = script(`
const cleanup = onShutdown(async () => { mark("start"); await sleep(400); mark("done"); });
mark("ready");
await cleanup();
await sleep(60_000);
`);
	await until(() => marks().includes("start"), "the cleanup to begin", 10_000);
	proc.kill("SIGTERM");
	expect(await proc.exited).toBe(143);
	expect(marks()).toEqual(["ready", "start", "done"]);
});

test("a cleanup that throws does not stop the others, and the exit code is still the signal's", async () => {
	const proc = script(`
onShutdown(() => mark("kept"));
onShutdown(() => { throw new Error("boom"); });
mark("ready"); await sleep(60_000);
`);
	await ready();
	proc.kill("SIGTERM");
	expect(await proc.exited).toBe(143);
	expect(marks()).toEqual(["ready", "kept"]);
	expect(await new Response(proc.stderr as ReadableStream).text()).toContain("cleanup failed: boom");
});

test("a second signal ends a cleanup that hangs", async () => {
	const proc = script(
		`onShutdown(() => { mark("stuck"); return Promise.withResolvers<void>().promise; }); mark("ready"); await sleep(60_000);`,
	);
	await ready();
	proc.kill("SIGTERM");
	await until(() => marks().includes("stuck"), "the cleanup to begin", 10_000);
	const second = Date.now();
	proc.kill("SIGTERM");
	expect(await proc.exited).toBe(143);
	expect(Date.now() - second).toBeLessThan(5000);
});

/** A shell that ignores SIGTERM (and so does what it starts), with a child of its own. */
function stubborn(): Bun.Subprocess {
	return Bun.spawn(["sh", "-c", "trap '' TERM; sleep 300 & wait"], { stdout: "ignore", stderr: "ignore" });
}

const gone = (pid: number) => !processExists(pid);

test("killTree ends a tree whose processes ignore SIGTERM, after the grace period", async () => {
	const top = stubborn();
	const pid = top.pid;
	await until(() => descendants(pid).length > 0, "the shell's child", 10_000);
	const below = descendants(pid);
	const started = Date.now();
	await killTree(pid, 300);
	expect(Date.now() - started).toBeLessThan(5000);
	await top.exited;
	for (const p of [pid, ...below]) expect(gone(p)).toBe(true);
});

test("killTree ends a stopped process at once: SIGTERM stays pending on it until it is continued", async () => {
	const proc = Bun.spawn(["sleep", "300"], { stdout: "ignore", stderr: "ignore" });
	process.kill(proc.pid, "SIGSTOP");
	await sleep(100);
	const started = Date.now();
	await killTree(proc.pid, 8000);
	expect(Date.now() - started).toBeLessThan(3000);
	await proc.exited;
	expect(gone(proc.pid)).toBe(true);
});

test("descendants lists the deepest first, and none for a process without children", async () => {
	const top = stubborn();
	await until(() => descendants(top.pid).length > 0, "the shell's child", 10_000);
	expect(descendants(top.pid)).toHaveLength(1);
	await killTree(top.pid, 200);
	await top.exited;
	expect(descendants(top.pid)).toEqual([]);
});
