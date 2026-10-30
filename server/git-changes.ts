import { realpathSync } from "node:fs";
import { isAbsolute, relative, sep } from "node:path";
import {
	CHANGES_LIMITS,
	type ChangedFile,
	type ChangeState,
	type DiffHunk,
	type DiffRow,
	type FileDiff,
	type FolderChanges,
} from "../shared/changes.ts";
import type { Run } from "./git.ts";

/**
 * What the Changes view of the Files tab asks of git (`git status`, `git diff`): which files of a folder differ from the
 * last commit, and how one of them does. Read only, and run so that nothing the repository holds can run a program or send
 * git elsewhere. `vetRepository` has refused the repository whose own configuration or attributes name a command (see
 * git-vet.ts); what is added here:
 *
 *  - git is told the directories (`--git-dir`, `--work-tree`) instead of finding them, so that a `core.worktree` in the
 *    repository's configuration cannot make it read another folder; `locateRepository` also refuses a repository whose work
 *    tree is not the folder or one of its parents;
 *  - no `fsmonitor`, no hooks, no `.gitattributes` of the folder, no external diff program and no `textconv`, no pager, no
 *    submodule entered, no lock taken, no fetch for a missing object, no environment of the user's own that picks a
 *    directory, a diff program or a pager (`changesEnv`);
 *  - the pathspecs are literal (a file called `*.ts` is only that), output is cut at a limit and the command is ended.
 */

/**
 * Git's empty tree, known to every repository without being stored in it: `--attr-source` with it reads no
 * `.gitattributes` of the folder, so a `filter=` in one cannot pick a filter of the user's own (Git LFS's, say) for the
 * files of a repository somebody else wrote; it is also what a repository without a commit is compared with. (A
 * repository's `.git/info/attributes` is still read: it is vetted instead.)
 */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

/** Where a repository is, as `locateRepository` found it. `prefix` is the folder below `toplevel` ("" for it), written with `/`. */
export interface Repo {
	toplevel: string;
	gitDir: string;
	prefix: string;
}

/** The answer kept for a folder: what the page is told, and what the diffs of its files need. */
export interface ChangesLoad {
	changes: FolderChanges;
	repo: Repo | null;
	/** The commit the changes are against (the empty tree where there is none yet). */
	base: string;
}

/** Variables of the environment that name a directory, a program or a pager to git: not the repository's, and not wanted. */
const DROPPED_ENV = [
	"GIT_DIR",
	"GIT_WORK_TREE",
	"GIT_INDEX_FILE",
	"GIT_OBJECT_DIRECTORY",
	"GIT_ALTERNATE_OBJECT_DIRECTORIES",
	"GIT_COMMON_DIR",
	"GIT_EXTERNAL_DIFF",
	"GIT_DIFF_OPTS",
	"GIT_PAGER",
	"GIT_PAGER_IN_USE",
	"PAGER",
	"GIT_ATTR_SOURCE",
	"GIT_NAMESPACE",
	"GIT_PREFIX",
];

/** The environment `base` becomes for these looks: see `DROPPED_ENV`; no prompts, no fetches, literal pathspecs. */
export function changesEnv(base: Record<string, string | undefined>): Record<string, string | undefined> {
	const env = { ...base };
	for (const key of DROPPED_ENV) delete env[key];
	return {
		...env,
		GIT_TERMINAL_PROMPT: "0",
		GIT_PAGER: "cat",
		GIT_LITERAL_PATHSPECS: "1",
		GIT_NO_LAZY_FETCH: "1",
		GIT_OPTIONAL_LOCKS: "0",
	};
}

/**
 * `git` with the arguments every look of this file starts with, for the repository `repo`. `core.bigFileThreshold` is the
 * largest file git diffs as text (a larger one is binary for it: a 2 GB log is not read for the sake of a diff).
 */
export function gitArgs(repo: Pick<Repo, "toplevel" | "gitDir">, ...rest: string[]): string[] {
	return [
		"git",
		"-c",
		"core.fsmonitor=false",
		"-c",
		"core.hooksPath=/dev/null",
		"-c",
		`core.bigFileThreshold=${CHANGES_LIMITS.fileBytes}`,
		`--git-dir=${repo.gitDir}`,
		`--work-tree=${repo.toplevel}`,
		`--attr-source=${EMPTY_TREE}`,
		"--no-optional-locks",
		"--no-pager",
		...rest,
	];
}

const real = (path: string): string => {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
};

