import { realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ChangedFile, FileDiff, FolderChanges } from "../shared/changes.ts";
import type { GitReport, GitStatus, PullRequest, WorktreeList } from "../shared/git.ts";
import { childEnv } from "./env.ts";
import {
	type ChangesLoad,
	changesEnv,
	EMPTY_TREE,
	listChanges,
	locateRepository,
	readFileDiff,
} from "./git-changes.ts";
import { type GitMarks, parseMarks } from "./git-marks.ts";
import { vetRepository } from "./git-vet.ts";
import { listWorktrees } from "./git-worktrees.ts";
import { run } from "./omp/run.ts";

/**
 * The branch, the number of changed files and the pull request of the folder a conversation works in, for the
 * status line (the TUI's own shows them). Both questions are asked of the same tools the TUI uses: `git status
 * --porcelain=v2 --branch`, and the GitHub CLI's `gh pr view`, which is optional. Neither may hold the page up or
 * break it: each runs with a time limit, a missing or failing tool is an absent answer, and answers are kept for a
 * moment, so a conversation, a second tab and a burst of tool calls ask git once.
 */

/** A folder with millions of entries is not a project: `git status` there is cut off, and the line goes without it. */
const STATUS_TIMEOUT_MS = 3000;
/** `gh` talks to GitHub. */
const PR_TIMEOUT_MS = 6000;
const STATUS_TTL_MS = 1000;
const PR_FOUND_TTL_MS = 60_000;
/** A branch without a pull request gets one once its owner creates it, so look again sooner. */
const PR_NONE_TTL_MS = 20_000;
const CACHED = 100;
/** A diff of one file may take longer than the status line's look: it is asked for by a click. */
const DIFF_TIMEOUT_MS = 6000;
/** A `fresh` ask joins a load that began this recently: the page asks on focus, on turn end and while streaming. */
const FRESH_JOIN_MS = 500;
/** The Worktrees tab looks at every worktree: what it was told is kept a little longer than one status look. */
const WORKTREES_TTL_MS = 5000;
/** A tool that did not answer in time is left alone this long, whatever the page asks. */
const SLOW_BACKOFF_MS = 30_000;
/** The most text of `git status --ignored` the Files tab reads: a tree with more to say goes without marks. */
const MAX_MARKS_TEXT = 4 * 1024 * 1024;

/**
 * `git status --porcelain=v2 --branch` read as a status: the branch (`# branch.head`, or the short commit of a
 * detached HEAD), and one count per kind of change. A file changed in both the index and the working tree counts in
 * both, as a prompt's `+1 ~1` does. Null for text that has no branch header: it is not git's answer.
 */
export function parseStatus(text: string): GitStatus | null {
	let head: string | null = null;
	let oid = "";
	let staged = 0;
	let unstaged = 0;
	let untracked = 0;
	for (const line of text.split("\n")) {
		if (line.startsWith("# branch.head ")) head = line.slice("# branch.head ".length).trim();
		else if (line.startsWith("# branch.oid ")) oid = line.slice("# branch.oid ".length).trim();
		else if (line.startsWith("1 ") || line.startsWith("2 ")) {
			// `1 <XY> …` and `2 <XY> …` (a rename or copy): X is the index's side, Y the working tree's; `.` is no change.
			if (line[2] !== ".") staged++;
			if (line[3] !== ".") unstaged++;
		} else if (line.startsWith("u ")) unstaged++;
		else if (line.startsWith("? ")) untracked++;
	}
	if (head === null) return null;
	const detached = head === "(detached)";
	const branch = detached ? oid.slice(0, 7) : head;
	if (!branch) return null;
	return { branch, detached, staged, unstaged, untracked };
}

/** The `gh pr view --json number,url` answer: null for anything but a pull request with a web address. */
export function parsePullRequest(text: string): PullRequest | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (!raw || typeof raw !== "object") return null;
	const { number, url } = raw as { number?: unknown; url?: unknown };
	if (typeof number !== "number" || !Number.isInteger(number) || number < 1) return null;
	// The page links to it: only a web address may be.
	if (typeof url !== "string" || !/^https?:\/\//i.test(url)) return null;
	return { number, url };
}

/**
 * The folder as the other endpoints take one (`/api/files`): it exists and is a directory, symlinks resolved. A
 * conversation's folder is always absolute: a relative or empty one would be the server's own.
 */
export function directoryOf(cwd: string): string {
	try {
		if (isAbsolute(cwd)) {
			const dir = realpathSync(cwd);
			if (statSync(dir).isDirectory()) return dir;
		}
	} catch {
		// Fall through to the one message for every way it can fail.
	}
	throw new Error("Not a directory");
}

