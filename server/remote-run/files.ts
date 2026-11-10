import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, mkdir, open, stat } from "node:fs/promises";
import { dirname } from "node:path";
import {
	COPY_HEADERS,
	type CopyDone,
	type CopyKind,
	pathProblem,
	REMOTE_COPY_IDLE_MS,
	REMOTE_COPY_MAX_BYTES,
	REMOTE_COPY_MAX_ENTRIES,
	REMOTE_COPY_PIECE,
	REMOTE_COPY_ROUTE,
	RemoteCopyError,
} from "../../shared/remote-copy.ts";
import { ERROR_HEADER, type TransferKind } from "../../shared/transfer.ts";
import type { TransferLog } from "../transfer-log.ts";
import {
	applyTop,
	checkTarget,
	discard,
	ensureRoom,
	makeParent,
	type Places,
	placeOf,
	publish,
	type Reserve,
	type SpaceOf,
	stagedBeside,
	unmake,
} from "./copy-place.ts";
import { fsFailure, packTar, TarUnpacker, walkFolder } from "./tar.ts";

/**
 * The other side of `remote_copy` (`shared/remote-copy.ts`): what this server answers when another computer of the person's
 * copies a file or a folder from it (`GET /api/remote-run/file`) or to it (`POST`, then `PUT` pieces, then `POST
 * /api/remote-run/file/<id>`). The routes are owner-only, as all of `/api/remote-run*` is: the person's own page (this
 * computer's) or one signed in through Cloudflare Access, which is what the other computer's server comes as; a page that holds
 * only the token is answered 403 before it gets here.
 *
 * A path is this computer's: absolute, or `~`/`~/…` (relative: to the home folder). What is written is held to
 * `copy-place.ts` (never the home folder or the app's data, nothing replaced unasked, written beside the target and moved into
 * place whole); a folder is unpacked as its pieces arrive (`tar.ts`), so nothing but the copy itself takes room on the disk.
 * An upload that gets no piece for `REMOTE_COPY_IDLE_MS` is given up. Every copy that ended or was refused is logged in the
 * transfer log (`copy-send`, `copy-receive`) with who asked: the Access email.
 */

export interface RemoteFilesOptions {
	log: TransferLog;
	places: Places;
	/** What every write leaves free on the disk (`DEFAULT_LIMITS`, or the test server's). */
	reserve: Reserve;
	spaceOf?: SpaceOf;
	now?: () => number;
	/** How long an upload may go without a byte arriving (`REMOTE_COPY_IDLE_MS`; tests: less). */
	idleMs?: number;
}

interface Upload {
	id: string;
	who: string;
	abs: string;
	kind: CopyKind;
	overwrite: boolean;
	/** The bytes the request said it would send (a folder's tar), and those that came. */
	size: number;
	received: number;
	/** The bytes of the files (a file's own size), as the request declared them. */
	bytes: number;
	mode: number | null;
	mtime: number | null;
	staged: string;
	/** The first folder above the target this upload made (removed again when it is given up). */
	made: string | undefined;
	handle: FileHandle | null;
	unpacker: TarUnpacker | null;
	/** A piece or the finish is under way. */
	busy: boolean;
	/** Stops the piece under way from being read (null: none is). */
	stop: (() => void) | null;
	/** When a byte last arrived (or the upload began). */
	touched: number;
	started: number;
}

const SWEEP_MS = 60_000;

const failure = (e: RemoteCopyError, more: Record<string, unknown> = {}): Response =>
	Response.json({ error: e.message, code: e.code, ...more }, { status: e.status, headers: { [ERROR_HEADER]: e.code } });

/** A whole number from the query, or null when it is absent; refuses anything else. */
function wholeOf(q: URLSearchParams, key: string, radix = 10): number | null {
	const v = q.get(key);
	if (v === null || v === "") return null;
	if (!(radix === 8 ? /^[0-7]{1,6}$/ : /^\d{1,16}$/).test(v))
		throw new RemoteCopyError(`${key} must be a whole number`, "badRequest");
	return Number.parseInt(v, radix);
}

export class RemoteFiles {
	readonly #uploads = new Map<string, Upload>();
	readonly #now: () => number;
	readonly #timer: ReturnType<typeof setInterval>;

