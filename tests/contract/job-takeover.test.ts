import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import type { OmpSnapshot } from "../../shared/omp-install.ts";
import { startAppServer } from "../support/app-server.ts";
import { writeFakeOmp } from "../support/fake-omp.ts";
import { isolatedEnv } from "../support/omp-env.ts";

/**
 * An omp install or update that ended while no server ran is settled by the next one, in `OmpLifecycle.init`, before
 * the server is listening. That is wiring `tests/unit/omp-lifecycle.test.ts` cannot see (its host is a stub): a
 * `const` of `main.ts` that `init` reached before it was declared ended the real server with a ReferenceError, at
 * every start, until the job's directory was deleted by hand (#310). Here the real server starts on data
 * directories that hold such jobs. A fake omp stands in for omp; no model is called.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-takeover-"));
let env: Record<string, string>;
const procs: Subprocess[] = [];
let n = 0;

beforeAll(async () => {
	env = await isolatedEnv(root);
	env.OMP_BIN = writeFakeOmp(root);
});
afterEach(() => {
	for (const p of procs.splice(0)) p.kill("SIGKILL");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** What an earlier server left in `<data dir>/omp-job` for an `omp update` that ended. */
function leaveJob(dataDir: string, files: { record?: unknown; exit?: string | null; output?: string }): string {
	const dir = join(dataDir, "omp-job");
	mkdirSync(dir, { recursive: true });
	const record = files.record ?? {
		version: 1,
		kind: "update",
		method: "homebrew",
		command: "omp update",
		auto: false,
		startedAt: Date.now() - 5000,
		before: "0.0.0-old",
		process: null,
	};
	writeFileSync(join(dir, "job.json"), typeof record === "string" ? record : JSON.stringify(record));
	writeFileSync(join(dir, "output.log"), files.output ?? "Updating omp…\n");
	if (files.exit !== null) writeFileSync(join(dir, "exit"), files.exit ?? "0");
	return dir;
}

/** A server like the app's on `dataDir`; resolves with how the page would see omp (`GET /api/omp`). */
async function startOn(dataDir: string, port: number) {
	const server = await startAppServer(env, dataDir, port);
	procs.push(server.proc);
	const res = await fetch(`http://127.0.0.1:${server.port}/api/omp`, {
		headers: { "x-omp-webui-token": server.token },
	});
	return { server, snapshot: (await res.json()) as OmpSnapshot };
}

function freshDataDir(): string {
	const dir = join(root, `data-${++n}`);
	mkdirSync(dir, { recursive: true });
	return dir;
}

test("the server starts on a data dir whose update ended while it was closed, and says the update is done", async () => {
	const dataDir = freshDataDir();
	const jobDir = leaveJob(dataDir, { exit: "0", output: "Updated.\n" });
	const { server, snapshot } = await startOn(dataDir, 0);
	expect(server.proc.exitCode).toBeNull();
	expect(snapshot.state.job).toMatchObject({ kind: "update", state: "done", exitCode: 0 });
	expect(snapshot.state.status).toBe("ready");
	expect(existsSync(jobDir)).toBe(false);
	// The next start finds nothing to settle.
	server.proc.kill("SIGTERM");
	await server.proc.exited;
	const again = await startOn(dataDir, 0);
	expect(again.snapshot.state.job).toBeNull();
});

test("a job that ended with an error is told as failed, and the server starts all the same", async () => {
	const dataDir = freshDataDir();
	const jobDir = leaveJob(dataDir, { exit: "3", output: "Update failed: the release server is down\n" });
	const { server, snapshot } = await startOn(dataDir, 0);
	expect(server.proc.exitCode).toBeNull();
	expect(snapshot.state.job).toMatchObject({ kind: "update", state: "failed", exitCode: 3 });
	expect(snapshot.state.job?.error).toContain("exited with code 3");
	expect(existsSync(jobDir)).toBe(false);
});

test("a job record that cannot be read does not stop the server, and is cleared", async () => {
	const dataDir = freshDataDir();
	const jobDir = leaveJob(dataDir, { record: "{ not json", exit: null });
	const { server, snapshot } = await startOn(dataDir, 0);
	expect(server.proc.exitCode).toBeNull();
	expect(snapshot.state.job).toBeNull();
	expect(existsSync(jobDir)).toBe(false);
	expect(readdirSync(dataDir).filter((name) => name.startsWith("omp-job"))).toEqual([]);
});
