import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ChatProjectError, ChatProjectStore } from "../../server/chat-projects.ts";
import {
	type ChatProject,
	chatProjectOfScope,
	chatProjectScope,
	PROJECT_NAME_MAX,
	parseChatProjects,
	parseProjectName,
	projectNameProblem,
	projectsFromGroups,
	projectsOf,
	serializeChatProjects,
} from "../../shared/chat-projects.ts";
import { expectMode } from "../support/modes.ts";

/**
 * The sidebar's projects: one file of this app's own, `<data dir>/chat-projects.json`, written whole and private, keyed by
 * session ids. A file somebody edited, an older version wrote, or a crash cut off must cost the person only the entries
 * that do not fit; the project groups of #636 become projects the first time the list is read; a conversation branched
 * from one in a project is in that project too, until it is moved or taken out itself.
 */

let dir: string;
let folder: string;
let warned: ReturnType<typeof spyOn>;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompw-projects-"));
	folder = join(dir, "work");
	mkdirSync(folder);
	warned = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	warned.mockRestore();
	rmSync(dir, { recursive: true, force: true });
});

const file = () => join(dir, "chat-projects.json");
const noSessions = async () => [];
const store = (sessions: () => Promise<{ id: string; cwd: string }[]> = noSessions, onChange = () => {}) =>
	new ChatProjectStore(dir, sessions, onChange);
const project = (id: string, name: string, sessions: string[] = [], order = 0): ChatProject => ({
	id,
	name,
	folder: null,
	order,
	collapsed: false,
	sessions,
});
const refused = async (run: Promise<unknown>): Promise<ChatProjectError> => {
	try {
		await run;
	} catch (e) {
		expect(e).toBeInstanceOf(ChatProjectError);
		return e as ChatProjectError;
	}
	throw new Error("the change was not refused");
};

test("a name is trimmed, kept to its length, and refused with a reason the page words", () => {
	expect(parseProjectName("  Work ")).toEqual({ ok: true, name: "Work" });
	expect(parseProjectName("   ")).toEqual({ ok: false, problem: "empty" });
	expect(parseProjectName("x".repeat(PROJECT_NAME_MAX + 1))).toEqual({ ok: false, problem: "tooLong" });
	// Characters, not code units: 60 emoji are a name.
	expect(parseProjectName("🦩".repeat(PROJECT_NAME_MAX)).ok).toBe(true);
	expect(parseProjectName("a\nb")).toEqual({ ok: false, problem: "invalid" });
	expect(parseProjectName("a\u202eb")).toEqual({ ok: false, problem: "invalid" });
	// Case, accents and width do not make another name; the project being renamed keeps its own.
	const list = [project("a", "Résumé")];
	expect(projectNameProblem(list, "resume")).toBe("taken");
	expect(projectNameProblem(list, "ＲＥＳＵＭＥ")).toBe("taken");
	expect(projectNameProblem(list, "RESUME", "a")).toBeNull();
});

test("the file is read leniently: what does not fit is dropped, a conversation is in one project", () => {
	expect(parseChatProjects(null)).toBeNull();
	expect(parseChatProjects({ groups: [] })).toBeNull();
	const parsed = parseChatProjects({
		projects: [
			{ id: "b", name: "Second", order: 1, sessions: ["s1", "s3"], folder: "relative/path" },
			{ id: "a", name: "First", order: 0, sessions: ["s1", "s2", 7, ""], folder: "/work/a/", collapsed: true },
			{ id: "c", name: "first", order: 2 },
			{ id: "", name: "No id" },
			{ id: "d", name: "" },
			"not a project",
		],
		excluded: ["s2", "s9", "s9", 4],
	});
	expect(parsed?.projects).toEqual([
		{ id: "a", name: "First", folder: "/work/a", order: 0, collapsed: true, sessions: ["s1", "s2"] },
		{ id: "b", name: "Second", folder: null, order: 1, collapsed: false, sessions: ["s3"] },
	]);
	// An id a project holds is not taken out of every project as well.
	expect(parsed?.excluded).toEqual(["s9"]);
	const text = serializeChatProjects(parsed?.projects ?? [], parsed?.excluded ?? []);
	expect(parseChatProjects(JSON.parse(text))).toEqual(parsed);
});

