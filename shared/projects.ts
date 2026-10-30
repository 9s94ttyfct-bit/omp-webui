/**
 * The projects folder (Settings › Projects folder) and the quick "New project folder" of the new-chat folder picker:
 * where new projects are made, what a project folder may be called, and why a name is refused. The page checks a name as
 * it is typed with `projectNameProblem`; the server checks it again with the same function before it makes anything.
 */

/** `GET /api/projects` and what a change of the setting answers: the folder new projects are made in. */
export interface ProjectsInfo {
	/** The folder, absolute: the person's choice, else `~/omp` (which may not be there yet: the first project makes it). */
	folder: string;
	/** Whether `folder` is the default: nothing was chosen. */
	isDefault: boolean;
	/** Whether projects can be made in `folder`: it is a folder, or it is `~/omp` and nothing is there yet. A chosen folder may have been moved or replaced since. */
	exists: boolean;
}

/** `POST /api/projects/new`: the folder that was made, and the setting it was made in. */
export interface ProjectCreated {
	path: string;
	info: ProjectsInfo;
}

/** The most characters a project folder's name has (and 255 bytes, which is what file systems allow). */
export const PROJECT_NAME_MAX = 100;
const PROJECT_NAME_MAX_BYTES = 255;

/** What is wrong with a name: nothing but a name of one folder, directly in the projects folder, is accepted. */
export type ProjectNameProblem =
	/** Nothing typed. */
	| "empty"
	/** More than `PROJECT_NAME_MAX` characters, or more bytes than a file system takes. */
	| "tooLong"
	/** A `/` or `\`: the name would be a path, and could leave the projects folder. */
	| "separator"
	/** Starts with a dot: `.`, `..` and hidden folders, which the folder picker does not list. */
	| "dot"
	/** Starts or ends with a space (or ends with a dot): file systems and shells treat those badly. */
	| "space"
	/** A control character, or one of `< > : " | ? *`, which some file systems refuse. */
	| "invalid";

/** Why `name` cannot be a project folder's name (null: it can). The name is taken exactly as given, not trimmed. */
export function projectNameProblem(name: string): ProjectNameProblem | null {
	if (name === "") return "empty";
	if (name.length > PROJECT_NAME_MAX || new TextEncoder().encode(name).length > PROJECT_NAME_MAX_BYTES) {
		return "tooLong";
	}
	if (name.includes("/") || name.includes("\\")) return "separator";
	if (name.startsWith(".")) return "dot";
	if (name.trim() !== name || name.endsWith(".")) return "space";
	// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
	if (/[\u0000-\u001f\u007f<>:"|?*]/.test(name)) return "invalid";
	return null;
}

/** What the server refuses besides a bad name: the name is taken, or the projects folder cannot be made in. */
export type ProjectProblem = ProjectNameProblem | "exists" | "folderGone" | "notFolder" | "noAccess" | "failed";

const PROJECT_PROBLEMS: readonly string[] = [
	"empty",
	"tooLong",
	"separator",
	"dot",
	"space",
	"invalid",
	"exists",
	"folderGone",
	"notFolder",
	"noAccess",
	"failed",
];

export function isProjectProblem(value: unknown): value is ProjectProblem {
	return typeof value === "string" && PROJECT_PROBLEMS.includes(value);
}
