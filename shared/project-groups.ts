import { isRecord } from "./guards.ts";

/**
 * The sidebar's project groups (#636): folders the person makes to put projects in, one level deep. A group has a name and
 * an order; the projects in it are named by their folder path, which is the key the sidebar's project list already uses
 * (a conversation's `cwd`). It is this app's own data — `<data dir>/project-groups.json` — and nothing about it is written
 * anywhere near a project: a group is a way to look at the list, and deleting one leaves every folder on disk alone.
 *
 * The file is read leniently and written whole: what fits is kept (a group without a usable name or id is dropped, a
 * project named twice is in the first group that names it), so one bad entry an older or a hand-edited file carries
 * cannot take the rest of the person's groups with it. Projects are kept even while their folder is gone: a project that
 * is not on the list right now is ignored by the page, not forgotten here (the folder may come back, and a missing one is
 * no reason to lose where the person put it).
 */

/** The most characters a group's name has (a name is a label, not a path: 60 is what a narrow sidebar shows). */
export const GROUP_NAME_MAX = 60;

/** The most groups one file keeps: a list longer than this is not a sidebar's. */
export const GROUP_LIMIT = 200;

/** One group, as the server keeps it and the page shows it. */
export interface ProjectGroup {
	/** Stable across renames: a rename does not move the group in the list. */
	id: string;
	name: string;
	/** Where it is in the list (lowest first); groups the person has not moved keep the order they were made in. */
	order: number;
	/** Folded in the sidebar: its projects are not shown. */
	collapsed: boolean;
	/** The folders (a conversation's `cwd`) the person put in it, in the order they were put there. */
	projects: string[];
}

/** What `GET /api/project-groups` answers and every change returns: the whole list, as the next read of it would be. */
export interface ProjectGroups {
	groups: ProjectGroup[];
	/** Why the file could not be read at all, when it could not (null: it was read, or there was none). */
	problem: string | null;
}

/** What is wrong with a group name: nothing but a name of one group is accepted. */
export type GroupNameProblem =
	/** Nothing typed (or only spaces). */
	| "empty"
	/** More than `GROUP_NAME_MAX` characters. */
	| "tooLong"
	/** A control character, or a direction mark that would reorder the rest of the name. */
	| "invalid"
	/** A group is already called that (case, accents and width do not tell two names apart). */
	| "taken";

const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** Characters no name may carry: a control character, and the bidi overrides that make a name read as another. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is refused.
const FORBIDDEN = /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/;

/**
 * What two group names are compared by: case, accents, width and compatibility forms do not make a name another one. The
 * same fold the list of Macs uses (`foldMacName`): NFKD, marks dropped, lower case then upper case then lower case (so `ß`
 * and `ss`, `σ` and `Σ` are the same letters), a final sigma written `σ`, NFC.
 */
export function foldGroupName(name: string): string {
	return name
		.normalize("NFKD")
		.replace(/\p{M}/gu, "")
		.toLowerCase()
		.toUpperCase()
		.toLowerCase()
		.replace(/\u03c2/g, "\u03c3")
		.normalize("NFC");
}

/**
 * The name as it would be kept (trimmed), or why it is not one. Whether another group has it is the list's to check
 * (`groupNameProblem`), as is whether a project may be in another group.
 */
export function parseGroupName(input: string): { ok: true; name: string } | { ok: false; problem: GroupNameProblem } {
	const name = input.trim();
	if (name === "") return { ok: false, problem: "empty" };
	let count = 0;
	for (const _ of graphemes.segment(name)) if (++count > GROUP_NAME_MAX) return { ok: false, problem: "tooLong" };
	if (FORBIDDEN.test(name)) return { ok: false, problem: "invalid" };
	return { ok: true, name };
}

/**
 * Why `name` cannot be the name of a group in `groups` (`except`: the group being renamed, which may keep its own name).
 * The server asks this before it writes and the page before it asks the server, so the answer is the same on both sides.
 */
