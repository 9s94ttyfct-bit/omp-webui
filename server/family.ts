import { statSync } from "node:fs";
import { promisify } from "node:util";
import { gunzip } from "node:zlib";
import type { AdvisorFile, SubagentFile } from "../shared/protocol.ts";
import { FAMILY_DEDUP_HEADER, FAMILY_HAVE_HEADER } from "../shared/protocol.ts";
import { acceptsGzip } from "./compress.ts";
import { ViewError, type ViewRequest } from "./history-request.ts";
import type { SessionStore } from "./sessions/store.ts";
import { deadlineFromEnv, WorkerDeadlineError } from "./worker-deadline.ts";

/**
 * `/api/family`: a conversation together with the branches and forks of its lineage, as one JSON document.
 * For a long conversation that is tens of MB, so it is never produced on the request thread: a worker
 * reads, parses, serializes and gzips it, and the gzip body is kept — per lineage, tagged with the
 * modification time and size of every member file — so the same lineage is not built twice. The tag is the
 * response's ETag, so a browser that has the document already is answered with a 304 and no body.
 *
 * A fork holds the whole path from the root copied, so a family of a long conversation and three of its forks is
 * four times the conversation. A client that can put the entries the files share back together says so (the
 * `x-family-dedup` header) and is sent the shared path once, with each file saying which entries it has (`order`).
 *
 * Every file of the family has a `tag`: its version (path, modification time and size, and those of its subagents'
 * and advisors' transcripts). The ETag covers all of them, so a write to any file makes the family a new document; but a
 * client that holds the family says which tags it holds (`x-family-have`), and a file it holds as it is comes only by name
 * (`kept`). A write to one fork then sends that fork — not the conversation, and every other fork, to a tab that views one of
 * them. The page needs every file (the branches of the conversation are in the others), so each is still part of the document.
 *
 * A request with `view` (`FamilyViewKind`) is answered with a window of the history of the one file instead (see
 * `history.ts`): the family's members, each with what a list of them needs and the one asked for with the window's entries,
 * or the figures of the file (`stats`). It is built by the same worker, from the indexes the worker keeps of the files while
 * it lives (`WORKER_IDLE_MS`), and its ETag covers what was asked for (the kind, `at`, `leaf` and `limit`) and the version of
 * every member. The end (`tail`) and the figures are kept per file version like the lineage; the windows paged in above or
 * below are not (`isKept`). A window that names an entry the file does not have is a 404 with the code `unknown_entry`.
 *
 * `/api/session` (one transcript, a subagent's) is the same document of one file, and goes the same way: read, parsed,
 * serialized and gzipped by the same worker, kept and tagged in the same way.
 */

export interface FamilyMember {
	file: string;
	subagents: SubagentFile[];
	advisors: AdvisorFile[];
	/** The file's version (`tagOf`): sent with the file in a family. */
	tag: string;
	/** The client holds this file as it is: it is sent by name and `tag` only, though the entries it has still count for the files after it. */
	kept?: boolean;
}

/** What the worker is asked to do, and what it answers. */
export interface Job {
	id: number;
	file: string;
	members: FamilyMember[];
	/** The document is the one member's `SessionFileData` (`/api/session`), not `{ file, members }`. */
	single?: boolean;
	/**
	 * The client can put the entries the files share back together (`restoreMembers` in the web UI): the shared path of
	 * a family is then sent once, not once per fork. A client that does not say so is sent every file whole.
	 */
	dedup?: boolean;
	/**
	 * A window of the history of `file` (`view`, see `history.ts`) is answered instead of the lineage whole: `members` are
	 * still all of the family, and each is sent with what a list of it needs, the one named by `file` with the window's entries.
	 */
	view?: ViewRequest;
}
/** `code` is set when the request cannot be answered because of what it names (`ViewError`). */
export type Reply = { id: number; gz: ArrayBuffer } | { id: number; error: string; code?: ViewError["code"] };

/** A body that `Response` takes. */
type Bytes = Uint8Array<ArrayBuffer>;

/** The gzip-compressed JSON of `{ file, members }` for a lineage (each member is a `SessionFileData`), or of the one member's with `single`. */
export type Build = (
	file: string,
	members: FamilyMember[],
	single?: boolean,
	dedup?: boolean,
	view?: ViewRequest,
) => Promise<Bytes>;

/**
 * How long the worker lives after its last job. What it holds goes with it: the thread's heap (a few MB with the modules it
 * loads) and the indexes of the files it has read (`IndexCache`: ~0.5 KB an entry, a few MB for a conversation of thousands
 * of entries). A thread that is merely idle keeps both and the allocator does not give them back: with the benchmark's long
 * conversation open and then left, the server stayed ~12 MB above what it is once the worker has stopped. A reader who pauses
 * for longer than this finds the next window a worker start (~10 ms) and an indexing pass (~0.4 ms per MB of the file) away, and
 * the figures of the file (`view=stats`) a fold over it again (9 ms for 17 MB, 44-64 ms for 50 MB): the cost of opening a small
 * conversation, once per pause.
 */