export interface Ran {
	code: number;
	stdout: string;
	/** The command printed more than it was allowed to (see `RunOpts.maxBytes`): it was ended, and `stdout` is what it had printed. */
	truncated?: true;
}

export interface RunOpts {
	/** The most the command may print to stdout. */
	maxBytes?: number;
}

/** Run a command with a time limit, in a folder; null when it cannot start or does not finish in time. */
export type Run = (
	cmd: string[],
	cwd: string,
	timeoutMs: number,
	env: Record<string, string | undefined>,
	opts?: RunOpts,
) => Promise<Ran | null>;

const spawnRun: Run = async (cmd, cwd, timeoutMs, env, opts) => {
	try {
		const { code, stdout, truncated } = await run(cmd, { cwd, base: env, timeoutMs, maxBytes: opts?.maxBytes });
		return truncated ? { code, stdout, truncated } : { code, stdout };
	} catch {
		// The tool is not installed, or it did not finish in time and has been killed with what it started.
		return null;
	}
};

export interface GitOptions {
	run?: Run;
	/** The environment the tools run in (`PATH` decides which `git` and `gh` they are). */
	env?: Record<string, string | undefined>;
	now?: () => number;
	/** How long `git status` and `gh pr view` may take, in ms. */
	timeouts?: { status?: number; pr?: number };
}

interface Entry<T> {
	promise: Promise<T>;
	/** When the load began. */
	startedAt: number;
	/** When the answer came; null while it is awaited. */
	settledAt: number | null;
	ttl: number;
	/** The tool did not start or finish in time: asking again at once would only do that again. */
	slow: boolean;
}

/** An answer, and whether the tool failed to give one in time (`null` from the runner). */
interface Loaded<T> {
	value: T;
	slow: boolean;
}

export class GitProbe {
	readonly #run: Run;
	readonly #env: Record<string, string | undefined>;
	readonly #now: () => number;
	readonly #timeouts: { status: number; pr: number };
	readonly #statuses = new Map<string, Entry<GitStatus | null>>();
	readonly #pulls = new Map<string, Entry<PullRequest | null>>();
	readonly #markSets = new Map<string, Entry<GitMarks | null>>();
	readonly #changeSets = new Map<string, Entry<ChangesLoad>>();
	readonly #worktreeSets = new Map<string, Entry<WorktreeList>>();
	/** Folders that were not looked at, and have been said so in the log. */
	readonly #warned = new Set<string>();

