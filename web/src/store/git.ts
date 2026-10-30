import type { GitReport, GitStatus, PullRequest } from "@shared/git.ts";
import { useEffect, useRef } from "react";
import { create } from "zustand";

/**
 * The branch, the changed files and the pull request of the folders conversations work in (`/api/git`), for the
 * status line. A folder the server cannot report on (no repository, no git, a folder that is gone) has none, and the
 * line goes without chips: nothing here may fail the page.
 */

interface Folder {
	git: GitStatus | null;
	/** Null where there is none, where `gh` is not there to say, or before it has been asked. */
	pr: PullRequest | null;
	/** The branch `pr` was asked for; null before it has been asked. */
	prBranch: string | null;
}

export const useGit = create<{ byCwd: Record<string, Folder> }>(() => ({ byCwd: {} }));

/** Asks in flight, so the status line and the menu share one. */
const asking = new Map<string, Promise<void>>();

/** Every ask is numbered in the order it was made; the newest answer applied for a folder is the one to beat. */
let issued = 0;
const applied = new Map<string, number>();

/**
 * Ask the server about a folder. `pr` also asks for the pull request, which takes a network round trip (the branch is
 * asked for alone first); `fresh` skips what the server kept from a moment ago. Both start work of their own, so they
 * are a POST; the branch-only look is a plain GET.
 *
 * An answer to an ask older than one already applied is dropped: a slow pull-request answer must not put back the
 * branch a newer look has since replaced. A branch whose pull request has not been asked for (the branch changed in
 * a terminal, and the branch-only look that noticed it carries none) is asked for it.
 */
export function refreshGit(cwd: string, opts: { pr?: boolean; fresh?: boolean } = {}): Promise<void> {
	const query = `cwd=${encodeURIComponent(cwd)}${opts.pr ? "&pr=1" : ""}${opts.fresh ? "&fresh=1" : ""}`;
	const running = asking.get(query);
	if (running) return running;
	const seq = ++issued;
	const p = fetch(
		`/api/git?${query}`,
		opts.pr || opts.fresh ? { method: "POST", headers: { "x-omp-webui": "1" } } : undefined,
	)
		.then(async (res): Promise<GitReport | null> => (res.ok ? res.json() : null))
		.catch(() => null)
		.then((report) => {
			const git = report?.git ?? null;
			const asked = report?.pr !== undefined;
			if (seq < (applied.get(cwd) ?? 0)) {
				// The look is older than the one on screen. Its pull request still counts where it is for the branch
				// on screen and none has been asked for yet: a newer branch-only look may have been the one that asked.
				const now = useGit.getState().byCwd[cwd];
				if (asked && git && now?.git?.branch === git.branch && now.prBranch !== git.branch) {
					useGit.setState((s) => ({
						byCwd: { ...s.byCwd, [cwd]: { ...now, pr: report?.pr ?? null, prBranch: git.branch } },
					}));
				}
				return;
			}
			applied.set(cwd, seq);
			// A refusal is as much an answer as a folder outside any repository.
			let missing = false;
			useGit.setState((s) => {
				const before = s.byCwd[cwd];
				// Another branch has another pull request: the old one goes at once, the new one comes with its own answer.
				const sameBranch = before?.git?.branch === git?.branch;
				const pr = report?.pr !== undefined ? report.pr : sameBranch ? (before?.pr ?? null) : null;
				const prBranch = asked ? (git?.branch ?? null) : sameBranch ? (before?.prBranch ?? null) : null;
				missing = git !== null && !git.detached && prBranch !== git.branch;
				return { byCwd: { ...s.byCwd, [cwd]: { git, pr: git ? pr : null, prBranch: git ? prBranch : null } } };
			});
			if (missing) void refreshGit(cwd, { pr: true });
		})
		.finally(() => asking.delete(query));
	asking.set(query, p);
	return p;
}

/** While a turn runs, the agent's changes are looked at this often at most. */
const WHILE_RUNNING_MS = 2500;

/**
 * Keep a folder's entry current: when the line opens or the folder changes (the branch, then the pull request),
 * when a turn ends (the agent may have changed files, switched branch or opened a pull request), every so often
 * while one runs, and when the window gets focus back (the user may have worked in a terminal).
 * `lastEntry` is the conversation's newest saved entry: a new one while streaming means tool calls happened.
 */
export function useGitSync(cwd: string | undefined, streaming: boolean, lastEntry: string | undefined): void {
	const wasStreaming = useRef(false);
	useEffect(() => {
		const turnEnded = wasStreaming.current && !streaming;
		wasStreaming.current = streaming;
		if (!cwd || streaming) return;
		// Opening a conversation reuses what the server kept of the pull request; a turn that ended may have opened one.
		void refreshGit(cwd, { fresh: true }).then(() => refreshGit(cwd, { pr: true, fresh: turnEnded }));
	}, [cwd, streaming]);

	const timer = useRef<number | undefined>(undefined);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new last entry is the trigger; it is not an input of the call.
	useEffect(() => {
		if (!cwd || !streaming || timer.current !== undefined) return;
		timer.current = window.setTimeout(() => {
			timer.current = undefined;
			void refreshGit(cwd, { fresh: true });
		}, WHILE_RUNNING_MS);
	}, [cwd, streaming, lastEntry]);
	useEffect(() => () => window.clearTimeout(timer.current), []);

	// The window's focus: the folder on screen is looked at again, for the branch the user may have switched in a
	// terminal. One listener for the whole hook, not one per folder: the folder is read when the window gets focus,
	// so a conversation that changed folder re-registered its listener and the old ones stayed behind.
	const cwdRef = useRef(cwd);
	cwdRef.current = cwd;
	useEffect(() => {
		const onFocus = () => {
			if (cwdRef.current) void refreshGit(cwdRef.current, { fresh: true });
		};
		window.addEventListener("focus", onFocus);
		return () => window.removeEventListener("focus", onFocus);
	}, []);
}
