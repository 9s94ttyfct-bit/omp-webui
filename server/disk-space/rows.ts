import { readdirSync } from "node:fs";
import { join, posix } from "node:path";
import type { DiskRowKind } from "../../shared/disk-space.ts";
import { isWithin } from "../sessions/cleanup-rules.ts";
import { isFolder, realOf } from "../sessions/cleanup-scan.ts";

/**
 * Which rows the Disk space page has, and whose conversations each holds (docs/superpowers/specs/2026-11-26-disk-space-page-design.md,
 * "Which rows"). Pure but for `projectSubfolders`: the paths are resolved by the `realOf` given.
 */

export interface RowConversation {
	file: string;
	cwd: string;
	title: string;
	modifiedAt: number;
}

export interface RowPlan {
	folder: string;
	/** Null: the folder is gone. */
	real: string | null;
	kind: DiskRowKind;
	/** The conversations it holds, by file, in the order they were given. */
	files: string[];
}

/**
 * The rows: every subfolder of the projects folder, and every other folder conversations ran in. A conversation belongs to
 * the project whose folder holds its own, else to the outermost other folder holding it. A protected folder (`isProtected`),
 * the projects folder and every folder above it hold only their own conversations: nothing rolls up into them.
 */
export function buildRows(input: {
	projectsFolder: string | null;
	subfolders: string[];
	conversations: RowConversation[];
	realOf: (path: string) => string | null;
	isProtected: (real: string) => boolean;
}): RowPlan[] {
	const pf = input.projectsFolder === null ? null : (input.realOf(input.projectsFolder) ?? input.projectsFolder);
	const rows = new Map<string, RowPlan>();
	const sheltered = (real: string) => input.isProtected(real) || (pf !== null && isWithin(pf, real));
	// A subfolder that is a link to a protected folder (the home folder, the projects folder) is no project.
	const projects: RowPlan[] = input.subfolders
		.filter((s) => !sheltered(s))
		.map((s) => ({ folder: s, real: s, kind: "project", files: [] }));
	for (const p of projects) rows.set(`r:${p.real}`, p);
	const projectOf = (real: string) => projects.find((p) => p.real !== null && isWithin(real, p.real));
	// The other folders, real: a folder inside another of them is that one's.
	const others = new Set<string>();
	const placed: { file: string; key: string | null; real: string | null; cwd: string }[] = [];
	for (const c of input.conversations) {
		const real = input.realOf(c.cwd);
		if (real === null) {
			// A folder that is gone, inside a project that is not: the project's.
			const where = nearestThere(c.cwd, input.realOf);
			const project = where === null ? undefined : projectOf(where);
			if (project) placed.push({ file: c.file, key: `r:${project.real}`, real: null, cwd: c.cwd });
			else placed.push({ file: c.file, key: `g:${c.cwd}`, real, cwd: c.cwd });
			continue;
		}
		const project = projectOf(real);
		if (project) placed.push({ file: c.file, key: `r:${project.real}`, real, cwd: c.cwd });
		else if (sheltered(real)) placed.push({ file: c.file, key: `p:${real}`, real, cwd: c.cwd });
		else {
			others.add(real);
			placed.push({ file: c.file, key: null, real, cwd: c.cwd });
		}
	}
	const outermost = (real: string) => {
		let best = real;
		for (const o of others) if (o.length < best.length && isWithin(real, o)) best = o;
		return best;
	};
	for (const p of placed) {
		let key = p.key;
		let row: RowPlan | undefined;
		if (key === null && p.real !== null) {
			const owner = outermost(p.real);
			key = `r:${owner}`;
			row = rows.get(key) ?? { folder: owner, real: owner, kind: "other", files: [] };
		} else if (key?.startsWith("p:")) {
			row = rows.get(key) ?? { folder: p.real as string, real: p.real, kind: "protected", files: [] };
		} else if (key?.startsWith("g:")) {
			row = rows.get(key) ?? { folder: p.cwd, real: null, kind: "other", files: [] };
		} else row = key ? rows.get(key) : undefined;
		if (!row || key === null) continue;
		row.files.push(p.file);
		rows.set(key, row);
	}
	return [...rows.values()].sort((a, b) => (a.folder < b.folder ? -1 : a.folder > b.folder ? 1 : 0));
}

/** Where `path` would be, by the real path of the nearest folder above it that is there; null when none is. */
function nearestThere(path: string, realOf: (path: string) => string | null): string | null {
	const rest: string[] = [];
	for (let at = path; ; ) {
		const up = posix.dirname(at);
		if (up === at) return null;
		rest.unshift(posix.basename(at));
		at = up;
		const real = realOf(at);
		if (real !== null) return posix.join(real, ...rest);
	}
}

/** The folders directly in the projects folder (hidden ones left out, as the folder picker leaves them), real; none when it is missing. */
export function projectSubfolders(projectsFolder: string): string[] {
	let names: string[];
	try {
		names = readdirSync(projectsFolder, { withFileTypes: true })
			.filter((d) => !d.name.startsWith(".") && (d.isDirectory() || d.isSymbolicLink()))
			.map((d) => d.name);
	} catch {
		return [];
	}
	const out: string[] = [];
	for (const name of names) {
		const real = realOf(join(projectsFolder, name));
		// A link to a file is no folder.
		if (real && isFolder(real) && !out.includes(real)) out.push(real);
	}
	return out;
}
