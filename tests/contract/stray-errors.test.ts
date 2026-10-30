import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startAppServer } from "../support/app-server.ts";
import { isolatedEnv } from "../support/omp-env.ts";
import { pollUntil } from "../support/poll.ts";

/**
 * A stray error does not end the real server (#373). Bun ends a process on a rejected promise nobody handles and on an
 * exception thrown from a timer; the macOS app took that for "the server stopped" and quit. A preload makes the running
 * server meet both, right after it is ready, and the server must still be there and answer.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-stray-"));
let env: Record<string, string>;
beforeAll(async () => {
	env = await isolatedEnv(root);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("a rejected promise and an exception thrown from a timer leave the server running and answering", async () => {
	const dataDir = join(root, "data");
	mkdirSync(dataDir, { recursive: true });
	const preload = join(import.meta.dir, "../support/stray-errors-preload.ts");
	const server = await startAppServer(env, dataDir, 0, { BUN_OPTIONS: `--preload ${preload}` });
	try {
		let exited = false;
		void server.proc.exited.then(() => {
			exited = true;
		});
		await pollUntil(() => exited || server.output().includes("STRAYS_FIRED"), "the preload to throw its errors");
		expect(exited).toBe(false);
		const lives = await fetch(`http://127.0.0.1:${server.port}/api/lives`, {
			headers: { "x-omp-webui-token": server.token },
		});
		expect(lives.status).toBe(200);
	} finally {
		server.proc.kill("SIGTERM");
		await server.proc.exited;
	}
}, 60_000);
