/** Where files came from: dropped on the composer, pasted into it, or chosen with its Attach button. */
export type DropSource = "drop" | "paste" | "pick";

/**
 * Files the composer was given, before anything is decided about them (see `components/DropChoice.tsx`). This module is
 * part of the first page load, so it is small: what needs more (asking the app's window where a drop was from, reading the
 * files) is done by the chunk that handles the request (`lib/drop-flow.ts`).
 */
export interface DropRequest {
	/** Names this request: a newer one replaces an older one that is still open. */
	id: number;
	files: File[];
	/** For each file: the browser says it is a folder (it has no content to read). */
	directories: boolean[];
	source: DropSource;
}

let counter = 0;

/**
 * The files a drop or a paste carries, or null when it carries none. The data of an event can only be read while the event
 * is handled, so the files and which of them are folders are taken at once.
 */
export function takeDrop(data: DataTransfer | null, source: DropSource): DropRequest | null {
	const files = data ? [...data.files] : [];
	if (!files.length || !data) return null;
	const items = [...data.items].filter((item) => item.kind === "file");
	return {
		id: ++counter,
		files,
		directories: files.map((_, i) => items[i]?.webkitGetAsEntry?.()?.isDirectory === true),
		source,
	};
}

/** Files chosen with the Attach button: no event data to read, and no folders. */
export function pickedFiles(files: Iterable<File>): DropRequest | null {
	const list = [...files];
	return list.length ? { id: ++counter, files: list, directories: list.map(() => false), source: "pick" } : null;
}
