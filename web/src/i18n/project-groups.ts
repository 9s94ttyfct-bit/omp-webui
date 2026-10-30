/**
 * Strings for the sidebar's project list and its groups (#636): the popover the funnel opens, the rows, the group menus, and
 * the dialog that names a group. Like `macs` and `projects`, the namespace is not in `MODULES` of `index.ts`: everything that
 * draws it is a lazy chunk, and its strings travel with the chunk (`lib/project-groups-strings.ts`, `addStrings`). The zh-CN
 * ones are a chunk of their own.
 *
 * Everything here replaced the sidebar's native `<select>` of projects (#415), which a menu, a disclosure button and a
 * context menu cannot be built on.
 */
export const en = {
	// The funnel and the popover
	allProjects: "All projects",
	title: "Projects",
	close: "Close",
	empty: "No projects yet: a project appears here with its first conversation.",
	// A group's line, and a project's.
	projectCount: "{n} conversations",
	projectCountOne: "1 conversation",
	// The name a group is known by to a screen reader, with how many projects are in it.
	groupAria: "{name}, group: {n} projects",
	groupAriaOne: "{name}, group: 1 project",
	groupAriaCollapsed: "{name}, group: {n} projects, folded",
	groupEmpty: "No projects in this group yet",

	// The menus
	groupMenu: "Actions for the group {name}",
	newGroup: "New group…",
	renameGroup: "Rename…",
	deleteGroup: "Delete group…",
	moveUp: "Move up",
	moveDown: "Move down",
	moveToTop: "Move out of the group",
	/** The submenu of the groups a project can be moved into, and how one already there reads. */
	moveToGroupAria: "Move {name} to a group",
	inThisGroup: "In this group",

	// Naming a group
	newGroupTitle: "New group",
	renameGroupTitle: "Rename group",
	nameLabel: "Group name",
	namePlaceholder: "Work",
	create: "Create",
	rename: "Rename",

	// Removing a group
	deleteTitle: "Delete “{name}”?",
	deleteDescription:
		"Its projects go back to the top level of the list. Nothing in their folders is deleted, and no conversation is touched.",
	deleteConfirm: "Delete group",

	// What is wrong, and what failed
	problemEmpty: "Type a name for the group.",
	problemTooLong: "That name is too long (at most {max} characters).",
	problemInvalid: "That name cannot hold control characters or direction marks.",
	problemTaken: "A group is already called “{name}”.",
	saveFailed: "Could not save the group: {error}",
	moveFailed: "Could not move {name}: {error}",
	deleteFailed: "Could not delete the group: {error}",
	damaged:
		"The file of groups holds entries that could not be read, so they are not shown. The rest of the list is here, and the file is kept when the next change writes it.",
};
