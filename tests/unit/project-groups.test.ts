import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectGroupError, ProjectGroupStore } from "../../server/project-groups.ts";
import {
	GROUP_NAME_MAX,
	groupNameProblem,
	type ProjectGroup,
	parseGroupName,
	parseGroups,
	serializeGroups,
} from "../../shared/project-groups.ts";

/**
 * The sidebar's project groups (#636): one file of this app's own, `<data dir>/project-groups.json`, written whole and
 * private. A file somebody edited, an older version wrote, or a crash cut off must cost the person only the entries that
 * do not fit, never the rest of their groups and never a project folder.
 */

let dir: string;
let warned: ReturnType<typeof spyOn>;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompw-groups-"));
	warned = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	warned.mockRestore();
	rmSync(dir, { recursive: true, force: true });
});

const file = () => join(dir, "project-groups.json");
const group = (id: string, name: string, projects: string[] = [], order = 0): ProjectGroup => ({
	id,
	name,
	order,
	collapsed: false,
	projects,
});
const refused = async (run: Promise<unknown>): Promise<ProjectGroupError> => {
	try {
		await run;
	} catch (e) {
		expect(e).toBeInstanceOf(ProjectGroupError);
		return e as ProjectGroupError;
	}
	throw new Error("the change was not refused");
};

test("a change is a whole file or none: the file is replaced, never written in place", async () => {
	const store = new ProjectGroupStore(dir);
	await store.create("Work");
	const before = readFileSync(file(), "utf8");
	await store.create("Home");
	// What the first change left is still readable on its own: a reader that opened it before the second saw a whole list.
	expect(JSON.parse(before)).toEqual({
		version: 1,
		groups: [{ id: expect.any(String), name: "Work", order: 0, collapsed: false, projects: [] }],
	});
	expect(JSON.parse(readFileSync(file(), "utf8")).groups.map((g: ProjectGroup) => g.name)).toEqual(["Work", "Home"]);
	// No temporary file is left beside it.
	expect(readdirSync(dir)).toEqual(["project-groups.json"]);
});

test("the file is private: 0600, whatever the umask", async () => {
	const store = new ProjectGroupStore(dir);
	await store.create("Work");
	expect(statSync(file()).mode & 0o777).toBe(0o600);
});

test("a name is trimmed, and two names that read the same are one name", async () => {
	const store = new ProjectGroupStore(dir);
	const made = await store.create("  Work  ");
	expect(made.group?.name).toBe("Work");
	for (const name of ["work", "WORK", "Wörk", "Ｗork"]) {
		const e = await refused(store.create(name));
		expect(e.status).toBe(400);
		expect(e.code).toBe("groupNameInvalid");
		expect(e.params.problem).toBe("taken");
	}
	// Its own name is not another group's: renaming a group to itself is no change, and not a refusal.
	const same = await store.rename(made.group?.id as string, "Work");
	expect(same.group?.name).toBe("Work");
	expect((await refused(store.create("x".repeat(GROUP_NAME_MAX + 1)))).params.problem).toBe("tooLong");
	expect((await refused(store.create("   "))).params.problem).toBe("empty");
	expect((await refused(store.create("Work\u202e"))).params.problem).toBe("invalid");
	expect(store.list().groups).toHaveLength(1);
});

test("a malformed file keeps the groups that fit, and one that is no list at all is kept beside the next write", async () => {
	// A cut-off file: not JSON. Nothing is listed, and the change does not write over what may be a person's file.
	writeFileSync(file(), '{"version":1,"groups":[{"id":"a","name":"Wo');
	const store = new ProjectGroupStore(dir);
	expect(store.list()).toEqual({ groups: [], problem: "damaged" });
	await store.create("Home");
	expect(readFileSync(`${file()}.damaged`, "utf8")).toBe('{"version":1,"groups":[{"id":"a","name":"Wo');
	expect((store.list().groups as ProjectGroup[]).map((g) => g.name)).toEqual(["Home"]);
	expect(warned).toHaveBeenCalled();
});

