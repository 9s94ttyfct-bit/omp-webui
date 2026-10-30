import { createHash, type Hash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, link, lstat, mkdir, open, readdir, realpath, rename, statfs, unlink } from "node:fs/promises";
import { join } from "node:path";
import { isRecord } from "../shared/guards.ts";
import { type ExistsFailure, isHiddenName, type UploadProgress, type UploadSaved } from "../shared/transfer.ts";
import { inside, isSecretLooking, partsOf } from "./folder.ts";
import {
	busy,
	conversationRoot,
	etagOf,
	type Gate,
	holdsHome,
	isProtected,
	json,
	type Limits,
	requireUpload,
	startsPrograms,
	type Trace,
	type TransferContext,
	type TransferEnv,
	TransferError,
	viaFolder,
} from "./transfer-core.ts";
import type { TransferLog } from "./transfer-log.ts";
import { nextPiece, numbered, realAsFarAsItGoes, safeName, serialized, UploadError } from "./upload.ts";

/**
 * `POST /api/folder/upload`: a file a page holds, into a folder of the conversation's folder, in pieces. What it promises, for
 * every page (one on this computer too):
 *
 *  - It lands inside the conversation's folder and nowhere else: the folder is walked from the real folder part by part, a part
 *    that is there must be a folder and no link (a link is not followed even when it leads inside), a part that is not there is
 *    made, and the real path of the result is compared once more at the end. Not into the home folder, nor one that holds it;
 *    not into a folder an omp-webui keeps its data in; not into a place that is protected (credentials, omp's configuration, files
 *    that start programs, and what CI runs on a push: below `.github/workflows` and `.github/actions`); not under a part, nor
 *    with a name, that is hidden by default (a dotfile, `node_modules`, `dist`) or looks like a secret. The name is one name: no
 *    folder part, no control or direction characters, never `.` or `..`.
 *  - It never overwrites on its own: a name that is taken is a 409 with the next free one, and what the page saw of the file that
 *    is there. The page replaces it (`replace=<etag>`) only if it is a regular file, not executable and no link, and still the one
 *    it saw (412 otherwise); it keeps both (`exists=keep`) by the next free name. Nothing is deleted, moved or made executable.
 *  - The file is written to a hidden staged file beside its place and published at the end, whole: `link` for a new name (a name
 *    that is taken is an error of the system itself, not a check followed by a write), `rename` for a replacement.
 *  - A piece is written where the file stopped and never elsewhere (`offset` is `received`), at most `pieceMax` of it and never
 *    past `size`; a piece that fails is taken back (the staged file is cut to what was received before it), so that it is sent
 *    again. The SHA-256 of what was received is kept on the way and answered at the end.
 *  - Its limits are the file's (`uploadBytes`), what is begun and not finished (`inFlightBytes`, counted the moment a file is
 *    begun, so that files begun together cannot each pass a check that does not count the others), how many uploads one asker and
 *    the server have going, and the disk (what a file leaves free: the larger of `reserveBytes` and `reservePercent`, after what
 *    the uploads that are going on have still to write).
 *
 * What it does not promise: a folder swapped for a link between the last check and `link`/`rename` is followed by that
 * one call (there is no `linkat` on a folder's descriptor in Node), as `folder.ts` says of reads; that takes something that can
 * already write to the folder.
 */

/** What an upload that is not finished is: kept in memory, bound to who began it. */
interface Upload {
	id: string;
	who: string;
	/** Where it goes: the conversation's folder, the folder in it (real, and relative to it), and the name. */
	root: string;
	dirAbs: string;
	dirRel: string;
	name: string;
	size: number;
	received: number;
	/** The SHA-256 of what is received (a piece is added when it is whole). */
	hash: Hash;
	staged: string;
	dev: bigint;
	ino: bigint;
	/** When it was last heard of (ms), and whether a piece is being written now. */
	touched: number;
	busy: boolean;
	started: number;
	release: () => void;
}

