import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pollUntil, processExists } from "../support/poll.ts";
import { startTestServer } from "../support/server.ts";

/**
 * What the test server leaves behind when it cannot be stopped politely, or never starts: a hung server must not hang
 * the teardown of the test that started it, and a failed start has no handle to clean up with.
 */

let scratch: string;
const realTmp = process.env.TMPDIR;

beforeEach(() => {
	scratch = mkdtempSync(join(realTmp ?? tmpdir(), "ompw-teardown-test-"));
	// Every server directory this file makes is under `scratch`, so that "nothing is left" is about this test alone.
	process.env.TMPDIR = scratch;
});
afterEach(() => {
	if (realTmp === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = realTmp;
	rmSync(scratch, { recursive: true, force: true });
});

test("a server stuck in a loop that ignores SIGTERM is stopped anyway: stop() returns, the process is gone, its directory removed", async () => {
	const pidFile = join(scratch, "pid");
	const flag = join(scratch, "wedge");
	const preload = join(import.meta.dir, "..", "support", "stuck-server-preload.ts");
	const server = await startTestServer(
		0,
		{ BUN_OPTIONS: `--preload ${preload}`, WEDGE_PIDFILE: pidFile, WEDGE_FLAG: flag },
		{ login: false },
	);
	const pid = Number(readFileSync(pidFile, "utf8"));
	expect(processExists(pid)).toBe(true);
	writeFileSync(flag, "");
	// It stops answering: the end-kept request that stop() makes first must not be waited for.
	await pollUntil(async () => {
		try {
			await fetch(`${server.url}/api/meta`, { signal: AbortSignal.timeout(300) });
			return false;
		} catch {
			return true;
		}
	}, "the server to stop answering");
	const started = Date.now();
	await server.stop();
	expect(Date.now() - started).toBeLessThan(12_000);
	expect(processExists(pid)).toBe(false);
	expect(existsSync(server.root)).toBe(false);
}, 30_000);

test("a server that cannot start leaves no directory behind", async () => {
	// The port is taken, so the server exits before it listens.
	const taken = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
	try {
		await expect(startTestServer(taken.port, {}, { login: false })).rejects.toThrow(
			/exited before ready|did not start/,
		);
	} finally {
		taken.stop(true);
	}
	expect(readdirSync(scratch).filter((name) => name.startsWith("ompw-e2e-"))).toEqual([]);
});