export type Located =
	| { kind: "ok"; repo: Repo }
	| { kind: "none" }
	| { kind: "slow" }
	/** The repository exists but is not looked at, and why (for the log). */
	| { kind: "refused"; why: string };

/**
 * Where the repository `dir` is in has its work tree and its git directory. Asked of git, which reads the repository's own
 * configuration for it (`core.worktree` included): a work tree that is not `dir` or a folder above it is somewhere else
 * (another folder's files would be listed as changes of this one), and is refused. The caller passes these two paths to
 * every look that follows, so that what was checked here is what is read.
 */
export async function locateRepository(
	run: Run,
	dir: string,
	timeoutMs: number,
	env: Record<string, string | undefined>,
): Promise<Located> {
	const ran = await run(
		["git", "rev-parse", "--path-format=absolute", "--show-toplevel", "--git-dir"],
		dir,
		timeoutMs,
		env,
	);
	if (ran === null) return { kind: "slow" };
	const lines = ran.stdout.split("\n");
	// A bare repository, or a folder inside the git directory itself, has no work tree: nothing to list.
	if (ran.code !== 0 || !isAbsolute(lines[0] ?? "") || !isAbsolute(lines[1] ?? "")) return { kind: "none" };
	const toplevel = real(lines[0] as string);
	const gitDir = real(lines[1] as string);
	const here = real(dir);
	// Below the work tree, or it is the folder itself: the way from one to the other does not climb.
	const down = relative(toplevel, here);
	if (down === ".." || down.startsWith(`..${sep}`) || isAbsolute(down)) {
		return { kind: "refused", why: `its work tree (${toplevel}) is not this folder or one above it` };
	}
	const prefix = down.split(sep).join("/");
	return { kind: "ok", repo: { toplevel, gitDir, prefix } };
}

/** What `git status --porcelain=v2 -z --branch` said, as far as the changes need it. */
export interface StatusScan {
	oid: string | null;
	head: string | null;
	/** Paths with a change in the index. */
	staged: Set<string>;
	/** Paths with an unresolved merge conflict. */
	conflicts: Set<string>;
	untracked: string[];
}

/** The text of `record` after its `n`th space (a path may hold spaces: it is the rest of the record). */
function afterFields(record: string, n: number): string | null {
	let at = -1;
	for (let i = 0; i < n; i++) {
		at = record.indexOf(" ", at + 1);
		if (at < 0) return null;
	}
	return record.slice(at + 1);
}

/** The fields before the path of a record of each kind (`1`: changed, `2`: renamed or copied, `u`: unmerged). */
const FIELDS_BEFORE_PATH: Record<string, number> = { "1": 8, "2": 9, u: 10 };

export function scanStatus(text: string): StatusScan {
	const scan: StatusScan = { oid: null, head: null, staged: new Set(), conflicts: new Set(), untracked: [] };
	const records = text.split("\0");
	for (let i = 0; i < records.length; i++) {
		const record = records[i] as string;
		if (record.startsWith("# branch.oid ")) scan.oid = record.slice("# branch.oid ".length);
		else if (record.startsWith("# branch.head ")) scan.head = record.slice("# branch.head ".length);
		else if (record.startsWith("? ")) scan.untracked.push(record.slice(2));
		else {
			const before = FIELDS_BEFORE_PATH[record[0] ?? ""];
			if (before === undefined || record[1] !== " ") continue;
			// A rename or copy is followed by a record of its own: the path it came from.
			if (record[0] === "2") i++;
			const path = afterFields(record, before);
			if (!path) continue;
			if (record[0] === "u") scan.conflicts.add(path);
			else if (record[2] !== ".") scan.staged.add(path);
		}
	}
	return scan;
}

/** One entry of `git diff --raw -z`. */
export interface RawChange {
	/** The letter git gives the change (`M`, `A`, `D`, `R`, `C`, `T`, `U`). */
	letter: string;
	path: string;
	from?: string;
	oldMode: string;
	newMode: string;
}

/** `added` and `removed` of `--numstat`; null for a file git does not diff as text. */
export type Counts = { added: number | null; removed: number | null };

/**
 * `git diff --raw --numstat -z -M` read: the records of `--raw` (`:old new oldsha newsha STATUS NUL path NUL`, a rename with
 * both paths) and then those of `--numstat` (`added TAB removed TAB path NUL`, a rename `added TAB removed TAB NUL from NUL
 * to NUL`). A record cut short (the output was cut) is not read.
 */
