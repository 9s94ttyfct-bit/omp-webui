import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Job, Reply } from "../../server/family.ts";

/**
 * What the family worker holds in memory while it builds the body of a long conversation (`/api/family`), measured as the
 * resident memory of this process (the worker is a thread of it). Like the latency budgets next to it, it is a measurement
 * of the machine, so it runs after the parallel pool.
 *
 * The worker once collected a file's entries as one list of strings, joined the list into one string, put that into the
 * file's document and gave zlib the document as bytes: four copies of the file's JSON next to its text. It holds the text
 * and one piece of the JSON at a time now.
 *
 * The conversation is written by a process of its own, before anything is measured. Written here, the generator would
 * allocate and free tens of MB of this process's memory first, and the worker would build its body in pages that are
 * already resident: the peak would hardly show (this worker 0.1 to 0.6 times the file's size, the old one 2.6 to 3.5).
 * Measured with the file written elsewhere, above what the idle worker holds (macOS, Bun 1.4, a 22 MB file): the old
 * worker peaks at 6.8 times the file's size, this one at 3.1 to 3.2. The budget is 4: well short of the old worker, with
 * room for the machine.
 * (That the worker does not keep the text after the job is `family-document.test.ts`'s.)
 */

const BIG_BYTES = 22 * 1024 * 1024;
const BUDGET = 4;
/** Large enough that what the worker holds of the file's text is far more than what it holds anyway. */
const INDEX_BYTES = 64 * 1024 * 1024;

/** The big conversation's file, written by another process (`tests/support/big-session.ts`): none of its memory is this one's. */
function writeElsewhere(agentDir: string, bytes = BIG_BYTES): string {
	const script = `import { writeBigSession } from ${JSON.stringify(join(import.meta.dir, "../support/big-session.ts"))};
console.log(writeBigSession(${JSON.stringify(agentDir)}, ${bytes}));`;
	const run = Bun.spawnSync([process.execPath, "-e", script], { stdout: "pipe", stderr: "pipe" });
	if (run.exitCode !== 0) throw new Error(`the big conversation was not written: ${run.stderr.toString()}`);
	return realpathSync(run.stdout.toString().trim());
}

test("the worker that builds a 22 MB conversation holds at most four times its size at once", async () => {
	const root = mkdtempSync(join(tmpdir(), "ompw-family-memory-"));
	const file = writeElsewhere(root);
	const size = statSync(file).size;
	const worker = new Worker(new URL("../../server/family-worker.ts", import.meta.url));
	const waiting = new Map<number, (reply: Reply) => void>();
	worker.onmessage = (event: MessageEvent<Reply>) => waiting.get(event.data.id)?.(event.data);
	const ask = (job: Job) => {
		const { promise, resolve } = Promise.withResolvers<Reply>();
		waiting.set(job.id, resolve);
		worker.postMessage(job);
		return promise;
	};
	try {
		// A family of no files: the worker has started and has answered once, and holds nothing of any job.
		await ask({ id: 1, file, members: [] });
		Bun.gc(true);
		const before = process.memoryUsage().rss;
		let peak = before;
		// Sampling is the measurement: the peak lives for a few tens of milliseconds, and no event says when it is.
		const sampler = setInterval(() => {
			peak = Math.max(peak, process.memoryUsage().rss);
		}, 5);
		const answer = await ask({
			id: 2,
			file,
			members: [{ file, tag: file, subagents: [], advisors: [] }],
			dedup: true,
		});
		clearInterval(sampler);
		peak = Math.max(peak, process.memoryUsage().rss);

		expect("gz" in answer).toBe(true);
		expect(peak - before).toBeLessThan(BUDGET * size);
	} finally {
		worker.terminate();
		rmSync(root, { recursive: true, force: true });
	}
}, 60_000);

/**
 * The worker keeps the index of a conversation it answered the end of (`history-index.ts`) for the next window, a few
 * seconds on: where each entry is, and its id, parent, type and time. The ids and times were once pieces of the chunk of
 * the file they were read from, and a piece shares the larger string's characters: an index of a 98 MB conversation held
 * 98 MB of its text (and the next conversation's, up to the cache's limit). The index holds a few percent of the file.
 */
test("the worker that answered the end of a 64 MB conversation holds a small part of its size afterwards, not its text", async () => {
	const root = mkdtempSync(join(tmpdir(), "ompw-index-memory-"));
	const worker = new Worker(new URL("../../server/family-worker.ts", import.meta.url));
	const waiting = new Map<number, (reply: Reply) => void>();
	worker.onmessage = (event: MessageEvent<Reply>) => waiting.get(event.data.id)?.(event.data);
	const ask = (job: Job) => {
		const { promise, resolve } = Promise.withResolvers<Reply>();
		waiting.set(job.id, resolve);
		worker.postMessage(job);
		return promise;
	};
	try {
		const file = writeElsewhere(root, INDEX_BYTES);
		const size = statSync(file).size;
		const members = [{ file, tag: file, subagents: [], advisors: [] }];
		await ask({ id: 1, file, members: [] });
		Bun.gc(true);
		const before = process.memoryUsage().rss;
		const answer = await ask({ id: 2, file, members, view: { kind: "tail" } });
		expect("gz" in answer).toBe(true);
		// The worker collects from a timer after its job (the job's own frame is still on the stack until then); give it that.
		await new Promise((r) => setTimeout(r, 500));
		Bun.gc(true);
		const held = process.memoryUsage().rss - before;
		// A constant (the modules the first window loads, the memory the allocator keeps from the chunks it read) and the index:
		// 15% of the file, where the text it once held was all of it.
		expect(held).toBeLessThan(0.35 * size);
	} finally {
		worker.terminate();
		rmSync(root, { recursive: true, force: true });
	}
}, 60_000);
