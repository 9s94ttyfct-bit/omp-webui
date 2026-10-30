import { isUtf8 } from "node:buffer";
import { createHash } from "node:crypto";
import { constants, type Dirent } from "node:fs";
import { type FileHandle, open, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import {
	documentTypeOf,
	extensionOf,
	FOLDER_LIMITS,
	type FolderDocument,
	type FolderEntry,
	type FolderFile,
	type FolderFound,
	type FolderListing,
	type FolderMatch,
	type FolderView,
	IMAGE_TYPES,
} from "../shared/folder.ts";
import { FileIndex, hiddenByDefault, SCAN_LIMITS, scanFiles, skipRepositoryData } from "./files.ts";
import { type GitMarks, isIgnored, markOf } from "./git-marks.ts";
import { run } from "./omp/run.ts";

/**
 * The files of the folder a conversation works in, for the Files tab, read only. Every path a page names is relative to
 * that folder and is resolved against its real location (`resolveInside`) before anything is listed, read or opened: a
 * path that climbs out of it (`..`), an absolute one, and a link that leads out of it are refused (403). Nothing here is
 * ever executed or written.
 *
 * What this does not promise: the folder's own writers are trusted. A path is resolved and then opened, and a link that
 * is put where a folder was in between (by something that can write to the project) can be followed by that one read; the
 * read is then checked against the real path and the file it opened (`opened`), which makes that very rare, not impossible.
 * Nothing the page can do makes such a link: it makes none, and the one thing it can write into the folder, a file sent
 * with Insert path (`server/upload.ts`, only under `.omp-webui/uploads`), is made new and never follows a link.
 */

export class FolderError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 403 | 404 | 415 | 501 | 504,
	) {
		super(message);
	}
}

/** The longest relative path taken: far above what any file system allows (PATH_MAX is 1024 on macOS, 4096 on Linux). */
const MAX_PATH_CHARS = 4096;

/** The real location of the folder; it must exist and be a folder. */
export async function rootOf(cwd: string): Promise<string> {
	try {
		if (isAbsolute(cwd)) {
			const root = await realpath(cwd);
			if ((await stat(root)).isDirectory()) return root;
		}
	} catch {
		// the one message for every way it can fail
	}
	throw new FolderError("The conversation's folder is not there", 404);
}

/** Whether `real` (a real path) is the folder `root` or something in it. */
export function inside(root: string, real: string): boolean {
	return real === root || real.startsWith(root.endsWith(sep) ? root : root + sep);
}

/**
 * The parts of a relative path a page names (`a/b/c`; empty for the folder itself). Refused outright, before the file
 * system is asked anything: a path that is absolute, one with a `..` part (whether or not it would come back in), one
 * with a NUL, and one that no file system holds.
 */
export function partsOf(rel: unknown): string[] {
	if (typeof rel !== "string" || rel.length > MAX_PATH_CHARS || rel.includes("\0"))
		throw new FolderError("Bad path", 400);
	if (isAbsolute(rel)) throw new FolderError("Outside the folder", 403);
	const parts = rel.split("/").filter((part) => part !== "" && part !== ".");
	if (parts.includes("..")) throw new FolderError("Outside the folder", 403);
	return parts;
}

export interface Resolved {
	/** The real path of the file or folder: no link left in it, and inside the root. */
	abs: string;
	/** The path as the page wrote it, tidied (`a//b/./c` is `a/b/c`). */
	rel: string;
}

/**
 * `rel` below `root` (the real path from `rootOf`), with every link followed. A path that leads out of `root` by a link
 * is refused (403) like one that leads out by `..`; a path that is not there is 404.
 */
export async function resolveInside(root: string, rel: unknown): Promise<Resolved> {
	const parts = partsOf(rel);
	let real: string;
	try {
		real = await realpath(parts.length ? join(root, ...parts) : root);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "EACCES" || code === "EPERM") throw new FolderError("No permission", 403);
		if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP" || code === "ENAMETOOLONG") {
			// Not there: but a path that goes out through a link is refused whether or not anything is at its end, so that the
			// answer does not tell what exists outside the folder.
			if (await leavesFolder(root, parts)) throw new FolderError("Outside the folder", 403);
			throw new FolderError("Not found", 404);
		}
		throw e;
	}
	if (!inside(root, real)) throw new FolderError("Outside the folder", 403);
	return { abs: real, rel: parts.join("/") };
}

