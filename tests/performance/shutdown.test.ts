import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { ShutdownWorld } from "../support/shutdown-world.ts";

/**
 * Real-clock budgets, not ordinary correctness tests: how soon omp and its tool are gone once the app that started the
 * server is killed. The server notices the app on a one-second check and then stops omp; a budget of 3.5 s for that
 * counts every moment the OS gives to unrelated processes, so the parallel pool cannot keep it. The test:contract and
 * test:all scripts run this phase after their pool, while the other suites are idle (see family.test.ts). That they are
 * gone at all, that the server ends and leaves no record, is asserted by tests/contract/shutdown.test.ts.
 */

const world = new ShutdownWorld();

beforeAll(() => world.setup());
afterEach(() => world.reap());
afterAll(() => world.close());

test("when the app is killed, a working omp and the tool it runs are gone within 3.5 s", async () => {
	expect((await world.killTheApp("working")).goneAfterMs).toBeLessThan(3500);
}, 90_000);

test("when the app is killed, an idle omp is closed within 3.5 s", async () => {
	expect((await world.killTheApp("idle")).goneAfterMs).toBeLessThan(3500);
}, 90_000);

test("a shutdown that takes longer than the app check's interval is over within 3.5 s all the same", async () => {
	expect((await world.killTheApp("stubborn")).goneAfterMs).toBeLessThan(3500);
}, 90_000);
