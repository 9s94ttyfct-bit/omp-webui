import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { ShutdownWorld } from "../support/shutdown-world.ts";

/**
 * A server the macOS app started stops its omp processes when the app is gone — force-quit or crashed — also while omp
 * is working, which it keeps doing after its stdin closes. Real server, real omp and a real tool process; no model
 * calls. What is asserted here is that they are gone, the server has ended and left no record of itself; how soon is a
 * real-clock budget of its own, in tests/performance/shutdown.test.ts.
 */

const world = new ShutdownWorld();

beforeAll(() => world.setup());
afterEach(() => world.reap());
afterAll(() => world.close());

test("when the app is killed, a working omp and the tool it runs are gone", async () => {
	const killed = await world.killTheApp("working");
	// The server went with them, and left no record of itself.
	expect(killed.exitCode).toBe(0);
	expect(killed.pidFileLeft).toBe(false);
}, 90_000);

test("when the app is killed, an idle omp is closed and the server exits", async () => {
	const killed = await world.killTheApp("idle");
	expect(killed.exitCode).toBe(0);
	expect(killed.pidFileLeft).toBe(false);
}, 90_000);

test("a shutdown that takes longer than the app check's interval still runs to its end", async () => {
	// An omp that ignores both its closed stdin and SIGTERM, with a tool in a session of its own: only SIGKILL
	// ends them, so the shutdown outlasts the one-second check for the app, which must not cut it short.
	const killed = await world.killTheApp("stubborn");
	expect(killed.exitCode).toBe(0);
	expect(killed.pidFileLeft).toBe(false);
}, 90_000);
