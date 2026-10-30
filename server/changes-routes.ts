import { lstat } from "node:fs/promises";
import { join } from "node:path";
import type { FileDiff, FolderChanges } from "../shared/changes.ts";
import { FolderError, guardedRefusal, holdsPrivateKey, partsOf, readFolderFile, SECRET_REFUSAL } from "./folder.ts";
import type { FolderContext } from "./folder-routes.ts";
import { newFileDiff } from "./git-changes.ts";

/**
 * `/api/folder/changes` and `/api/folder/diff`: how the folder a conversation works in differs from its repository's last
 * commit, and how one file does (the Changes view of the Files tab). Read only, and under the rules of the other folder
 * routes: the page names the conversation and a path in its folder, never anything else, and a page that is not this
 * computer's is told no more than the Files tab would show it: what looks like a secret and what is hidden by default is
 * neither named in the list nor shown in a diff (a file that was deleted is judged by its name, as it is not there to ask).
 */

type Changes = Pick<FolderContext, "changes" | "diff">;

/** The list of changes, as far as the page may see it. */
export async function changesAnswer(
	ctx: Changes,
	root: string,
	fresh: boolean,
	guarded: boolean,
): Promise<FolderChanges> {
	const changes = { ...(await ctx.changes(root, fresh)), root };
	if (!guarded) return changes;
	const files = changes.files.filter(
		(f) => guardedRefusal(root, f.path) === null && (f.from === undefined || guardedRefusal(root, f.from) === null),
	);
	return { ...changes, files, omitted: changes.files.length - files.length, guarded: true };
}

/**
 * The change of one file the list names. A path the list does not name is not found, whatever git could be asked about
 * it; a new file git does not know is read (as the Files tab reads a file) and shown as all added.
 */
export async function diffAnswer(ctx: Changes, root: string, rawPath: string, guarded: boolean): Promise<FileDiff> {
	const parts = partsOf(rawPath);
	if (parts.length === 0) throw new FolderError("Bad path", 400);
	const rel = parts.join("/");
	const refusal = guarded ? guardedRefusal(root, rel) : null;
	if (refusal) throw refusal;
	// git lists a repository inside this folder as one entry with a slash at its end (`nested/`), which is not a file.
	const file = (await ctx.changes(root, false)).files.find((f) => f.path === rel || f.path === `${rel}/`);
	if (!file) throw new FolderError("This file has no change", 404);
	// What the list calls it is what is judged: `node_modules/` is a dependency folder, `node_modules` might be a file.
	const listedRefusal = guarded ? guardedRefusal(root, file.path) : null;
	if (listedRefusal) throw listedRefusal;
	const fromRefusal = guarded && file.from !== undefined ? guardedRefusal(root, file.from) : null;
	if (fromRefusal) throw fromRefusal;

	let diff: FileDiff | null;
	if (file.state === "untracked") {
		const info = await lstat(join(root, ...parts)).catch(() => null);
		if (!info) throw new FolderError("This file is gone", 404);
		if (info.isSymbolicLink()) diff = newFileDiff(file, { reason: "link" });
		else if (!info.isFile()) diff = newFileDiff(file, { reason: "notFile" });
		else {
			const read = await readFolderFile(root, rel, false, { guarded });
			diff = newFileDiff(file, read.kind === "text" ? { text: read.text, cut: read.truncated } : { binary: true });
		}
	} else {
		diff = await ctx.diff(root, rel);
		if (!diff) throw new FolderError("git did not answer", 504);
	}
	// A key is a key whatever the file is called, in a diff as in a file.
	if (guarded && holdsPrivateKey(diff.hunks.flatMap((h) => h.rows.map((r) => r.text)).join("\n"))) {
		throw new FolderError(SECRET_REFUSAL, 403);
	}
	return diff;
}