const WORKER_IDLE_MS = 3_000;

/**
 * How long one job may take, from the moment it is handed to the worker (which includes the worker coming up) to its answer;
 * past that the worker is wedged, or never started, and is replaced. A 300 MB conversation (the largest measured) is read,
 * parsed, serialized and gzipped in about 2 s on a machine that was busy with other work (1.7 s of CPU, 1.4 GB at the peak),
 * whether it is made of small entries or of large tool results: 60 s is thirty times that, room for a slow disk and a loaded
 * machine, and short enough that a wedged worker is not waited on for long. `OMP_WEBUI_FAMILY_DEADLINE_MS` overrides it.
 */
export const FAMILY_DEADLINE_MS = 60_000;

interface Task {
	job: Job;
	resolve(bytes: Bytes): void;
	reject(error: Error): void;
	timer?: NodeJS.Timeout;
}

export interface WorkerHostOptions {
	/** The job deadline (`FAMILY_DEADLINE_MS`). */
	deadlineMs?: number;
	/** How long the worker lives after its last job (`WORKER_IDLE_MS`). */
	idleMs?: number;
	/** Starts the worker (the family worker). */
	spawn?: () => Worker;
}

/**
 * The family worker and the jobs for it. One job is with the worker at a time: the deadline then measures that job, never
 * the wait behind another, and two big conversations are not parsed side by side in one thread's memory. A worker that does
 * not answer in time, or stops, is terminated and fails the job it held; the jobs behind it, and every later one, get a new worker.
 */
export class WorkerHost {
	private worker: Worker | null = null;
	private queue: Task[] = [];
	private current: Task | null = null;
	private seq = 0;
	private idle: NodeJS.Timeout | undefined;
	private readonly deadlineMs: number;
	private readonly idleMs: number;
	private readonly spawn: () => Worker;

	constructor(options: WorkerHostOptions = {}) {
		this.deadlineMs =
			options.deadlineMs ?? deadlineFromEnv(process.env.OMP_WEBUI_FAMILY_DEADLINE_MS, FAMILY_DEADLINE_MS);
		this.idleMs = options.idleMs ?? WORKER_IDLE_MS;
		this.spawn = options.spawn ?? (() => new Worker(new URL("./family-worker.ts", import.meta.url)));
	}

	build(file: string, members: FamilyMember[], single?: boolean, dedup?: boolean, view?: ViewRequest): Promise<Bytes> {
		const { promise, resolve, reject } = Promise.withResolvers<Bytes>();
		this.queue.push({ job: { id: ++this.seq, file, members, single, dedup, view }, resolve, reject });
		this.pump();
		return promise;
	}

	/** Hand the next job to the worker, starting one if there is none; with no job left, let the worker go after a while. */
	private pump(): void {
		if (this.current) return;
		clearTimeout(this.idle);
		const task = this.queue.shift();
		if (!task) {
			if (!this.worker) return;
			this.idle = setTimeout(() => this.stop(), this.idleMs);
			this.idle.unref();
			return;
		}
		this.current = task;
		task.timer = setTimeout(
			() => this.settle(task, new WorkerDeadlineError("The family worker", this.deadlineMs), true),
			this.deadlineMs,
		);
		task.timer.unref();
		try {
			this.start().postMessage(task.job);
		} catch (e) {
			this.settle(task, e instanceof Error ? e : new Error(String(e)), true);
		}
	}

	private start(): Worker {
		if (this.worker) return this.worker;
		const worker = this.spawn();
		worker.onmessage = (event: MessageEvent<Reply>) => {
			const task = this.current;
			if (this.worker !== worker || task?.job.id !== event.data.id) return;
			if ("error" in event.data) {
				const { error, code } = event.data;
				this.settle(task, code ? new ViewError(error, code) : new Error(error), false);
			} else this.settle(task, new Uint8Array(event.data.gz), false);
		};
		const died = (message: string) => {
			// A worker that was replaced or stopped on purpose is no longer `this.worker`.
			if (this.worker !== worker || !this.current) return;
			this.settle(this.current, new Error(message), true);
		};
		worker.addEventListener("error", (event) => died(`The family worker failed: ${event.message}`));
		worker.addEventListener("close", () => died("The family worker stopped"));
		this.worker = worker;
		return worker;
	}

