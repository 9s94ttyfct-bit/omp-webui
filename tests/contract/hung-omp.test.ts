import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { startAppServer } from "../support/app-server.ts";
import { writeFakeOmp } from "../support/fake-omp.ts";
import { isolatedEnv } from "../support/omp-env.ts";
import { pollUntil } from "../support/poll.ts";

/**
 * An omp that stops answering its helper commands (`omp config get …`: a lock, a keychain prompt, a network file
 * system) kept the server from ever listening, because start-up waits for the overlay's `omp config get` (#319). The real
 * server starts on such an omp, and the commands it started are gone. The omp is a script whose `--version` answers, whose
 * conversations are the scripted fake, and whose every other command hangs on a `sleep` with a number of its own.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-hung-"));
let env: Record<string, string>;
const procs: Subprocess[] = [];

beforeAll(async () => {
	env = await isolatedEnv(root);
});
afterEach(() => {
	for (const p of procs.splice(0)) p.kill("SIGKILL");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const HANG = "3137";
/**
 * The hung commands of *this* test, and only of this test: the fake omp hangs with a marker that is its own, and
 * what is looked for is what runs under this test's directory. A machine-wide `sleep 3137` — a leftover of an earlier
 * run, another checkout — is none of this test's business, and counting it made the test fail for what was not its
 * doing (#500).
 */
const hanging = (): string[] =>
	Bun.spawnSync(["ps", "-A", "-ww", "-o", "pid=,command="])
		.stdout.toString()
		.split("\n")
		.filter((line) => line.includes(`sleep ${HANG}`) && line.includes(root))
		.map((line) => line.trim());

test("the server listens although omp's `config get` hangs, and nothing it started is left running", async () => {
	const dir = join(root, "bin");
	mkdirSync(dir, { recursive: true });
	const conversations = writeFakeOmp(dir);
	const bin = join(root, "omp");
	// The hang carries this test's own directory, so that what is looked for is this test's and no one's else.
	const marker = join(root, "hang");
	writeFileSync(
		bin,
		`#!/bin/sh
case "$1" in
  --version) echo "omp/18.12.2"; exit 0 ;;
  --mode) exec "${conversations}" "$@" ;;
esac
exec sleep ${HANG} "${marker}"
`,
	);
	chmodSync(bin, 0o755);
	const dataDir = join(root, "data");
	mkdirSync(dataDir, { recursive: true });

	// Listening: after the limit of the overlay's read (10 s), not never. The omp hangs for `3137` seconds, so a server that
	// waited for it fails by the test's own timeout; how long the limit takes on a busy machine is not asserted.
	const server = await startAppServer(env, dataDir, 0, { OMP_BIN: bin });
	procs.push(server.proc);
	const res = await fetch(`http://127.0.0.1:${server.port}/api/meta`, {
		headers: { "x-omp-webui-token": server.token },
	});
	expect(res.status).toBe(200);
	await pollUntil(() => hanging().length === 0, "the hung `omp config get` to be gone");
}, 90_000);
