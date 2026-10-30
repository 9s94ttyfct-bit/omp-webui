import { readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { Run } from "./git.ts";

/**
 * A folder is only looked at (`git status`, `gh pr view`) when nothing in its own repository tells git to run a command.
 * The status line shows a conversation's folder whenever the conversation is shown, trusted or not, and git does what a
 * repository's own configuration says: `core.fsmonitor` is a program run on every status, a `filter.<name>.clean` is run
 * on the files an attribute names it for (`.git/info/attributes` names one without a commit), and so on. None of that
 * comes with a clone: it takes a folder prepared by someone else (an unpacked archive with its `.git`).
 *
 * What is the user's own is not asked about: their global and system configuration (Git LFS's filters live there).
 * A submodule's own git directory (`.git/modules/<name>`) is not vetted: the look does not enter submodules (`git status
 * --ignore-submodules=all`, see git.ts), so nothing of it is read.
 */

export type Vetting =
	| { ok: true }
	/** `slow`: git did not answer in time. `refused`: what keeps the folder from being looked at (absent: no repository). */
	| { ok: false; slow: boolean; refused?: string };

/** An attributes file larger than this is not read (and the folder not looked at). */
const MAX_ATTRIBUTES_BYTES = 1024 * 1024;

/** The scopes of `git config --list --show-scope` that a repository controls: its own file and its worktree's. */
const REPOSITORY_SCOPES: readonly string[] = ["local", "worktree"];

/** Keys that name a command (or a file of attributes the repository picks), whatever their value. */
const COMMAND_KEYS = [
	/^core\.(pager|editor|sshcommand|gitproxy|askpass|attributesfile)$/,
	/^sequence\.editor$/,
	/^filter\..+\.(clean|smudge|process)$/,
	/^diff\.external$/,
	/^diff\..+\.(command|textconv)$/,
	/^merge\..+\.driver$/,
	/^gpg\.(.+\.)?program$/,
];
/** Keys that are a switch or a command: `core.fsmonitor=true` is git's own daemon, `core.fsmonitor=./hook` a program. */
const COMMAND_UNLESS_SWITCH = [/^core\.fsmonitor$/, /^pager\..+$/];
const SWITCH = /^(true|false|yes|no|on|off|0|1)?$/i;

/**
 * The keys of `git config --list --show-scope -z` that name a command, among the entries a repository controls. Git has
 * done the reading: includes are followed, names are lower-cased as git does (not the subsection), and the entries come
 * as `scope NUL key LF value NUL` (a key written without `=` has no LF: it is a switch that is on).
 */
export function commandKeys(listing: string): string[] {
	const parts = listing.split("\0");
	const found: string[] = [];
	for (let i = 0; i + 1 < parts.length; i += 2) {
		if (!REPOSITORY_SCOPES.includes(parts[i] as string)) continue;
		const entry = parts[i + 1] as string;
		const lf = entry.indexOf("\n");
		const key = lf < 0 ? entry : entry.slice(0, lf);
		const value = lf < 0 ? null : entry.slice(lf + 1);
		const switchLike = value === null || SWITCH.test(value);
		if (COMMAND_KEYS.some((re) => re.test(key)) || (!switchLike && COMMAND_UNLESS_SWITCH.some((re) => re.test(key)))) {
			found.push(key);
		}
	}
	return found;
}

/** Lines of an attributes file that give a path a filter, a diff driver or a merge driver (`filter=lfs`; not `-diff`). */
export function commandAttributes(text: string): string[] {
	return text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line && !line.startsWith("#") && /(?:^|\s)(?:filter|diff|merge)=\S/.test(line));
}

/** The attributes file's text; empty when there is none, null when it cannot be read or is too large to. */
function readAttributes(file: string): string | null {
	try {
		if (statSync(file).size > MAX_ATTRIBUTES_BYTES) return null;
		return readFileSync(file, "utf8");
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		return code === "ENOENT" || code === "ENOTDIR" ? "" : null;
	}
}

/**
 * Whether the repository `dir` is in can be looked at. Asked of git itself where the repository is and what its own
 * configuration says (`git config --list` only reads: it runs nothing), so that what is vetted is what git would use.
 */
export async function vetRepository(
	run: Run,
	dir: string,
	timeoutMs: number,
	env: Record<string, string | undefined>,
): Promise<Vetting> {
	const where = await run(
		["git", "rev-parse", "--path-format=absolute", "--git-path", "info/attributes"],
		dir,
		timeoutMs,
		env,
	);
	if (where === null) return { ok: false, slow: true };
	const attributes = where.stdout.trim();
	// Not a repository, or one git will not open: there is nothing to look at.
	if (where.code !== 0 || !isAbsolute(attributes)) return { ok: false, slow: false };

	const listing = await run(["git", "config", "--list", "--show-scope", "-z"], dir, timeoutMs, env);
	if (listing === null) return { ok: false, slow: true };
	if (listing.code !== 0) return { ok: false, slow: false, refused: "its configuration cannot be read" };
	const keys = commandKeys(listing.stdout);
	if (keys.length > 0) return { ok: false, slow: false, refused: `its configuration sets ${keys.join(", ")}` };

	const text = readAttributes(attributes);
	if (text === null) return { ok: false, slow: false, refused: `${dirname(attributes)} cannot be read` };
	const lines = commandAttributes(text);
	if (lines.length > 0) return { ok: false, slow: false, refused: `${attributes} assigns ${lines[0]}` };
	return { ok: true };
}
