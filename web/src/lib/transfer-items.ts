import { isHiddenName, TRANSFER_LIMITS } from "@shared/transfer.ts";
import type { Taken } from "./transfer-take.ts";

/**
 * Turning what was dropped or picked into the files to send: each with the folder it sits in (relative to what was
 * dropped, "/"-separated) and its name. What the server would refuse is not gathered: hidden names (dotfiles, dependency
 * and build folders; a `.github` folder is fine) are left out and counted, and a folder that holds more files than an
 * upload may is read no further. Empty folders are not uploaded (files only).
 */
export interface Item {
	file: File;
	/** Where it sits in what was dropped: "" at the top, else `proj/src`. */
	dir: string;
	name: string;
	size: number;
}

export interface Gathered {
	items: Item[];
	/** Files and folders left out for being hidden (a hidden folder counts once, whatever is in it). */
	hidden: number;
	/** More files than one upload takes: the gathering stopped, and the files are not to be sent. */
	tooMany: boolean;
}

const LIMIT = TRANSFER_LIMITS.uploadFiles;

const item = (file: File, dir: string): Item => ({ file, dir, name: file.name, size: file.size });

/** The files of a file input, with `webkitRelativePath` as the folder they came in (a folder picker fills it). */
export function fromFileList(files: Iterable<File>): Gathered {
	const out: Gathered = { items: [], hidden: 0, tooMany: false };
	const skipped = new Set<string>();
	for (const file of files) {
		const relative = file.webkitRelativePath || "";
		const slash = relative.lastIndexOf("/");
		const dir = slash < 0 ? "" : relative.slice(0, slash);
		const parts = dir ? dir.split("/") : [];
		// A hidden folder on the way: the file is left out, and the folder is counted once.
		const at = parts.findIndex((part) => isHiddenName(part, true));
		if (at >= 0) {
			skipped.add(parts.slice(0, at + 1).join("/"));
			continue;
		}
		if (isHiddenName(file.name, false)) {
			skipped.add(relative || file.name);
			continue;
		}
		if (out.items.length >= LIMIT) {
			out.tooMany = true;
			break;
		}
		out.items.push(item(file, dir));
	}
	out.hidden = skipped.size;
	return out;
}

/** All the entries of a directory: `readEntries` gives them in pieces and says it is done with an empty one. */
async function readAll(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
	const reader = dir.createReader();
	const all: FileSystemEntry[] = [];
	for (;;) {
		const { promise, resolve, reject } = Promise.withResolvers<FileSystemEntry[]>();
		reader.readEntries(resolve, reject);
		const batch = await promise;
		if (batch.length === 0) return all;
		all.push(...batch);
	}
}

function fileOf(entry: FileSystemFileEntry): Promise<File> {
	const { promise, resolve, reject } = Promise.withResolvers<File>();
	entry.file(resolve, reject);
	return promise;
}

/** The files of what a drop carried: loose files, and the files below each dropped folder. */
export async function gatherTaken(taken: Taken): Promise<Gathered> {
	const out: Gathered = { items: [], hidden: 0, tooMany: false };
	for (const file of taken.files) {
		if (isHiddenName(file.name, false)) out.hidden++;
		else if (out.items.length >= LIMIT) out.tooMany = true;
		else out.items.push(item(file, ""));
	}
	const walk = async (entry: FileSystemEntry, dir: string): Promise<void> => {
		if (out.tooMany) return;
		if (isHiddenName(entry.name, entry.isDirectory)) {
			out.hidden++;
			return;
		}
		if (entry.isFile) {
			if (out.items.length >= LIMIT) {
				out.tooMany = true;
				return;
			}
			try {
				out.items.push(item(await fileOf(entry as FileSystemFileEntry), dir));
			} catch {
				// A file that cannot be read (it went away, or it is not allowed): not sent, and nothing to say about it.
			}
			return;
		}
		if (!entry.isDirectory) return;
		const here = dir ? `${dir}/${entry.name}` : entry.name;
		for (const child of await readAll(entry as FileSystemDirectoryEntry)) await walk(child, here);
	};
	for (const entry of taken.entries) await walk(entry, "");
	return out;
}
