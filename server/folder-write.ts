import { isUtf8 } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { type BigIntStats, constants } from "node:fs";
import { access, lstat, open, realpath, rename, unlink } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { FOLDER_LIMITS, type FolderSaved } from "../shared/folder.ts";
import { isRecord } from "../shared/guards.ts";
import type { EditConflict } from "../shared/transfer.ts";
import {
	holdsPrivateKey,
	inside,
	isSecretLooking,
	looksBinary,
	type OpenHooks,
	openRegular,
	partsOf,
	type Resolved,
	resolveFor,
} from "./folder.ts";
import {
	conversationRoot,
	holdsHome,
	isProtected,
	json,
	record,
	requireUpload,
	startsPrograms,
	type Trace,
	type TransferContext,
	type TransferEnv,
	TransferError,
	viaFolder,
} from "./transfer-core.ts";
import type { TransferLog } from "./transfer-log.ts";
import { realAsFarAsItGoes, serialized } from "./upload.ts";

/**
 * `POST /api/folder/file`: the whole new text of a file of the conversation's folder, written by the page that opened it in the
 * Files tab's editor. What it promises, for every page (one on this computer too):
 *
 *  - It changes a file that is there and makes none: a regular file, found as the Files tab finds it (`resolveFor`: for a page
 *    that is not this computer's, what the tab does not show it is not written either), and inside the conversation's folder
 *    whatever way leads to it (a link that leads out is refused, one that leads to a file inside is the file it leads to).
 *    Not what looks like a secret (by its name, or by a private key in it), not what CI runs on a push (`.github/workflows`,
 *    `.github/actions`), not a protected place, not a folder an omp-webui keeps its data in, and, for a page that is not on this
 *    computer, not in a conversation whose folder is the home folder or holds it (as an upload).
 *  - It is for a page that may upload (`requireUpload`): the person's setting for a page that is not on this computer.
 *  - What is written is the text the page was shown, changed: the file must be whole UTF-8 text of at most
 *    `FOLDER_LIMITS.editBytes`, so that what the page did not touch comes back byte for byte (a byte order mark is kept; a
 *    file in another encoding is refused, never rewritten as UTF-8).
 *  - It never overwrites what it was not made from: the page names the `etag` (SHA-256 of the bytes) of the file it opened,
 *    and a file that is another one now is a 409 `conflict` with the etag it has now (saving again with that etag overwrites).
 *    The check and the swap are one step for every save that goes through here and every upload's publish (`serialized`), and
 *    the file is looked at once more just before the swap (same inode, size and change time), so a file changed by anything
 *    else in between is a conflict too. What is not promised: a change that lands between that last look and `rename`.
 *  - It is written whole or not at all: to a hidden file beside the file, flushed, with the file's permissions (never more),
 *    then moved over it. A file the process cannot write (`access`) is not replaced through its folder's permissions.
 */

const MiB = 1024 * 1024;
/** What the body of a save may weigh: the text's cap with every byte of it escaped as JSON would at worst, and what surrounds it. */
const BODY_MAX = 8 * MiB;
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
/** How much of the start of a file decides whether it is text (as the read does). */
const SNIFF_BYTES = 8000;
const strict = new TextDecoder("utf-8", { fatal: true });

/** Why a save of `rel` would be refused for a reason of where it is, or null: one question for the answer to the read (`editable`) and for the save. */
export async function placeRefusal(
	root: string,
	rel: unknown,
	file: Resolved,
	env: TransferEnv,
): Promise<TransferError | null> {
	if (!env.local && holdsHome(root, env))
		return new TransferError(
			"Files are not edited from a page that is not on this computer in the home folder",
			403,
			"homeFolder",
		);
	const named = await viaFolder(async () => partsOf(rel));
	const real = relative(root, file.abs).split(sep);
	if (startsPrograms(named) || startsPrograms(real))
		return new TransferError("That is a place nothing is written into unasked", 403, "protected");
	if (isSecretLooking(named.join("/")) || isSecretLooking(real.join("/")))
		return new TransferError("This looks like a secret: nothing is written into it", 403, "secret");
	for (const dir of env.dataDirs) {
		if (inside(await realAsFarAsItGoes(dir), file.abs))
			return new TransferError("That is a folder the app keeps its own data in", 403, "ownData");
	}
	if (isProtected(file.abs, env))
		return new TransferError("That is a place nothing is written into unasked", 403, "protected");
	return null;
}