	constructor(opts: GitOptions = {}) {
		this.#run = opts.run ?? spawnRun;
		this.#now = opts.now ?? Date.now;
		this.#timeouts = { status: opts.timeouts?.status ?? STATUS_TIMEOUT_MS, pr: opts.timeouts?.pr ?? PR_TIMEOUT_MS };
		this.#env = {
			...(opts.env ?? childEnv()),
			// A tool that asks a question would wait for an answer nobody gives.
			GIT_TERMINAL_PROMPT: "0",
			GH_PROMPT_DISABLED: "1",
			GH_NO_UPDATE_NOTIFIER: "1",
			NO_COLOR: "1",
		};
	}

	/**
	 * The folder's report. `pr` asks for the pull request too, which takes a network round trip: the page asks for
	 * the branch alone first. `fresh` skips the answers kept from a moment ago (a turn just ended).
	 */
	async report(cwd: string, opts: { pr?: boolean; fresh?: boolean } = {}): Promise<GitReport> {
		const dir = directoryOf(cwd);
		const fresh = opts.fresh === true;
		const git = await this.#cached(
			this.#statuses,
			dir,
			fresh,
			() => this.#status(dir),
			() => STATUS_TTL_MS,
		);
		if (!opts.pr) return { git };
		// A detached HEAD has no branch to have a pull request.
		if (!git || git.detached) return { git, pr: null };
		const pr = await this.#cached(
			this.#pulls,
			`${dir}\0${git.branch}`,
			fresh,
			() => this.#pull(dir),
			(found) => (found ? PR_FOUND_TTL_MS : PR_NONE_TTL_MS),
		);
		return { git, pr };
	}

	/**
	 * Which files of the folder differ from the last commit and which `.gitignore` names, for the Files tab: null where the
	 * folder is not in a repository or was not looked at (see `vetRepository`). One more `git status`, run only when that
	 * tab asks, with the same time limit, vetting and refusal to run anything the repository names as `report`'s; the
	 * answers are kept for a moment and `fresh` skips them.
	 */
	marks(cwd: string, opts: { fresh?: boolean } = {}): Promise<GitMarks | null> {
		const dir = directoryOf(cwd);
		return this.#cached(
			this.#markSets,
			dir,
			opts.fresh === true,
			() => this.#marks(dir),
			() => STATUS_TTL_MS,
		);
	}

	/**
	 * The repository's worktrees, for the Worktrees tab (#698): read only, and run as the other looks are (see
	 * `git-worktrees.ts`). Kept for a few seconds; `fresh` skips what is kept.
	 */
	worktrees(cwd: string, opts: { fresh?: boolean } = {}): Promise<WorktreeList> {
		const dir = directoryOf(cwd);
		return this.#cached(
			this.#worktreeSets,
			dir,
			opts.fresh === true,
			() => listWorktrees(this.#run, dir, this.#timeouts.status, this.#env),
			() => WORKTREES_TTL_MS,
		);
	}

	/**
	 * How the folder differs from the repository's last commit, for the Changes view of the Files tab: the files changed
	 * (the index and the working tree together) and the new ones, as `FolderChanges` says. Read only, and run as the other
	 * looks are (vetted, no fsmonitor, no hooks, no attributes of the folder, no submodule entered, no lock taken); the
	 * repository must also have its work tree at the folder or above it (see `locateRepository`), and git is told which
	 * directories those are rather than finding them. `state` says why a folder has no list.
	 */
	async changes(cwd: string, opts: { fresh?: boolean } = {}): Promise<FolderChanges> {
		const dir = directoryOf(cwd);
		return (await this.#changesOf(dir, opts.fresh === true)).changes;
	}

	/**
	 * The text change of one of the files `changes` lists (by its path in the folder): null when the folder is not looked
	 * at, the file is not among the changes git reports now, or git did not answer in time. A new file has no change in
	 * git (it is not in the index): the caller reads it, and shows it as all added.
	 */
	async diff(cwd: string, path: string): Promise<FileDiff | null> {
		const dir = directoryOf(cwd);
		const load = await this.#changesOf(dir, false);
		const file: ChangedFile | undefined = load.changes.files.find((f) => f.path === path);
		if (!load.repo || !file || file.state === "untracked") return null;
		return readFileDiff(this.#run, load.repo, load.base, file, DIFF_TIMEOUT_MS, changesEnv(this.#env));
	}

	#changesOf(dir: string, fresh: boolean): Promise<ChangesLoad> {
		return this.#cached(
			this.#changeSets,
			dir,
			fresh,
			() => this.#changes(dir),
			() => STATUS_TTL_MS,
		);
	}

	async #changes(dir: string): Promise<Loaded<ChangesLoad>> {
		const env = changesEnv(this.#env);
		const gone = (state: "none" | "unsafe" | "slow" | "unreadable"): ChangesLoad => ({
			changes: { root: dir, state, branch: "", files: [], truncated: false, omitted: 0 },
			repo: null,
			base: EMPTY_TREE,
		});
		const vetting = await vetRepository(this.#run, dir, this.#timeouts.status, env);
		if (!vetting.ok) {
			if (vetting.refused) this.#warnOnce(dir, vetting.refused);
			const state = vetting.slow ? "slow" : vetting.refused ? "unsafe" : "none";
			return { value: gone(state), slow: vetting.slow };
		}
		const where = await locateRepository(this.#run, dir, this.#timeouts.status, env);
		if (where.kind === "slow") return { value: gone("slow"), slow: true };
		if (where.kind === "none") return { value: gone("none"), slow: false };
		if (where.kind === "refused") {
			this.#warnOnce(dir, where.why);
			return { value: gone("unsafe"), slow: false };
		}
		const read = await listChanges(this.#run, where.repo, this.#timeouts.status, env);
		if (read === "slow") return { value: gone("slow"), slow: true };
		if (read === "failed") return { value: gone("unreadable"), slow: false };
		return {
			value: {
				changes: {
					root: dir,
					state: "ok",
					branch: read.branch,
					files: read.files,
					truncated: read.truncated,
					omitted: 0,
				},
				repo: where.repo,
				base: read.base,
			},
			slow: false,
		};
	}

	async #marks(dir: string): Promise<Loaded<GitMarks | null>> {
		const vetting = await vetRepository(this.#run, dir, this.#timeouts.status, this.#env);
		if (!vetting.ok) {
			if (vetting.refused) this.#warnOnce(dir, vetting.refused);
			return { value: null, slow: vetting.slow };
		}
		// The look of `#status` (nothing the repository names is run, no submodule is entered, no index lock is taken),
		// with the ignored files and folders (a whole ignored folder is one entry) and the paths as git writes them: NUL
		// separated, unquoted.
		const [prefix, status] = await Promise.all([
			this.#run(["git", "rev-parse", "--show-prefix"], dir, this.#timeouts.status, this.#env),
			this.#run(
				[
					"git",
					"-c",
					"core.fsmonitor=false",
					"-c",
					"core.hooksPath=/dev/null",
					`--attr-source=${EMPTY_TREE}`,
					"--no-optional-locks",
					"status",
					"--porcelain=v2",
					"-z",
					"--ignored=traditional",
					"--ignore-submodules=all",
				],
				dir,
				this.#timeouts.status,
				this.#env,
			),
		]);
		if (prefix === null || status === null) return { value: null, slow: true };
		// A tree with this much to say is not a project: it goes without marks, as a status that took too long does.
		if (prefix.code !== 0 || status.code !== 0 || status.stdout.length > MAX_MARKS_TEXT)
			return { value: null, slow: false };
		return { value: parseMarks(status.stdout, prefix.stdout.replace(/\n$/, "")), slow: false };
	}

	async #status(dir: string): Promise<Loaded<GitStatus | null>> {
		const vetting = await vetRepository(this.#run, dir, this.#timeouts.status, this.#env);
		if (!vetting.ok) {
			if (vetting.refused) this.#warnOnce(dir, vetting.refused);
			return { value: null, slow: vetting.slow };
		}
		// Whatever the repository's own settings say, the look runs no program: no fsmonitor, no hooks, no `.gitattributes`
		// of the folder (`--attr-source` needs git 2.40; an older git gives no status, and so no chips), and no submodule
		// entered: `git status` runs a `git status` of its own in each, with the configuration and `info/attributes` of the
		// submodule's git directory, which are not what was vetted (a changed file there runs its clean filter).
		// `--no-optional-locks`: this is a look, and it must not take the index lock from the agent's own git commands.
		const ran = await this.#run(
			[
				"git",
				"-c",
				"core.fsmonitor=false",
				"-c",
				"core.hooksPath=/dev/null",
				`--attr-source=${EMPTY_TREE}`,
				"--no-optional-locks",
				"status",
				"--porcelain=v2",
				"--branch",
				"--ignore-submodules=all",
			],
			dir,
			this.#timeouts.status,
			this.#env,
		);
		return { value: ran && ran.code === 0 ? parseStatus(ran.stdout) : null, slow: ran === null };
	}

	/** A folder that is not looked at says why once, not at every look: the status line asks every few seconds. */
	#warnOnce(dir: string, why: string): void {
		if (this.#warned.has(dir)) return;
		if (this.#warned.size >= CACHED) this.#warned.clear();
		this.#warned.add(dir);
		console.warn(`omp-webui: git is not run in ${dir}: ${why}`);
	}

	async #pull(dir: string): Promise<Loaded<PullRequest | null>> {
		const ran = await this.#run(["gh", "pr", "view", "--json", "number,url"], dir, this.#timeouts.pr, this.#env);
		return { value: ran && ran.code === 0 ? parsePullRequest(ran.stdout) : null, slow: ran === null };
	}

	/**
	 * Whether an answer already asked for can serve this ask: one awaited, or kept for its time to live, is shared.
	 * `fresh` wants the tree as it is now, but a load that began within `FRESH_JOIN_MS` says as much, and one that
	 * did not finish in time is not asked again before its backoff is over, `fresh` or not.
	 */
	#reuses<T>(hit: Entry<T>, fresh: boolean): boolean {
		const now = this.#now();
		if (hit.settledAt === null) return !fresh || now - hit.startedAt < FRESH_JOIN_MS;
		if (hit.slow) return now - hit.settledAt < hit.ttl;
		return fresh ? now - hit.startedAt < FRESH_JOIN_MS : now - hit.settledAt < hit.ttl;
	}

	#cached<T>(
		cache: Map<string, Entry<T>>,
		key: string,
		fresh: boolean,
		load: () => Promise<Loaded<T>>,
		ttlOf: (value: T) => number,
	): Promise<T> {
		const hit = cache.get(key);
		if (hit && this.#reuses(hit, fresh)) return hit.promise;
		const entry: Entry<T> = {
			promise: Promise.resolve(null as T),
			startedAt: this.#now(),
			settledAt: null,
			ttl: 0,
			slow: false,
		};
		entry.promise = load().then(
			(answer) => {
				entry.settledAt = this.#now();
				entry.slow = answer.slow;
				entry.ttl = answer.slow ? SLOW_BACKOFF_MS : ttlOf(answer.value);
				return answer.value;
			},
			(error) => {
				// A failure is not kept: the next ask tries again.
				if (cache.get(key) === entry) cache.delete(key);
				throw error;
			},
		);
		cache.delete(key);
		cache.set(key, entry);
		// The oldest answers go first; folders that are no longer asked about must not pile up.
		for (const old of cache.keys()) {
			if (cache.size <= CACHED) break;
			cache.delete(old);
		}
		return entry.promise;
	}
}
