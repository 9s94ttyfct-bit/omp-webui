import { sep } from "node:path";

/**
 * The rules of what a delete may move to the Trash (docs/superpowers/specs/2026-11-11-delete-session-folder-design.md),
 * on real paths (every link resolved) only: which folders are never offered, who works in a folder, and which folders in
 * it are dependency folders. Pure: the looks at the disk and the processes are `cleanup-scan.ts`'s.
 */

/** `child` is `parent` or inside it. */
export function isWithin(child: string, parent: string): boolean {
	if (child === parent) return true;
	const base = parent.endsWith(sep) ? parent : parent + sep;
	return child.startsWith(base);
}

/** Folders that are never offered themselves, though a folder inside one may be (`/tmp/scratch`). */
const SYSTEM_EXACT = new Set([
	"/",
	"/Users",
	"/Volumes",
	"/tmp",
	"/var",
	"/etc",
	"/opt",
	"/cores",
	"/private",
	"/private/tmp",
	"/private/var",
	"/private/etc",
	"/private/var/tmp",
	"/private/var/folders",
]);

/** Folders neither offered nor anything inside them. */
const SYSTEM_TREES = ["/System", "/Library", "/Applications", "/usr", "/bin", "/sbin", "/private/etc", "/dev"];

/** A volume's root (`/Volumes/Backup`), or the per-user temporary folder or one above it (`/private/var/folders/xy/…/T`). */
const SYSTEM_SHAPES = [/^\/Volumes\/[^/]+$/, /^\/private\/var\/folders(?:\/[^/]+){1,3}$/];

export interface Protected {
	/** The real home folder. */
	home: string;
	/** omp-webui's data folder and omp's home (`~/.omp`), real. */
	data: string[];
}

/** Why `real` is never offered, or null when nothing forbids it. */
export function protectedReason(real: string, p: Protected): "home" | "system" | "data" | null {
	if (SYSTEM_EXACT.has(real) || SYSTEM_SHAPES.some((re) => re.test(real))) return "system";
	if (SYSTEM_TREES.some((tree) => isWithin(real, tree))) return "system";
	if (isWithin(p.home, real)) return "home";
	// The home's own system folders (its Library, its Trash) and what is in them.
	if (["Library", ".Trash"].some((name) => isWithin(real, p.home + sep + name))) return "system";
	if (p.data.some((d) => isWithin(real, d) || isWithin(d, real))) return "data";
	return null;
}

/** Something that works in a folder: a conversation, a sidebar project, or a running process (a Terminal tab's shell among them). */
export interface FolderUser {
	/** Its folder, real. */
	real: string;
	/** How the dialog names it. */
	label: string;
	kind: "conversation" | "project" | "process";
}

/**
 * Whether anything else works in the folder `real`. A conversation or a project in it, or in a folder that holds it (a
 * project's subfolder is not moved from under it), makes it `inUse`, unless that folder is the home folder or above it
 * (a chat started in `~` would otherwise hold every folder); a process counts only in the folder or inside it (every app
 * works in `/`). Anything in a folder inside it makes it `containsOther`.
 */
export function folderUse(
	real: string,
	users: readonly FolderUser[],
	p: Protected,
): { refused: "inUse" | "containsOther" | null; usedBy: string[] } {
	let refused: "inUse" | "containsOther" | null = null;
	const usedBy: string[] = [];
	for (const u of users) {
		let hit: "inUse" | "containsOther" | null = null;
		if (u.real === real) hit = "inUse";
		else if (isWithin(u.real, real)) hit = "containsOther";
		else if (u.kind !== "process" && isWithin(real, u.real) && protectedReason(u.real, p) === null) hit = "inUse";
		if (!hit) continue;
		if (refused !== "inUse") refused = hit;
		if (!usedBy.includes(u.label)) usedBy.push(u.label);
	}
	return { refused, usedBy };
}

/**
 * What blocks a dependency folder of the conversation working in `folder`: only what runs there now (a conversation's
 * process, a Terminal tab, a dev server), in the folder or inside it. Old conversations and projects do not: what is in
 * a dependency folder can be installed again.
 */
export function depUse(folder: string, running: readonly FolderUser[]): string[] {
	const usedBy: string[] = [];
	for (const u of running) if (isWithin(u.real, folder) && !usedBy.includes(u.label)) usedBy.push(u.label);
	return usedBy;
}

/** What a folder's name and surroundings say about it: a dependency folder, and whether git must ignore it to count. */
export interface DependencyCandidate {
	kind: string;
	/** Listed only when git ignores it (it may be committed source: Go's or PHP's `vendor`). */
	needsIgnored: boolean;
}

const GRADLE_FILES = ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"];

/**
 * Whether the folder `name` is a dependency folder: `beside(n)` tells whether its parent holds `n`, `holds(n)` whether
 * it holds `n` itself. Only kinds whose folder can be made again by an install are listed; listing is not a promise.
 */
export function dependencyCandidate(
	name: string,
	beside: (n: string) => boolean,
	holds: (n: string) => boolean,
): DependencyCandidate | null {
	switch (name) {
		case "node_modules":
			return { kind: name, needsIgnored: false };
		case ".venv":
		case "venv":
			return holds("pyvenv.cfg") ? { kind: name, needsIgnored: false } : null;
		case "target":
			return holds("CACHEDIR.TAG") ? { kind: name, needsIgnored: false } : null;
		case "Pods":
			return beside("Podfile.lock") ? { kind: name, needsIgnored: false } : null;
		case "build":
		case ".gradle":
			return GRADLE_FILES.some(beside) ? { kind: name, needsIgnored: true } : null;
		case "vendor":
			return beside("composer.json") || beside("go.mod") ? { kind: name, needsIgnored: true } : null;
		default:
			return null;
	}
}
