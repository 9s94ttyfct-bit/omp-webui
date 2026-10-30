import { constants, type Dirent } from "node:fs";
import { type FileHandle, lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { UPLOAD_DIR, UPLOAD_LIMITS, type UploadCode, type UploadFailure, type UploadResult } from "../shared/upload.ts";
import { FolderError, inside, rootOf } from "./folder.ts";

/**
 * `POST /api/upload?live=…&file=…&name=…` (body: the file's bytes): save a file the page holds into the folder the
 * conversation works in, for a page that cannot say where the file is on its own computer (#617). Loaded when the first
 * upload is made (`main.ts`).
 *
 * What it promises: the file lands at `<conversation folder>/.omp-webui/uploads/<date>/<name>` and nowhere else. The page
 * names the conversation and never a folder (as the Files tab does, see `folder-routes.ts`); the name is reduced to a file
 * name (no folder part, no control, invisible or direction characters, bounded) and is never overwritten (a taken name is
 * numbered); a link where a folder of the path should be is refused, not followed; and a file over `fileBytes`, or one that
 * would take everything under `UPLOAD_DIR` over `folderBytes`, is refused while it is read, whatever its headers said, and the
 * part written is removed. Uploads into one folder go one at a time (`serialized`), so that the room left is worked out
 * with every earlier upload on disk: parallel requests cannot each take the same room. A folder that holds as many entries
 * as the walk that adds them up counts (`UPLOAD_LIMITS.counted`) takes no more files, and one whose `.omp-webui` is an
 * omp-webui data folder (any of them: this server's, the app's, the web version's), or holds it, or is in it, takes none at all.
 *
 * What it does not promise: the folder's own writers are trusted (a link put where a folder was in between the check and
 * the write is followed by that one write, as `folder.ts` says of reads).
 */

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export class UploadError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 403 | 404 | 408 | 413 | 500,
		readonly code: UploadCode,
		readonly limit?: number,
	) {
		super(message);
	}
}

export interface UploadContext {
	/** The folder the conversation the request names works in; null when it names none the server knows. */
	cwdOf(live: string | null, file: string | null): Promise<string | null>;
	/** Every folder an omp-webui keeps its own data in (`knownDataDirs()`, and this server's): never written into, whatever folder a conversation works in. Empty is refused, not allowed. */
	dataDirs: readonly string[];
	/** The time, for the day's folder (tests set it). */
	now?: () => Date;
	/** Other limits (tests use small ones); `stallMs` is how long a body may take to send its next piece. */
	limits?: Partial<Record<"fileBytes" | "folderBytes" | "counted" | "stallMs", number>>;
}

/** The longest file name saved, in bytes: well inside what any file system takes (255), with room for ` (999)`. */
const MAX_NAME_BYTES = 120;
/** The longest name the page may send (it is reduced to the above). */
const MAX_GIVEN_CHARS = 1024;
/** How long an upload may wait for its next piece before it is given up: the folder's other uploads wait behind it. */
const STALL_MS = 30_000;

/**
 * What a name from a page becomes: a file name and nothing more. The part after the last `/` or `\`; control characters
 * (C0, DEL and C1), line and paragraph separators, characters that do not show (zero-width ones, the Arabic letter mark),
 * direction overrides (they make `gpj.exe` read as `exe.jpg`) and what file systems of other systems refuse (`: * ? " < > |`)
 * become `_`; dots and spaces at the end go; a name that is empty or only dots is `file`; one that is too long is cut in its
 * middle (the extension stays).
 */
