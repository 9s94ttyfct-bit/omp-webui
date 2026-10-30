import { readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * A folder conversations are read from, and how they are laid out in it.
 *
 * omp's own agent directory and a profile's keep them in buckets, one folder per project
 * (`<dir>/<bucket>/<name>.jsonl`). A `--session-dir` is flat: omp writes `<dir>/<name>.jsonl` into the folder it was
 * given. Either way the artifacts of a conversation (its subagents' and advisors' transcripts) are in the folder its
 * file name names (`X.jsonl` → `X/`), beside it, so in a flat folder that folder is *not* a bucket.
 */
export interface Folder {
	dir: string;
	/** `<dir>/<name>.jsonl`, not `<dir>/<bucket>/<name>.jsonl`. */
	flat: boolean;
}

/**
 * The conversation files of `folder`, and only those: a flat folder's own `*.jsonl`, or the `*.jsonl` of each bucket.
 * A folder that cannot be read throws: a listing that silently came out empty would read as every conversation gone.
 */
export function* conversationFiles(folder: Folder): Generator<string> {
	const entries = readdirSync(folder.dir, { withFileTypes: true });
	if (folder.flat) {
		for (const f of entries) if (f.isFile() && f.name.endsWith(".jsonl")) yield join(folder.dir, f.name);
		return;
	}
	for (const bucket of entries) {
		if (!bucket.isDirectory()) continue;
		const dir = join(folder.dir, bucket.name);
		for (const f of readdirSync(dir, { withFileTypes: true })) {
			if (f.isFile() && f.name.endsWith(".jsonl")) yield join(dir, f.name);
		}
	}
}

/**
 * Whether `folder` holds a conversation. One that cannot be read holds none: it is not a folder of conversations, and
 * keeping it for ever would leave a value the user cannot use in the list of the folders that are read.
 */
export function holdsConversation(folder: Folder): boolean {
	try {
		return !conversationFiles(folder).next().done;
	} catch {
		return false;
	}
}