/**
 * Whether the page that asked for the file `rel` may be offered to edit it, as far as the place and the page go (the text is
 * `readFolderFile`'s to judge): what the save would not refuse for them. Never throws: a file that cannot be judged is not editable.
 */
export async function mayEdit(root: string, rel: unknown, env: TransferEnv): Promise<boolean> {
	if (!env.local && env.setting !== "full") return false;
	try {
		const file = await resolveFor(root, rel, !env.local);
		return (await placeRefusal(root, rel, file, env)) === null;
	} catch {
		return false;
	}
}

const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

const tooLarge = () =>
	new TransferError("That text is larger than a file is edited at here", 413, "tooLarge", {
		limit: FOLDER_LIMITS.editBytes,
	});

/** The body, as text: at most `BODY_MAX` of it, however it is sent, and nothing that is not UTF-8. */
async function bodyText(req: Request): Promise<string> {
	const declared = Number(req.headers.get("content-length"));
	if (Number.isFinite(declared) && declared > BODY_MAX) throw tooLarge();
	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = req.body?.getReader();
	if (reader) {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.length;
			if (total > BODY_MAX) {
				await reader.cancel().catch(() => {});
				throw tooLarge();
			}
			chunks.push(value);
		}
	}
	try {
		return strict.decode(Buffer.concat(chunks));
	} catch {
		throw new TransferError("The request was not UTF-8", 400, "badRequest");
	}
}

interface Save {
	live: string | null;
	file: string | null;
	path: string;
	text: string;
	etag: string;
}

/** The request: the conversation, the file, the text and the etag, each of the kind it must be. */
async function saveOf(req: Request): Promise<Save> {
	let body: unknown;
	try {
		body = JSON.parse(await bodyText(req));
	} catch (e) {
		if (e instanceof TransferError) throw e;
		throw new TransferError("The request was not JSON", 400, "badRequest");
	}
	if (!isRecord(body)) throw new TransferError("The request was not understood", 400, "badRequest");
	const { live, file, path, text, etag } = body;
	if (
		(live !== undefined && typeof live !== "string") ||
		(file !== undefined && typeof file !== "string") ||
		typeof path !== "string" ||
		path === "" ||
		typeof text !== "string" ||
		typeof etag !== "string" ||
		etag === ""
	)
		throw new TransferError("A save names the file, its text and the etag of what it was made from", 400, "badRequest");
	return { live: live ?? null, file: file ?? null, path, text, etag };
}

/** What the file `abs` holds now, and what it is (one read, as the file is when it is looked at). */
async function holding(abs: string, hooks?: OpenHooks): Promise<{ bytes: Buffer; info: BigIntStats }> {
	const { handle, size } = await viaFolder(() => openRegular(abs, hooks));
	try {
		if (size > FOLDER_LIMITS.editBytes)
			throw new TransferError("That file is larger than a file is edited at here", 413, "tooLarge", {
				limit: FOLDER_LIMITS.editBytes,
			});
		const buffer = Buffer.alloc(size);
		const { bytesRead } = await handle.read(buffer, 0, size, 0);
		return { bytes: buffer.subarray(0, bytesRead), info: await handle.stat({ bigint: true }) };
	} finally {
		await handle.close();
	}
}

const conflict = (etag: string) =>
	new TransferError("The file changed since it was opened", 409, "conflict", { etag } satisfies Pick<
		EditConflict,
		"etag"
	>);

export interface EditDeps {
	log: TransferLog;
	/** Steps a test takes between the ones of a read (see `OpenHooks`). */
	hooks?: OpenHooks;
	/** After the new text is on disk beside the file, before it is looked at once more and moved over it (tests change the file here). */
	beforePublish?: () => Promise<void> | void;
}