test("a list whose entries do not fit loses those entries only", async () => {
	const good = group("a", "Work", ["/p/one"], 1);
	writeFileSync(
		file(),
		JSON.stringify({
			version: 1,
			groups: [
				{ id: "b" }, // no name
				good,
				{ id: "a", name: "Other" }, // the id is taken
				{ id: "c", name: "work" }, // the name is taken (case does not tell two apart)
				{ id: "d", name: "  " }, // blank
				{ id: "e", name: "Play", projects: ["/p/two", "/p/two", 7, ""] },
				"not a group",
			],
		}),
	);
	const groups = parseGroups(JSON.parse(readFileSync(file(), "utf8"))) ?? [];
	expect(groups.map((g) => [g.id, g.name, g.projects])).toEqual([
		["a", "Work", ["/p/one"]],
		["e", "Play", ["/p/two"]],
	]);
	// The store reports the file as not all usable, and the next change keeps a copy of it first.
	const store = new ProjectGroupStore(dir);
	expect(store.list().problem).toBe("damaged");
	expect((store.list().groups as ProjectGroup[]).map((g) => g.id)).toEqual(["a", "e"]);
});

test("a project is in one group: the first group in the list keeps it, and a folder named twice in it is there once", () => {
	const groups = parseGroups({
		groups: [
			{ id: "b", name: "Second", order: 2, projects: ["/p/shared"] },
			{ id: "a", name: "First", order: 1, projects: ["/p/shared", "/p/own", "/p/own"] },
		],
	}) as ProjectGroup[];
	expect(groups.map((g) => [g.name, g.projects])).toEqual([
		["First", ["/p/shared", "/p/own"]],
		["Second", []],
	]);
});

test("order decides the list; an order that is no number is the group's place in the file", () => {
	const groups = parseGroups({
		groups: [
			{ id: "a", name: "A", order: 9 },
			{ id: "b", name: "B" },
			{ id: "c", name: "C", order: "1" },
			{ id: "d", name: "D", order: 0 },
			{ id: "e", name: "E", order: 1 },
		],
	}) as ProjectGroup[];
	// B and C have their place in the file (1 and 2); D and E are 0 and 1, and a tie keeps the file's order by name.
	expect(groups.map((g) => g.name)).toEqual(["D", "B", "E", "C", "A"]);
	expect(groups.find((g) => g.name === "B")?.order).toBe(1);
	expect(groups.find((g) => g.name === "C")?.order).toBe(2);
});

test("deleting a group keeps its projects: they are the top level's again, and no folder is touched", async () => {
	const store = new ProjectGroupStore(dir);
	const work = (await store.create("Work")).group as ProjectGroup;
	await store.move("/p/one", work.id);
	await store.move("/p/two", work.id);
	const projects = join(dir, "p");
	mkdirSync(projects);
	writeFileSync(join(projects, "keep.txt"), "kept");
	const answer = await store.remove(work.id);
	expect(answer.group).toBeNull();
	expect(answer.groups).toEqual([]);
	// Nothing on disk changed but the groups file, and the projects file is still there.
	expect(readdirSync(dir).sort()).toEqual(["p", "project-groups.json"]);
	expect(readFileSync(join(projects, "keep.txt"), "utf8")).toBe("kept");
	expect(existsSync(join(projects, "one"))).toBe(false);
});

test("a project's folder is not looked at: a project that is gone from the list is kept where the person put it", async () => {
	const store = new ProjectGroupStore(dir);
	const work = (await store.create("Work")).group as ProjectGroup;
	await store.move("/p/not-there-yet", work.id);
	// A project the sidebar has never shown, whose folder does not exist, is still in the group.
	expect(store.list().groups[0]?.projects).toEqual(["/p/not-there-yet"]);
	// Reading it back from the file (a server start) keeps it too.
	const again = new ProjectGroupStore(dir);
	expect(again.list().groups[0]?.projects).toEqual(["/p/not-there-yet"]);
});

test("moving a project out of a group, and into another, leaves it in one group only", async () => {
	const store = new ProjectGroupStore(dir);
	const work = (await store.create("Work")).group as ProjectGroup;
	const play = (await store.create("Play")).group as ProjectGroup;
	await store.move("/p/one", work.id);
	await store.move("/p/one", play.id);
	let groups = store.list().groups;
	expect(groups.map((g) => g.projects)).toEqual([[], ["/p/one"]]);
	// Out to the top level: no group names it.
	await store.move("/p/one", null);
	groups = store.list().groups;
	expect(groups.map((g) => g.projects)).toEqual([[], []]);
	// And a project no group has can be moved to the top level without a write.
	const before = readFileSync(file(), "utf8");
	await store.move("/p/one", null);
	expect(readFileSync(file(), "utf8")).toBe(before);
});