export interface UploadDeps {
	log: TransferLog;
	gate: Gate;
	limits: Limits;
	now: () => number;
	/** What the disk holds free and in all, in bytes, at `path` (tests give a full one). */
	statfs?: (path: string) => Promise<{ free: number; total: number }>;
	/** A step a test takes between the last check and the publishing. */
	beforePublish?: () => Promise<void> | void;
}

const MiB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const STAGED = /^\.ompw-upload-[0-9a-f]{32}$/;

/** A number in the query: whole and not absurd. */
function whole(q: URLSearchParams, key: string): number {
	const v = q.get(key);
	if (v === null || !/^\d{1,16}$/.test(v)) throw new TransferError(`${key} must be a whole number`, 400, "badRequest");
	return Number(v);
}

/** What the request says its body weighs; null when it does not say. */
function declaredLength(req: Request): number | null {
	const header = req.headers.get("content-length");
	return header !== null && /^\d+$/.test(header) ? Number(header) : null;
}

const fsFree = async (path: string) => {
	const s = await statfs(path);
	return { free: s.bavail * s.bsize, total: s.blocks * s.bsize };
};

export class Uploads {
	readonly #byId = new Map<string, Upload>();
	/** Bytes of the files begun and not finished, across the server (a file that is being begun is counted from the start). */
	#declared = 0;
	readonly #swept = new Set<string>();
	readonly #sweeping = new Set<Promise<void>>();

	constructor(private readonly deps: UploadDeps) {}

	get size(): number {
		return this.#byId.size;
	}