/** `POST /api/folder/file`: see above. */
export async function editFile(
	req: Request,
	ctx: TransferContext,
	env: TransferEnv,
	trace: Trace,
	deps: EditDeps,
): Promise<Response> {
	requireUpload(env);
	const save = await saveOf(req);
	const root = await conversationRoot(ctx, save.live, save.file);
	trace.root = root;
	trace.path = save.path.slice(0, 4096);
	const target = await viaFolder(() => resolveFor(root, save.path, !env.local));
	const refused = await placeRefusal(root, save.path, target, env);
	if (refused) throw refused;
	const text = Buffer.from(save.text, "utf8");
	if (text.length > FOLDER_LIMITS.editBytes) throw tooLarge();
	const dir = dirname(target.abs);
	const saved = await serialized(dir, () => publish(root, target.abs, dir, text, save, deps));
	record(deps.log, env, trace, "ok", { size: saved.size, sha256: saved.etag });
	return json(saved);
}

/** Look at the file, check that it is the one the text was made from, and replace it. */
async function publish(
	root: string,
	abs: string,
	dir: string,
	text: Buffer,
	save: Save,
	deps: EditDeps,
): Promise<FolderSaved> {
	const { bytes: before, info } = await holding(abs, deps.hooks);
	// A secret's content is not told by its etag, nor its place by what it says: the checks that depend on what is in the file
	// come before the one that names it.
	if (holdsPrivateKey(before.toString("utf8")))
		throw new TransferError("This looks like a secret: nothing is written into it", 403, "secret");
	if (looksBinary(before.subarray(0, SNIFF_BYTES)) || !isUtf8(before))
		throw new TransferError("That file is not UTF-8 text: it is not rewritten here", 415, "notText");
	const current = sha256(before);
	if (current !== save.etag) throw conflict(current);
	// A byte order mark is the encoding's, not the text's: the page never saw it, and the file keeps it.
	const bom = before.length >= 3 && before.subarray(0, 3).equals(BOM) && !save.text.startsWith("\uFEFF");
	const out = bom ? Buffer.concat([BOM, text]) : text;
	if (out.equals(before)) return { etag: current, size: before.length, modified: Math.floor(Number(info.mtimeMs)) };
	try {
		await access(abs, constants.W_OK);
	} catch {
		throw new TransferError("That file is not writable", 403, "refused");
	}
	const staged = join(dir, `.ompw-edit-${randomBytes(16).toString("hex")}`);
	try {
		try {
			const handle = await open(
				staged,
				constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
				0o600,
			);
			try {
				// What the file was allowed to be it stays (never an execute bit it did not have, nor a setuid one).
				await handle.chmod(Number(info.mode) & 0o777);
				await handle.writeFile(out);
				await handle.sync();
			} finally {
				await handle.close();
			}
			await deps.beforePublish?.();
			const [real, now] = await Promise.all([
				realpath(dir).catch(() => null),
				lstat(abs, { bigint: true }).catch(() => null),
			]);
			if (real !== dir || !inside(root, real))
				throw new TransferError("The folder is not the one it was", 403, "refused");
			if (
				now === null ||
				!now.isFile() ||
				now.ino !== info.ino ||
				now.dev !== info.dev ||
				now.size !== info.size ||
				now.mtimeNs !== info.mtimeNs
			) {
				// Changed under the save: the answer names what it is now (a file that is gone is a 404 of the read).
				throw conflict(sha256((await holding(abs)).bytes));
			}
			await rename(staged, abs);
		} catch (e) {
			const code = (e as NodeJS.ErrnoException).code;
			if (code === "ENOSPC" || code === "EDQUOT") throw new TransferError("The disk is full", 507, "diskFull");
			if (code === "EACCES" || code === "EPERM" || code === "EROFS")
				throw new TransferError("That file is not writable", 403, "refused");
			throw e;
		}
	} catch (e) {
		await unlink(staged).catch(() => {});
		throw e;
	}
	const after = await lstat(abs).catch(() => null);
	return { etag: sha256(out), size: out.length, modified: Math.floor(after?.mtimeMs ?? Date.now()) };
}