/** Whether the part of `parts` that exists leads out of `root`: the nearest ancestor that can be resolved is outside it. */
async function leavesFolder(root: string, parts: string[]): Promise<boolean> {
	for (let n = parts.length - 1; n >= 0; n--) {
		try {
			return !inside(root, await realpath(n ? join(root, ...parts.slice(0, n)) : root));
		} catch {
			// this one is not there either: look at its parent
		}
	}
	return false;
}

/** Folders whose whole content is a secret, by name (lower case). */
const SECRET_DIRS: readonly string[] = [".ssh", ".gnupg", ".aws"];
/** File names that are a secret, whole (lower case). */
const SECRET_NAMES: readonly string[] = [
	".npmrc",
	".netrc",
	".pgpass",
	".htpasswd",
	".git-credentials",
	"credentials",
	"secrets",
];
/** Extensions of files that are a key or a store of them and cannot be told by their text (lower case, with the dot). */
const SECRET_EXTENSIONS: readonly string[] = [".p12", ".pfx", ".keystore", ".jks", ".ppk"];
/** `credentials.json`, `secrets.yml`: data files by those names. Not `credentialsProvider.tsx` or `secrets.ts`, which are code. */
const SECRET_DATA = /^(?:credentials|secrets)\.(?:json|ya?ml|toml|ini|cfg|conf|xml|csv|txt|enc)$/;
/** The private keys ssh makes: `id_rsa`, `id_ed25519`, `id_ecdsa_sk`, `id_rsa.bak` (its `.pub` is public, and is not one). */
const SSH_KEY = /^id_(?:rsa|dsa|ecdsa|ed25519)(?:_sk)?(?:\.(?!pub$).+)?$/;
/** An environment file's name ends in what a template's does: `.env.example` has nothing in it. */
const ENV_TEMPLATE = /\.(?:example|sample|template|dist|defaults)$/;

/**
 * Whether a path (relative to the folder, any case: a Mac's file system does not tell `.ENV` from `.env`) looks like it
 * holds a secret, by its name: environment files (`.env`, `.env.local`, `prod.env`; not `.environment`, `.env.example`),
 * ssh private keys (`id_rsa`, `id_ed25519`; not `id_helper.ts`), key stores (`.p12`, `.pfx`, `.keystore`), `credentials`
 * and `secrets` data files, `.npmrc`, `.netrc` and the like, `.ssh/**` and `.git/config`. A page that is not this
 * computer's is shown none of these (see `ListOptions.guarded`). A key in a PEM file is told by its text instead, when the
 * file is read (`holdsPrivateKey`), since `server.key` may be a key and `keyboard.key` a presentation. A name is what is
 * looked at here: a secret in a file called `notes.txt` is not found, and nothing replaces keeping secrets out of the folder.
 */
export function isSecretLooking(rel: string): boolean {
	const parts = rel.toLowerCase().split("/").filter(Boolean);
	for (const [i, part] of parts.entries()) {
		if (SECRET_DIRS.includes(part)) return true;
		if (part === ".git" && parts[i + 1] === "config") return true;
	}
	const name = parts.at(-1) ?? "";
	if (SECRET_NAMES.includes(name) || SECRET_DATA.test(name) || SSH_KEY.test(name)) return true;
	if (SECRET_EXTENSIONS.some((x) => name.endsWith(x))) return true;
	if (name === ".env" || name.endsWith(".env")) return true;
	return name.startsWith(".env.") && !ENV_TEMPLATE.test(name);
}

/** A private key in the text of a file, whatever the file is called: the line a PEM key (or an ssh or PGP one) begins with. */
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY/;
export const holdsPrivateKey = (text: string): boolean => PRIVATE_KEY_BLOCK.test(text);