	/** The upload `id` of the one who asks: null for one that is not there, or is another's (neither says which). */
	#find(id: string | null, env: TransferEnv): Upload {
		const u = id !== null && /^[0-9a-f]{32}$/.test(id) ? this.#byId.get(id) : undefined;
		if (!u || u.who !== env.who)
			throw new TransferError("That upload is not known any more: send the file again", 404, "gone");
		u.touched = this.deps.now();
		return u;
	}

	#log(
		u: Upload,
		status: string,
		more: { size?: number; sha256?: string; path?: string; replaced?: boolean } = {},
	): void {
		const { path, ...rest } = more;
		this.deps.log.append({
			t: new Date().toISOString(),
			kind: "upload",
			who: u.who,
			root: u.root,
			// What was saved, under the name it was saved by: a name that was taken is logged as the one it was kept under.
			path: path ?? (u.dirRel ? `${u.dirRel}/${u.name}` : u.name),
			...rest,
			status,
			ms: this.deps.now() - u.started,
		});
	}

	/** The upload is over: out of the table, its place given back, its staged file gone. */
	async #drop(u: Upload, status?: string): Promise<void> {
		if (this.#byId.get(u.id) === u) this.#byId.delete(u.id);
		u.release();
		await unlink(u.staged).catch(() => {});
		if (status) this.#log(u, status, { size: u.received });
	}

	/** Uploads nothing has been heard of for `idleMs` are given up (a piece that is being written is not idle). */
	async expire(): Promise<void> {
		const now = this.deps.now();
		for (const u of [...this.#byId.values()]) {
			if (!u.busy && now - u.touched > this.deps.limits.idleMs) await this.#drop(u, "expired");
		}
	}

	/** The server is going away: what was staged is removed. */
	async close(): Promise<void> {
		for (const u of [...this.#byId.values()]) await this.#drop(u, "aborted");
	}

	/** `POST /api/folder/upload/cancel`: the file is given up, and what had arrived is removed. */
	async cancel(req: Request, env: TransferEnv): Promise<Response> {
		requireUpload(env);
		const body: unknown = await req.json().catch(() => null);
		const id = isRecord(body) && typeof body.id === "string" ? body.id : null;
		const u = id !== null && /^[0-9a-f]{32}$/.test(id) ? this.#byId.get(id) : undefined;
		if (u && u.who === env.who) await this.#drop(u, "aborted");
		// What is not there is as gone as it was asked to be.
		return json({ ok: true });
	}

	/** `GET /api/folder/upload/state?id`: how far a file got. */
	state(url: URL, env: TransferEnv): Response {
		requireUpload(env);
		const u = this.#find(url.searchParams.get("id"), env);
		return json({ id: u.id, received: u.received, size: u.size } satisfies UploadProgress);
	}

	/** `POST /api/folder/upload`: the first piece of a file (no `id`), or the next (`id` and `offset`). */
	async upload(req: Request, url: URL, ctx: TransferContext, env: TransferEnv, trace: Trace): Promise<Response> {
		requireUpload(env);
		const q = url.searchParams;
		const size = whole(q, "size");
		if (size > this.deps.limits.uploadBytes)
			throw new TransferError("The file is too large", 413, "tooLarge", { limit: this.deps.limits.uploadBytes });
		const fresh = q.get("id") === null;
		const u = fresh ? await this.#begin(q, ctx, env, trace, size) : this.#find(q.get("id"), env);
		if (u.busy)
			throw new TransferError("A piece of that file is being received", 429, "busy", {}, { "retry-after": "1" });
		u.busy = true;
		try {
			if (size !== u.size) throw new TransferError("The size is not the one the file began with", 400, "badRequest");
			const offset = fresh ? 0 : whole(q, "offset");
			if (offset !== u.received)
				throw new TransferError("That piece does not begin where the file stopped", 409, "offset", {
					received: u.received,
				});
			const room = u.size - u.received;
			const limit = Math.min(this.deps.limits.pieceMax, room);
			const declared = declaredLength(req);
			if (declared !== null && declared > limit)
				throw new TransferError("That piece is too large", 413, "tooLarge", { limit });
			const got = room === 0 ? 0 : await this.#receive(u, req, limit);
			if (this.#byId.get(u.id) !== u) throw new TransferError("That upload was cancelled", 404, "gone");
			if (got === 0 && room > 0) throw new TransferError("The piece is empty", 400, "badRequest");
			u.received += got;
			u.touched = this.deps.now();
			if (u.received < u.size) {
				return json({ id: u.id, received: u.received, size: u.size } satisfies UploadProgress, 202);
			}
			return await this.#finish(u, q);
		} catch (e) {
			// An upload that failed on its first piece is not kept: the page never got to know its id.
			if (fresh) await this.#drop(u);
			throw e;
		} finally {
			u.busy = false;
		}
	}

	/** The folder `parts` below `root`, made as far as it is not there, by the rules above. */
	async #folder(root: string, parts: readonly string[]): Promise<{ abs: string; rel: string }> {
		let abs = root;
		const rels: string[] = [];
		for (const raw of parts) {
			if (Buffer.byteLength(raw) > 255) throw new TransferError("A folder name is too long", 400, "badName");
			const literal = join(abs, raw);
			let info = await lstat(literal).catch(() => null);
			// A folder that is there is used as it is named; one that is not is made under the name a file system takes.
			const use = info === null ? safeName(raw) : raw;
			if (isHiddenName(raw, true) || isHiddenName(use, true))
				throw new TransferError("A hidden folder is not written into", 403, "hidden");
			rels.push(use);
			if (startsPrograms(rels))
				throw new TransferError("That is a place nothing is written into unasked", 403, "protected");
			if (isSecretLooking(rels.join("/")))
				throw new TransferError("This looks like a secret: nothing is sent into it", 403, "secret");
			const next = join(abs, use);
			if (use !== raw) info = await lstat(next).catch(() => null);
			if (info === null) {
				try {
					await mkdir(next, { mode: 0o755 });
				} catch (e) {
					// Made by an upload that began a moment earlier: the check below looks at it all the same.
					if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
				}
				info = await lstat(next);
			}
			if (info.isSymbolicLink() || !info.isDirectory())
				throw new TransferError("A link or a file is where a folder should be: not used", 403, "refused");
			abs = next;
		}
		const real = await realpath(abs);
		if (real !== abs || !inside(root, real))
			throw new TransferError("The folder is not the one it was", 403, "refused");
		return { abs, rel: rels.join("/") };
	}

	/** Begin a file: every rule above is asked before anything is written but the folders it needs. */
	async #begin(
		q: URLSearchParams,
		ctx: TransferContext,
		env: TransferEnv,
		trace: Trace,
		size: number,
	): Promise<Upload> {
		const given = q.get("name");
		if (
			given === null ||
			given === "" ||
			given === "." ||
			given === ".." ||
			given.length > 1024 ||
			// biome-ignore lint/suspicious/noControlCharactersInRegex: NUL is what is refused.
			/[/\\\u0000]/.test(given)
		)
			throw new TransferError("That is not a name a file can have here", 400, "badName");
		const exists = q.get("exists");
		if (exists !== null && exists !== "keep") throw new TransferError("exists can only be keep", 400, "badRequest");
		const replace = q.get("replace");
		const root = await conversationRoot(ctx, q.get("live"), q.get("file"));
		trace.root = root;
		trace.path = `${q.get("dir") ?? ""}/${given}`.slice(0, 4096);
		if (holdsHome(root, env))
			throw new TransferError(
				"Files are not received into the home folder: choose a folder inside it",
				403,
				"homeFolder",
			);
		const parts = await viaFolder(async () => partsOf(q.get("dir") ?? ""));
		if (parts.length > 32) throw new TransferError("That folder is too deep", 400, "badRequest");
		if (startsPrograms(parts))
			throw new TransferError("That is a place nothing is written into unasked", 403, "protected");
		// Before a folder is made: not in a folder an omp-webui keeps its data in, nor a protected place.
		const planned = join(root, ...parts);
		const real = await realAsFarAsItGoes(planned);
		for (const dir of env.dataDirs) {
			if (inside(await realAsFarAsItGoes(dir), real))
				throw new TransferError("That is a folder the app keeps its own data in", 403, "ownData");
		}
		if (isProtected(real, env))
			throw new TransferError("That is a place nothing is written into unasked", 403, "protected");
		const name = safeName(given);
		if (isHiddenName(name, false) || given.startsWith("."))
			throw new TransferError("A hidden file is not received", 403, "hidden");
		const releaseSlot = this.deps.gate.take(env.who);
		if (!releaseSlot) throw busy();
		// What is begun and not finished is counted here, before anything is awaited: files begun together cannot each pass a
		// check that does not count the others, and the bytes the others have still to write are known to the disk check.
		if (this.#declared + size > this.deps.limits.inFlightBytes) {
			releaseSlot();
			throw busy();
		}
		this.#declared += size;
		let written = 0;
		for (const other of this.#byId.values()) written += other.received;
		const owed = this.#declared - size - written;
		let returned = false;
		const give = () => {
			if (returned) return;
			returned = true;
			this.#declared -= size;
			releaseSlot();
		};
		let kept = false;
		try {
			const dir = await this.#folder(root, parts);
			if (isProtected(dir.abs, env) || isProtected(join(dir.abs, name), env))
				throw new TransferError("That is a place nothing is written into unasked", 403, "protected");
			if (isSecretLooking(dir.rel ? `${dir.rel}/${name}` : name))
				throw new TransferError("This looks like a secret: nothing is sent into it", 403, "secret");
			const free = await (this.deps.statfs ?? fsFree)(dir.abs);
			const reserve = Math.max(this.deps.limits.reserveBytes, (free.total * this.deps.limits.reservePercent) / 100);
			// The free space does not show what the uploads that are going on will still write.
			if (free.free - owed - size < reserve)
				throw new TransferError("There is not enough room on the disk", 507, "diskFull");
			await this.#taken(dir.abs, name, exists === "keep", replace);
			this.#sweep(dir.abs);
			const staged = join(dir.abs, `.ompw-upload-${randomBytes(16).toString("hex")}`);
			// A new file, exclusively, and no link: the system itself says no to a name that is there.
			const handle = await open(
				staged,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o666,
			);
			let info: { dev: bigint; ino: bigint };
			try {
				info = await handle.stat({ bigint: true });
			} finally {
				await handle.close();
			}
			const u: Upload = {
				id: randomBytes(16).toString("hex"),
				who: env.who,
				root,
				dirAbs: dir.abs,
				dirRel: dir.rel,
				name,
				size,
				received: 0,
				hash: createHash("sha256"),
				staged,
				dev: info.dev,
				ino: info.ino,
				touched: this.deps.now(),
				busy: false,
				started: this.deps.now(),
				release: give,
			};
			this.#byId.set(u.id, u);
			kept = true;
			return u;
		} finally {
			if (!kept) give();
		}
	}

	/** What is at the name now: nothing, or what the page was told it may do about it. */
	async #taken(dir: string, name: string, keep: boolean, replace: string | null): Promise<void> {
		const there = await lstat(join(dir, name), { bigint: true }).catch(() => null);
		if (there === null) return;
		if (replace !== null) {
			if (!there.isFile() || Number(there.mode) & 0o111)
				throw new TransferError("That file is not replaced: it is a link, a folder or a program", 403, "refused");
			if (etagOf(there) !== replace) throw new TransferError("That file changed since it was seen", 412, "changed");
			return;
		}
		if (keep) return;
		throw await this.#exists(dir, name, there);
	}

	/** The answer for a name that is taken: the next free one, and what is there. */
	async #exists(
		dir: string,
		name: string,
		there: { size: bigint; mtimeMs: bigint; ino: bigint; mode: bigint; isFile(): boolean },
	): Promise<TransferError> {
		let suggestion = numbered(name, 1);
		for (let n = 1; n < 1000; n++) {
			suggestion = numbered(name, n);
			if ((await lstat(join(dir, suggestion)).catch(() => null)) === null) break;
		}
		const body: Omit<ExistsFailure, "error" | "code"> = {
			suggestion,
			existing: {
				size: Number(there.size),
				modified: Math.floor(Number(there.mtimeMs)),
				etag: etagOf(there),
				replaceable: there.isFile() && (Number(there.mode) & 0o111) === 0,
			},
		};
		return new TransferError("A file by that name is there", 409, "exists", body);
	}

	/** Staged files an earlier server left (a crash), older than a day and named like ours, are removed once per folder. */
	#sweep(dir: string): void {
		if (this.#swept.has(dir)) return;
		this.#swept.add(dir);
		const active = new Set([...this.#byId.values()].map((u) => u.staged));
		const sweeping = (async () => {
			for (const entry of await readdir(dir).catch(() => [])) {
				if (!STAGED.test(entry) || active.has(join(dir, entry))) continue;
				const info = await lstat(join(dir, entry)).catch(() => null);
				if (info?.isFile() && this.deps.now() - info.mtimeMs > DAY_MS) await unlink(join(dir, entry)).catch(() => {});
			}
		})();
		this.#sweeping.add(sweeping);
		void sweeping.finally(() => this.#sweeping.delete(sweeping));
	}

	/** The sweeps of old staged files that are going on have ended (a test waits for this). */
	async swept(): Promise<void> {
		await Promise.all(this.#sweeping);
	}

	/** The body of the request written to the staged file where it stopped; how many bytes. A piece that fails is taken back. */
	async #receive(u: Upload, req: Request, limit: number): Promise<number> {
		let handle: Awaited<ReturnType<typeof open>>;
		try {
			handle = await open(u.staged, constants.O_WRONLY | constants.O_NOFOLLOW);
		} catch {
			throw new TransferError("That upload is not known any more: send the file again", 404, "gone");
		}
		try {
			const info = await handle.stat({ bigint: true });
			if (!info.isFile() || info.dev !== u.dev || info.ino !== u.ino)
				throw new TransferError("That upload is not known any more: send the file again", 404, "gone");
			const piece = u.hash.copy();
			let got = 0;
			if (req.body) {
				const reader = req.body.getReader();
				try {
					for (;;) {
						const next = await nextPiece(reader, this.deps.limits.stallMs).catch((e) => {
							if (e instanceof UploadError)
								throw new TransferError(e.message, e.status, e.code === "stalled" ? "stalled" : "badRequest");
							throw e;
						});
						if (next.done) break;
						const chunk = next.value;
						// What would pass the limit is not written.
						if (got + chunk.byteLength > limit)
							throw new TransferError("That piece is too large", 413, "tooLarge", { limit });
						for (let at = 0; at < chunk.byteLength; ) {
							at += (await handle.write(chunk, at, chunk.byteLength - at, u.received + got + at)).bytesWritten;
						}
						piece.update(chunk);
						got += chunk.byteLength;
					}
				} catch (e) {
					// The page stops sending; what was written of this piece is cut off, so that it is sent again from the same place.
					await reader.cancel().catch(() => {});
					await handle.truncate(u.received).catch(() => {});
					throw e;
				}
			}
			u.hash = piece;
			return got;
		} finally {
			await handle.close().catch(() => {});
		}
	}

	/** Every byte is here: the file is made whole and published. */
	async #finish(u: Upload, q: URLSearchParams): Promise<Response> {
		const exists = q.get("exists") === "keep";
		const replace = q.get("replace");
		try {
			const handle = await open(u.staged, constants.O_WRONLY | constants.O_NOFOLLOW);
			try {
				await handle.truncate(u.size);
				if (u.size > MiB) await handle.sync();
			} finally {
				await handle.close();
			}
			const saved = await serialized(u.dirAbs, () => this.#publish(u, exists, replace));
			// The staged file is gone from under its name (it became the file, or was moved there).
			if (this.#byId.get(u.id) === u) this.#byId.delete(u.id);
			u.release();
			this.#log(u, "ok", {
				size: u.size,
				sha256: saved.sha256,
				path: saved.path,
				...(saved.replaced ? { replaced: true } : {}),
			});
			return json(saved);
		} catch (e) {
			await this.#drop(u);
			throw e;
		}
	}

	async #publish(u: Upload, keep: boolean, replace: string | null): Promise<UploadSaved> {
		await this.deps.beforePublish?.();
		const [real, info] = await Promise.all([realpath(u.dirAbs).catch(() => null), lstat(u.dirAbs).catch(() => null)]);
		if (real !== u.dirAbs || !info?.isDirectory())
			throw new TransferError("The folder is not the one it was", 403, "refused");
		const sha256 = u.hash.digest("hex");
		const saved = (name: string, replaced: boolean): UploadSaved => ({
			done: true,
			path: u.dirRel ? `${u.dirRel}/${name}` : name,
			name,
			bytes: u.size,
			sha256,
			replaced,
		});
		const final = join(u.dirAbs, u.name);
		if (replace !== null) {
			const there = await lstat(final, { bigint: true }).catch(() => null);
			if (there !== null) {
				if (!there.isFile() || Number(there.mode) & 0o111)
					throw new TransferError("That file is not replaced: it is a link, a folder or a program", 403, "refused");
				if (etagOf(there) !== replace) throw new TransferError("That file changed since it was seen", 412, "changed");
				// What the file was allowed to be it stays: its permissions, never an execute bit.
				await chmod(u.staged, Number(there.mode) & 0o666);
				await rename(u.staged, final);
				return saved(u.name, true);
			}
		}
		for (let n = 0; n < 1000; n++) {
			const name = n === 0 ? u.name : numbered(u.name, n);
			const target = join(u.dirAbs, name);
			try {
				try {
					await link(u.staged, target);
				} catch (e) {
					// A disk with no hard links (a FAT or exFAT volume) is written by copy; the name is still taken exclusively.
					const code = (e as NodeJS.ErrnoException).code;
					if (code !== "EPERM" && code !== "ENOTSUP" && code !== "EXDEV" && code !== "ENOSYS") throw e;
					await copyFile(u.staged, target, constants.COPYFILE_EXCL);
				}
				await unlink(u.staged).catch(() => {});
				return saved(name, false);
			} catch (e) {
				if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
				if (!keep) {
					const there = await lstat(target, { bigint: true }).catch(() => null);
					if (there === null) continue;
					throw await this.#exists(u.dirAbs, u.name, there);
				}
			}
		}
		throw new TransferError("There are too many files of that name", 409, "exists");
	}
}
