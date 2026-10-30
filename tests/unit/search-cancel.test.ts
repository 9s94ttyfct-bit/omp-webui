import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Job, type RawHit, type Reply, SearchIndex, type SearchRequest } from "../../server/search-index.ts";

/**
 * Typing a query sends one search per pause, and the index worker answers them one after the other: a search that nobody
 * waits for any more (its request was dropped by the page that sent the next one) must not cost the next one its time.
 */

const STUCK = new URL("../support/stuck-worker.ts", import.meta.url);
const REAL = new URL("../../server/search-index-worker.ts", import.meta.url);

const dirs: string[] = [];
const workers: Worker[] = [];
const indexes: SearchIndex[] = [];
afterEach(() => {
	for (const w of workers.splice(0)) w.terminate();
	for (const i of indexes.splice(0)) i.close();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "ompw-search-cancel-"));
	dirs.push(dir);
	return dir;
}

/** A conversation with one message that says `text`. */
function sessionFile(dir: string, text: string): { file: string; size: number; mtime: number } {
	const id = "01a00000-0000-7000-8000-00000000ca01";
	const stamp = "2026-01-07T00:00:00.000Z";
	const lines = [
		{ type: "session", version: 3, id, timestamp: stamp, cwd: "/tmp/cancel" },
		{
			type: "message",
			id: "m1",
			parentId: null,
			timestamp: stamp,
			message: { role: "user", content: [{ type: "text", text }] },
		},
	];
	const file = join(dir, `2026-01-07T00-00-00-000Z_${id}.jsonl`);
	const body = `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`;
	writeFileSync(file, body);
	return { file, size: Buffer.byteLength(body), mtime: Date.now() };
}

/** The real index worker over a library of one conversation, spoken to directly. */
function realWorker(text: string) {
	const dir = tempDir();
	const worker = new Worker(REAL);
	workers.push(worker);
	worker.postMessage({ t: "open", dbPath: join(dir, "search.db") } satisfies Job);
	worker.postMessage({ t: "files", files: [sessionFile(dir, text)], gone: [], full: true } satisfies Job);
	let seq = 0;
	const replies = new Map<number, (reply: Reply) => void>();
	worker.onmessage = (event: MessageEvent<Reply>) => {
		const reply = event.data;
		if (reply.t !== "progress" && reply.id !== null) replies.get(reply.id)?.(reply);
	};
	/** Searches (waiting for the one file to be indexed) with the cancel flag set as `cancelled` says. */
	return async (cancelled: boolean): Promise<RawHit[]> => {
		const id = ++seq;
		const cancel = new Int32Array(new SharedArrayBuffer(4));
		if (cancelled) Atomics.store(cancel, 0, 1);
		const answer = new Promise<Reply>((resolve) => replies.set(id, resolve));
		const req: SearchRequest = { q: "durian", max: 5, cap: 5, waitMs: 20_000 };
		worker.postMessage({ t: "search", id, req, cancel } satisfies Job);
		const reply = await answer;
		if (reply.t !== "result") throw new Error(reply.t === "error" ? reply.message : "not a result");
		return reply.hits;
	};
}

test("the worker does not run a search that was cancelled while it waited its turn", async () => {
	const search = realWorker("a durian smoothie");
	expect((await search(false)).map((h) => h.entryId)).toEqual(["m1"]);
	expect(await search(true)).toEqual([]);
	// Cancelling one search leaves the next one alone.
	expect((await search(false)).map((h) => h.entryId)).toEqual(["m1"]);
});

function stuckIndex(spawned: Worker[]) {
	const index = new SearchIndex(join(tempDir(), "search.db"), {
		searchDeadlineMs: 60_000,
		spawn: () => {
			const worker = new Worker(STUCK);
			spawned.push(worker);
			return worker;
		},
	});
	indexes.push(index);
	return index;
}

test("a search whose request is already dropped is not asked of the worker at all", async () => {
	const spawned: Worker[] = [];
	const index = stuckIndex(spawned);
	const gone = AbortSignal.abort();
	await expect(index.search({ q: "zebra", max: 5, cap: 5, waitMs: 0 }, gone)).rejects.toMatchObject({
		name: "AbortError",
	});
	// Not even a worker was started for it.
	expect(spawned).toHaveLength(0);
});

test("a search that is dropped while the worker holds it fails at once, not at its deadline", async () => {
	const spawned: Worker[] = [];
	const index = stuckIndex(spawned);
	const controller = new AbortController();
	const answer = index.search({ q: "zebra", max: 5, cap: 5, waitMs: 0 }, controller.signal).then(
		() => null,
		(e: Error) => e,
	);
	controller.abort();
	const failed = await answer;
	expect(failed?.name).toBe("AbortError");
	expect(spawned).toHaveLength(1);
});
