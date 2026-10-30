/** `GET /api/dirs?path=<folder>`: the folders in one folder, for the folder picker. */
export interface DirListing {
	/** The folder listed, absolute and normalized (`~` expanded). */
	path: string;
	parent: string;
	/** Sub-folder names, sorted, without hidden ones (a leading dot); symlinks to folders are in. */
	dirs: string[];
	/** How many more folders there are than `dirs` holds (the list is cut at `DIR_LIST_MAX`); 0 when it is whole. */
	omitted: number;
}

/** The most sub-folders one answer lists: a folder of thousands must not become a response of that size. */
export const DIR_LIST_MAX = 500;
