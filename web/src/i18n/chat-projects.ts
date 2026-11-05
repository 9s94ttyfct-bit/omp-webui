/**
 * Strings for the sidebar's projects beyond what the sidebar draws at first (that is `shell`'s): a project's menu, the
 * dialogs that name, delete or give a folder to one, "Move to project" in a conversation's menu, and a project's own page.
 * Like `macs` and `projects`, the namespace is not in `MODULES` of `index.ts`: everything that draws it is a lazy chunk, and
 * its strings travel with the chunk (`lib/chat-projects-strings.ts`, `addStrings`). The zh-CN ones are a chunk of their own.
 */
export const en = {
	// A project's menu
	newChat: "New chat in this project",
	rename: "Rename…",
	setFolder: "Set folder…",
	changeFolder: "Change folder…",
	removeFolder: "Remove folder",
	moveUp: "Move up",
	moveDown: "Move down",
	deleteProject: "Delete project…",

	// "Move to project" in a conversation's menu (its title and "New project…" are `shell`'s, which the selection bar uses too)
	removeFromProject: "Remove from project",
	inThisProject: "In this project",
	noProjects: "No projects yet",

	// Naming a project
	newTitle: "New project",
	renameTitle: "Rename project",
	nameLabel: "Project name",
	namePlaceholder: "Research",
	create: "Create",
	save: "Rename",
	newHint: "A project groups conversations, whatever folder each works in. Its folder is optional.",

	// A project's folder
	folderTitle: "Choose the project's folder",
	folderDescription: "Its folder button shows this folder in the Files panel, and its new chats start in it.",

	// Removing a project
	deleteTitle: "Delete “{name}”?",
	deleteDescription:
		"Its conversations go back to the list by date. No conversation is deleted, and nothing in its folder is touched.",
	deleteConfirm: "Delete project",

	// What is wrong, and what failed
	problemEmpty: "Type a name for the project.",
	problemTooLong: "That name is too long (at most {max} characters).",
	problemInvalid: "That name cannot hold control characters or direction marks.",
	problemTaken: "A project is already called “{name}”.",
	saveFailed: "Could not save the project: {error}",
	deleteFailed: "Could not delete the project: {error}",

	// A project's page (`#/project/<id>`)
	pageConversations: "Conversations",
	pageEmpty: "No conversations in this project yet. Start one with New chat, or move one here from the sidebar.",
	pageNewChat: "New chat",
	pageFiles: "Files",
	pageNoFolder: "This project has no folder. Set one to see its files here.",
	pageGone: "This project is no longer there.",
};
