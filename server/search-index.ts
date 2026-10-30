import { WorkerDeadlineError } from "./worker-deadline.ts";

/**
 * Full-text search over the session files, in a worker thread of its own.
 *
 * Indexing a transcript (decoding it, picking the searchable text, writing the trigram index) and querying the
 * index take far longer than the server may hold its request thread: a cold index of a few hundred MB is tens of
 * seconds of work, one query over it a few hundred milliseconds. Both therefore happen here, in a worker with a
 * database file of its own, and the server only hears how far it got. The session list never waits for it.
 *
 * What the index covers is described by byte offsets: for each file, the first `indexed` bytes are in the index.
 * A transcript that grew is indexed from where it stopped; one that was rewritten (the bytes before that offset
 * no longer hash as they did) is indexed again from the start. The worker keeps that bookkeeping itself, so the
 * server only says how large each file is now.
 *
 * The compiled app embeds `search-index-worker.ts` as an entry point of its own (scripts/app.ts) and reaches it
 * through the same relative URL as from source: keep both files next to `main.ts`.
 */

/** A search over the index; `q` is already trimmed and non-empty. */
export interface SearchRequest {
	q: string;
	/** At most this many hits come back. */
	max: number;
	/** At most this many hits per conversation (`max` when one conversation is searched). */
	cap: number;
	/** Restrict the search to this session file (and index it first). */
	file?: string;
	/** How long to wait for the index to catch up with the files before searching. */
	waitMs: number;
	/**
	 * How long to wait for the file this search names to be wholly in the index (as long as that takes): the answer of
	 * a search for one conversation is from all of it, or says that it was not searched in full (#509). The wait of a
	 * search without a file is `waitMs` alone.
	 */
	fileWaitMs?: number;
	/**
	 * Match every word of `q` in any order within one message, instead of `q` as one phrase (the sidebar's search, #717:
	 * "foo bar" finds "bar … foo").
	 */
	words?: boolean;
}

export interface RawHit {
	file: string;
	entryId: string;
	role: string;
	snippet: string;
	timestamp: string;
	/** On the last hit of a conversation: how many more matches it has that are not in the result. */
	more: number;
}

/** How much of the session files the index covers: files that are fully indexed, of all it knows. */
export interface Coverage {
	indexed: number;
	total: number;
}

/**
 * How much of one conversation the index covers: the bytes of it that are in the index, of all there are. A search that
 * names a conversation answers with this, so that a caller can tell a conversation that was searched in full from one
 * that was only partly in the index when the answer came.
 */
export interface FileCoverage {
	/** The bytes of the file that are in the index. */
	indexed: number;
	/** The size of the file as the server last said it is. */
	total: number;
	/** Whether the index has taken in all of the file it will: the whole of it, or all of it that is whole lines (a last line that is not finished is not waited for). */
	complete: boolean;
}

/** What the worker has done since it started: rows written to the index, files indexed over from the start, and compactions that ended. */
export interface IndexStats {
	rows: number;
	resets: number;
	compactions: number;
}

export interface FileState {
	size: number;
	mtime: number;
}

export type Job =
	| { t: "open"; dbPath: string }
	| {
			t: "files";
			files: { file: string; size: number; mtime: number }[];
			gone: string[];
			/** `files` is every file there is, not what changed: whatever else the index holds belongs to files that are gone. */
			full?: boolean;
	  }
	| {
			t: "search";
			id: number;
			req: SearchRequest;
			/** The worker does not run the search once `cancel[0]` is 1: it is shared memory, as a message would wait behind the searches ahead. */
			cancel: Int32Array<SharedArrayBuffer>;
	  }
	| { t: "flush"; id: number /** Also compact the index now, if it is due. */; compact?: boolean }
	/** Close the database, then set `done[0]` and wake whoever waits on it: the server ends the thread after that. */
	| { t: "close"; done: Int32Array<SharedArrayBuffer> };

export type Reply =
	| { t: "result"; id: number; hits: RawHit[]; coverage: Coverage; file?: FileCoverage }
	| { t: "flushed"; id: number; coverage: Coverage; stats: IndexStats }
	| { t: "progress"; coverage: Coverage }
	| { t: "error"; id: number | null; message: string };

interface Waiter {
	resolve(reply: Extract<Reply, { id: number }>): void;
	reject(error: Error): void;
	timer?: NodeJS.Timeout;
	/** The wait for the answer is this long, and starts over whenever the worker reports progress (a job with no end in sight but its own). */
	stallMs?: number;
}

/** The longest `close` waits for the worker to close its database. */
const CLOSE_WAIT_MS = 2000;

/**
 * What the index takes in a millisecond, in bytes: a megabyte a second is far below what it does (about 30 MB/s on a
 * free machine, less on a busy one), so a conversation that is waited for has room to spare.
 */
const INDEX_BYTES_PER_MS = 1024;
/** The longest a search waits for the conversation it names: a big conversation takes a while to index, and the page is told. */
const FILE_WAIT_CAP_MS = 5000;