	/** The current job ends, with its bytes or its error; a worker that failed it is terminated, and the next job starts a new one. */
	private settle(task: Task, outcome: Bytes | Error, terminate: boolean): void {
		if (this.current !== task) return;
		clearTimeout(task.timer);
		this.current = null;
		if (terminate) this.stop();
		if (outcome instanceof Error) task.reject(outcome);
		else task.resolve(outcome);
		this.pump();
	}

	/**
	 * End the worker. A job it still holds fails at once (and the next job gets a new worker) instead of waiting out its deadline
	 * for an answer that cannot come. The idle timer cannot get here with a job in hand (it is armed only with none), and `settle`
	 * ends its job before it stops the worker: this is for a caller that stops the host while a job runs.
	 */
	private stop(): void {
		clearTimeout(this.idle);
		this.worker?.terminate();
		this.worker = null;
		if (this.current) this.settle(this.current, new Error("The family worker was stopped"), false);
	}
}

const host = new WorkerHost();

/** The production `Build`: in a worker thread, shared by every cache. */
export const buildInWorker: Build = (file, members, single, dedup, view) =>
	host.build(file, members, single, dedup, view);

const CACHE_CONTROL = "private, no-cache";
const gunzipAsync = promisify(gunzip);

interface Entry {
	/** What the body is of: the document's ETag, and which files of it are sent by name only. */
	version: string;
	gz: Bytes;
}

