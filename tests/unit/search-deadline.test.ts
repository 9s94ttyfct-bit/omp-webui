import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SearchIndex } from "../../server/search-index.ts";
import { WorkerDeadlineError } from "../../server/worker-deadline.ts";

/** A search index worker that does not answer fails what waits for it within its deadline, and is replaced by the next call. */

const STUCK = new URL("../support/stuck-worker.ts", import.meta.url);
const PROGRESS = new URL("../support/progress-worker.ts", import.meta.url);
const REAL = new URL("../../server/search-index-worker.ts", import.meta.url);

const dirs: string[] = [];
const indexes: SearchIndex[] = [];
afterEach(() => {
	for (const i of indexes.splice(0)) i.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** What cuts a request that a wedged worker holds: short, so that the test does not wait for it. */
const DEADLINE_MS = 300;
/** How long a flush may go without a word of progress: well above the 100 ms between the progress worker's. */
const STALL_MS = 1000;
/** The limit of a request that must be answered: far longer than a loaded machine needs to start a worker and open a database. */
const FAR_MS = 60_000;

/**
 * The limits of the requests the index makes from now on (they are read when a request is made; one in flight keeps its
 * own): a wedged worker is cut at once, a working one has the time a machine under load takes.
 */
function deadlinesFromNow(index: SearchIndex): void {
	Object.assign(index, { searchDeadlineMs: FAR_MS, flushStallMs: FAR_MS });
}

function indexOver(options: { stallMs?: number }, ...urls: URL[]) {
	const dir = mkdtempSync(join(tmpdir(), "ompw-search-deadline-"));
	dirs.push(dir);
	const started: Worker[] = [];
	const index = new SearchIndex(join(dir, "search.db"), {
		searchDeadlineMs: DEADLINE_MS,
		flushStallMs: options.stallMs,
		spawn: () => {
			const worker = new Worker(urls[Math.min(started.length, urls.length - 1)]);
			started.push(worker);
			return worker;
		},
	});
	indexes.push(index);
	return { index, started };
}

test("a search the worker never answers fails at its deadline, and the next search gets a fresh worker", async () => {
	const { index, started } = indexOver({}, STUCK, REAL);
	index.sync([]);

	const began = performance.now();
	const failed = await index.search({ q: "zebra", max: 5, cap: 5, waitMs: 0 }).then(
		() => null,
		(e) => e,
	);
	expect(failed).toBeInstanceOf(WorkerDeadlineError);
	// Not before its deadline. (How long after is not asserted: that depends on what else the machine is running.)
	expect(performance.now() - began).toBeGreaterThanOrEqual(DEADLINE_MS - 20);
	expect(started).toHaveLength(1);

	deadlinesFromNow(index);
	const answer = await index.search({ q: "zebra", max: 5, cap: 5, waitMs: 0 });
	expect(answer.hits).toEqual([]);
	expect(started).toHaveLength(2);
});

test("a flush that keeps reporting progress is not cut off, and one that falls silent is", async () => {
	// Progress every 100 ms for 2 s against a stall limit of 1 s: alive the whole time, and for longer than the limit.
	const busy = indexOver({ stallMs: STALL_MS }, PROGRESS);
	const done = await busy.index.flush();
	expect(done.indexed).toBe(2);

	const silent = indexOver({ stallMs: STALL_MS }, STUCK, REAL);
	await expect(silent.index.flush()).rejects.toBeInstanceOf(WorkerDeadlineError);
	deadlinesFromNow(silent.index);
	expect((await silent.index.flush()).total).toBe(0);
});
