/**
 * Strings for the projects folder: Settings › Projects folder and "New project folder" in the folder picker of a new chat.
 * Like `guard`, this namespace is not in `MODULES` of `index.ts`: both are lazy chunks, and the strings travel with them
 * (`lib/projects-strings.ts`, `addStrings`). The zh-CN ones are a chunk of their own, fetched only by a person who reads the
 * page in Chinese.
 */
export const en = {
	title: "Projects folder",
	hint: "Where “New project folder” makes a project when you start a chat. Choose one of your own, or keep the default.",
	folderLabel: "Projects folder",
	pathAria: "Path of the projects folder",
	isDefault: "Default",
	defaultNote: "Default: ~/omp (made when the first project folder is).",
	choose: "Choose…",
	chooseTitle: "Choose the projects folder",
	chooseDesc: "New project folders are made inside this folder.",
	save: "Save",
	useDefault: "Use default",
	saving: "Saving…",
	saved: "Saved",
	loadFailed: "Could not read the projects folder: {error}",
	saveFailed: "Could not change the projects folder: {error}",
	missing:
		"This folder is no longer there, or is not a folder, so no project folder can be made in it. Choose another.",
	remoteNote:
		"Change the projects folder on the computer omp-webui runs on. From here you can still make a project folder in it.",
	// The picker of a new chat.
	newProject: "New project folder",
	newIn: "Made in {folder}",
	nameLabel: "Folder name",
	namePlaceholder: "my-project",
	create: "Create and use",
	creating: "Creating…",
	back: "Back",
	problemEmpty: "Type a name for the folder.",
	problemTooLong: "That name is too long (at most {max} characters).",
	problemSeparator: "A name cannot contain / or \\: it is one folder, made in the projects folder.",
	problemDot: "A name cannot start with a dot.",
	problemSpace: "A name cannot start or end with a space, or end with a dot.",
	problemInvalid: 'A name cannot contain control characters or any of < > : " | ? *',
	problemExists:
		"“{name}” already exists in the projects folder. Choose another name, or pick the folder from the list.",
	problemFolderGone: "The projects folder no longer exists. Choose another in Settings.",
	problemNotFolder: "The projects folder is not a folder. Choose another in Settings.",
	problemNoAccess: "No permission to make a folder in the projects folder.",
	problemFailed: "The folder could not be made: {error}",
};