/**
 * How long a search waits for the conversation it names to be in the index: as long as indexing it takes, which is a
 * matter of its size, and never less than the moment a conversation that just grew needs to have its tail in. The
 * library-wide wait is for a library that is still being indexed for the first time, which is a different thing: a
 * search for one conversation is answered from all of it, or says that it was not (#509).
 *
 * A caller that asks for no wait at all (`waitMs` of 0) is answered at once: what it gets says that the conversation
 * is not wholly in the index, so nothing is read as "there is nothing in it".
 */
export function fileWaitMs(size: number, waitMs: number): number {
	if (waitMs <= 0) return 0;
	return Math.max(waitMs, Math.min(Math.ceil(size / INDEX_BYTES_PER_MS), FILE_WAIT_CAP_MS));
}

/**
 * A search is answered this long after its own `waitMs` (the worker answers between two batches of indexing, and a query
 * over the index takes a few hundred milliseconds): past that the worker is wedged, or never started, and is replaced.
 * `flush` has no end in sight but the library's size, so what is bounded is the time without a word of progress.
 */
export const SEARCH_DEADLINE_MS = 30_000;
export const FLUSH_STALL_MS = 60_000;

export interface SearchIndexOptions {
	/** Starts the worker (the search index worker). */
	spawn?: () => Worker;
	/** `SEARCH_DEADLINE_MS`. */
	searchDeadlineMs?: number;
	/** `FLUSH_STALL_MS`. */
	flushStallMs?: number;
}

export class SearchIndex {
	private worker: Worker | null = null;
	private readonly pending = new Map<number, Waiter>();
	private seq = 0;
	/** What the worker was last told about each file, so it is only told what changed. */
	private sent = new Map<string, FileState>();
	/** The worker has been told every file there is, once: what it was told after that is what changed. */
	private told = false;
	private latest: Coverage = { indexed: 0, total: 0 };

	private readonly spawn: () => Worker;
	private readonly searchDeadlineMs: number;
	private readonly flushStallMs: number;

	constructor(
		private readonly dbPath: string,
		options: SearchIndexOptions = {},
	) {
		this.spawn = options.spawn ?? (() => new Worker(new URL("./search-index-worker.ts", import.meta.url)));
		this.searchDeadlineMs = options.searchDeadlineMs ?? SEARCH_DEADLINE_MS;
		this.flushStallMs = options.flushStallMs ?? FLUSH_STALL_MS;
	}

	/** Coverage as of the worker's last report. */
	get coverage(): Coverage {
		return this.latest;
	}

	/**
	 * Tell the worker which files exist and how large they are; it indexes what differs from what it has. The first list a worker
	 * is given is the whole library, and it forgets what it holds of files that are not in it: a file deleted or moved while no
	 * server was running was never reported gone.
	 */
	sync(files: Iterable<{ file: string; size: number; mtime: number }>): void {
		const changed: { file: string; size: number; mtime: number }[] = [];
		const seen = new Set<string>();
		for (const f of files) {
			seen.add(f.file);
			const known = this.sent.get(f.file);
			if (known && known.size === f.size && known.mtime === f.mtime) continue;
			this.sent.set(f.file, { size: f.size, mtime: f.mtime });
			changed.push(f);
		}
		const gone = [...this.sent.keys()].filter((f) => !seen.has(f));
		for (const f of gone) this.sent.delete(f);
		const full = !this.told;
		if (!full && changed.length === 0 && gone.length === 0) return;
		this.told = true;
		this.start().postMessage({ t: "files", files: changed, gone, full } satisfies Job);
	}

	/**
	 * `sync` for what changed, when nothing else has: the files in `files` as they are now, and the ones in `gone` that went.
	 * The work is that of the change, not of the library. False when the worker has not been told the whole library yet (it was
	 * just started again): the caller `sync`s it.
	 */
	update(files: Iterable<{ file: string; size: number; mtime: number }>, gone: Iterable<string>): boolean {
		if (!this.told) return false;
		const changed: { file: string; size: number; mtime: number }[] = [];
		for (const f of files) {
			const known = this.sent.get(f.file);
			if (known && known.size === f.size && known.mtime === f.mtime) continue;
			this.sent.set(f.file, { size: f.size, mtime: f.mtime });
			changed.push(f);
		}
		const left = [...gone].filter((f) => this.sent.delete(f));
		if (changed.length === 0 && left.length === 0) return true;
		this.start().postMessage({ t: "files", files: changed, gone: left, full: false } satisfies Job);
		return true;
	}

	/**
	 * Hand `job` to the worker. With `deadlineMs` the worker has that long to answer (with `stall`, that long since its last
	 * report of progress), or it is terminated and everything waiting for it fails with a `WorkerDeadlineError`: a thread that is
	 * stuck answers nothing, so what else is waiting is stuck with it, and the next call starts a new worker.
	 */
	private ask(
		job: Job & { id: number },
		deadlineMs: number | null,
		stall = false,
	): Promise<Extract<Reply, { id: number }>> {
		const { promise, resolve, reject } = Promise.withResolvers<Extract<Reply, { id: number }>>();
		const waiter: Waiter = { resolve, reject, stallMs: stall && deadlineMs !== null ? deadlineMs : undefined };
		this.pending.set(job.id, waiter);
		if (deadlineMs !== null) this.arm(waiter, deadlineMs);
		try {
			this.start().postMessage(job);
		} catch (e) {
			this.stop(e instanceof Error ? e : new Error(String(e)));
		}
		return promise;
	}

