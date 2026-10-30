import type { ProjectGroup } from "@shared/project-groups.ts";

/**
 * What the sidebar's project popover draws (#636): the groups in their order with the projects in them, then the projects no
 * group names. Apart from `project-groups.ts` (the API) because this half is asked for by the lazy list alone: the first page
 * carries the funnel and the server's list, not this.
 */

/** One project in the list: its folder, how many conversations run in it, and the group it is in (null: the top level). */
export interface ProjectRow {
	cwd: string;
	count: number;
	/** The group's id, or null for the top level. */
	group: string | null;
}

/** One line of the list: a group's disclosure button and the projects in it, or a project at the top level. */
export type ProjectLine =
	| { kind: "group"; group: ProjectGroup; projects: ProjectRow[] }
	| { kind: "project"; project: ProjectRow };

/**
 * The list the sidebar's project popover draws: the groups in their order, folded or not, each with the projects in it,
 * then the projects no group names.
 *
 * A group whose projects are all gone from the list is still drawn: it is the person's, and it is where the next project of
 * that name goes. A project that no longer exists is not drawn (and is kept in the file: `ProjectGroupStore`).
 */
export function projectLines(projects: readonly ProjectRow[], groups: readonly ProjectGroup[]): ProjectLine[] {
	const byGroup = new Map<string, ProjectRow[]>();
	const loose: ProjectRow[] = [];
	const known = new Set(groups.map((g) => g.id));
	for (const p of projects) {
		// A group that is gone (deleted from another page between this page's read and its write) leaves its projects at the
		// top level, which is where a deleted group's projects are.
		if (p.group !== null && known.has(p.group)) {
			const list = byGroup.get(p.group) ?? [];
			list.push(p);
			byGroup.set(p.group, list);
		} else loose.push(p);
	}
	const out: ProjectLine[] = groups.map((group) => ({ kind: "group", group, projects: byGroup.get(group.id) ?? [] }));
	// The top level's projects keep the order the list gave them (most conversations first).
	for (const project of loose) out.push({ kind: "project", project });
	return out;
}

/**
 * Each project's group, by its folder: what `/api/project-groups` says. A folder no group names is the top level's.
 * `projects` is the list the sidebar already has (folder → conversations), so a group is drawn with the counts it shows.
 */
export function groupOf(groups: readonly ProjectGroup[]): Map<string, string> {
	const out = new Map<string, string>();
	for (const group of groups) for (const cwd of group.projects) if (!out.has(cwd)) out.set(cwd, group.id);
	return out;
}

/** The projects of the list, each with its group. */
export function withGroups(projects: readonly [string, number][], groups: readonly ProjectGroup[]): ProjectRow[] {
	const where = groupOf(groups);
	return projects.map(([cwd, count]) => ({ cwd, count, group: where.get(cwd) ?? null }));
}