/** What a page that is not this computer's is told when it asks for what looks like a secret. */
export const SECRET_REFUSAL = "This looks like a secret: it is not shown to a page that is not on this computer";
const HIDDEN_REFUSAL = "This is hidden: it is not shown to a page that is not on this computer";

/**
 * Whether a path leads through something that is hidden by default (see `hiddenByDefault`): a dotfile or dot folder but
 * `.github`, a dependency or build folder. `parts` are the real path's, relative to the folder; `last` is whether the last
 * is a folder. A page that is not this computer's cannot read what its listing does not show.
 */
export function throughHidden(root: string, parts: string[], lastIsDir: boolean): boolean {
	return parts.some((part, i) =>
		hiddenByDefault(part, i < parts.length - 1 || lastIsDir, join(root, ...parts.slice(0, i + 1))),
	);
}

/**
 * What keeps a `guarded` page from a path of the folder that need not be there (the diff of a file that was deleted is asked
 * for too): a name that looks like a secret, or a part that is hidden by default. Null when the page may be shown it. It is
 * what `resolveFor` refuses by, from the name alone. A slash at the end says the path is a folder (as git writes a
 * repository inside the folder: `nested/`).
 */
export function guardedRefusal(root: string, rel: string): FolderError | null {
	if (isSecretLooking(rel)) return new FolderError(SECRET_REFUSAL, 403);
	if (throughHidden(root, rel.split("/").filter(Boolean), rel.endsWith("/")))
		return new FolderError(HIDDEN_REFUSAL, 403);
	return null;
}

/**
 * `rel` as `resolveInside` resolves it, and for a `guarded` page refused when what it leads to looks like a secret (by the
 * name of the file itself, whatever a link calls it: a link called `notes.txt` to `.env` is `.env`) or lies in or is
 * something that is hidden by default (the listing of a guarded page leaves those out, so they are not read by their path
 * either).
 */
export async function resolveFor(root: string, rel: unknown, guarded: boolean): Promise<Resolved> {
	const file = await resolveInside(root, rel);
	if (!guarded) return file;
	const real = relative(root, file.abs);
	if (isSecretLooking(real)) throw new FolderError(SECRET_REFUSAL, 403);
	const parts = real.split(sep).filter(Boolean);
	if (parts.length > 0) {
		const lastIsDir = await stat(file.abs).then(
			(info) => info.isDirectory(),
			() => false,
		);
		if (throughHidden(root, parts, lastIsDir)) {
			throw new FolderError(HIDDEN_REFUSAL, 403);
		}
	}
	return file;
}

/**
 * Whether `abs` (a real path, from `resolveInside`) still leads where it did: resolving it again gives the same path. A
 * folder on the way that was swapped for a link since is found here, whatever it led to.
 */
async function unchanged(abs: string): Promise<boolean> {
	try {
		return (await realpath(abs)) === abs;
	} catch {
		return false;
	}
}

const collator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });
const byName = (a: { name: string }, b: { name: string }) =>
	collator.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);

/** The entry a link in a folder is: what it leads to when that is inside the folder, else a leaf that is never followed. */
async function linkEntry(root: string, abs: string, name: string): Promise<FolderEntry | null> {
	try {
		const real = await realpath(abs);
		if (!inside(root, real)) return { name, kind: "file", link: "out" };
		const target = await stat(real);
		if (target.isDirectory()) return { name, kind: "dir", link: "in" };
		if (target.isFile()) return { name, kind: "file", link: "in" };
		return null;
	} catch {
		// A link to nothing: shown, and it leads nowhere.
		return { name, kind: "file", link: "out" };
	}
}

export interface ListOptions {
	/** List what is hidden by default too (marked `hidden`). Never for a `guarded` page. */
	all: boolean;
	marks: GitMarks | null;
	/**
	 * The page is not this computer's (the tunnel, a proxy, a network address): what is hidden by default stays hidden, and
	 * what looks like a secret (`isSecretLooking`) is neither listed, found nor read.
	 */
	guarded?: boolean;
	/** For tests (see `OpenHooks`): `beforeOpen` runs after the folder is resolved, `afterOpen` after it is found to be a folder, before it is read. */
	hooks?: OpenHooks;
	/** `find`: walk the folder again instead of using the list kept for a moment (something was seen to change). */
	fresh?: boolean;
}

