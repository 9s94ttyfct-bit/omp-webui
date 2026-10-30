import { readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { DIR_LIST_MAX, type DirListing } from "../shared/dirs.ts";
import { CodedError, type ErrorCode } from "../shared/error-info.ts";

/** A folder that cannot be listed, told in a sentence of its own (`code`) and with the HTTP status that fits. */
export class DirError extends CodedError {
	constructor(
		message: string,
		code: ErrorCode,
		readonly status: number,
		path: string,
	) {
		super(message, code, { path });
	}
}

/** `path` as an absolute one: `~` and `~/…` are in `home`; a relative path has nothing to be relative to. */
export function absolute(path: string, home: string): string {
	if (path === "") return home;
	if (path === "~" || path.startsWith("~/")) return resolve(home, path.slice(2));
	if (!isAbsolute(path)) {
		throw new DirError(`${path} is not an absolute path: start it with / or ~`, "dirRelative", 400, path);
	}
	return resolve(path);
}

/** Whether `parent/name` is a folder, links followed: a link to a folder is one, a dangling link or a link to a file is not. */
function isFolder(parent: string, name: string): boolean {
	try {
		return statSync(join(parent, name)).isDirectory();
	} catch {
		return false;
	}
}

/** The folders in `path` (default: `home`), by name, without the hidden ones. */
export function listDirs(path: string, home: string): DirListing {
	const dir = absolute(path.trim(), home);
	let names: string[];
	try {
		names = readdirSync(dir, { withFileTypes: true })
			.filter((d) => !d.name.startsWith(".") && (d.isDirectory() || (d.isSymbolicLink() && isFolder(dir, d.name))))
			.map((d) => d.name)
			.sort((a, b) => a.localeCompare(b));
	} catch (e) {
		const code = e instanceof Error && "code" in e ? e.code : null;
		if (code === "ENOENT" || code === "ENAMETOOLONG" || code === "ELOOP") {
			throw new DirError(`${dir} does not exist`, "dirNotFound", 404, dir);
		}
		if (code === "ENOTDIR") throw new DirError(`${dir} is not a folder`, "dirNotFolder", 400, dir);
		if (code === "EACCES" || code === "EPERM") {
			throw new DirError(`No permission to open ${dir}`, "dirNoAccess", 403, dir);
		}
		throw e;
	}
	return {
		path: dir,
		parent: resolve(dir, ".."),
		dirs: names.slice(0, DIR_LIST_MAX),
		omitted: Math.max(0, names.length - DIR_LIST_MAX),
	};
}
