import type { GitMark } from "../shared/folder.ts";

/**
 * What the Files tab knows of a repository's working tree: which files differ from the last commit, which folders are
 * untracked as a whole, and what `.gitignore` names. Read from one `git status --porcelain=v2 -z --ignored=traditional`
 * (see `GitProbe.marks`); paths are relative to the folder the conversation works in, written with `/`.
 */
export interface GitMarks {
	files: Map<string, GitMark>;
	/** Folders git reports as one untracked entry (`dir/`): everything in them is untracked. */
	untrackedDirs: Set<string>;
	/** Folders (the conversation's own is "") with a changed or untracked file somewhere below. */
	changedDirs: Set<string>;
	/** Ignored files, and ignored folders with a trailing `/` (git reports an ignored folder as one entry). */
	ignored: Set<string>;
}

/** What each ` ` separated field before the path of a status record is, by the record's type. */
const FIELDS_BEFORE_PATH: Record<string, number> = { "1": 8, "2": 9, u: 10 };

/** The text after the `n`th space of `record` (paths may hold spaces, so a path is the rest of the record). */
function afterFields(record: string, n: number): string | null {
	let at = -1;
	for (let i = 0; i < n; i++) {
		at = record.indexOf(" ", at + 1);
		if (at < 0) return null;
	}
	return record.slice(at + 1);
}

/** `X` is the index's side of a record's `XY`, `Y` the working tree's; `.` is no change. */
function markOfRecord(type: string, xy: string): GitMark {
	if (type === "u") return "conflict";
	// A file new to the index is added, whatever happened to it since; a renamed one is a new path too.
	if (xy[0] === "A" || xy[0] === "R" || xy[0] === "C") return "added";
	return "modified";
}

/**
 * `git status --porcelain=v2 -z --ignored=traditional` read as marks, for the folder `prefix` below the repository's
 * root (`git rev-parse --show-prefix`: empty at the root, else `sub/dir/`). What is outside the folder is left out.
 */
export function parseMarks(text: string, prefix: string): GitMarks {
	const marks: GitMarks = { files: new Map(), untrackedDirs: new Set(), changedDirs: new Set(), ignored: new Set() };
	const records = text.split("\0");
	const within = (path: string): string | null => (path.startsWith(prefix) ? path.slice(prefix.length) : null);
	const changed = (path: string) => {
		marks.changedDirs.add("");
		for (let slash = path.indexOf("/"); slash >= 0; slash = path.indexOf("/", slash + 1))
			marks.changedDirs.add(path.slice(0, slash));
	};
	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		if (!record) continue;
		const type = record[0];
		if (type === "?" || type === "!") {
			const rel = within(record.slice(2));
			// The folder the conversation works in is itself untracked or ignored: not a mark of anything in it.
			if (rel === null || rel === "") continue;
			if (type === "!") marks.ignored.add(rel);
			else if (rel.endsWith("/")) {
				marks.untrackedDirs.add(rel.slice(0, -1));
				changed(rel.slice(0, -1));
			} else {
				marks.files.set(rel, "untracked");
				changed(rel);
			}
			continue;
		}
		const before = FIELDS_BEFORE_PATH[type];
		if (before === undefined) continue;
		// A rename or copy is followed by a record of its own: the path it came from.
		if (type === "2") i++;
		const path = afterFields(record, before);
		const rel = path === null ? null : within(path);
		if (rel === null || rel === "") continue;
		marks.files.set(rel, markOfRecord(type, record.slice(2, 4)));
		changed(rel);
	}
	return marks;
}

/** Each folder `path` is in, outermost first (`a/b/c` is in `a` and `a/b`). */
function* ancestors(path: string): Generator<string> {
	for (let slash = path.indexOf("/"); slash >= 0; slash = path.indexOf("/", slash + 1)) yield path.slice(0, slash);
}

/** How `path` differs from the last commit: a file's mark, a folder's `changed`; undefined when it does not. */
export function markOf(marks: GitMarks, path: string, isDir: boolean): GitMark | "changed" | undefined {
	for (const dir of ancestors(path)) if (marks.untrackedDirs.has(dir)) return "untracked";
	if (isDir) {
		if (marks.untrackedDirs.has(path)) return "untracked";
		return marks.changedDirs.has(path) ? "changed" : undefined;
	}
	return marks.files.get(path);
}

/** Whether `.gitignore` names `path`, or a folder it is in. */
export function isIgnored(marks: GitMarks, path: string, isDir: boolean): boolean {
	if (marks.ignored.has(isDir ? `${path}/` : path)) return true;
	for (const dir of ancestors(path)) if (marks.ignored.has(`${dir}/`)) return true;
	return false;
}