/**
 * The folder `rel` of `root`: folders first, then files, each by name; what is hidden by default only when asked for.
 * Under a folder swapped for a link while it is read, a listing is the weakest of the reads: `readdir` has no handle to
 * compare with the path, so it is checked by the path alone, once, after the read, and what can leak is the names in the
 * folder it was led to (never what is in a file).
 */
export async function listFolder(root: string, rel: unknown, opts: ListOptions): Promise<FolderListing> {
	const guarded = opts.guarded === true;
	const all = opts.all && !guarded;
	const dir = await resolveFor(root, rel, guarded);
	await opts.hooks?.beforeOpen?.();
	let names: Dirent[];
	try {
		if (!(await stat(dir.abs)).isDirectory()) throw new FolderError("Not a folder", 400);
		await opts.hooks?.afterOpen?.();
		names = await readdir(dir.abs, { withFileTypes: true });
	} catch (e) {
		if (e instanceof FolderError) throw e;
		// A folder that went while it was listed is not there (the page closes it); anything else is for the system to say.
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") throw new FolderError("Not found", 404);
		throw new FolderError("No permission", 403);
	}
	// The folder was swapped for a link while it was read: what was read is not this folder's.
	if (!(await unchanged(dir.abs))) throw new FolderError("Outside the folder", 403);
	const entries: FolderEntry[] = [];
	let hiddenCount = 0;
	for (const item of names) {
		const abs = join(dir.abs, item.name);
		let entry: FolderEntry | null;
		if (item.isDirectory()) entry = { name: item.name, kind: "dir" };
		else if (item.isFile()) entry = { name: item.name, kind: "file" };
		else if (item.isSymbolicLink()) entry = await linkEntry(root, abs, item.name);
		else entry = null;
		if (!entry) continue;
		const path = dir.rel ? `${dir.rel}/${entry.name}` : entry.name;
		if (guarded && isSecretLooking(path)) continue;
		const isDir = entry.kind === "dir";
		const hidden =
			hiddenByDefault(entry.name, isDir, abs) || (opts.marks !== null && isIgnored(opts.marks, path, isDir));
		if (hidden) {
			if (!all) {
				hiddenCount++;
				continue;
			}
			entry.hidden = true;
		}
		const git = opts.marks ? markOf(opts.marks, path, isDir) : undefined;
		if (git) entry.git = git;
		entries.push(entry);
	}
	// Folders first: a link that leads out is shown with the files, as the leaf it is.
	entries.sort((a, b) => Number(b.kind === "dir") - Number(a.kind === "dir") || byName(a, b));
	const truncated = entries.length > FOLDER_LIMITS.listEntries;
	return {
		root,
		path: dir.rel,
		entries: truncated ? entries.slice(0, FOLDER_LIMITS.listEntries) : entries,
		hiddenCount,
		truncated,
		git: opts.marks !== null,
		...(guarded ? { guarded: true as const } : {}),
	};
}

/** The files the filter searches: the `@` walk's (see server/files.ts), and the walk that leaves out only repository data. */
export const tidyIndex = new FileIndex();
export const fullIndex = new FileIndex((dir) => scanFiles(dir, SCAN_LIMITS, undefined, skipRepositoryData));

/** How well `path` answers the filter: 0 starts with it, 1 its name does, 2 contains it; -1 does not. */
function score(lower: string, q: string): number {
	if (lower.startsWith(q)) return 0;
	const name = lower.slice(lower.lastIndexOf("/") + 1);
	if (name.startsWith(q)) return 1;
	return lower.includes(q) ? 2 : -1;
}

/**
 * The files of `root` whose path holds `query` (case does not matter), best first: a bounded walk like the `@`
 * completion's, so a home folder answers too (`partial` says the walk ended at its limits). What the tree hides by default
 * is not matched unless `all`.
 */
