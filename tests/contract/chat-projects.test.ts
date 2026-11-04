import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { placementOf } from "../../server/migrate/layout.ts";
import type { ChatProject, ChatProjects, ChatProjectsAnswer } from "../../shared/chat-projects.ts";
import { messageWhere } from "../support/frames.ts";
import { expectMode } from "../support/modes.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect } from "../support/ws.ts";

/**
 * The sidebar's projects over HTTP: `<data dir>/chat-projects.json`, written by any page that holds the token (as the pins
 * and the archive are: they are how a page looks at the list, not a setting of this computer), answered whole by every
 * change, and said to every page as soon as it changes. The Files panel of a project reads the project's folder, which the
 * server finds from the project's id.
 */

let s: TestServer;
beforeAll(async () => {
	s = await startTestServer(0, {}, { login: false });
}, 120_000);
afterAll(async () => {
	await s?.stop();
});

const file = () => join(s.root, "data", "chat-projects.json");

const call = (path: string, body?: unknown): Promise<Response> =>
	fetch(`${s.url}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			"x-omp-webui-token": s.accessToken,
			...(body === undefined ? {} : { "x-omp-webui": "1", "content-type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});

const answerOf = async (res: Response): Promise<ChatProjectsAnswer> => {
	expect(res.status, await res.clone().text()).toBe(200);
	return (await res.json()) as ChatProjectsAnswer;
};

async function created(name: string, sessions: string[] = []): Promise<ChatProject> {
	const answer = await answerOf(await call("/api/chat-projects/create", { name, sessions }));
	if (!answer.project) throw new Error("creating a project answered no project");
	return answer.project;
}

/** The list as a page reads it. */
const listed = async () => (await (await call("/api/chat-projects")).json()) as ChatProjects;

test("a project is made, renamed, given a folder, filled, emptied, reordered and deleted: each answer is the whole list", async () => {
	const work = await created("Work");
	const home = await created("Home", ["sess-1"]);
	expect(home.sessions).toEqual(["sess-1"]);

	const renamed = await answerOf(await call("/api/chat-projects/rename", { id: work.id, name: "Job" }));
	expect(renamed.projects.map((p) => p.name)).toEqual(["Job", "Home"]);

	const folder = join(s.work, "project-folder");
	mkdirSync(folder, { recursive: true });
	const withFolder = await answerOf(await call("/api/chat-projects/folder", { id: work.id, folder }));
	expect(withFolder.project?.folder).toBe(folder);

	// Into a project: out of the one it was in.
	const moved = await answerOf(
		await call("/api/chat-projects/assign", { sessions: ["sess-1", "sess-2"], project: work.id }),
	);
	expect(moved.projects.find((p) => p.id === work.id)?.sessions).toEqual(["sess-1", "sess-2"]);
	expect(moved.projects.find((p) => p.id === home.id)?.sessions).toEqual([]);
	// Out of every project.
	const out = await answerOf(await call("/api/chat-projects/assign", { sessions: ["sess-2"], project: null }));
	expect(out.excluded).toEqual(["sess-2"]);
	expect(out.projects.find((p) => p.id === work.id)?.sessions).toEqual(["sess-1"]);

	const folded = await answerOf(await call("/api/chat-projects/collapse", { id: home.id, collapsed: true }));
	expect(folded.project?.collapsed).toBe(true);
	const reordered = await answerOf(await call("/api/chat-projects/reorder", { id: home.id, delta: -1 }));
	expect(reordered.projects.map((p) => p.name)).toEqual(["Home", "Job"]);

	// Deleted: its conversations are in no project; the list a page reads is the answer.
	const removed = await answerOf(await call("/api/chat-projects/delete", { id: work.id }));
	expect(removed.project).toBeNull();
	expect(removed.projects.map((p) => p.name)).toEqual(["Home"]);
	expect(removed.projects.flatMap((p) => p.sessions)).toEqual([]);
	expect(await listed()).toEqual({ projects: removed.projects, excluded: removed.excluded, problem: null });
	await answerOf(await call("/api/chat-projects/delete", { id: home.id }));

	expectMode(file(), 0o600);
	const stored = JSON.parse(readFileSync(file(), "utf8")) as { version: number; projects: ChatProject[] };
	expect(stored.version).toBe(1);
	expect(stored.projects).toEqual((await listed()).projects);
});

test("a change from one page reaches a second page's socket, and the second page reads the same list", async () => {
	const other = await connect(s);
	try {
		const told = messageWhere(other, (m) => m.t === "chat_projects");
		const made = await created("Shared");
		await told;
		expect((await listed()).projects.some((p) => p.id === made.id && p.name === "Shared")).toBe(true);
		await answerOf(await call("/api/chat-projects/delete", { id: made.id }));
	} finally {
		other.close();
	}
});

test("a project's Files panel lists the project's folder, found by its id; a project without one is refused", async () => {
	const folder = join(s.work, "files-of-a-project");
	mkdirSync(folder, { recursive: true });
	await Bun.write(join(folder, "notes.md"), "# notes\n");
	const made = await created("With files");
	const scope = encodeURIComponent(`chat-project:${made.id}`);
	const before = await call(`/api/folder/list?file=${scope}&path=`);
	expect(before.status).toBe(404);
	await answerOf(await call("/api/chat-projects/folder", { id: made.id, folder }));
	const listing = (await (await call(`/api/folder/list?file=${scope}&path=`)).json()) as {
		entries: { name: string }[];
	};
	expect(listing.entries.map((e) => e.name)).toContain("notes.md");
	// A project that is not there names no folder.
	expect((await call(`/api/folder/list?file=${encodeURIComponent("chat-project:nope")}&path=`)).status).toBe(404);
	await answerOf(await call("/api/chat-projects/delete", { id: made.id }));
});

test("every refusal answers with a code the page words, and nothing is written", async () => {
	const stored = () => (existsSync(file()) ? readFileSync(file(), "utf8") : null);
	const before = stored();
	for (const [path, body, status, code] of [
		["/api/chat-projects/create", { name: "" }, 400, "projectNameInvalid"],
		["/api/chat-projects/create", { name: "x".repeat(61) }, 400, "projectNameInvalid"],
		["/api/chat-projects/rename", { id: "nope", name: "Fine" }, 404, "projectUnknown"],
		["/api/chat-projects/folder", { id: "nope", folder: "/tmp" }, 404, "projectUnknown"],
		["/api/chat-projects/assign", { sessions: ["x"], project: "nope" }, 404, "projectUnknown"],
		["/api/chat-projects/assign", { sessions: [""], project: null }, 400, "projectSessionInvalid"],
		["/api/chat-projects/collapse", { id: "nope", collapsed: true }, 404, "projectUnknown"],
		["/api/chat-projects/reorder", { id: "nope", delta: -1 }, 404, "projectUnknown"],
		["/api/chat-projects/delete", { id: "nope" }, 404, "projectUnknown"],
	] as const) {
		const res = await call(path, body);
		expect(res.status, `${path} ${JSON.stringify(body)}: ${await res.clone().text()}`).toBe(status);
		expect(((await res.json()) as { code?: string }).code).toBe(code);
	}
	expect(stored()).toBe(before);
	// A folder that is not there is refused too, with the list as it was.
	const made = await created("Folder check");
	const after = stored();
	const res = await call("/api/chat-projects/folder", { id: made.id, folder: join(s.work, "no-such-folder") });
	expect(res.status).toBe(400);
	expect(((await res.json()) as { code?: string }).code).toBe("projectFolderInvalid");
	expect(stored()).toBe(after);
	await answerOf(await call("/api/chat-projects/delete", { id: made.id }));
});

test("a change is asked for with POST: a GET is the list, never a write", async () => {
	const before = (await listed()).projects;
	expect((await call("/api/chat-projects/create")).status).toBe(405);
	expect((await listed()).projects).toEqual(before);
});

test("a page without the token is refused the projects, as it is the pins", async () => {
	for (const path of ["/api/pins", "/api/chat-projects"]) {
		const res = await fetch(`${s.url}${path}`, { headers: { Origin: s.url } });
		expect(res.status, path).toBe(401);
	}
});

test("the projects file is one of this app's data files for a move to another computer", () => {
	expect(placementOf("webui/chat-projects.json")).toEqual({ category: "webui", kind: "config" });
	expect(placementOf("webui/chat-projects.json.8d1c.tmp")).toBeNull();
	expect(placementOf("webui/chat-projects.json.damaged")).toBeNull();
});