	private arm(waiter: Waiter, ms: number): void {
		clearTimeout(waiter.timer);
		waiter.timer = setTimeout(() => this.stop(new WorkerDeadlineError("The search index worker", ms)), ms);
		waiter.timer.unref();
	}

	/**
	 * Search the index. With `signal`, a search nobody waits for any more is dropped: one that is aborted before it is asked
	 * for is never sent (nor is a worker started for it), one that is aborted in the worker's queue fails at once and the
	 * worker skips it when its turn comes. Typing sends a search per pause, and the worker runs them one after the other.
	 */
	async search(
		req: SearchRequest,
		signal?: AbortSignal,
	): Promise<{ hits: RawHit[]; coverage: Coverage; file?: FileCoverage }> {
		signal?.throwIfAborted();
		// Shared memory, not a message: the worker has the searches ahead of this one to run first, and a message would queue behind them.
		const cancel = new Int32Array(new SharedArrayBuffer(4));
		const id = ++this.seq;
		// The worker waits for the conversation this search names for as long as that takes, so the deadline of the
		// answer covers that wait too.
		const waited = req.fileWaitMs ?? req.waitMs;
		const asked = this.ask({ t: "search", id, req, cancel }, waited + this.searchDeadlineMs);
		const abandon = () => {
			Atomics.store(cancel, 0, 1);
			const waiter = this.pending.get(id);
			if (!waiter) return;
			this.pending.delete(id);
			clearTimeout(waiter.timer);
			waiter.reject(signal?.reason);
		};
		signal?.addEventListener("abort", abandon, { once: true });
		try {
			const reply = await asked;
			if (reply.t !== "result") throw new Error("The search index answered something else than a search");
			return { hits: reply.hits, coverage: reply.coverage, file: reply.file };
		} finally {
			signal?.removeEventListener("abort", abandon);
		}
	}

	/** Resolves once everything the worker was told about is indexed (and, with `compact`, the index compacted if it is due). */
	async flush(compact = false): Promise<Coverage & IndexStats> {
		// A compaction rewrites the file without a word of progress, for as long as the file is big: it is not bounded.
		const reply = await this.ask({ t: "flush", id: ++this.seq, compact }, compact ? null : this.flushStallMs, true);
		if (reply.t !== "flushed") throw new Error("The search index answered something else than a flush");
		return { ...reply.coverage, ...reply.stats };
	}

	/**
	 * Stop the worker. It closes its database first (and says so in the file, so that the next start does not have to look at
	 * every page of it), which the caller waits for: for a moment at most, a worker in the middle of a long statement is not
	 * waited for.
	 */
	close(): void {
		if (this.worker) {
			const done = new Int32Array(new SharedArrayBuffer(4));
			this.worker.postMessage({ t: "close", done } satisfies Job);
			Atomics.wait(done, 0, 0, CLOSE_WAIT_MS);
		}
		this.stop(new Error("The search index was closed"));
	}

	private start(): Worker {
		if (this.worker) return this.worker;
		const worker = this.spawn();
		// Bun's workers do not keep the process alive by default: a server that is shutting down does not wait for one.
		worker.onmessage = (event: MessageEvent<Reply>) => {
			const reply = event.data;
			if (reply.t === "progress") {
				this.latest = reply.coverage;
				for (const waiter of this.pending.values()) if (waiter.stallMs) this.arm(waiter, waiter.stallMs);
				return;
			}
			if (reply.t === "error" && reply.id === null) return;
			const id = reply.id as number;
			const waiter = this.pending.get(id);
			if (!waiter) return;
			this.pending.delete(id);
			clearTimeout(waiter.timer);
			if (reply.t === "error") {
				waiter.reject(new Error(reply.message));
				return;
			}
			this.latest = reply.coverage;
			waiter.resolve(reply);
		};
		const died = (message: string) => {
			// A worker that was replaced or stopped on purpose is no longer `this.worker`.
			if (this.worker !== worker) return;
			this.stop(new Error(message));
		};
		worker.addEventListener("error", (event) => died(`The search index worker failed: ${event.message}`));
		worker.addEventListener("close", () => died("The search index worker stopped"));
		worker.postMessage({ t: "open", dbPath: this.dbPath } satisfies Job);
		this.worker = worker;
		return worker;
	}

	/** The worker is gone: what it was working on fails, and the next call starts a new one that is told everything again. */
	private stop(error: Error): void {
		const waiters = [...this.pending.values()];
		this.pending.clear();
		for (const waiter of waiters) clearTimeout(waiter.timer);
		this.worker?.terminate();
		this.worker = null;
		this.sent = new Map();
		this.told = false;
		for (const waiter of waiters) waiter.reject(error);
	}
}