export async function findFiles(root: string, query: string, opts: ListOptions): Promise<FolderFound> {
	const q = query.trim().toLowerCase();
	if (!q) return { matches: [], truncated: false, partial: false };
	const guarded = opts.guarded === true;
	const all = opts.all && !guarded;
	const { files, complete } = await (all ? fullIndex : tidyIndex).walk(root, opts.fresh === true);
	const scored: { path: string; score: number }[] = [];
	for (const path of files) {
		const s = score(path.toLowerCase(), q);
		if (s < 0) continue;
		if (guarded && isSecretLooking(path)) continue;
		if (!all) {
			const name = path.slice(path.lastIndexOf("/") + 1);
			if (name.startsWith(".") || (opts.marks !== null && isIgnored(opts.marks, path, false))) continue;
		}
		scored.push({ path, score: s });
	}
	scored.sort((a, b) => a.score - b.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
	const matches: FolderMatch[] = scored.slice(0, FOLDER_LIMITS.matches).map(({ path }) => {
		const git = opts.marks ? markOf(opts.marks, path, false) : undefined;
		return git && git !== "changed" ? { path, git } : { path };
	});
	return { matches, truncated: scored.length > FOLDER_LIMITS.matches, partial: !complete };
}

const decoder = new TextDecoder("utf-8");

/**
 * Whether the start of a file is not text: a NUL byte, or so many control bytes or bytes that are not UTF-8 that it is
 * data (an archive, an executable, a font) and not words in some encoding. A text in another encoding than UTF-8 (GBK,
 * Latin-1) is shown as what UTF-8 makes of it unless most of it is not valid.
 */
export function looksBinary(sample: Uint8Array): boolean {
	if (sample.length === 0) return false;
	let controls = 0;
	for (const byte of sample) {
		if (byte === 0) return true;
		// Tab, newline, form feed, carriage return and escape (colour codes in a log) are text.
		if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 12 && byte !== 13 && byte !== 27) controls++;
	}
	if (controls / sample.length > 0.1) return true;
	const text = decoder.decode(sample);
	let invalid = 0;
	for (const ch of text) if (ch === "\uFFFD") invalid++;
	return invalid / Math.max(1, text.length) > 0.1;
}

/** What a file of this name opens as: Markdown and SVG are rendered (with their source one click away), the rest is code. */
export function viewOf(name: string): FolderView {
	const ext = extensionOf(name);
	if (ext === "md" || ext === "markdown") return "markdown";
	return ext === "svg" ? "svg" : "code";
}

/** How much of the start of a file decides whether it is text. */
const SNIFF_BYTES = 8000;

/** `abs` still leads where it did, once more, after what was read from it has been read (see `openRegular`). */
async function stillThere(abs: string, hooks?: OpenHooks): Promise<void> {
	await hooks?.afterRead?.();
	if (!(await unchanged(abs))) throw new FolderError("Outside the folder", 403);
}

/** Steps a test takes between the ones of a read, to make what a race would (a folder swapped for a link). */
export interface OpenHooks {
	/** After the path was resolved, before the file is opened (or, for `openFolderFile`, handed to the system). */
	beforeOpen?: () => Promise<void> | void;
	/** After the file is opened, before it is checked. */
	afterOpen?: () => Promise<void> | void;
	/** After the file is read, before the check that it is still where it was. */
	afterRead?: () => Promise<void> | void;
}

/** How a file is asked for. */
export interface ReadOptions {
	/** The page is not this computer's: what looks like a secret is refused (see `isSecretLooking`). */
	guarded?: boolean;
	hooks?: OpenHooks;
}

/**
 * Open the real path `abs` of `root` for reading, as a regular file and nothing else: not followed if the file itself has
 * become a link since it was resolved (`O_NOFOLLOW`), and never waiting on a pipe (a FIFO opened for reading blocks until
 * something writes to it).
 *
 * `O_NOFOLLOW` guards the last part of the path only. A folder on the way that was swapped for a link between the
 * resolving and the opening is followed by the open, so what was opened is then checked: its path must still be `abs`,
 * twice, with the same device and inode as the open file, and once more after the read. That makes a swap that lands in
 * the window very rare to win (a loop that does nothing but swap won 26 times in 379,000 tries against `O_NOFOLLOW` alone,
 * and none in 315,000 with these checks), not impossible (the checks are by path as well); it takes something that can write
 * to the project folder, which the page cannot.
 */