test("a move refuses a project that is not named by a folder, and a group that is not there", async () => {
	const store = new ProjectGroupStore(dir);
	const e = await refused(store.move("relative/path", null));
	expect(e.status).toBe(400);
	expect(e.code).toBe("groupProjectInvalid");
	for (const bad of ["", "/p\u0000x", "https://example.com/x"])
		expect((await refused(store.move(bad, null))).status).toBe(400);
	const missing = await refused(store.move("/p/one", "no-such-id"));
	expect(missing.status).toBe(404);
	expect(missing.code).toBe("groupUnknown");
	expect((await refused(store.rename("no-such-id", "Name"))).status).toBe(404);
	expect((await refused(store.remove("no-such-id"))).status).toBe(404);
	expect((await refused(store.setCollapsed("no-such-id", true))).status).toBe(404);
	expect(existsSync(file())).toBe(false);
});

test("a folder's trailing slash is not another folder", async () => {
	const store = new ProjectGroupStore(dir);
	const work = (await store.create("Work")).group as ProjectGroup;
	await store.move("/p/one/", work.id);
	await store.move("/p/one", work.id);
	expect(store.list().groups[0]?.projects).toEqual(["/p/one"]);
});

test("the collapse state is kept, and is the group's own, not a page's", async () => {
	const store = new ProjectGroupStore(dir);
	const work = (await store.create("Work")).group as ProjectGroup;
	expect(work.collapsed).toBe(false);
	await store.setCollapsed(work.id, true);
	expect(new ProjectGroupStore(dir).list().groups[0]?.collapsed).toBe(true);
	const before = readFileSync(file(), "utf8");
	await store.setCollapsed(work.id, true);
	expect(readFileSync(file(), "utf8")).toBe(before);
});

test("a group keeps its id and its projects when it is renamed, and its place in the list", async () => {
	const store = new ProjectGroupStore(dir);
	const one = (await store.create("One")).group as ProjectGroup;
	await store.create("Two");
	await store.move("/p/one", one.id);
	const renamed = await store.rename(one.id, "Uno");
	expect(renamed.group?.id).toBe(one.id);
	expect(renamed.group?.projects).toEqual(["/p/one"]);
	expect(renamed.groups.map((g) => g.name)).toEqual(["Uno", "Two"]);
});

test("reordering swaps a group with its neighbour, and stops at either end", async () => {
	const store = new ProjectGroupStore(dir);
	await store.create("One");
	const two = (await store.create("Two")).group as ProjectGroup;
	await store.create("Three");
	await store.reorder(two.id, -1);
	expect(store.list().groups.map((g) => [g.name, g.order])).toEqual([
		["Two", 0],
		["One", 1],
		["Three", 2],
	]);
	await store.reorder(two.id, -1);
	expect(store.list().groups.map((g) => g.name)).toEqual(["Two", "One", "Three"]);
	await store.reorder(two.id, 1);
	expect(store.list().groups.map((g) => g.name)).toEqual(["One", "Two", "Three"]);
});

test("every change is announced once, after it was written, and no change writes nothing", async () => {
	let told = 0;
	const store = new ProjectGroupStore(dir, () => told++);
	const work = (await store.create("Work")).group as ProjectGroup;
	expect(told).toBe(1);
	await store.rename(work.id, "Work");
	expect(told).toBe(1);
	await store.rename(work.id, "Job");
	expect(told).toBe(2);
	await store.setCollapsed(work.id, false);
	expect(told).toBe(2);
	await store.setCollapsed(work.id, true);
	expect(told).toBe(3);
	expect(warned).not.toHaveBeenCalled();
});

test("what is written reads back as the same list", () => {
	const groups = [group("a", "Work", ["/p/one", "/p/two"], 0), { ...group("b", "Play", [], 1), collapsed: true }];
	expect(parseGroups(JSON.parse(serializeGroups(groups)))).toEqual(groups);
});

test("a name's checks are the same on the page and on the server", () => {
	expect(parseGroupName("Work")).toEqual({ ok: true, name: "Work" });
	expect(parseGroupName("")).toEqual({ ok: false, problem: "empty" });
	expect(groupNameProblem([], "Work")).toBeNull();
	expect(groupNameProblem([group("a", "Work")], "work")).toBe("taken");
	expect(groupNameProblem([group("a", "Work")], "work", "a")).toBeNull();
});