export function scanDiffList(text: string): { raws: RawChange[]; counts: Map<string, Counts> } {
	const tokens = text.split("\0");
	const raws: RawChange[] = [];
	const counts = new Map<string, Counts>();
	let i = 0;
	while (i < tokens.length && (tokens[i] as string).startsWith(":")) {
		const fields = (tokens[i] as string).split(" ");
		const letter = (fields[4] ?? "").charAt(0);
		const paths = letter === "R" || letter === "C" ? 2 : 1;
		if (!letter || i + paths >= tokens.length) return { raws, counts };
		const first = tokens[i + 1] as string;
		const second = tokens[i + 2] as string;
		raws.push({
			letter,
			path: paths === 2 ? second : first,
			...(paths === 2 ? { from: first } : {}),
			oldMode: (fields[0] ?? "").slice(1),
			newMode: fields[1] ?? "",
		});
		i += 1 + paths;
	}
	const number = (s: string): number | null => (s === "-" ? null : Number(s));
	while (i < tokens.length) {
		const parts = (tokens[i] as string).split("\t");
		if (parts.length < 3) break;
		const entry: Counts = { added: number(parts[0] as string), removed: number(parts[1] as string) };
		const path = parts.slice(2).join("\t");
		if (path === "") {
			// A rename: its two paths follow.
			if (i + 2 >= tokens.length) break;
			counts.set(tokens[i + 2] as string, entry);
			i += 3;
		} else {
			counts.set(path, entry);
			i += 1;
		}
	}
	return { raws, counts };
}

const LETTER_STATE: Record<string, ChangeState> = {
	M: "modified",
	A: "added",
	C: "added",
	D: "deleted",
	R: "renamed",
	T: "typechange",
	U: "conflict",
};

const byPath = (a: { path: string }, b: { path: string }) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

/**
 * The files a status and a list of changes together make: the changed files by path, then the new ones by path, with
 * paths relative to the folder (`prefix` below the repository's top; what is outside the folder is left out).
 */
export function mergeChanges(
	scan: StatusScan,
	raws: readonly RawChange[],
	counts: ReadonlyMap<string, Counts>,
	prefix: string,
): ChangedFile[] {
	const lead = prefix ? `${prefix}/` : "";
	const within = (path: string): string | null => (path.startsWith(lead) ? path.slice(lead.length) : null);
	const tracked: ChangedFile[] = [];
	const seen = new Set<string>();
	for (const raw of raws) {
		const path = within(raw.path);
		if (path === null || path === "") continue;
		seen.add(raw.path);
		const count = counts.get(raw.path);
		const from = raw.from === undefined ? null : within(raw.from);
		const entry: ChangedFile = {
			path,
			state: scan.conflicts.has(raw.path) ? "conflict" : (LETTER_STATE[raw.letter] ?? "modified"),
			staged: scan.staged.has(raw.path),
		};
		if (from !== null) entry.from = from;
		if (count) {
			if (count.added === null || count.removed === null) entry.binary = true;
			else {
				entry.added = count.added;
				entry.removed = count.removed;
			}
		}
		if (raw.oldMode !== raw.newMode && raw.oldMode !== "000000" && raw.newMode !== "000000") {
			entry.mode = { from: raw.oldMode, to: raw.newMode };
		}
		tracked.push(entry);
	}
	// A conflict git's list of changes does not name (both sides deleted, say) is still one.
	for (const path of scan.conflicts) {
		const rel = within(path);
		if (rel !== null && rel !== "" && !seen.has(path)) tracked.push({ path: rel, state: "conflict", staged: false });
	}
	const fresh: ChangedFile[] = [];
	for (const path of scan.untracked) {
		const rel = within(path);
		if (rel !== null && rel !== "") fresh.push({ path: rel, state: "untracked", staged: false });
	}
	return [...tracked.sort(byPath), ...fresh.sort(byPath)];
}

/** What `listChanges` read. `slow`: git did not answer in time; `failed`: it answered with an error. */
export type ChangesRead =
	| { branch: string; base: string; files: ChangedFile[]; truncated: boolean }
	| "slow"
	| "failed";

const OID = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

/** What a command printed, less the record it was in the middle of when its output was cut (records end with a NUL). */
function wholeRecords(ran: { stdout: string; truncated?: true }): string {
	return ran.truncated === true ? ran.stdout.slice(0, ran.stdout.lastIndexOf("\0") + 1) : ran.stdout;
}