/** Whether an `If-None-Match` header names `etag` (weak comparison: `W/"x"` and `"x"` are the same document). */
function matches(header: string | null, etag: string): boolean {
	if (!header) return false;
	const bare = (tag: string) => tag.trim().replace(/^W\//, "");
	return header.trim() === "*" || header.split(",").some((tag) => bare(tag) === bare(etag));
}

/**
 * The version of one file of a lineage: its path, modification time, size, change time and inode, and those of its
 * subagent and advisor transcripts — everything the file's part of the document is made of.
 *
 * The change time and the inode are in it because the modification time and the size do not tell a rewrite from the
 * file they were read from: a restore that keeps times (`rsync -t`, `cp -p`, `touch -r`) or two writes in one clock
 * tick of a coarse file system leaves both as they were. The change time cannot be set back (`utimes` does not touch
 * it) and a file that was replaced has another inode, so a file that was rewritten is not the one a client holds.
 *
 * A file that is gone fails the request, as it did: the request is answered for a family whose files are all there.
 */
function tagOf(member: Omit<FamilyMember, "tag">): string {
	const st = statSync(member.file);
	const parts = [`${member.file}:${st.mtimeMs}:${st.size}:${st.ctimeMs}:${st.ino}`];
	for (const sub of member.subagents) parts.push(`${sub.file}:${sub.modifiedAt}:${sub.size}`);
	for (const advisor of member.advisors) parts.push(`${advisor.file}:${advisor.modifiedAt}:${advisor.size}`);
	return Bun.hash(parts.join("\n")).toString(36);
}

/**
 * The ETag of a lineage's document: derived from the requested file and the version of every member file. A window of the
 * history is another document, of the file, the kind of window and what it was asked for.
 */
function etagOf(file: string, members: FamilyMember[], single: boolean, dedup: boolean, view?: ViewRequest): string {
	// The shared path of the family is sent once to a client that can put it back together and whole to one that
	// cannot: the two are different documents, and say so.
	const what = view
		? `view ${file} ${view.kind} ${view.at ?? ""} ${view.leaf ?? ""} ${view.limit ?? ""}`
		: single
			? `session ${file}`
			: dedup
				? `family ${file}`
				: file;
	const parts = [what, ...members.map((m) => m.tag)];
	return `W/"${Bun.hash(parts.join("\n")).toString(36)}"`;
}

/**
 * Whether the body of this request is kept for the next one. The lineage whole and a transcript are (hundreds of ms of work
 * to rebuild); so are the end of a conversation (what every open and reload asks for) and its figures (a pass over the whole
 * file when the worker has let its index go). The windows a reader pages in above or below, or jumps to, are not: each is a few
 * ms from a warm index, is asked for once, and a client that asks again has its copy (the ETag answers it with a 304 before
 * any body is looked for). Kept, a conversation of thousands of entries left ~8 MB of them in the server.
 */
function isKept(view: ViewRequest | undefined): boolean {
	return !view || view.kind === "tail" || view.kind === "stats";
}

export class FamilyCache {
	/** The latest body per requested file; Map order is use order, oldest first. */
	private entries = new Map<string, Entry>();
	private bytes = 0;
	/** Bodies being built, by file and ETag: a second request for the same version joins the first. */
	private building = new Map<string, Promise<Bytes>>();
	private readonly build: Build;
	private readonly limitBytes: number;

	constructor(
		private readonly store: SessionStore,
		options: { build?: Build; limitBytes?: number } = {},
	) {
		this.build = options.build ?? buildInWorker;
		this.limitBytes = options.limitBytes ?? 64 * 1024 * 1024;
	}

	/**
	 * Answer a request for the lineage of `file` (the canonical path of a session file), or for the window of its history
	 * `view` asks for (the lineage's members with the entries of the window in `file`'s, or its stats).
	 */
	respond(req: Request, file: string, view?: ViewRequest): Promise<Response> {
		return this.answer(req, file, false, view);
	}

	/** Answer a request for the transcript `file` alone: its entries, subagents and advisors, as a `SessionFileData`. */
	respondSession(req: Request, file: string): Promise<Response> {
		return this.answer(req, file, true);
	}

	private async answer(req: Request, file: string, single: boolean, view?: ViewRequest): Promise<Response> {
		const files = single ? [file] : await this.store.family(file);
		const members: FamilyMember[] = await Promise.all(
			files.map(async (f) => {
				const transcripts = { file: f, ...(await this.store.transcripts(f)) };
				return { ...transcripts, tag: tagOf(transcripts) };
			}),
		);
		// A client that says it can put the entries the files share back together is sent the shared path once; one that
		// does not (an older page, another program) is sent every file whole, as before.
		const dedup = !single && !view && req.headers.get(FAMILY_DEDUP_HEADER) === "1";
		const etag = etagOf(file, members, single, dedup, view);
		const headers = {
			etag,
			"cache-control": CACHE_CONTROL,
			vary: `accept-encoding, ${FAMILY_DEDUP_HEADER}, ${FAMILY_HAVE_HEADER}`,
			...(dedup ? { [FAMILY_DEDUP_HEADER]: "1" } : {}),
		};
		if (matches(req.headers.get("if-none-match"), etag)) return new Response(null, { status: 304, headers });

		// A file of the family that the client says it holds (and that is as it was) is sent by name only.
		if (dedup) {
			const have = new Set((req.headers.get(FAMILY_HAVE_HEADER) ?? "").split(",").map((tag) => tag.trim()));
			for (const member of members) member.kept = have.has(member.tag);
		}
		const slot = view
			? `view\0${file}\0${view.kind}\0${view.at ?? ""}\0${view.leaf ?? ""}\0${view.limit ?? ""}`
			: single
				? `session\0${file}`
				: file;
		let gz: Bytes;
		try {
			gz = await this.body(slot, etag, file, members, single, dedup, view);
		} catch (e) {
			// What the request names is not in the file: the page asks for the end of the history instead.
			if (!(e instanceof ViewError)) throw e;
			return Response.json({ error: e.message, code: e.code }, { status: 404 });
		}
		if (acceptsGzip(req)) {
			return new Response(gz, {
				headers: { ...headers, "content-type": "application/json", "content-encoding": "gzip" },
			});
		}
		return new Response(await gunzipAsync(gz), { headers: { ...headers, "content-type": "application/json" } });
	}

	/** The body kept under `slot` (the file, `session\0` and the file, or a view's), or built: `file` and `members` are what it is made of. */
	private body(
		slot: string,
		etag: string,
		file: string,
		members: FamilyMember[],
		single: boolean,
		dedup: boolean,
		view?: ViewRequest,
	): Promise<Bytes> {
		// The same document, with other files held by the client, is another body.
		const version = `${etag}\0${members.map((m) => (m.kept ? "1" : "0")).join("")}`;
		const kept = this.entries.get(slot);
		if (kept?.version === version) {
			// Used again: last in line to be dropped.
			this.entries.delete(slot);
			this.entries.set(slot, kept);
			return Promise.resolve(kept.gz);
		}
		const key = `${slot}\0${version}`;
		let building = this.building.get(key);
		if (!building) {
			building = this.build(file, members, single, dedup, view)
				.then((gz) => {
					if (isKept(view)) this.keep(slot, { version, gz });
					return gz;
				})
				.finally(() => this.building.delete(key));
			this.building.set(key, building);
		}
		return building;
	}

	/** Keep `entry` as the body of `file`, dropping the least recently used bodies to stay within the limit. */
	private keep(file: string, entry: Entry): void {
		const old = this.entries.get(file);
		if (old) this.bytes -= old.gz.byteLength;
		this.entries.delete(file);
		if (entry.gz.byteLength > this.limitBytes) return;
		this.entries.set(file, entry);
		this.bytes += entry.gz.byteLength;
		for (const [oldest, dropped] of this.entries) {
			if (this.bytes <= this.limitBytes) break;
			this.entries.delete(oldest);
			this.bytes -= dropped.gz.byteLength;
		}
	}
}