export async function openRegular(
	abs: string,
	hooks?: OpenHooks,
): Promise<{ handle: FileHandle; size: number; modified: number }> {
	await hooks?.beforeOpen?.();
	let handle: FileHandle;
	try {
		handle = await open(abs, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "EACCES" || code === "EPERM") throw new FolderError("No permission", 403);
		throw new FolderError("Not found", 404);
	}
	try {
		await hooks?.afterOpen?.();
		const info = await handle.stat({ bigint: true });
		if (!info.isFile()) throw new FolderError("Not a regular file", 415);
		if (!(await unchanged(abs))) throw new FolderError("Outside the folder", 403);
		const there = await stat(abs, { bigint: true }).catch(() => null);
		if (!there || there.dev !== info.dev || there.ino !== info.ino) throw new FolderError("Outside the folder", 403);
		if (!(await unchanged(abs))) throw new FolderError("Outside the folder", 403);
		return { handle, size: Number(info.size), modified: Math.floor(Number(info.mtimeMs)) };
	} catch (e) {
		await handle.close();
		throw e;
	}
}

/** The file `rel` of `root`, as the panel shows it: text (its first megabyte), an image, or a file that is neither. */
export async function readFolderFile(
	root: string,
	rel: unknown,
	local: boolean,
	opts: ReadOptions = {},
): Promise<FolderFile> {
	const file = await resolveFor(root, rel, opts.guarded === true);
	const { handle, size, modified } = await openRegular(file.abs, opts.hooks);
	try {
		const name = file.rel.slice(file.rel.lastIndexOf("/") + 1);
		const base = { path: file.rel, size, modified, local };
		const mime = IMAGE_TYPES[extensionOf(name)];
		if (mime) return size <= FOLDER_LIMITS.imageBytes ? { ...base, kind: "image", mime } : { ...base, kind: "binary" };
		// A PDF or a Word document is not read here: the page fetches its bytes (`readFolderDocument`) to draw or read it.
		const type = documentTypeOf(name);
		if (type) {
			return size <= FOLDER_LIMITS.documentBytes ? { ...base, kind: "document", type } : { ...base, kind: "binary" };
		}
		const want = Math.min(size, FOLDER_LIMITS.textBytes);
		const buffer = Buffer.alloc(want);
		const { bytesRead } = await handle.read(buffer, 0, want, 0);
		await stillThere(file.abs, opts.hooks);
		const bytes = buffer.subarray(0, bytesRead);
		if (looksBinary(bytes.subarray(0, SNIFF_BYTES))) return { ...base, kind: "binary" };
		const truncated = size > FOLDER_LIMITS.textBytes;
		let text = decoder.decode(bytes);
		// A private key is a private key whatever the file is called (`server.key`, `notes.txt`).
		if (opts.guarded === true && holdsPrivateKey(text)) throw new FolderError(SECRET_REFUSAL, 403);
		// A character cut by the limit decodes as the replacement character: it is not the file's.
		if (truncated && text.endsWith("\uFFFD")) text = text.slice(0, -1);
		// A byte order mark is the encoding's, not the text's.
		if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
		return {
			...base,
			kind: "text",
			text,
			truncated,
			view: viewOf(name),
			etag: createHash("sha256").update(bytes).digest("hex"),
			// Whole, and bytes that are the text's own (a file in another encoding does not come back from a save as it was).
			editable: !truncated && isUtf8(bytes),
		};
	} finally {
		await handle.close();
	}
}

/**
 * The bytes of a file of `root` whose name `typeOf` accepts (it names what the bytes are served as), at most `limit` of them;
 * refused as `what` when the name is not one it accepts.
 */
