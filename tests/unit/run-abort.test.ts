// needs: posixShell
import { expect, test } from "bun:test";
import { run } from "../../server/omp/run.ts";

/**
 * A command run with a signal ends, with what it started, when the signal aborts (#321): the server stopping ends the
 * omp command of a plugin change instead of leaving it running beside the next server.
 */

test("an aborted signal kills the command at once, whatever time limit it has", async () => {
	const stop = new AbortController();
	const started = Date.now();
	const ran = run(["sh", "-c", "sleep 60"], { timeoutMs: 120_000, signal: stop.signal });
	setTimeout(() => stop.abort(), 100);
	const { code } = await ran;
	expect(code).not.toBe(0);
	expect(Date.now() - started).toBeLessThan(20_000);
});

test("a signal that was aborted before the command started kills it too", async () => {
	const stop = new AbortController();
	stop.abort();
	const { code } = await run(["sh", "-c", "sleep 60"], { timeoutMs: 120_000, signal: stop.signal });
	expect(code).not.toBe(0);
});
