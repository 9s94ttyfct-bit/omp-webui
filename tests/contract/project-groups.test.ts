import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { placementOf } from "../../server/migrate/layout.ts";
import { ProjectGroupStore } from "../../server/project-groups.ts";
import type { ProjectGroup, ProjectGroupsAnswer } from "../../shared/project-groups.ts";
import { messageWhere } from "../support/frames.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect } from "../support/ws.ts";

/**
 * The sidebar's project groups (#636) over HTTP: `<data dir>/project-groups.json`, written by any page that holds the token
 * (as the pins and the archive are: they are how a page looks at the list, not a setting of this computer), and said to
 * every page as soon as it changes.
 */

let s: TestServer;
beforeAll(async () => {
	s = await startTestServer(0, {}, { login: false });
}, 120_000);
afterAll(async () => {
	await s?.stop();
});

const file = () => join(s.root, "data", "project-groups.json");

const call = (path: string, body?: unknown): Promise<Response> =>
	fetch(`${s.url}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			"x-omp-webui-token": s.accessToken,
			...(body === undefined ? {} : { "x-omp-webui": "1", "content-type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});

const answerOf = async (res: Response): Promise<ProjectGroupsAnswer> => {
	expect(res.status, await res.clone().text()).toBe(200);
	return (await res.json()) as ProjectGroupsAnswer;
};

async function created(name: string): Promise<ProjectGroup> {
	const answer = await answerOf(await call("/api/project-groups/create", { name }));
	const group = answer.group;
	if (!group) throw new Error("creating a group answered no group");
	return group;
}

/** The list as a page reads it. */
const listed = async () =>
	(await (await call("/api/project-groups")).json()) as { groups: ProjectGroup[]; problem: string | null };

test("a group is made, renamed, filled, folded, emptied and deleted, and each change is the list it leaves", async () => {
	const made = await created("Work");
	expect(made.name).toBe("Work");
	expect(made.projects).toEqual([]);

	expect((await answerOf(await call("/api/project-groups/rename", { id: made.id, name: "Job" }))).groups[0]?.name).toBe(
		"Job",
	);

	const moved = await answerOf(
		await call("/api/project-groups/move", { cwd: "/tmp/ompw-group-proj/", group: made.id }),
	);
	// A folder's trailing slash is not another folder.
	expect(moved.groups[0]?.projects).toEqual(["/tmp/ompw-group-proj"]);
	expect(moved.group?.id).toBe(made.id);

	const folded = await answerOf(await call("/api/project-groups/collapse", { id: made.id, collapsed: true }));
	expect(folded.group?.collapsed).toBe(true);
	expect((await listed()).groups[0]?.collapsed).toBe(true);

	// Out to the top level.
	expect(
		(await answerOf(await call("/api/project-groups/move", { cwd: "/tmp/ompw-group-proj", group: null }))).groups[0]
			?.projects,
	).toEqual([]);

	// Deleted: its projects are the top level's again, and nothing on disk is touched.
	const removed = await answerOf(await call("/api/project-groups/delete", { id: made.id }));
	expect(removed.group).toBeNull();
	expect(removed.groups.some((g) => g.id === made.id)).toBe(false);
	expect((await listed()).groups).toEqual([]);
});

test("a name another group has is refused, and the file is private and what the page read", async () => {
	await created("Home");
	const res = await call("/api/project-groups/create", { name: "home" });
	expect(res.status).toBe(400);
	const body = (await res.json()) as { code: string; params: Record<string, unknown> };
	expect(body.code).toBe("groupNameInvalid");
	expect(body.params.problem).toBe("taken");
	expect(statSync(file()).mode & 0o777).toBe(0o600);
	const stored = JSON.parse(readFileSync(file(), "utf8")) as { version: number; groups: ProjectGroup[] };
	expect(stored.version).toBe(1);
	expect(stored.groups).toEqual((await listed()).groups);
});

test("a change from one page reaches a second page's socket, and the second page reads the same list", async () => {
	// A socket of its own, as another tab of the person's is.
	const other = await connect(s);
	try {
		const told = messageWhere(other, (m) => m.t === "project_groups");
		const made = await created("Shared");
		// The frame comes when the change is written, with no timer of the test's: the change's own answer came first.
		await told;
		expect((await listed()).groups.some((g) => g.id === made.id && g.name === "Shared")).toBe(true);
	} finally {
		other.close();
	}
});

test("every refusal answers with a code the page words, and nothing is written", async () => {
	const before = existsSync(file()) ? readFileSync(file(), "utf8") : null;
	for (const [path, body, status, code] of [
		["/api/project-groups/create", { name: "" }, 400, "groupNameInvalid"],
		["/api/project-groups/create", { name: "x".repeat(61) }, 400, "groupNameInvalid"],
		["/api/project-groups/rename", { id: "nope", name: "Fine" }, 404, "groupUnknown"],
		["/api/project-groups/move", { cwd: "relative", group: null }, 400, "groupProjectInvalid"],
		["/api/project-groups/move", { cwd: "/tmp/x", group: "nope" }, 404, "groupUnknown"],
		["/api/project-groups/collapse", { id: "nope", collapsed: true }, 404, "groupUnknown"],
		["/api/project-groups/reorder", { id: "nope", delta: -1 }, 404, "groupUnknown"],
		["/api/project-groups/delete", { id: "nope" }, 404, "groupUnknown"],
	] as const) {
		const res = await call(path, body);
		expect(res.status, `${path} ${JSON.stringify(body)}: ${await res.clone().text()}`).toBe(status);
		const answer = (await res.json()) as { code?: string };
		expect(answer.code).toBe(code);
	}
	expect(existsSync(file()) ? readFileSync(file(), "utf8") : null).toBe(before);
});

test("a change is asked for with POST: a GET is the list, never a write", async () => {
	const before = (await listed()).groups;
	const res = await call("/api/project-groups/create");
	expect(res.status).toBe(405);
	expect((await listed()).groups).toEqual(before);
});

test("a page without the token is refused the groups, as it is the pins", async () => {
	// The same answer `/api/pins` and `/api/archive` give a request with no token: the routes are behind the same gate.
	for (const path of ["/api/pins", "/api/project-groups"]) {
		const res = await fetch(`${s.url}${path}`, { headers: { Origin: s.url } });
		expect(res.status, path).toBe(401);
	}
});

/**
 * The groups are this app's own data, so moving to another computer carries them ("This app's data"), and the importer
 * merges them by id: a person's groups here are kept and the archive's are added beside them.
 */
test("the groups file is one of this app's data files for a move to another computer", () => {
	expect(placementOf("webui/project-groups.json")).toEqual({ category: "webui", kind: "config" });
	// A temporary file beside it, or the copy kept of one that was not a list, is not data.
	expect(placementOf("webui/project-groups.json.8d1c.tmp")).toBeNull();
	expect(placementOf("webui/project-groups.json.damaged")).toBeNull();
});

test("the first change makes the data dir's file, private, with nothing beside it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-groups-contract-"));
	try {
		mkdirSync(join(dir, "nested"), { mode: 0o700 });
		const store = new ProjectGroupStore(join(dir, "nested"));
		await store.create("Work");
		expect(readdirSync(join(dir, "nested"))).toEqual(["project-groups.json"]);
		expect(statSync(join(dir, "nested", "project-groups.json")).mode & 0o777).toBe(0o600);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
