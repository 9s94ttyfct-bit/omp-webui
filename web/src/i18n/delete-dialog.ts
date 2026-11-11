/**
 * The sidebar's delete dialogs (`DeleteDialog.tsx`, a chunk of its own that registers these with `registerStrings`), with
 * what they offer to move to the Trash. The first page does not carry them.
 */
export const en = {
	sidebarDeleteTitle: "Delete conversation?",
	sidebarDeleteDescription: "omp will delete “{title}” and its subagent transcripts. This cannot be undone.",
	sidebarDeleteFailed: "Delete failed: {error}",
	sidebarDeleteBusy: "“{title}” is replying or waiting for you. Stop it first, then delete it.",
	sidebarBulkDeleteTitle: "Delete {n} conversations?",
	sidebarBulkDeleteTitleOne: "Delete 1 conversation?",
	sidebarBulkDeleteDescription: "omp removes these transcripts and their files. This cannot be undone.",
	sidebarBulkDeleteDescriptionOne: "omp removes this transcript and its files. This cannot be undone.",
	sidebarBulkDeleteList: "Conversations to delete",
	sidebarBulkDeleteFailed: "{n} could not be deleted: {error}",

	// What a delete may move to the Trash with the conversation
	cleanupLooking: "Looking at what it left on disk…",
	cleanupFolder: "Also move its folder to the Trash",
	cleanupDeps: "Or only its dependency folders:",
	cleanupSizeUnknown: "size unknown",
	cleanupOffers: "{n} can go to the Trash",
	cleanupGitUncommitted: "{n} uncommitted changes",
	cleanupGitUnpushed: "{n} commits not pushed",
	cleanupGitUnknown: "git could not be asked what is not committed",
	cleanupWorktree: "A git worktree: git lists it until `git worktree prune`.",
	cleanupRefusedHome: "Your home folder (or above it): never moved.",
	cleanupRefusedSystem: "A system folder: never moved.",
	cleanupRefusedData: "Holds omp's or omp-webui's own data: never moved.",
	cleanupRefusedInUse: "In use by {who}.",
	cleanupRefusedContains: "A folder in it is in use by {who}.",
	cleanupRefusedUnchecked: "The running processes could not be checked: nothing is moved.",
	cleanupDepRunning: "{who} runs in the folder.",
	cleanupWhoConversation: "“{name}”",
	cleanupWhoNewChat: "a new chat",
	cleanupWhoProject: "the project “{name}”",
	cleanupWhoTerminal: "a Terminal tab",
	cleanupWhoProcess: "{name} (pid {pid})",
	cleanupWhoMore: "{list} and {n} more",
	cleanupSummaryOne: "After the delete, 1 item goes to the Trash.",
	cleanupSummary: "After the delete, {n} items go to the Trash.",
	cleanupNotMoved: "Not moved to the Trash: {path} ({error})",
	cleanupNotMovedMore: "{n} items were not moved to the Trash. {path}: {error}",
};
