import type { FileDiff, FolderChanges } from "../shared/changes.ts";
import type { GitReport, WorktreeList } from "../shared/git.ts";
import type { directoryOf, GitProbe } from "./git.ts";
import type { GitMarks } from "./git-marks.ts";

/**
 * What the status line asks of git (`git.ts`: the branch, the changes and the pull request of a conversation's folder) and
 * the Files tab asks for its marks, loaded by the first of them (#585). A server that has not been asked holds none of
 * it: `git.ts`, the check that a repository's own configuration cannot run anything (`git-vet.ts`) and the parser of
 * `git status` (`git-marks.ts`) are loaded then, and the probe and its caches are made then.
 */
interface Loaded {
	probe: GitProbe;
	directoryOf: typeof directoryOf;
}

export class LazyGit {
	#loading: Promise<Loaded> | null = null;

	/** The code is loaded once, by whichever use comes first; one that failed to load is tried again by the next. */
	#load(): Promise<Loaded> {
		this.#loading ??= import("./git.ts").then(
			(git) => ({ probe: new git.GitProbe(), directoryOf: git.directoryOf }),
			(error: unknown) => {
				this.#loading = null;
				throw error;
			},
		);
		return this.#loading;
	}

	/** The folder `cwd` names, as a real directory; throws what `directoryOf` throws. */
	async directoryOf(cwd: string): Promise<string> {
		return (await this.#load()).directoryOf(cwd);
	}

	async report(cwd: string, opts: { pr?: boolean; fresh?: boolean } = {}): Promise<GitReport> {
		return (await this.#load()).probe.report(cwd, opts);
	}

	async marks(cwd: string, opts: { fresh?: boolean } = {}): Promise<GitMarks | null> {
		return (await this.#load()).probe.marks(cwd, opts);
	}

	async changes(cwd: string, opts: { fresh?: boolean } = {}): Promise<FolderChanges> {
		return (await this.#load()).probe.changes(cwd, opts);
	}

	async worktrees(cwd: string, opts: { fresh?: boolean } = {}): Promise<WorktreeList> {
		return (await this.#load()).probe.worktrees(cwd, opts);
	}

	async diff(cwd: string, path: string): Promise<FileDiff | null> {
		return (await this.#load()).probe.diff(cwd, path);
	}
}
