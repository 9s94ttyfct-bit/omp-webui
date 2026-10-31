/**
 * Strings for the side panel's CI tab: the GitHub Actions runs of the conversation's folder, read with the person's own
 * GitHub CLI. The tab is a lazy chunk that registers these (`registerStrings`); the tab's label and its badge are
 * `panel.tabCi*`.
 */
export const en = {
	listLabel: "Workflow runs",
	scopeLabel: "Show runs of",
	scopeBranch: "This branch",
	scopeAll: "All branches",
	branchIs: "Branch {branch}",
	detached: "Detached HEAD: the runs of every branch are shown.",
	refresh: "Refresh",
	notify: "Notify when a run of this branch finishes",
	notifyBlocked:
		"Notifications are blocked or off. Allow them for this site, and turn on Notifications in Settings › Conversations & files.",
	empty: "No workflow runs",
	emptyBranch: "GitHub has no run of {branch} yet.",
	emptyAll: "This repository has no GitHub Actions runs.",
	noFolder: "This conversation has no folder to look in.",
	stateQueued: "Queued",
	stateRunning: "Running",
	stateSuccess: "Passed",
	stateFailure: "Failed",
	stateCancelled: "Cancelled",
	stateSkipped: "Skipped",
	queuedAt: "queued {when}",
	startedAt: "started {when}",
	took: "took {duration}",
	runningFor: "running for {duration}",
	openOnGitHub: "Open on GitHub",
	runOnGitHub: "{workflow} on GitHub",
	jobsLabel: "Jobs of {workflow}",
	jobsLoading: "Asking GitHub for the jobs…",
	jobsEmpty: "No jobs yet.",
	failedStep: "Failed at: {step}",
	viewLog: "Log",
	logOf: "Log of {job} on GitHub",
	problemNoGh:
		"The GitHub CLI (gh) is not installed. Install it (for example `brew install gh`), sign in with `gh auth login`, then refresh.",
	problemSignedOut: "The GitHub CLI is not signed in. Run `gh auth login` in a terminal, then refresh.",
	problemNoRepo: "This folder is not a git repository with a GitHub remote.",
	problemUnsafe: "This repository's own configuration names a command, so it is not looked at ({why}).",
	problemSlow: "GitHub gave no answer in time. Try again in a moment.",
	problemRateLimited: "GitHub's API rate limit was reached: the runs are looked at again in a few minutes.",
	problemFailed: "gh could not read the runs: {message}",
	problemFailedBare: "gh could not read the runs.",
	countShown: "The latest {n}",
	readOnly:
		"Read only: nothing is written to GitHub. Looked at every 10 s while a run is queued or running, every minute otherwise.",
};