/**
 * The files of the folder that differ from the repository's last commit, in the index and the working tree together, and
 * the new ones. Two looks, one after the other: `git status` (which commit, which files are new, staged or in conflict),
 * then `git diff` against that commit (what happened to each, and by how many lines).
 */
export async function listChanges(
	run: Run,
	repo: Repo,
	timeoutMs: number,
	env: Record<string, string | undefined>,
): Promise<ChangesRead> {
	const status = await run(
		gitArgs(
			repo,
			"status",
			"--porcelain=v2",
			"-z",
			"--branch",
			"--untracked-files=all",
			"--ignore-submodules=all",
			...(repo.prefix ? ["--", repo.prefix] : []),
		),
		repo.toplevel,
		timeoutMs,
		env,
		{ maxBytes: CHANGES_LIMITS.listBytes },
	);
	if (status === null) return "slow";
	// An answer cut at the byte limit was killed, so it exits with an error all the same: the first of its files are the list.
	if (status.code !== 0 && status.truncated !== true) return "failed";
	const scan = scanStatus(wholeRecords(status));
	if (scan.head === null) return "failed";
	const base = scan.oid !== null && OID.test(scan.oid) ? scan.oid : EMPTY_TREE;
	const detached = scan.head === "(detached)";
	const branch = detached ? (scan.oid ?? "").slice(0, 7) : scan.head;
	const diff = await run(
		gitArgs(
			repo,
			"diff",
			base,
			"--raw",
			"--numstat",
			"-z",
			"-M",
			"--no-color",
			"--no-ext-diff",
			"--no-textconv",
			"--ignore-submodules=all",
			...(repo.prefix ? ["--", repo.prefix] : []),
		),
		repo.toplevel,
		timeoutMs,
		env,
		{ maxBytes: CHANGES_LIMITS.listBytes },
	);
	if (diff === null) return "slow";
	if (diff.code !== 0 && diff.truncated !== true) return "failed";
	const { raws, counts } = scanDiffList(wholeRecords(diff));
	const all = mergeChanges(scan, raws, counts, repo.prefix);
	const cut = all.length > CHANGES_LIMITS.files;
	return {
		branch,
		base,
		files: cut ? all.slice(0, CHANGES_LIMITS.files) : all,
		truncated: cut || status.truncated === true || diff.truncated === true,
	};
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/;

/** `text` cut to `CHANGES_LIMITS.rowChars` characters; `clipped` says it was. */
function clip(row: DiffRow): DiffRow {
	if (row.text.length <= CHANGES_LIMITS.rowChars) return row;
	return { ...row, text: row.text.slice(0, CHANGES_LIMITS.rowChars), clipped: true };
}

export interface ParsedDiff {
	hunks: DiffHunk[];
	added: number;
	removed: number;
	binary: boolean;
	truncated: boolean;
}

/**
 * The text of a `git diff` of one file read as hunks. The headers of the file are skipped (the page knows the file); a hunk
 * is read by the line counts its header gives, so that a line of the file that looks like a header is a line of the file.
 * `\ No newline at end of file` is a flag of the row before it. At most `CHANGES_LIMITS.rows` rows are kept.
 */
export function parseUnifiedDiff(text: string, cut = false): ParsedDiff {
	const lines = text.split("\n");
	const out: ParsedDiff = { hunks: [], added: 0, removed: 0, binary: false, truncated: cut };
	let kept = 0;
	let i = 0;
	while (i < lines.length) {
		const line = lines[i] as string;
		if (line.startsWith("Binary files ") || line.startsWith("GIT binary patch")) {
			out.binary = true;
			i++;
			continue;
		}
		const m = HUNK.exec(line);
		if (!m) {
			i++;
			continue;
		}
		const hunk: DiffHunk = {
			oldStart: Number(m[1]),
			oldLines: m[2] === undefined ? 1 : Number(m[2]),
			newStart: Number(m[3]),
			newLines: m[4] === undefined ? 1 : Number(m[4]),
			section: m[5] ?? "",
			rows: [],
		};
		i++;
		let oldLeft = hunk.oldLines;
		let newLeft = hunk.newLines;
		let oldNo = hunk.oldStart;
		let newNo = hunk.newStart;
		while (i < lines.length && (oldLeft > 0 || newLeft > 0 || (lines[i] as string).startsWith("\\"))) {
			const row = lines[i] as string;
			if (row.startsWith("\\")) {
				const last = hunk.rows.at(-1);
				if (last) last.noEol = true;
				i++;
				continue;
			}
			// `diff.suppressBlankEmpty` writes an empty context line as "".
			const sign = row === "" ? " " : row[0];
			if (sign !== " " && sign !== "+" && sign !== "-") break;
			if (kept >= CHANGES_LIMITS.rows) {
				out.truncated = true;
				if (hunk.rows.length) out.hunks.push(hunk);
				return out;
			}
			const body = row.endsWith("\r") ? row.slice(1, -1) : row.slice(1);
			if (sign === "+") {
				hunk.rows.push(clip({ kind: "add", new: newNo++, text: body }));
				out.added++;
				newLeft--;
			} else if (sign === "-") {
				hunk.rows.push(clip({ kind: "del", old: oldNo++, text: body }));
				out.removed++;
				oldLeft--;
			} else {
				hunk.rows.push(clip({ kind: "ctx", old: oldNo++, new: newNo++, text: body }));
				oldLeft--;
				newLeft--;
			}
			kept++;
			i++;
		}
		out.hunks.push(hunk);
	}
	return out;
}

/** The change of one file as the page shows it, from git's text (`diff`, and whether the output was cut). */
export function fileDiffOf(file: ChangedFile, text: string, cut: boolean): FileDiff {
	const parsed = parseUnifiedDiff(text, cut);
	const diff: FileDiff = {
		path: file.path,
		state: file.state,
		view: parsed.hunks.length ? "text" : parsed.binary || file.binary ? "binary" : "empty",
		hunks: parsed.hunks,
		added: file.added ?? parsed.added,
		removed: file.removed ?? parsed.removed,
		truncated: parsed.truncated,
	};
	if (file.from !== undefined) diff.from = file.from;
	if (file.mode) diff.mode = file.mode;
	return diff;
}

/**
 * The text change of a file the list names: what `git diff` against `base` says for it (and for the path it was renamed
 * from, so that git can pair them). Null when git did not answer in time.
 */
export async function readFileDiff(
	run: Run,
	repo: Repo,
	base: string,
	file: ChangedFile,
	timeoutMs: number,
	env: Record<string, string | undefined>,
): Promise<FileDiff | null> {
	const lead = repo.prefix ? `${repo.prefix}/` : "";
	const paths = [`${lead}${file.path}`, ...(file.from === undefined ? [] : [`${lead}${file.from}`])];
	const ran = await run(
		gitArgs(
			repo,
			"diff",
			base,
			"-M",
			`-U${CHANGES_LIMITS.context}`,
			"--no-color",
			"--no-ext-diff",
			"--no-textconv",
			"--ignore-submodules=all",
			"--",
			...paths,
		),
		repo.toplevel,
		timeoutMs,
		env,
		{ maxBytes: CHANGES_LIMITS.diffBytes },
	);
	if (ran === null) return null;
	// A diff cut at the byte limit was killed, so it exits with an error all the same: what it printed is what there is.
	if (ran.code !== 0 && ran.truncated !== true) return { ...fileDiffOf(file, "", false), view: "empty" };
	return fileDiffOf(file, ran.stdout, ran.truncated === true);
}

/**
 * A file git does not know yet, shown as all added: `text` is what was read of it (its first megabyte at most; `cut` says
 * the file is longer). A file that is not text, a link or anything but a regular file is `unreadable`/`binary`.
 */
export function newFileDiff(
	file: ChangedFile,
	read: { text: string; cut: boolean } | { binary: true } | { reason: "link" | "notFile" },
): FileDiff {
	const base: FileDiff = {
		path: file.path,
		state: "untracked",
		view: "text",
		hunks: [],
		added: 0,
		removed: 0,
		truncated: false,
	};
	if ("reason" in read) return { ...base, view: "unreadable", reason: read.reason };
	if ("binary" in read) return { ...base, view: "binary" };
	if (read.text === "") return { ...base, view: "empty" };
	const lines = read.text.split("\n");
	const endsWell = read.text.endsWith("\n");
	if (endsWell) lines.pop();
	const kept = lines.slice(0, CHANGES_LIMITS.rows);
	const rows: DiffRow[] = kept.map((text, i) =>
		clip({
			kind: "add",
			new: i + 1,
			text: text.endsWith("\r") ? text.slice(0, -1) : text,
			...(!endsWell && !read.cut && i === lines.length - 1 ? { noEol: true as const } : {}),
		}),
	);
	return {
		...base,
		hunks: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: rows.length, section: "", rows }],
		added: rows.length,
		truncated: read.cut || kept.length < lines.length,
	};
}
