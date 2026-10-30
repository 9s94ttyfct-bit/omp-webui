import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { WorkerHost } from "../../server/family.ts";
import { WorkerDeadlineError } from "../../server/worker-deadline.ts";
import { seedFixtures } from "../support/fixtures.ts";

/**
 * A family worker that does not answer must not leave its job pending: the host terminates it, the job fails with a
 * `WorkerDeadlineError`, and the next job runs in a worker of its own. Workers here are real threads that never answer.
 */

const STUCK = new URL("../support/stuck-worker.ts", import.meta.url);
const STUCK_BUSY = new URL("../support/busy-worker.ts", import.meta.url);
const REAL = new URL("../../server/family-worker.ts", import.meta.url);
/** What cuts a job a wedged worker holds: short, so that the test does not wait for it. */
const DEADLINE_MS = 300;
/** The deadline of a job that must be answered: far longer than a loaded machine needs to start a worker thread. */
const FAR_MS = 60_000;

const dirs: string[] = [];
afterEach(() => {
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A host with this deadline whose n-th worker is `urls[n]` (the last one repeats), and the workers it has started. */
function hostOver(deadlineMs: number, ...urls: URL[]) {
	const started: Worker[] = [];
	const host = new WorkerHost({
		deadlineMs,
		spawn: () => {
			const worker = new Worker(urls[Math.min(started.length, urls.length - 1)]);
			started.push(worker);
			return worker;
		},
	});
	return { host, started };
}

/**
 * The deadline of the jobs the host starts from now on (a job's deadline is read when it starts: one that is running
 * keeps its own). A wedged worker is cut at once, a working one is given what a machine under load takes to start a
 * thread and answer.
 */
function deadlineFromNow(host: WorkerHost, ms: number): void {
	Object.assign(host, { deadlineMs: ms });
}

function fixture() {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "ompw-deadline-")));
	dirs.push(dir);
	const { alpha } = seedFixtures(dir);
	return { file: alpha, members: [{ file: alpha, subagents: [], advisors: [], tag: "fixture" }] };
}

/** Whether a worker still runs: a terminated one answers no message. */
async function alive(worker: Worker): Promise<boolean> {
	return new Promise((resolve) => {
		worker.onmessage = () => resolve(true);
		worker.postMessage({ id: -1, file: "/nonexistent", members: [], single: true });
		setTimeout(() => resolve(false), 500);
	});
}

for (const [how, stuck] of [
	["never replies", STUCK],
	["spins its thread", STUCK_BUSY],
] as const) {
	test(`a worker that ${how}: the job fails at its deadline, and the next job gets a fresh worker`, async () => {
		const { file, members } = fixture();
		const { host, started } = hostOver(DEADLINE_MS, stuck, REAL);

		const began = performance.now();
		const failed = await host.build(file, members, true).then(
			() => null,
			(e) => e,
		);
		const took = performance.now() - began;
		expect(failed).toBeInstanceOf(WorkerDeadlineError);
		expect((failed as Error).message).toContain("gave no answer");
		// Not before its deadline. (How long after is not asserted: that depends on what else the machine is running.)
		expect(took).toBeGreaterThanOrEqual(DEADLINE_MS - 20);
		expect(started).toHaveLength(1);

		deadlineFromNow(host, FAR_MS);
		const gz = await host.build(file, members, true);
		expect(started).toHaveLength(2);
		const session = JSON.parse(gunzipSync(gz).toString());
		expect(session.file).toBe(file);
		expect(session.entries.length).toBeGreaterThan(0);
		// The wedged thread is gone, not left spinning.
		expect(await alive(started[0])).toBe(false);
	});
}

test("a job that waits behind a wedged one gets its whole deadline from its own start", async () => {
	const { file, members } = fixture();
	const { host, started } = hostOver(DEADLINE_MS, STUCK, REAL);

	const first = host.build(file, members, true).then(
		() => null,
		(e) => e,
	);
	// Handed over right away, but the worker is busy with the first for a whole deadline.
	const second = host.build(file, members, true);
	// The first has its deadline set; the second gets the one that is set when it starts. A deadline kept from when it
	// was handed over would be the first's, and cut it as it starts: with the time of a loaded machine, nothing else does.
	deadlineFromNow(host, FAR_MS);

	expect(await first).toBeInstanceOf(WorkerDeadlineError);
	expect(JSON.parse(gunzipSync(await second).toString()).file).toBe(file);
	expect(started).toHaveLength(2);
});

test("a worker that stops fails its job at once, and the next job gets a fresh worker", async () => {
	const { file, members } = fixture();
	// A deadline no test waits for: what ends the job is the worker's end, which the message says (a deadline that came
	// first would say that no answer came).
	const { host, started } = hostOver(FAR_MS, new URL("../support/exiting-worker.ts", import.meta.url), REAL);

	await expect(host.build(file, members, true)).rejects.toThrow(/family worker (stopped|failed)/);

	expect(JSON.parse(gunzipSync(await host.build(file, members, true)).toString()).file).toBe(file);
	expect(started).toHaveLength(2);
});

test("a job the worker answers in time is not cut off, and its worker serves the next", async () => {
	const { file, members } = fixture();
	const { host, started } = hostOver(FAR_MS, REAL);

	await host.build(file, members, true);
	await host.build(file, members, false);
	expect(started).toHaveLength(1);
});

test("a worker with no job left stops after its idle time, taking what it holds, and the next job gets a fresh one", async () => {
	const { file, members } = fixture();
	const started: Worker[] = [];
	const closed: Promise<void>[] = [];
	const host = new WorkerHost({
		deadlineMs: FAR_MS,
		idleMs: 500,
		spawn: () => {
			const worker = new Worker(REAL);
			const { promise, resolve } = Promise.withResolvers<void>();
			worker.addEventListener("close", () => resolve());
			started.push(worker);
			closed.push(promise);
			return worker;
		},
	});

	await host.build(file, members, true);
	// A job within the idle time is served by the worker that is there.
	await host.build(file, members, true);
	expect(started).toHaveLength(1);
	// None for longer than that: the worker is stopped (its thread ends, and what it held with it).
	await closed[0];

	expect(JSON.parse(gunzipSync(await host.build(file, members, true)).toString()).file).toBe(file);
	expect(started).toHaveLength(2);
	expect(await alive(started[1] as Worker)).toBe(true);
});

test("a worker stopped while it holds a job fails that job at once, not at its deadline, and the next job gets a fresh worker", async () => {
	const { file, members } = fixture();
	// A worker that never answers, and a deadline no test waits for: what ends the job is the stop.
	const { host, started } = hostOver(FAR_MS, STUCK, REAL);
	const held = host.build(file, members, true);
	const outcome = held.then(
		() => "answered",
		(e: Error) => e.message,
	);
	// The job is with the worker as soon as it is asked for.
	expect(started).toHaveLength(1);
	Reflect.apply(Reflect.get(host, "stop"), host, []);
	expect(await outcome).toMatch(/stopped/);

	expect(JSON.parse(gunzipSync(await host.build(file, members, true)).toString()).file).toBe(file);
	expect(started).toHaveLength(2);
});