	constructor(private readonly o: RemoteFilesOptions) {
		this.#now = o.now ?? Date.now;
		this.#timer = setInterval(() => void this.expire(), SWEEP_MS);
		this.#timer.unref();
	}

	/** A request for `REMOTE_COPY_ROUTE` or below it, from `who` (the Access email). */
	async handle(req: Request, url: URL, who: string): Promise<Response> {
		try {
			if (url.pathname === REMOTE_COPY_ROUTE) {
				if (req.method === "GET") return await this.#send(url, who);
				if (req.method === "POST") return await this.#begin(url, who);
			} else {
				const id = url.pathname.slice(REMOTE_COPY_ROUTE.length + 1);
				if (req.method === "PUT") return await this.#piece(req, id, url, who);
				if (req.method === "POST") return await this.#finish(id, who);
				if (req.method === "DELETE") return await this.#cancel(id, who);
			}
			return Response.json({ error: "Method not allowed" }, { status: 405 });
		} catch (e) {
			if (e instanceof RemoteCopyError) return failure(e);
			return Response.json({ error: (e as Error).message }, { status: 500 });
		}
	}

	/** The server is going away: what was being received is removed. */
	async close(): Promise<void> {
		clearInterval(this.#timer);
		await Promise.all([...this.#uploads.values()].map((u) => this.#drop(u, "aborted")));
	}

	/**
	 * Uploads that got no byte for `idleMs` are given up, a piece that is under way and stalled included: its request is no
	 * longer read, and what it holds of the disk is given back.
	 */
	async expire(): Promise<void> {
		const now = this.#now();
		const idle = this.o.idleMs ?? REMOTE_COPY_IDLE_MS;
		for (const u of [...this.#uploads.values()]) {
			// The finish is under way (`busy` with no piece): it is quick and ends the upload itself.
			if (now - u.touched <= idle || (u.busy && !u.stop)) continue;
			u.stop?.();
			await this.#drop(u, "expired");
		}
	}

	#record(kind: TransferKind, who: string, path: string, started: number, status: string, more = {}): void {
		this.o.log.append({
			t: new Date().toISOString(),
			kind,
			who,
			root: "",
			path,
			...more,
			status,
			ms: this.#now() - started,
		});
	}

	#pathOf(q: URLSearchParams): string {
		const given = q.get("path");
		const problem = pathProblem("path", given);
		if (problem) throw new RemoteCopyError(problem, "badRequest");
		return placeOf(given as string, this.o.places.home, this.o.places.home);
	}

	// ------------------------------------------------------------------ sending

	async #send(url: URL, who: string): Promise<Response> {
		const started = this.#now();
		const abs = this.#pathOf(url.searchParams);
		try {
			// The path itself is followed when it is a link (what it names is copied); links inside a folder are copied as links.
			const st = await stat(abs).catch((e) => {
				const code = (e as NodeJS.ErrnoException).code;
				throw code === "ENOENT" || code === "ENOTDIR"
					? new RemoteCopyError(`Nothing is at ${abs}`, "notFound")
					: fsFailure(e, abs);
			});
			const headers: Record<string, string> = {
				"content-type": "application/octet-stream",
				"cache-control": "no-store",
				[COPY_HEADERS.path]: encodeURIComponent(abs),
				[COPY_HEADERS.mode]: (st.mode & 0o777).toString(8),
				[COPY_HEADERS.mtime]: String(Math.floor(st.mtimeMs / 1000)),
			};
			let body: ReadableStream<Uint8Array>;
			let files: number;
			let bytes: number;
			if (st.isFile()) {
				if (st.size > REMOTE_COPY_MAX_BYTES)
					throw new RemoteCopyError(`${abs} is larger than ${REMOTE_COPY_MAX_BYTES} bytes`, "tooLarge");
				// What is sent is what the file held when it was looked at: one that grows is cut there, one that shrinks ends short
				// (and the other side, counting, refuses it).
				body = Bun.file(abs).slice(0, st.size).stream();
				files = 1;
				bytes = st.size;
				Object.assign(headers, { [COPY_HEADERS.kind]: "file", [COPY_HEADERS.leftOut]: "0" });
			} else if (st.isDirectory()) {
				const walked = await walkFolder(abs, { maxBytes: REMOTE_COPY_MAX_BYTES, maxEntries: REMOTE_COPY_MAX_ENTRIES });
				body = packTar(abs, walked.entries);
				files = walked.files;
				bytes = walked.bytes;
				Object.assign(headers, { [COPY_HEADERS.kind]: "folder", [COPY_HEADERS.leftOut]: String(walked.leftOut) });
			} else throw new RemoteCopyError(`${abs} is not a file or a folder`, "badRequest");
			headers[COPY_HEADERS.files] = String(files);
			headers[COPY_HEADERS.bytes] = String(bytes);
			let ended = false;
			const end = (status: string) => {
				if (ended) return;
				ended = true;
				this.#record("copy-send", who, abs, started, status, { size: bytes, files });
			};
			const reader = body.getReader();
			const logged = new ReadableStream<Uint8Array>(
				{
					async pull(controller) {
						try {
							const { done, value } = await reader.read();
							if (done) {
								end("ok");
								controller.close();
							} else controller.enqueue(value);
						} catch (e) {
							end("failed");
							controller.error(e);
						}
					},
					async cancel(reason) {
						end("aborted");
						await reader.cancel(reason);
					},
				},
				{ highWaterMark: 0 },
			);
			return new Response(logged, { headers });
		} catch (e) {
			if (e instanceof RemoteCopyError) this.#record("copy-send", who, abs, started, `refused:${e.code}`);
			throw e;
		}
	}

	// ------------------------------------------------------------------ receiving

	/** What is still to come of the uploads under way: the disk check counts it as taken. */
	#owed(): number {
		let n = 0;
		for (const u of this.#uploads.values()) n += u.size - u.received;
		return n;
	}

	async #begin(url: URL, who: string): Promise<Response> {
		const started = this.#now();
		const q = url.searchParams;
		const abs = this.#pathOf(q);
		try {
			const kind = q.get("kind");
			if (kind !== "file" && kind !== "folder") throw new RemoteCopyError("kind must be file or folder", "badRequest");
			const size = wholeOf(q, "size");
			const bytes = wholeOf(q, "bytes");
			if (size === null || bytes === null) throw new RemoteCopyError("size and bytes are needed", "badRequest");
			if (bytes > REMOTE_COPY_MAX_BYTES)
				throw new RemoteCopyError(`More than ${REMOTE_COPY_MAX_BYTES} bytes of files to copy`, "tooLarge");
			// A file is its bytes; a folder's tar is its files' bytes and a header or two of each entry.
			if (kind === "file" ? size !== bytes : size < bytes || size > bytes + REMOTE_COPY_MAX_ENTRIES * 2048)
				throw new RemoteCopyError("size does not fit bytes", "badRequest");
			const overwrite = q.get("overwrite") === "1";
			await checkTarget(abs, overwrite, this.o.places);
			// Room first: a copy that is refused for it makes no folder.
			await ensureRoom(dirname(abs), this.#owed() + size, this.o.reserve, this.o.spaceOf);
			const made = await makeParent(abs);
			const staged = stagedBeside(abs);
			let handle: FileHandle | null = null;
			let unpacker: TarUnpacker | null = null;
			try {
				if (kind === "file")
					handle = await open(
						staged,
						constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
						0o600,
					);
				else {
					await mkdir(staged);
					unpacker = new TarUnpacker(staged, { maxBytes: bytes, maxEntries: REMOTE_COPY_MAX_ENTRIES });
				}
			} catch (e) {
				await unmake(abs, made);
				throw fsFailure(e, dirname(abs));
			}
			const u: Upload = {
				id: randomBytes(16).toString("hex"),
				who,
				abs,
				kind,
				overwrite,
				size,
				received: 0,
				bytes,
				mode: wholeOf(q, "mode", 8),
				mtime: wholeOf(q, "mtime"),
				staged,
				made,
				handle,
				unpacker,
				busy: false,
				stop: null,
				touched: this.#now(),
				started,
			};
			this.#uploads.set(u.id, u);
			return Response.json({ id: u.id, path: abs });
		} catch (e) {
			if (e instanceof RemoteCopyError) this.#record("copy-receive", who, abs, started, `refused:${e.code}`);
			throw e;
		}
	}

	#upload(id: string, who: string): Upload {
		const u = this.#uploads.get(id);
		// Another asker's upload is none of this one's: it is answered as one that is not there.
		if (!u || u.who !== who) throw new RemoteCopyError("No copy is being received under that id", "unknownUpload");
		return u;
	}

