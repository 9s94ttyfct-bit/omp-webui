import type { FileDiff, FolderChanges } from "@shared/changes.ts";
import type { FolderFile, FolderFound, FolderListing } from "@shared/folder.ts";
import { ApiError } from "./api.ts";

/**
 * The Files tab's requests (`/api/folder/*`, see server/folder-routes.ts). A request names the conversation, never a
 * folder: the server knows where the conversation works, and everything is a path inside that folder.
 */

export interface FolderScope {
	/** The conversation's running process, when it has one. */
	live: string | null;
	/** Its session file. */
	file: string | null;
}

const enc = encodeURIComponent;

function query(scope: FolderScope, extra: Record<string, string> = {}): string {
	const parts: string[] = [];
	if (scope.live) parts.push(`live=${enc(scope.live)}`);
	if (scope.file) parts.push(`file=${enc(scope.file)}`);
	for (const [k, v] of Object.entries(extra)) parts.push(`${k}=${enc(v)}`);
	return parts.join("&");
}

async function read<T>(res: Response): Promise<T> {
	if (!res.ok) {
		const body = await res.json().catch(() => ({ error: res.statusText }));
		throw new ApiError(body.error ?? res.statusText, res.status, body.code, body.params);
	}
	return res.json();
}

export const folder = {
	/**
	 * A folder's entries. `fresh` looks at git again instead of using what was read a moment ago, which is a POST (see
	 * `/api/git`): the tree asks it once something has changed.
	 */
	list: (scope: FolderScope, path: string, all: boolean, fresh: boolean, signal?: AbortSignal) =>
		fetch(
			`/api/folder/list?${query(scope, { path, ...(all ? { all: "1" } : {}), ...(fresh ? { fresh: "1" } : {}) })}`,
			{
				signal,
				...(fresh ? { method: "POST", headers: { "x-omp-webui": "1" } } : {}),
			},
		).then((res) => read<FolderListing>(res)),
	/** `fresh`: walk the folder again (something changed): a POST, like `list`'s. */
	find: (scope: FolderScope, q: string, all: boolean, fresh: boolean, signal?: AbortSignal) =>
		fetch(`/api/folder/find?${query(scope, { q, ...(all ? { all: "1" } : {}), ...(fresh ? { fresh: "1" } : {}) })}`, {
			signal,
			...(fresh ? { method: "POST", headers: { "x-omp-webui": "1" } } : {}),
		}).then((res) => read<FolderFound>(res)),
	file: (scope: FolderScope, path: string, signal?: AbortSignal) =>
		fetch(`/api/folder/file?${query(scope, { path })}`, { signal }).then((res) => read<FolderFile>(res)),
	/** How the folder differs from its repository's last commit (the Changes view); `fresh` looks again (a POST, as the other fresh looks are). */
	changes: (scope: FolderScope, fresh: boolean, signal?: AbortSignal) =>
		fetch(`/api/folder/changes?${query(scope, fresh ? { fresh: "1" } : {})}`, {
			signal,
			...(fresh ? { method: "POST", headers: { "x-omp-webui": "1" } } : {}),
		}).then((res) => read<FolderChanges>(res)),
	/** The change of one file the list names. */
	diff: (scope: FolderScope, path: string, signal?: AbortSignal) =>
		fetch(`/api/folder/diff?${query(scope, { path })}`, { signal }).then((res) => read<FileDiff>(res)),
	/** Where an image's bytes are; `modified` is in the address so that a changed image is not the one the browser kept. */
	imageUrl: (scope: FolderScope, path: string, modified: number) =>
		`/api/folder/raw?${query(scope, { path, v: String(modified) })}`,
	/** Where a PDF's or a Word document's bytes are (`kind: "document"`); `modified` is in the address as for a picture's. */
	documentUrl: (scope: FolderScope, path: string, modified: number) =>
		`/api/folder/doc?${query(scope, { path, v: String(modified) })}`,
	/** Hand the file to macOS (a page on this computer only): `reveal` shows it in Finder instead of opening it. */
	open: (scope: FolderScope, path: string, reveal: boolean) =>
		fetch("/api/folder/open", {
			method: "POST",
			headers: { "content-type": "application/json", "x-omp-webui": "1" },
			body: JSON.stringify({ live: scope.live, file: scope.file, path, reveal }),
		}).then((res) => read<{ ok: true }>(res)),
	/**
	 * Open a folder in Finder (a page on this computer only): `path` is relative to the conversation's folder, and empty is
	 * that folder itself.
	 */
	openDir: (scope: FolderScope, path: string) =>
		fetch("/api/folder/open", {
			method: "POST",
			headers: { "content-type": "application/json", "x-omp-webui": "1" },
			body: JSON.stringify({ live: scope.live, file: scope.file, path, dir: true }),
		}).then((res) => read<{ ok: true }>(res)),
};
