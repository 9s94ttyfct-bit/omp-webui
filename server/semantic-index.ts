import type { Endpoint } from "./semantic/runtime.ts";
import { WorkerDeadlineError } from "./worker-deadline.ts";

/**
 * Semantic search's index of the conversations, in a worker thread of its own (`semantic-worker.ts`): one vector per passage
 * of every message the full-text index holds, made by the model `llama-server` runs (`semantic/runtime.ts`), kept in
 * `<data dir>/semantic/index.db` and in the worker's memory, where a search scores all of them.
 *
 * The messages are read from the full-text index (`index.search.db`, `search-index.ts`), which already knows which messages
 * of which conversation are searchable and keeps up with the files as they are written: a message is embedded once it is
 * there, a conversation deleted or rewritten there is deleted or embedded again here (by its `fid` and `epoch`).
 *
 * The worker asks this side for the server (`need`) when it has messages to embed, and holds it running while it does
 * (`busy`); a search asks for it first. Neither the indexing nor a search waits on the server's request thread.
 *
 * The compiled app embeds `semantic-worker.ts` as an entry point of its own (scripts/lib/server-compile.ts) and reaches it
 * through the same relative URL as from source: keep both files next to `main.ts`.
 */

export interface RawSemanticHit {
	file: string;
	entryId: string;
	role: string;
	snippet: string;
	timestamp: string;
	score: number;
}

export interface SemanticProgress {
	/** Messages embedded (or passed over as too short), of all the full-text index holds. */
	indexed: number;
	total: number;
}

export type SemanticJob =
	| { t: "open"; dbPath: string; ftsPath: string }
	| { t: "endpoint"; id: number; endpoint: Endpoint | null; error?: string }
	| { t: "search"; id: number; q: string; max: number; endpoint: Endpoint }
	| { t: "close"; done: Int32Array<SharedArrayBuffer> };

export type SemanticReply =
	| { t: "need"; id: number }
	| { t: "busy"; on: boolean }
	| { t: "progress"; progress: SemanticProgress }
	/** Embedding failed (`message`), or works again (`message` null) after it had. */
	| { t: "trouble"; message: string | null }
	| { t: "result"; id: number; hits: RawSemanticHit[] }
	| { t: "error"; id: number | null; message: string };

export interface SemanticRuntime {
	ensure(): Promise<Endpoint>;
	hold(on: boolean): void;
}

export interface SemanticIndexOptions {
	dbPath: string;
	ftsPath: string;
	runtime: SemanticRuntime;
	/** Told when embedding fails, or works again (null). */
	onTrouble?: (message: string | null) => void;
	spawn?: () => Worker;
	/** How long a search may take once the server is up (its query is embedded, every vector scored). */
	searchDeadlineMs?: number;
}

const CLOSE_WAIT_MS = 2000;
const SEARCH_DEADLINE_MS = 30_000;

export class SemanticIndex {
	private worker: Worker | null = null;
	private readonly pending = new Map<
		number,
		{ resolve(hits: RawSemanticHit[]): void; reject(e: Error): void; timer: NodeJS.Timeout }
	>();
	private seq = 0;
	private latest: SemanticProgress = { indexed: 0, total: 0 };
	/** The worker holds the server (it is embedding): let go when it says so, or when it is gone. */
	private holding = false;
	private closed = false;

	constructor(private readonly opts: SemanticIndexOptions) {
		this.start();
	}

	get progress(): SemanticProgress {
		return this.latest;
	}

	/** The `max` conversations closest to `q`, best first: one passage each. */
	async search(q: string, max: number, signal?: AbortSignal): Promise<RawSemanticHit[]> {
		signal?.throwIfAborted();
		const endpoint = await this.opts.runtime.ensure();
		signal?.throwIfAborted();
		const id = ++this.seq;
		const { promise, resolve, reject } = Promise.withResolvers<RawSemanticHit[]>();
		const ms = this.opts.searchDeadlineMs ?? SEARCH_DEADLINE_MS;
		const timer = setTimeout(() => this.fail(new WorkerDeadlineError("The semantic index worker", ms)), ms);
		timer.unref();
		this.pending.set(id, { resolve, reject, timer });
		const abandon = () => {
			const waiter = this.pending.get(id);
			if (!waiter) return;
			this.pending.delete(id);
			clearTimeout(waiter.timer);
			waiter.reject(signal?.reason);
		};
		signal?.addEventListener("abort", abandon, { once: true });
		try {
			this.start().postMessage({ t: "search", id, q, max, endpoint } satisfies SemanticJob);
			return await promise;
		} finally {
			signal?.removeEventListener("abort", abandon);
		}
	}

	/** Stop the worker, its database closed first (for a moment at most). */
	close(): void {
		this.closed = true;
		if (this.worker) {
			const done = new Int32Array(new SharedArrayBuffer(4));
			this.worker.postMessage({ t: "close", done } satisfies SemanticJob);
			Atomics.wait(done, 0, 0, CLOSE_WAIT_MS);
		}
		this.fail(new Error("The semantic index was closed"));
	}

	private start(): Worker {
		if (this.worker) return this.worker;
		if (this.closed) throw new Error("The semantic index was closed");
		const worker = this.opts.spawn?.() ?? new Worker(new URL("./semantic-worker.ts", import.meta.url));
		worker.onmessage = (event: MessageEvent<SemanticReply>) => this.onReply(worker, event.data);
		const died = (message: string) => {
			if (this.worker === worker) this.fail(new Error(message));
		};
		worker.addEventListener("error", (event) => died(`The semantic index worker failed: ${event.message}`));
		worker.addEventListener("close", () => died("The semantic index worker stopped"));
		worker.postMessage({ t: "open", dbPath: this.opts.dbPath, ftsPath: this.opts.ftsPath } satisfies SemanticJob);
		this.worker = worker;
		return worker;
	}

	private onReply(worker: Worker, reply: SemanticReply): void {
		switch (reply.t) {
			case "need":
				this.opts.runtime.ensure().then(
					(endpoint) => worker.postMessage({ t: "endpoint", id: reply.id, endpoint } satisfies SemanticJob),
					(e: unknown) =>
						worker.postMessage({
							t: "endpoint",
							id: reply.id,
							endpoint: null,
							error: e instanceof Error ? e.message : String(e),
						} satisfies SemanticJob),
				);
				return;
			case "busy":
				if (reply.on === this.holding) return;
				this.holding = reply.on;
				this.opts.runtime.hold(reply.on);
				return;
			case "progress":
				this.latest = reply.progress;
				return;
			case "trouble":
				this.opts.onTrouble?.(reply.message);
				return;
			case "result":
			case "error": {
				const id = reply.id;
				if (id === null) {
					if (reply.t === "error") console.error(`semantic index: ${reply.message}`);
					return;
				}
				const waiter = this.pending.get(id);
				if (!waiter) return;
				this.pending.delete(id);
				clearTimeout(waiter.timer);
				if (reply.t === "result") waiter.resolve(reply.hits);
				else waiter.reject(new Error(reply.message));
				return;
			}
		}
	}

	/** The worker is gone: what waited on it fails, and (unless closed) a new one starts and takes up where the file is. */
	private fail(error: Error): void {
		const waiters = [...this.pending.values()];
		this.pending.clear();
		for (const w of waiters) clearTimeout(w.timer);
		this.worker?.terminate();
		this.worker = null;
		if (this.holding) {
			this.holding = false;
			this.opts.runtime.hold(false);
		}
		for (const w of waiters) w.reject(error);
		if (!this.closed) this.start();
	}
}
