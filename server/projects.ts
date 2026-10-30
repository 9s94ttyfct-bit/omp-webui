import {
	accessSync,
	constants,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { isRecord } from "../shared/guards.ts";
import { type ProjectCreated, type ProjectProblem, type ProjectsInfo, projectNameProblem } from "../shared/projects.ts";
import { absolute, DirError } from "./dirs.ts";

/** A project folder that was not made (`problem` says why, `status` is the HTTP answer that fits). */
export class ProjectError extends Error {
	constructor(
		message: string,
		readonly problem: ProjectProblem,
		readonly status: number,
	) {
		super(message);
	}
}

/** Whether `path` is a folder now (links followed). */
function isFolder(path: string): boolean {
	try {
		return statSync(path).isDirectory();
	} catch {
		return false;
	}
}

/** Whether anything is at `path` (a link counts, whatever it points to). */
function isThere(path: string): boolean {
	try {
		lstatSync(path);
		return true;
	} catch {
		return false;
	}
}

/**
 * The projects folder: where "New project folder" (the folder picker of a new chat) makes a project. The setting is kept
 * in `<data dir>/projects-folder.json`; nothing chosen is `~/omp`, which is made (that one folder, not its parents) when
 * the first project folder is made in it. Worked out at each look, so that a folder made (or removed) since is followed.
 * The file is read at each look too, not held: a second server on the same data dir changes it as well.
 */
export class ProjectsFolder {
	private readonly file: string;

	constructor(
		dataDir: string,
		private readonly home: string,
	) {
		this.file = join(dataDir, "projects-folder.json");
	}

	/** The folder that was chosen, or null: nothing chosen, or a file that cannot be trusted. */
	private chosen(): string | null {
		try {
			const body: unknown = JSON.parse(readFileSync(this.file, "utf8"));
			const folder = isRecord(body) ? body.folder : null;
			return typeof folder === "string" && folder.startsWith("/") ? folder : null;
		} catch {
			return null;
		}
	}

	info(): ProjectsInfo {
		const chosen = this.chosen();
		if (chosen !== null) return { folder: chosen, isDefault: false, exists: isFolder(chosen) };
		// `~/omp` that is not there yet is shown all the same, and made by the first project; one that is there and not a folder
		// (a file, a link to nothing) cannot be, and is not made over.
		const usual = join(this.home, "omp");
		return { folder: usual, isDefault: true, exists: isFolder(usual) || !isThere(usual) };
	}

	/**
	 * Choose the folder (`~` is the home folder); null, or nothing, goes back to the default. It has to be a folder that
	 * exists and can be written to: a setting that could not be used would only be found out when a project is made.
	 */
	set(value: string | null): ProjectsInfo {
		const text = value?.trim() ?? "";
		let folder: string | null = null;
		if (text !== "") {
			folder = absolute(text, this.home);
			if (!isFolder(folder)) {
				let kind: "dirNotFound" | "dirNotFolder" = "dirNotFound";
				try {
					statSync(folder);
					kind = "dirNotFolder";
				} catch {}
				throw new DirError(
					kind === "dirNotFound" ? `${folder} does not exist` : `${folder} is not a folder`,
					kind,
					kind === "dirNotFound" ? 404 : 400,
					folder,
				);
			}
			try {
				accessSync(folder, constants.W_OK);
			} catch {
				throw new DirError(`No permission to make folders in ${folder}`, "dirNotWritable", 403, folder);
			}
		}
		const temporary = `${this.file}.${process.pid}.tmp`;
		writeFileSync(temporary, `${JSON.stringify({ folder }, null, 2)}\n`, { mode: 0o600 });
		renameSync(temporary, this.file);
		return this.info();
	}

	/** Why `mkdir` of `path`, a folder directly in `parent`, did not make it. */
	private refusal(e: unknown, path: string, parent: string): ProjectError {
		const code = e instanceof Error && "code" in e ? e.code : null;
		if (code === "EEXIST") return new ProjectError(`${path} exists already`, "exists", 409);
		if (code === "ENOENT") return new ProjectError(`The projects folder ${parent} does not exist`, "folderGone", 404);
		if (code === "EACCES" || code === "EPERM" || code === "EROFS") {
			return new ProjectError(`No permission to make a folder in ${parent}`, "noAccess", 403);
		}
		return new ProjectError(`Could not make ${path}${typeof code === "string" ? ` (${code})` : ""}`, "failed", 500);
	}

	/** Make `<projects folder>/<name>`: a new folder directly in it, never over one that is there. */
	create(name: unknown): ProjectCreated {
		const problem = typeof name === "string" ? projectNameProblem(name) : "invalid";
		if (typeof name !== "string" || problem !== null) {
			throw new ProjectError(`${JSON.stringify(name)} cannot be a project folder's name`, problem ?? "invalid", 400);
		}
		const info = this.info();
		if (!info.exists) {
			// Something that is not a folder (or a link to nothing) is there: for the default that is `~/omp`, for a chosen
			// folder one that was replaced since it was chosen.
			if (isThere(info.folder)) {
				throw new ProjectError(`The projects folder ${info.folder} is not a folder`, "notFolder", 409);
			}
			throw new ProjectError(`The projects folder ${info.folder} does not exist`, "folderGone", 404);
		}
		if (info.isDefault && !isFolder(info.folder)) {
			try {
				// Not `recursive`: only `~/omp` itself is made, never the folders above it.
				mkdirSync(info.folder);
			} catch (e) {
				// Made by somebody since the look is as good as made by us; anything else there is not a folder.
				const raced = e instanceof Error && "code" in e && e.code === "EEXIST";
				if (!(raced && isFolder(info.folder))) {
					throw raced
						? new ProjectError(`The projects folder ${info.folder} is not a folder`, "notFolder", 409)
						: this.refusal(e, info.folder, this.home);
				}
			}
		}
		const path = join(info.folder, name);
		try {
			// Not `recursive`: that would take an existing folder for success, and the name has no separators to need it.
			mkdirSync(path);
		} catch (e) {
			throw this.refusal(e, path, info.folder);
		}
		return { path, info };
	}
}
