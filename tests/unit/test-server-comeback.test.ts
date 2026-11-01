// needs: posixSignals
import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pollUntil, processExists } from "../support/poll.ts";
import { startTestServer } from "../support/server.ts";
import { serversAlive } from "../support/test-servers.ts";
import { setTempDir } from "../support/tmp.ts";

/**
 * A test server that exits by itself is started again (#3, audit A-018). Bun's test runner can send SIGTERM to a file's shared
 * server in the middle of the file (`killed 1 dangling process`); the server ends cleanly and says nothing, and every later
 * test of the file used to fail with a refused connection.
 */

let scratch: string;
const realTmp = process.env.TMPDIR;

beforeEach(() => {
	scratch = mkdtempSync(join(realTmp ?? tmpdir(), "ompw-comeback-test-"));
	setTempDir(scratch);
});
afterEach(() => {
	if (realTmp === undefined) delete process.env.TMPDIR;
	else setTempDir(realTmp);
	rmSync(scratch, { recursive: true, force: true });
});

const meta = (s: { url: string; accessToken: string }) =>
	fetch(`${s.url}/api/meta`, { headers: { "x-omp-webui-token": s.accessToken, "x-omp-webui": "1" } });

test("a server ended by a SIGTERM nobody in the helper sent is started again on its port and data dir, and says so", async () => {
	const s = await startTestServer(0, {}, { login: false });
	try {
		const url = s.url;
		expect((await meta(s)).status).toBe(200);
		const first = s.pid as number;
		// What Bun's runner does to a worker's spawned processes.
		process.kill(first, "SIGTERM");
		await pollUntil(() => !processExists(first), "the server to end");
		await pollUntil(() => s.errors().includes("exited by itself (0)"), "the helper to see it end");
		// The next test waits for it (the preload's beforeEach), and then the server answers, at the same address.
		await serversAlive();
		await s.alive();
		expect(s.url).toBe(url);
		expect((await meta(s)).status).toBe(200);
		expect(s.pid).not.toBe(first);
		expect(s.errors()).toContain(`omp-webui test server started again on ${url}, on the same data dir`);
	} finally {
		await s.stop();
	}
	expect(existsSync(s.root)).toBe(false);
}, 60_000);

test("a server the helper stops is not started again", async () => {
	const s = await startTestServer(0, {}, { login: false });
	const pid = s.pid as number;
	await s.stop();
	expect(processExists(pid)).toBe(false);
	await s.alive();
	expect(s.errors()).not.toContain("exited by itself");
	expect(existsSync(s.root)).toBe(false);
}, 60_000);