export function safeName(given: string): string {
	let name = given.normalize("NFC");
	name = name.slice(name.lastIndexOf("/") + 1);
	name = name.slice(name.lastIndexOf("\\") + 1);
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is replaced.
	name = name.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff:*?"<>|]/g, "_");
	name = name.trim().replace(/[. ]+$/, "");
	if (name === "" || /^\.+$/.test(name)) return "file";
	if (Buffer.byteLength(name) <= MAX_NAME_BYTES) return name;
	const dot = name.lastIndexOf(".");
	const ext = dot > 0 && name.length - dot <= 16 ? name.slice(dot) : "";
	const stem = Array.from(name.slice(0, name.length - ext.length));
	while (stem.length > 1 && Buffer.byteLength(stem.join("") + ext) > MAX_NAME_BYTES) stem.pop();
	const cut = stem.join("") + ext;
	// The cut can leave what was inside the name at its end: no name ends in a dot or a space.
	return (ext === "" ? cut.replace(/[. ]+$/, "") : cut) || "file";
}

/** `name` with `n` before its extension: `report (2).pdf`; a dotfile or a name without an extension gets it at the end. */
export function numbered(name: string, n: number): string {
	const dot = name.lastIndexOf(".");
	return dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`;
}

/** The day's folder name, in the server's time zone: `2026-10-23`. */
export function uploadDate(now: Date): string {
	const two = (n: number) => String(n).padStart(2, "0");
	return `${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())}`;
}

const refused = () => new UploadError("The upload folder is a link or a file: not used", 403, "refused");

/** The ends of the chains of uploads waiting for a folder, by the folder. A folder with none waiting has no entry. */
const queues = new Map<string, Promise<void>>();

/**
 * Run `job` once the earlier jobs under `key` have finished, whether they succeeded or not; one at a time per key. The
 * job's own result (or failure) is what this resolves to.
 */
export async function serialized<T>(key: string, job: () => Promise<T>): Promise<T> {
	const turn = (queues.get(key) ?? Promise.resolve()).then(job);
	const settled = turn.then(
		() => {},
		() => {},
	);
	queues.set(key, settled);
	try {
		return await turn;
	} finally {
		if (queues.get(key) === settled) queues.delete(key);
	}
}

/**
 * `p` as the file system sees it, as far as it is there: the real path of the deepest folder that exists, with the parts
 * below it put back. A folder that is not there yet is still compared where it would be (`~/.omp-webui` on a machine where
 * no omp-webui has run, and a home named through a link like `/var` → `/private/var`).
 */
export async function realAsFarAsItGoes(p: string): Promise<string> {
	const resolved = resolve(p);
	let at = resolved;
	const below: string[] = [];
	for (;;) {
		try {
			const real = await realpath(at);
			return below.length === 0 ? real : join(real, ...below.slice().reverse());
		} catch {
			const parent = dirname(at);
			if (parent === at) return resolved;
			below.push(basename(at));
			at = parent;
		}
	}
}

/** Whether `a` and `b` are one folder, or one holds the other (compared as real paths, as far as they exist). */
async function overlaps(a: string, b: string): Promise<boolean> {
	const [x, y] = await Promise.all([realAsFarAsItGoes(a), realAsFarAsItGoes(b)]);
	return inside(x, y) || inside(y, x);
}

/**
 * The folder `parts` below `root`, made as far as it is not there. A part that exists must be a folder and no link: a link
 * is not followed even when it leads inside the folder, because it can be moved (a symlinked `.omp-webui` is one the person
 * made, and is refused with the same answer). The real path is checked once more at the end.
 */
async function ensureDir(root: string, parts: readonly string[]): Promise<string> {
	let dir = root;
	for (const part of parts) {
		const next = join(dir, part);
		const known = await lstat(next).catch(() => null);
		if (known === null) {
			try {
				await mkdir(next, { mode: 0o755 });
			} catch (e) {
				// Made by an upload that began a moment earlier: the check below looks at it all the same.
				if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
			}
		}
		const now = await lstat(next);
		if (now.isSymbolicLink() || !now.isDirectory()) throw refused();
		dir = next;
	}
	if (!inside(root, await realpath(dir))) throw refused();
	return dir;
}

/** Everything git should leave alone about the uploads: the folder ignores itself and what is in it. */
async function ignoreInGit(dir: string): Promise<void> {
	try {
		const handle = await open(join(dir, ".gitignore"), "wx", 0o644);
		try {
			await handle.writeFile("*\n");
		} finally {
			await handle.close();
		}
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
	}
}

/** What is under `dir`: the bytes in its files and how many entries (files and folders) it holds, links not followed. The walk stops at `counted` entries. */
async function usage(dir: string, counted: number): Promise<{ bytes: number; entries: number }> {
	let bytes = 0;
	let entries = 0;
	const pending = [dir];
	for (let at = pending.pop(); at !== undefined; at = pending.pop()) {
		let listed: Dirent[];
		try {
			listed = await readdir(at, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of listed) {
			if (++entries >= counted) return { bytes, entries };
			const full = join(at, entry.name);
			if (entry.isDirectory()) pending.push(full);
			else if (entry.isFile()) bytes += (await lstat(full).catch(() => null))?.size ?? 0;
		}
	}
	return { bytes, entries };
}

/** A new file in `dir` named `name`, or `name (1)`, `name (2)` … when that is taken: never one that is there. */
async function createUnique(dir: string, name: string): Promise<{ handle: FileHandle; name: string; path: string }> {
	for (let n = 0; n <= 999; n++) {
		const candidate = n === 0 ? name : numbered(name, n);
		const path = join(dir, candidate);
		try {
			// Exclusive: it fails on a name that is taken, and on a link by that name, which it does not follow.
			const handle = await open(
				path,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o644,
			);
			return { handle, name: candidate, path };
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
		}
	}
	throw new UploadError("There are too many files of that name", 400, "badRequest");
}

/** What the request says its body weighs; null when it does not say. */
function declaredLength(req: Request): number | null {
	const header = req.headers.get("content-length");
	return header !== null && /^\d+$/.test(header) ? Number(header) : null;
}

/** What the body gave next: a piece of it, or its end. */
export type Piece = { done: false; value: Uint8Array } | { done: true; value?: undefined };

/**
 * The next piece of the body. A body that ends badly (the page was closed, or the connection dropped: the stream errors) is
 * the page's own doing and is answered as such, not logged as a failure of the server; one that sends nothing for `stallMs`
 * is given up, because the uploads behind it wait for this one.
 */
export async function nextPiece(reader: ReadableStreamDefaultReader<Uint8Array>, stallMs: number): Promise<Piece> {
	const { promise: stalled, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => reject(new UploadError("The upload stopped arriving", 408, "stalled")), stallMs);
	try {
		return await Promise.race([
			reader.read().catch(() => {
				throw new UploadError("The upload was interrupted", 400, "badRequest");
			}),
			stalled,
		]);
	} finally {
		clearTimeout(timer);
	}
}

/** The request's body written to `handle`: at most `fileBytes` of it, and at most `room` more than the folder of uploads (`folderBytes` big) already holds. Returns how many bytes. */
async function writeBody(
	req: Request,
	handle: FileHandle,
	limits: { fileBytes: number; room: number; folderBytes: number; stallMs: number },
): Promise<number> {
	if (!req.body) return 0;
	const reader = req.body.getReader();
	let received = 0;
	try {
		for (;;) {
			const { done, value } = await nextPiece(reader, limits.stallMs);
			if (done) return received;
			received += value.byteLength;
			if (received > limits.fileBytes)
				throw new UploadError("The file is too large", 413, "tooLarge", limits.fileBytes);
			if (received > limits.room)
				throw new UploadError("The folder of uploads is full", 413, "quota", limits.folderBytes);
			for (let at = 0; at < value.byteLength; ) {
				at += (await handle.write(value, at, value.byteLength - at)).bytesWritten;
			}
		}
	} catch (e) {
		// The page stops sending: what it has not sent is not read.
		await reader.cancel().catch(() => {});
		throw e;
	}
}

/** Save the body as the file the query names; the answer is `UploadResult`, or an `UploadFailure` with its status. */
async function save(req: Request, url: URL, ctx: UploadContext): Promise<UploadResult> {
	const q = url.searchParams;
	const given = q.get("name");
	if (given === null || given === "" || given.length > MAX_GIVEN_CHARS || given.includes("\0"))
		throw new UploadError("The file has no usable name", 400, "badRequest");
	const fileBytes = ctx.limits?.fileBytes ?? UPLOAD_LIMITS.fileBytes;
	const folderBytes = ctx.limits?.folderBytes ?? UPLOAD_LIMITS.folderBytes;
	const counted = ctx.limits?.counted ?? UPLOAD_LIMITS.counted;
	const stallMs = ctx.limits?.stallMs ?? STALL_MS;
	const declared = declaredLength(req);
	if (declared !== null && declared > fileBytes)
		throw new UploadError("The file is too large", 413, "tooLarge", fileBytes);
	const cwd = await ctx.cwdOf(q.get("live"), q.get("file"));
	if (!cwd) throw new UploadError("Unknown conversation", 404, "unknownConversation");
	let root: string;
	try {
		root = await rootOf(cwd);
	} catch (e) {
		if (e instanceof FolderError) throw new UploadError(e.message, 404, "folderGone");
		throw e;
	}
	const base = UPLOAD_DIR.split("/");
	// The app's own data folders are no place for what a page sends: not one that has `.omp-webui` in it or is in it. Every
	// omp-webui's data folder counts, not only this server's: the macOS app keeps its data in Application Support, so a
	// conversation in the home folder would otherwise upload into `~/.omp-webui`, where the web version keeps its own. A
	// context that names no data folder at all is refused rather than allowed: what it would not protect is unknown.
	const own = join(root, base[0] as string);
	if (ctx.dataDirs.length === 0 || (await Promise.all(ctx.dataDirs.map((dir) => overlaps(own, dir)))).some(Boolean))
		throw new UploadError("The conversation's folder holds the app's own data", 403, "ownData");
	const uploads = await ensureDir(root, base);
	await ignoreInGit(own);
	return serialized(uploads, async () => {
		const used = await usage(uploads, counted);
		if (used.entries >= counted)
			throw new UploadError("The folder of uploads holds too many files", 413, "tooMany", counted);
		if (used.bytes + (declared ?? 0) > folderBytes)
			throw new UploadError("The folder of uploads is full", 413, "quota", folderBytes);
		const dir = await ensureDir(root, [...base, uploadDate((ctx.now ?? (() => new Date()))())]);
		const made = await createUnique(dir, safeName(given));
		try {
			const bytes = await writeBody(req, made.handle, {
				fileBytes,
				room: folderBytes - used.bytes,
				folderBytes,
				stallMs,
			});
			await made.handle.close();
			return { path: made.path, name: made.name, bytes };
		} catch (e) {
			// A file that was not finished is not left: nothing named it before this upload, and nothing else is removed.
			await made.handle.close().catch(() => {});
			await unlink(made.path).catch(() => {});
			throw e;
		}
	});
}

export async function handleUpload(req: Request, url: URL, ctx: UploadContext): Promise<Response> {
	if (req.method !== "POST") return json({ error: "POST required", code: "badRequest" } satisfies UploadFailure, 405);
	try {
		return json(await save(req, url, ctx));
	} catch (e) {
		if (e instanceof UploadError) {
			return json(
				{
					error: e.message,
					code: e.code,
					...(e.limit === undefined ? {} : { limit: e.limit }),
				} satisfies UploadFailure,
				e.status,
			);
		}
		if (typeof (e as NodeJS.ErrnoException).code === "string") {
			// What the system said is for the log: its message names a path.
			console.error("omp-webui: upload failed:", e);
			return json({ error: "The file could not be written", code: "write" } satisfies UploadFailure, 500);
		}
		throw e;
	}
}