async function readServed<T extends string>(
	root: string,
	rel: unknown,
	opts: ReadOptions,
	typeOf: (name: string) => T | null | undefined,
	limit: number,
	what: string,
): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: T }> {
	const file = await resolveFor(root, rel, opts.guarded === true);
	const type = typeOf(file.rel);
	if (!type) throw new FolderError(`Not ${what}`, 415);
	const { handle, size } = await openRegular(file.abs, opts.hooks);
	try {
		if (size > limit) throw new FolderError("Too large", 415);
		const bytes = Buffer.alloc(size);
		const { bytesRead } = await handle.read(bytes, 0, size, 0);
		await stillThere(file.abs, opts.hooks);
		return { bytes: bytes.subarray(0, bytesRead), type };
	} finally {
		await handle.close();
	}
}

/** The bytes of an image file of `root`, and what to serve them as. Only a raster picture: never an SVG, a page or a text. */
export async function readFolderImage(
	root: string,
	rel: unknown,
	opts: ReadOptions = {},
): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: string }> {
	const { bytes, type } = await readServed(
		root,
		rel,
		opts,
		(name) => IMAGE_TYPES[extensionOf(name)],
		FOLDER_LIMITS.imageBytes,
		"an image",
	);
	return { bytes, mime: type };
}

/**
 * The bytes of a PDF or a Word (`.docx`) file of `root`, for the page to draw or read: nothing else, whatever the page asks
 * (a page, a script, a text). `type` is which it is; the route serves the bytes as an opaque download, never as the document.
 */
export async function readFolderDocument(
	root: string,
	rel: unknown,
	opts: ReadOptions = {},
): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: FolderDocument }> {
	return readServed(root, rel, opts, documentTypeOf, FOLDER_LIMITS.documentBytes, "a PDF or Word document");
}

/**
 * What macOS would run or load as a page if it were asked to open one (by the extension, lower case): scripts, installers,
 * applications, configuration profiles, shortcuts that open an address (`.webloc`, `.vncloc`, `.afploc`...), and pages
 * (`.html`, `.svg`, `.webarchive`) that a browser would draw with its scripts. The default app of these is not an editor:
 * they can be shown in Finder, not opened.
 */
const NEVER_OPENED: readonly string[] = (
	"command tool terminal sh bash zsh csh ksh fish py pyw pl rb php lua tcl jar jnlp pkg mpkg dmg app workflow action " +
	"scpt scptd applescript osa fileloc webloc inetloc vncloc afploc ftploc url exe msi bat cmd com ps1 vbs scr " +
	"mobileconfig prefpane kext saver widget html htm xhtml svg webarchive"
).split(" ");

/** Whether a file of this name is never opened by the page (only shown in Finder). */
export const neverOpened = (name: string): boolean => NEVER_OPENED.includes(extensionOf(name));

/** The system's own `open`, by its full name: the page's `PATH` does not decide what runs. */
const OPEN = "/usr/bin/open";
const OPEN_MS = 15_000;

export type Runner = (argv: string[]) => Promise<number>;
const runOpen: Runner = async (argv) => (await run(argv, { timeoutMs: OPEN_MS })).code;

const basenameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * Hand the file `rel` of `root` to the system: `reveal` shows it in Finder, otherwise it opens in the app macOS has for it.
 * Nothing is executed: a file with an execute permission, a script, an installer or a page is not opened (only revealed),
 * whether the name asked for says so or the name of the file it leads to does (a link called `README.txt` to `payload.jar`
 * is a `.jar`), and a folder is only revealed (opening one that is an app would start it).
 */
export async function openFolderFile(
	root: string,
	rel: unknown,
	reveal: boolean,
	platform: string = process.platform,
	runner: Runner = runOpen,
	opts: ReadOptions = {},
): Promise<void> {
	if (platform !== "darwin") throw new FolderError("Opening files from the page is only available on macOS", 501);
	const file = await resolveFor(root, rel, opts.guarded === true);
	const info = await stat(file.abs);
	if (!reveal) {
		if (!info.isFile()) throw new FolderError("Only files are opened", 400);
		if ((info.mode & 0o111) !== 0) throw new FolderError("An executable file is never opened", 403);
		if (neverOpened(basenameOf(file.rel)) || neverOpened(basenameOf(file.abs))) {
			throw new FolderError("A script, installer or page is never opened: it can be shown in Finder", 403);
		}
	} else if (!info.isFile() && !info.isDirectory()) {
		throw new FolderError("Not a file or folder", 400);
	}
	// A folder on the way swapped for a link while this looked: what is handed over is not what was checked.
	await opts.hooks?.beforeOpen?.();
	if (!(await unchanged(file.abs))) throw new FolderError("Outside the folder", 403);
	const code = await runner(reveal ? [OPEN, "-R", file.abs] : [OPEN, file.abs]);
	if (code !== 0) throw new FolderError(`open failed with code ${code}`, 404);
}

