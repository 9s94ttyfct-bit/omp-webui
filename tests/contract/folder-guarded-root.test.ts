import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CSRF_HEADER } from "../../shared/transfer.ts";
import { writeChatSession } from "../support/chat-session.ts";
import { proxiedClient, remoteSettings } from "../support/remote-client.ts";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * A page that holds only the token is kept out of a conversation's folder that it would be refused inside one (#219): the
 * folder is its own choice (a new conversation starts anywhere), so a conversation started in `~/.config/gh`, in omp's agent
 * folder or in a repository's `.git` shows it nothing and takes no save from it. The person's own page is not held to it.
 *
 *   home/.config/gh/hosts.yml   a token, in a folder hidden on the way down from home
 *   work/proj/.git/config       a repository's own folder, outside home
 *   work/proj/notes.md          an ordinary project
 */

const root = mkdtempSync(join(tmpdir(), "ompw-guarded-root-"));
const settingsFile = join(root, "remote.json");
let s: TestServer;
let home: string;
let proj: string;
let inGh: string;
let inAgent: string;
let inGit: string;
let inProj: string;

beforeAll(async () => {
	writeFileSync(settingsFile, JSON.stringify(remoteSettings({ fileTransfer: "full", remoteShell: false })));
	s = await startTestServer(0, { OMP_WEBUI_REMOTE_CONFIG: settingsFile }, { login: false });
	home = realpathSync(s.home);
	proj = join(realpathSync(s.work), "proj");
	mkdirSync(join(home, ".config/gh"), { recursive: true });
	writeFileSync(join(home, ".config/gh/hosts.yml"), "github.com:\n    oauth_token: gho_FAKE\n");
	mkdirSync(join(proj, ".git"), { recursive: true });
	writeFileSync(join(proj, ".git/config"), "[core]\n\tbare = false\n");
	writeFileSync(join(proj, "notes.md"), "# Notes\n");
	const chat = (n: number, cwd: string) =>
		writeChatSession(s.agentDir, { n, title: `Root ${n}`, cwd, turns: [{ prompt: "hi", reply: "ok" }] });
	inGh = chat(201, join(home, ".config/gh"));
	inAgent = chat(202, realpathSync(s.agentDir));
	inGit = chat(203, join(proj, ".git"));
	inProj = chat(204, proj);
}, 90_000);

afterAll(async () => {
	await s?.stop();
	rmSync(root, { recursive: true, force: true });
});

const token = () => proxiedClient(s);
const owner = (path: string) => fetch(`${s.url}${path}`, { headers: { "x-omp-webui-token": s.accessToken } });
const q = (o: Record<string, string>) => new URLSearchParams(o).toString();

describe("a token-only page in a folder it is kept out of (#219)", () => {
	test("lists and reads nothing of a conversation in ~/.config/gh or in omp's agent folder", async () => {
		for (const file of [inGh, inAgent]) {
			expect((await token().fetch(`/api/folder/list?${q({ file, path: "" })}`)).status).toBe(403);
			expect((await token().fetch(`/api/folder/find?${q({ file, q: "yml" })}`)).status).toBe(403);
		}
		const read = await token().fetch(`/api/folder/file?${q({ file: inGh, path: "hosts.yml" })}`);
		expect(read.status).toBe(403);
		expect(await read.text()).not.toContain("gho_FAKE");
		const download = await token().fetch(`/api/folder/download?${q({ file: inGh, path: "hosts.yml" })}`);
		expect(download.status).toBe(403);
	});

	test("is offered no file name there when it completes an @", async () => {
		const res = await token().fetch(`/api/files?${q({ cwd: join(home, ".config/gh"), q: "" })}`);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});

	test("reads and saves nothing of a repository's .git outside the home folder, as the conversation's own folder", async () => {
		const list = await token().fetch(`/api/folder/list?${q({ file: inGit, path: "" })}`);
		expect(list.status).toBe(403);
		const read = await token().fetch(`/api/folder/file?${q({ file: inGit, path: "config" })}`);
		expect(read.status).toBe(403);
		const download = await token().fetch(`/api/folder/download?${q({ file: inGit, path: "config" })}`);
		expect(download.status).toBe(403);
		const res = await token().fetch(
			"/api/folder/file",
			{ method: "POST", headers: { [CSRF_HEADER]: "1" } },
			JSON.stringify({ file: inGit, path: "config", text: "[core]\n\tfsmonitor = touch x\n", etag: "x" }),
		);
		expect(res.status).toBe(403);
		expect(readFileSync(join(proj, ".git/config"), "utf8")).not.toContain("fsmonitor");
	});

	test("still sees an ordinary project, and the person's own page sees all of them", async () => {
		expect((await token().fetch(`/api/folder/list?${q({ file: inProj, path: "" })}`)).status).toBe(200);
		for (const file of [inGh, inAgent, inGit])
			expect((await owner(`/api/folder/list?${q({ file, path: "" })}`)).status).toBe(200);
	});
});
