/**
 * What a drop carries, taken at once. The data of a drag event is cleared when its handler returns, so the entries (and the
 * files, for a browser that has no entries) are taken inside the handler; reading what is in a dropped folder comes after,
 * with the entries in hand (`lib/transfer-items.ts`). This module is small on purpose: the Files tab imports it for the
 * drop, and the rest of the transfer code is loaded when it is first used.
 */
export interface Taken {
	entries: FileSystemEntry[];
	/** Files of items that gave no entry (and every file, when the browser gave no items). */
	files: File[];
}

/** A drag that carries files (text dragged from a page does not: it is not for the upload). */
export function carriesFiles(data: DataTransfer | null): boolean {
	return data?.types.includes("Files") ?? false;
}

export function takeTransfer(data: DataTransfer): Taken {
	const entries: FileSystemEntry[] = [];
	const files: File[] = [];
	if (data.items?.length) {
		for (const item of Array.from(data.items)) {
			if (item.kind !== "file") continue;
			const entry = item.webkitGetAsEntry?.() ?? null;
			if (entry) entries.push(entry);
			else {
				const file = item.getAsFile();
				if (file) files.push(file);
			}
		}
	} else files.push(...Array.from(data.files));
	return { entries, files };
}