test("membership is by session id, so a moved or renamed file keeps its project", () => {
	const projects = [project("p", "Work", ["id-1"])];
	const before = projectsOf([{ file: "/s/a/one.jsonl", id: "id-1", parentSession: null }], projects, []);
	expect(before.get("/s/a/one.jsonl")).toEqual({ project: "p", inherited: false });
	// omp's `/move` writes the conversation to another file; its id is the same.
	const after = projectsOf([{ file: "/s/b/one.jsonl", id: "id-1", parentSession: null }], projects, []);
	expect(after.get("/s/b/one.jsonl")).toEqual({ project: "p", inherited: false });
});

test("a branch, a fork or a copy is in the project of the conversation it came from, up the chain", () => {
	const sessions = [
		{ file: "/s/root.jsonl", id: "root", parentSession: null },
		// A parent named by its file, by its id, and by a file that has moved since (the id in its name).
		{ file: "/s/branch.jsonl", id: "branch", parentSession: "/s/root.jsonl" },
		{ file: "/s/fork.jsonl", id: "01a00000-fork", parentSession: "branch" },
		{ file: "/s/copy.jsonl", id: "copy", parentSession: "/old/place/2026-01-01T00-00-00_01a00000-fork.jsonl" },
		{ file: "/s/other.jsonl", id: "other", parentSession: null },
	];
	const projects = [project("p", "Work", ["root"]), project("q", "Home", ["01a00000-fork"], 1)];
	const m = projectsOf(sessions, projects, []);
	expect(m.get("/s/root.jsonl")).toEqual({ project: "p", inherited: false });
	expect(m.get("/s/branch.jsonl")).toEqual({ project: "p", inherited: true });
	// One that is in a project of its own is there, and what came from it goes with it.
	expect(m.get("/s/fork.jsonl")).toEqual({ project: "q", inherited: false });
	expect(m.get("/s/copy.jsonl")).toEqual({ project: "q", inherited: true });
	expect(m.has("/s/other.jsonl")).toBe(false);
	// Taken out on purpose: neither it nor what came from it is in its parent's project.
	const out = projectsOf(sessions, [project("p", "Work", ["root"])], ["branch"]);
	expect(out.has("/s/branch.jsonl")).toBe(false);
	expect(out.has("/s/fork.jsonl")).toBe(false);
	expect(out.get("/s/root.jsonl")?.project).toBe("p");
});

test("a chain that loops ends where it loops", () => {
	const sessions = [
		{ file: "/s/a.jsonl", id: "a", parentSession: "b" },
		{ file: "/s/b.jsonl", id: "b", parentSession: "a" },
	];
	expect(projectsOf(sessions, [], []).size).toBe(0);
	expect(projectsOf(sessions, [project("p", "Work", ["a"])], []).get("/s/b.jsonl")).toEqual({
		project: "p",
		inherited: true,
	});
});

test("a project is made, renamed, given a folder, filled, reordered and deleted; deleting it keeps its conversations", async () => {
	const told: number[] = [];
	const s = store(noSessions, () => told.push(1));
	const work = (await s.create("Work")).project as ChatProject;
	const home = (await s.create("Home", null, ["c1"])).project as ChatProject;
	expect(home.sessions).toEqual(["c1"]);
	expect((await s.rename(work.id, "Job")).project?.name).toBe("Job");
	expect((await s.setFolder(work.id, `${folder}/`)).project?.folder).toBe(folder);
	// A conversation is in one project: moving it takes it out of the other.
	const moved = await s.assign(["c1", "c2"], work.id);
	expect(moved.projects.find((p) => p.id === work.id)?.sessions).toEqual(["c1", "c2"]);
	expect(moved.projects.find((p) => p.id === home.id)?.sessions).toEqual([]);
	// Out of every project: remembered as out, and back in when it is moved again.
	expect((await s.assign(["c2"], null)).excluded).toEqual(["c2"]);
	expect((await s.assign(["c2"], home.id)).excluded).toEqual([]);
	expect((await s.reorder(home.id, -1)).projects.map((p) => p.name)).toEqual(["Home", "Job"]);
	expect((await s.setCollapsed(home.id, true)).project?.collapsed).toBe(true);
	// Deleted: its conversations are in no project (the page lists them by date again); none is touched.
	const removed = await s.remove(home.id);
	expect(removed.projects.map((p) => p.name)).toEqual(["Job"]);
	expect(removed.projects.flatMap((p) => p.sessions)).toEqual(["c1"]);
	expect(removed.project).toBeNull();
	expect((await s.list()).projects).toEqual(removed.projects);
	// Every change that was written told the pages.
	expect(told.length).toBe(10);
	expectMode(file(), 0o600);
	expect(readdirSync(dir).sort()).toEqual(["chat-projects.json", "work"]);
});