	async #piece(req: Request, id: string, url: URL, who: string): Promise<Response> {
		const u = this.#upload(id, who);
		if (u.busy) throw new RemoteCopyError("Another piece of this copy is being written", "offset");
		const offset = wholeOf(url.searchParams, "offset");
		if (offset !== u.received)
			return failure(new RemoteCopyError(`The copy stands at ${u.received} bytes`, "offset"), { received: u.received });
		u.busy = true;
		const reader = req.body?.getReader();
		u.stop = () => void reader?.cancel().catch(() => {});
		try {
			let piece = 0;
			for (;;) {
				const next = await reader?.read();
				if (!next || next.done) break;
				const chunk = next.value;
				if (!this.#uploads.has(u.id)) break;
				u.touched = this.#now();
				piece += chunk.length;
				if (piece > REMOTE_COPY_PIECE.max)
					throw new RemoteCopyError(`A piece is at most ${REMOTE_COPY_PIECE.max} bytes`, "tooLarge");
				if (u.received + chunk.length > u.size)
					throw new RemoteCopyError("More arrived than the copy said it would send", "badRequest");
				if (u.handle) {
					let done = 0;
					while (done < chunk.length)
						done += (
							await u.handle.write(chunk, done, chunk.length - done).catch((e) => Promise.reject(fsFailure(e, u.abs)))
						).bytesWritten;
				} else await u.unpacker?.write(chunk);
				u.received += chunk.length;
			}
			// Given up while the piece was read (it stalled past `idleMs`, or the copy was cancelled): nothing of it stands.
			if (!this.#uploads.has(u.id))
				throw new RemoteCopyError("The copy was given up while this piece arrived", "unknownUpload");
			u.touched = this.#now();
			return Response.json({ received: u.received });
		} catch (e) {
			// A piece that failed ends the copy: what arrived is removed, and the other side begins again if it wants.
			await this.#drop(u, e instanceof RemoteCopyError ? `refused:${e.code}` : "failed");
			throw e;
		} finally {
			u.busy = false;
			u.stop = null;
			reader?.releaseLock();
		}
	}

	async #finish(id: string, who: string): Promise<Response> {
		const u = this.#upload(id, who);
		if (u.busy) throw new RemoteCopyError("A piece of this copy is still being written", "offset");
		u.busy = true;
		try {
			if (u.received !== u.size)
				throw new RemoteCopyError(`Only ${u.received} of ${u.size} bytes arrived`, "incomplete");
			let files = 1;
			let bytes = u.received;
			if (u.handle) {
				const handle = u.handle;
				u.handle = null;
				await handle.close();
			} else if (u.unpacker) ({ files, bytes } = await u.unpacker.end());
			await applyTop(u.staged, u.mode, u.mtime, u.kind === "folder");
			const replaced = await publish(u.staged, u.abs, u.overwrite);
			this.#uploads.delete(u.id);
			this.#record("copy-receive", u.who, u.abs, u.started, "ok", {
				size: bytes,
				files,
				...(replaced ? { replaced } : {}),
			});
			return Response.json({ path: u.abs, kind: u.kind, files, bytes, replaced } satisfies CopyDone);
		} catch (e) {
			await this.#drop(u, e instanceof RemoteCopyError ? `refused:${e.code}` : "failed");
			throw e;
		}
	}

	async #cancel(id: string, who: string): Promise<Response> {
		const u = this.#upload(id, who);
		await this.#drop(u, "aborted");
		return new Response(null, { status: 204 });
	}

	/** Give an upload up: what arrived is removed, and the log says how it ended. */
	async #drop(u: Upload, status: string): Promise<void> {
		if (!this.#uploads.delete(u.id)) return;
		await u.handle?.close().catch(() => {});
		await u.unpacker?.close();
		await discard(u.staged);
		await unmake(u.abs, u.made);
		this.#record("copy-receive", u.who, u.abs, u.started, status, { size: u.bytes });
	}
}