export function groupNameProblem(
	groups: readonly ProjectGroup[],
	name: string,
	except: string | null = null,
): GroupNameProblem | null {
	const parsed = parseGroupName(name);
	if (!parsed.ok) return parsed.problem;
	const folded = foldGroupName(parsed.name);
	const namesake = groups.find((g) => g.id !== except && foldGroupName(g.name) === folded);
	return namesake ? "taken" : null;
}

/** What a request changed: the whole list, and the group it made or changed (`null` for a delete). */
export interface ProjectGroupsAnswer extends ProjectGroups {
	/** The group the change made or changed; null when the change removed one. */
	group: ProjectGroup | null;
}

/** The id a new group gets: it names nothing on disk, so it only has to be unique and stay put across renames. */
export function newGroupId(taken: readonly string[]): string {
	const used = new Set(taken);
	for (;;) {
		const id = crypto.randomUUID();
		if (!used.has(id)) return id;
	}
}

/**
 * The list from what the file holds, keeping what fits. `null` is no answer at all (the file is not JSON, or is not an
 * object): the caller says so, and keeps the file as it is rather than writing over a person's groups with none.
 *
 * - A group without an id or a usable name is dropped.
 * - A name a group already has is dropped with it (`Name`, `name` and `Náme` are one name): the list shows one group of a
 *   name, and the first in the file is the one it was made as.
 * - A project is in one group: the first group naming it keeps it (`order` decides which is first).
 * - `order` that is not a finite number is the group's place in the file; `collapsed` that is not `true` is not collapsed.
 * - Beyond `GROUP_LIMIT` groups the rest is dropped.
 */
export function parseGroups(value: unknown): ProjectGroup[] | null {
	if (!isRecord(value)) return null;
	const raw = Array.isArray(value.groups) ? value.groups : null;
	if (!raw) return null;
	const out: ProjectGroup[] = [];
	const ids = new Set<string>();
	const names = new Set<string>();
	for (const [at, entry] of raw.entries()) {
		if (out.length >= GROUP_LIMIT) break;
		if (!isRecord(entry)) continue;
		const id = typeof entry.id === "string" && entry.id !== "" ? entry.id : null;
		if (!id || ids.has(id)) continue;
		const parsed = typeof entry.name === "string" ? parseGroupName(entry.name) : null;
		if (!parsed?.ok) continue;
		const folded = foldGroupName(parsed.name);
		if (names.has(folded)) continue;
		ids.add(id);
		names.add(folded);
		const projects = Array.isArray(entry.projects)
			? entry.projects.filter((p): p is string => typeof p === "string" && p !== "")
			: [];
		const order = typeof entry.order === "number" && Number.isFinite(entry.order) ? entry.order : at;
		out.push({ id, name: parsed.name, order, collapsed: entry.collapsed === true, projects });
	}
	// A project is in one group, and it is the one that comes first in the list: what the sidebar shows is the list.
	const claimed = new Set<string>();
	return out
		.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
		.map((g) => {
			const projects = g.projects.filter((p) => {
				if (claimed.has(p)) return false;
				claimed.add(p);
				return true;
			});
			return projects.length === g.projects.length ? g : { ...g, projects };
		});
}

/** The file's text for `groups`: what `parseGroups` reads back as the same list. */
export function serializeGroups(groups: readonly ProjectGroup[]): string {
	const ordered = groups
		.toSorted((a, b) => a.order - b.order)
		.map((g, order) => ({
			id: g.id,
			name: g.name,
			order,
			collapsed: g.collapsed,
			projects: [...g.projects],
		}));
	return `${JSON.stringify({ version: 1, groups: ordered }, null, "\t")}\n`;
}

/** Where each project is, by its folder: `group` is the group it is in, or null for the top level. */
export function groupOfProject(
	groups: readonly ProjectGroup[],
	cwd: string,
): { group: ProjectGroup; at: number } | null {
	for (const group of groups) {
		const at = group.projects.indexOf(cwd);
		if (at >= 0) return { group, at };
	}
	return null;
}