test("every refusal leaves the file as it was", async () => {
	const s = store();
	const made = (await s.create("Work")).project as ChatProject;
	const before = readFileSync(file(), "utf8");
	expect((await refused(s.create("work"))).code).toBe("projectNameInvalid");
	expect((await refused(s.create(""))).params).toEqual({ problem: "empty" });
	expect((await refused(s.rename("nope", "X"))).status).toBe(404);
	expect((await refused(s.setFolder(made.id, "relative"))).code).toBe("projectFolderInvalid");
	expect((await refused(s.setFolder(made.id, join(dir, "missing")))).code).toBe("projectFolderInvalid");
	expect((await refused(s.assign(["ok", ""], made.id))).code).toBe("projectSessionInvalid");
	expect((await refused(s.assign(["ok"], "nope"))).code).toBe("projectUnknown");
	expect((await refused(s.remove("nope"))).code).toBe("projectUnknown");
	expect(readFileSync(file(), "utf8")).toBe(before);
});

test("a file that is not a list is kept beside itself when the next change writes", async () => {
	writeFileSync(file(), "{ not json");
	const s = store();
	expect(await s.list()).toEqual({ projects: [], excluded: [], problem: "damaged" });
	await s.create("Fresh");
	expect(readFileSync(`${file()}.damaged`, "utf8")).toBe("{ not json");
	expect((await s.list()).projects.map((p) => p.name)).toEqual(["Fresh"]);
});

test("the project groups of #636 become projects the first time, by the folders their conversations ran in", async () => {
	const groups = {
		version: 1,
		groups: [
			{ id: "g1", name: "Clients", order: 0, collapsed: true, projects: ["/work/acme", "/work/globex/"] },
			{ id: "g2", name: "Personal", order: 1, collapsed: false, projects: ["/srv/notes"] },
			{ id: "g3", name: "Empty", order: 2, projects: [] },
			// A folder another group has is the first group's, as the list showed it.
			{ id: "g4", name: "Dup", order: 3, projects: ["/work/acme"] },
			{ id: "g5", name: "" },
		],
	};
	writeFileSync(join(dir, "project-groups.json"), JSON.stringify(groups));
	const sessions = [
		{ id: "s-acme", cwd: "/work/acme" },
		{ id: "s-globex", cwd: "/work/globex" },
		{ id: "s-notes", cwd: "/srv/notes" },
		{ id: "s-loose", cwd: "/elsewhere" },
	];
	let asked = 0;
	const s = store(async () => {
		asked++;
		return sessions;
	});
	const listed = await s.list();
	expect(listed.projects).toEqual([
		{
			id: "g1",
			name: "Clients",
			folder: null,
			order: 0,
			collapsed: true,
			sessions: ["s-acme", "s-globex"],
		},
		{ id: "g2", name: "Personal", folder: "/srv/notes", order: 1, collapsed: false, sessions: ["s-notes"] },
		{ id: "g3", name: "Empty", folder: null, order: 2, collapsed: false, sessions: [] },
		{ id: "g4", name: "Dup", folder: null, order: 3, collapsed: false, sessions: [] },
	]);
	expect(existsSync(file())).toBe(true);
	// The old file is left where it was, and not read again: a new server reads the new list.
	expect(existsSync(join(dir, "project-groups.json"))).toBe(true);
	writeFileSync(
		join(dir, "project-groups.json"),
		JSON.stringify({ groups: [{ id: "x", name: "Late", projects: [] }] }),
	);
	expect((await store(async () => sessions).list()).projects.map((p) => p.name)).toEqual([
		"Clients",
		"Personal",
		"Empty",
		"Dup",
	]);
	expect(asked).toBe(1);
});

test("the move from groups is pure: a file that is not a list of groups makes nothing", () => {
	expect(projectsFromGroups({ projects: [] }, [])).toBeNull();
	expect(projectsFromGroups({ groups: [] }, [])).toEqual([]);
});

test("a project's Files scope names the project, never a folder", () => {
	expect(chatProjectOfScope(chatProjectScope("abc"))).toBe("abc");
	expect(chatProjectOfScope("/sessions/x.jsonl")).toBeNull();
	expect(chatProjectOfScope(null)).toBeNull();
	expect(chatProjectOfScope(chatProjectScope(""))).toBeNull();
});
