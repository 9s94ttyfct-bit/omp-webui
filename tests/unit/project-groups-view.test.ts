import { expect, test } from "bun:test";
import type { ProjectGroup } from "../../shared/project-groups.ts";
import { groupOf, projectLines, withGroups } from "../../web/src/lib/project-groups-view.ts";

/**
 * What the sidebar's project popover draws (#636): the groups in their order with the projects in them, then the projects no
 * group names. A project the list no longer has is ignored, and a group with nothing in it is still the person's.
 */

const group = (id: string, name: string, projects: string[]): ProjectGroup => ({
	id,
	name,
	order: 0,
	collapsed: false,
	projects,
});

const PROJECTS: [string, number][] = [
	["/p/alpha", 4],
	["/p/beta", 3],
	["/p/gamma", 2],
	["/p/delta", 1],
];

test("a project is in the group that names it, and no group names one it does not have", () => {
	const groups = [group("g1", "Work", ["/p/beta", "/p/gone"])];
	expect(withGroups(PROJECTS, groups)).toEqual([
		{ cwd: "/p/alpha", count: 4, group: null },
		{ cwd: "/p/beta", count: 3, group: "g1" },
		{ cwd: "/p/gamma", count: 2, group: null },
		{ cwd: "/p/delta", count: 1, group: null },
	]);
	// A project whose folder is gone (`/p/gone`) is not drawn: the list has no such row.
	expect(groupOf(groups).has("/p/gone")).toBe(true);
});

test("the lines are the groups first, in their order, then the top level's projects in the list's order", () => {
	const groups = [group("g1", "Work", ["/p/beta"]), group("g2", "Play", ["/p/delta"])];
	const lines = projectLines(withGroups(PROJECTS, groups), groups);
	expect(lines.map((l) => (l.kind === "group" ? `group:${l.group.name}` : `project:${l.project.cwd}`))).toEqual([
		"group:Work",
		"group:Play",
		"project:/p/alpha",
		"project:/p/gamma",
	]);
	expect(lines[0]?.kind === "group" && lines[0].projects.map((p) => p.cwd)).toEqual(["/p/beta"]);
});

test("a group with no project of the list in it is still drawn: it is where the next one goes", () => {
	const groups = [group("g1", "Empty", ["/p/gone"])];
	const lines = projectLines(withGroups(PROJECTS, groups), groups);
	expect(lines.map((l) => l.kind)).toEqual(["group", "project", "project", "project", "project"]);
	expect(lines[0]?.kind === "group" && lines[0].projects).toEqual([]);
});

test("a project in a group that is gone (deleted from another page) is at the top level, not lost", () => {
	const rows = [{ cwd: "/p/beta", count: 3, group: "gone" }];
	const lines = projectLines(rows, [group("g1", "Work", [])]);
	expect(lines.map((l) => [l.kind, l.kind === "project" ? l.project.cwd : l.group.name])).toEqual([
		["group", "Work"],
		["project", "/p/beta"],
	]);
});