/**
 * Directory extensions macOS treats as one thing that `open` starts or hands to an app: an application, a plug-in, an
 * installer package, a project, a disk image, a library or a document of an app. A folder called that is shown in Finder
 * by the folder around it (`openFolderFile` with `reveal`), not opened (lower case). This is the floor: what
 * LaunchServices says (`PackageProbe`) is asked as well, since apps register package kinds of their own.
 */
const PACKAGE_DIRS: readonly string[] = (
	"app workflow action saver widget wdgt prefpane kext dext systemextension pkg mpkg scptd framework bundle plugin " +
	"xpc appex service component qlgenerator mdimporter xcodeproj xcworkspace playground rtfd sparsebundle menu pvm " +
	"download nib mlmodelc xcarchive swiftpm pbproj caction osax photoslibrary photolibrary aplibrary musiclibrary " +
	"tvlibrary band pages numbers key logicx fcpbundle imovielibrary theater docset textbundle"
).split(" ");

/** Whether a folder of this name is a package macOS would start or open in an app rather than show as a folder. */
export const isPackageDir = (name: string): boolean => PACKAGE_DIRS.includes(extensionOf(name));

/** Whether macOS treats the folder at this real path as one package (`open` would hand it to an app, not to Finder). */
export type PackageProbe = (abs: string) => Promise<boolean>;

const PACKAGE_JXA =
	'function run(a){ObjC.import("AppKit");return $.NSWorkspace.sharedWorkspace.isFilePackageAtPath(a[0])}';

/**
 * LaunchServices' own answer (`NSWorkspace.isFilePackageAtPath`), asked through `osascript` with the path as an argument
 * (never in the script). Anything but a plain `false`, or a failure to ask, counts as a package: the folder is refused.
 */
export const systemPackageProbe: PackageProbe = async (abs) => {
	try {
		const r = await run(["/usr/bin/osascript", "-l", "JavaScript", "-e", PACKAGE_JXA, abs], { timeoutMs: OPEN_MS });
		return r.code !== 0 || r.stdout.trim() !== "false";
	} catch {
		return true;
	}
};

/**
 * Open the folder `rel` of `root` (empty: the conversation's folder itself) in Finder. Only a folder that is there is
 * opened: a file (whatever it is called) is refused (400), and so is a folder that macOS would start or open in an app
 * (an application, a plug-in, a project: 403; the folder around it can show it in Finder). What is handed to `open` is
 * the real path from `resolveFor`, one element of an argument list (never a shell), after the same checks as every other
 * path and once more after a look that nothing under it was swapped for a link.
 */
export async function openFolderDir(
	root: string,
	rel: unknown,
	platform: string = process.platform,
	runner: Runner = runOpen,
	opts: ReadOptions = {},
	isPackage: PackageProbe = systemPackageProbe,
): Promise<void> {
	if (platform !== "darwin") throw new FolderError("Opening folders from the page is only available on macOS", 501);
	const dir = await resolveFor(root, rel, opts.guarded === true);
	if (!(await stat(dir.abs)).isDirectory()) throw new FolderError("Only folders are opened", 400);
	if (isPackageDir(basenameOf(dir.rel)) || isPackageDir(basenameOf(dir.abs)) || (await isPackage(dir.abs))) {
		throw new FolderError("An application or package is never opened: it can be shown in Finder", 403);
	}
	// A folder on the way swapped for a link while this looked: what is handed over is not what was checked.
	await opts.hooks?.beforeOpen?.();
	if (!(await unchanged(dir.abs))) throw new FolderError("Outside the folder", 403);
	const code = await runner([OPEN, dir.abs]);
	if (code !== 0) throw new FolderError(`open failed with code ${code}`, 404);
}
