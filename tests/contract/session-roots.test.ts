import "../unit/browser-globals.ts";
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { SessionSummary } from "../../shared/protocol.ts";
import { socket } from "../../web/src/lib/ws.ts";
import { openLive } from "../../web/src/store/app.ts";
import { type PageStore, pageStore, viewLive } from "../support/page-store.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type StubScripted, startScriptedStub } from "../support/stub-scripted.ts";
import { connect, request } from "../support/ws.ts";
import { installGlobals, restoreGlobals } from "../unit/browser-globals.ts";

/**
 * A conversation started with `--session-dir <dir>` or `--profile <name>` keeps its transcript outside omp's own agent
 * directory. The server remembers the folders it has started omp with, so that such a conversation is listed in the
 * sidebar, searchable, and can be reopened with its transcript.
 *
 * The model is a scripted stub (no live call): a `!echo` runs the command, and the answer that follows it is what
 * makes omp write the transcript.
 */

let server: TestServer;
let backend: StubScripted;
/**
 * The server's own answers: the page's stand-in for `fetch` (see `tests/unit/browser-globals.ts`) answers every
 * request with an empty list, and this test asks the server what it lists and what it serves.
 */
const realFetch = (url: string, init?: RequestInit): Promise<Response> => Bun.fetch(url, init);
let ws: WebSocket;
let page: PageStore;
let liveId = "";
/** The folders the conversations of this run were started in; they are removed when it ends. */
const made: string[] = [];

/** The agent directory of a profile of the test server's own home. */
const profileAgentDir = (profile: string) => join(server.home, ".omp", "profiles", profile, "agent");

/** The model a conversation of this run uses: the stub, written into the agent directory it runs with. */
function useStub(agentDir: string): void {
	mkdirSync(agentDir, { recursive: true });
	writeFileSync(
		join(agentDir, "models.yml"),
		`providers:\n  omlx:\n    baseUrl: ${backend.url}\n    api: openai-completions\n    apiKey: ${backend.apiKey}\n    models:\n      - id: stub-model\n`,
	);
	writeFileSync(
		join(agentDir, "config.yml"),
		["modelRoles:", ...["default", "smol", "slow", "tiny", "commit"].map((r) => `  ${r}: omlx/stub-model`), ""].join(
			"\n",
		),
	);
}

beforeAll(async () => {
	installGlobals();

	backend = await startScriptedStub(() => ({ text: "The probe is here." }));
	server = await startTestServer(0, {}, { login: false });
	// The stub model, in the server's own agent directory and in the profile's: a profile keeps its own.
	useStub(server.agentDir);
	useStub(profileAgentDir("work"));
	ws = await connect(server);
	page = pageStore(ws);
}, 120_000);

afterAll(async () => {
	page?.stop();
	ws?.close();
	await server?.stop();
	await backend?.stop();
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
	restoreGlobals();
});

afterEach(async () => {
	if (liveId) await request(ws, { t: "close", liveId }).catch(() => {});
	liveId = "";
});

/** The conversations the server lists. */
async function listed(): Promise<SessionSummary[]> {
	const response = await realFetch(`${server.url}/api/sessions`, {
		headers: { "x-omp-webui-token": server.accessToken, "x-omp-webui": "1" },
	});
	expect(response.status).toBe(200);
	const body = (await response.json()) as SessionSummary[] | { changed: SessionSummary[] };
	return Array.isArray(body) ? body : body.changed;
}

/** The transcript of a conversation, as the server serves it. */
async function transcript(file: string): Promise<string> {
	const response = await realFetch(`${server.url}/api/session?file=${encodeURIComponent(file)}`, {
		headers: { "x-omp-webui-token": server.accessToken, "x-omp-webui": "1" },
	});
	expect(response.status).toBe(200);
	return response.text();
}

/**
 * Start a conversation with `args`, run a `!echo` in it and let the model answer: the answer is what makes omp write
 * the transcript. Returns the file it wrote.
 */
async function chatWith(args: string[], probe: string): Promise<string> {
	liveId = await openLive({ kind: "new", cwd: server.work, args });
	viewLive(liveId, null);
	// The command runs in the conversation, and the answer that follows it is what omp writes down.
	await socket.rpc(liveId, { type: "bash", command: `echo ${probe}` });
	await socket.rpc(liveId, { type: "prompt", message: `Say the probe: ${probe}` });
	await pollUntil(
		async () => {
			const file = await sessionFile();
			return file !== null && existsSync(file);
		},
		"the conversation to write its transcript",
		30_000,
	);
	const file = await sessionFile();
	if (!file) throw new Error("the conversation wrote no file");
	return file;
}

/** The file of the conversation this test opened, as the server knows it. */
async function sessionFile(): Promise<string | null> {
	const lives = (await request<{ liveId: string; sessionFile?: string | null }[]>(ws, { t: "list_lives" })) ?? [];
	return lives.find((l) => l.liveId === liveId)?.sessionFile ?? null;
}

test("a conversation started with --session-dir is listed, and reopened with its transcript", async () => {
	const elsewhere = join(server.root, "elsewhere-sessions");
	mkdirSync(elsewhere, { recursive: true });
	made.push(elsewhere);

	const file = await chatWith([`--session-dir=${elsewhere}`], "probe-session-dir");
	// It is kept where the flag said, and not in omp's own sessions directory.
	expect(file.startsWith(realpathSync(elsewhere))).toBe(true);

	// The sidebar lists it: the server reads the folder it has started omp with.
	await pollUntil(async () => (await listed()).some((s) => s.file === file), "the conversation to be listed", 30_000);
	const entry = (await listed()).find((s) => s.file === file);
	expect(entry?.cwd).toBe(server.work);

	// It can be reopened: the server serves the file, not just names it.
	const body = await transcript(file);
	expect(body).toContain("probe-session-dir");
}, 120_000);

test("a conversation started with --profile is listed, and reopened with its transcript", async () => {
	const profile = "work";
	// A profile keeps its conversations under the user's own home, not under the agent directory of the server.
	const file = await chatWith([`--profile=${profile}`], "probe-profile");
	expect(file).toContain(join(".omp", "profiles", profile, "agent", "sessions"));

	await pollUntil(async () => (await listed()).some((s) => s.file === file), "the conversation to be listed", 30_000);
	const body = await transcript(file);
	expect(body).toContain("probe-profile");
}, 120_000);

test("a conversation kept in another folder is reopened with the folder it was started with", async () => {
	const elsewhere = join(server.root, "reopen-sessions");
	mkdirSync(elsewhere, { recursive: true });
	made.push(elsewhere);
	const file = await chatWith([`--session-dir=${elsewhere}`], "probe-reopen");

	// The conversation is closed, and opened again from its file: omp must be started with the same flag, or it
	// would write the next turn somewhere else.
	await request(ws, { t: "close", liveId });
	liveId = "";
	await request(ws, { t: "close", liveId: "" }).catch(() => {});

	const opened = await request<{ liveId: string; sessionFile?: string | null }>(ws, {
		t: "open",
		target: { kind: "resume", sessionFile: file },
	});
	expect(opened.sessionFile).toBe(file);
	// The reopened process is this test's to close, as the first one was.
	liveId = opened.liveId;
}, 120_000);

test("the folders the server has started omp with are written down in its own data dir", async () => {
	const elsewhere = join(server.root, "remembered-sessions");
	mkdirSync(elsewhere, { recursive: true });
	made.push(elsewhere);
	await chatWith([`--session-dir=${elsewhere}`], "probe-remembered");

	const file = join(server.root, "data", "session-roots.json");
	expect(existsSync(file)).toBe(true);
	const written = JSON.parse(await Bun.file(file).text()) as { roots: { dir: string; kind: string }[] };
	expect(written.roots.map((r) => r.kind)).toContain("session-dir");
	expect(written.roots.map((r) => r.dir)).toContain(realpathSync(elsewhere));
}, 120_000);

/** A request to the server as the page makes it: a GET, or a POST of `body`. */
const api = (path: string, body?: unknown): Promise<Response> =>
	realFetch(`${server.url}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { "x-omp-webui-token": server.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});

/** Close the running conversation of `file` and wait until its omp has ended: it writes to the file until then. */
async function closeConversation(file: string): Promise<void> {
	await request(ws, { t: "close", liveId });
	liveId = "";
	await pollUntil(
		async () => {
			const lives = (await request<{ sessionFile?: string | null; exited: boolean }[]>(ws, { t: "list_lives" })) ?? [];
			return lives.every((l) => l.exited || l.sessionFile !== file);
		},
		"the conversation's omp to end",
		30_000,
	);
}

test("a conversation started with --session-dir can be pinned and unpinned, as omp's own list has it", async () => {
	const elsewhere = join(server.root, "pin-sessions");
	mkdirSync(elsewhere, { recursive: true });
	made.push(elsewhere);
	const file = await chatWith([`--session-dir=${elsewhere}`], "probe-pin-dir");
	await closeConversation(file);
	await pollUntil(async () => (await listed()).some((s) => s.file === file), "the conversation to be listed", 30_000);

	const pinned = await api("/api/pins", { file, pinned: true });
	expect(pinned.status).toBe(200);
	expect(await pinned.json()).toEqual([file]);
	expect(await (await api("/api/pins")).json()).toEqual([file]);
	expect(await await (await api("/api/pins", { file, pinned: false })).json()).toEqual([]);
}, 120_000);

test("a conversation started with --profile can be pinned and unpinned, in the list the sidebar reads", async () => {
	const file = await chatWith(["--profile=work"], "probe-pin-profile");
	await closeConversation(file);
	await pollUntil(async () => (await listed()).some((s) => s.file === file), "the conversation to be listed", 30_000);

	const pinned = await api("/api/pins", { file, pinned: true });
	expect(pinned.status).toBe(200);
	expect(await pinned.json()).toEqual([file]);
	expect(await (await api("/api/pins")).json()).toEqual([file]);
	// The pin is in the server's own omp list, the one the sidebar reads: not in the profile's, which it never reads.
	expect(JSON.parse(readFileSync(join(server.agentDir, "session-pins.json"), "utf8"))).toHaveLength(1);
	expect(existsSync(join(profileAgentDir("work"), "session-pins.json"))).toBe(false);
	expect(await await (await api("/api/pins", { file, pinned: false })).json()).toEqual([]);
}, 120_000);

test("a conversation kept in another folder has its own usage-wait choice and preset, and a stranger's file has none", async () => {
	const elsewhere = join(server.root, "keys-sessions");
	mkdirSync(elsewhere, { recursive: true });
	made.push(elsewhere);
	const file = await chatWith([`--session-dir=${elsewhere}`], "probe-keys");
	const q = encodeURIComponent(file);

	const preset = await api(`/api/model-preset/session?file=${q}`);
	expect(preset.status).toBe(200);
	expect(await preset.json()).toEqual({ models: null });
	const before = await api(`/api/usage-reset-wait?file=${q}`);
	expect(before.status).toBe(200);
	expect(((await before.json()) as { session: boolean | null }).session).toBeNull();
	// The choice made for the conversation is the one read back for it.
	expect((await api("/api/usage-reset-wait/session", { file, enabled: true })).status).toBe(200);
	const after = await api(`/api/usage-reset-wait?file=${q}`);
	expect(((await after.json()) as { session: boolean | null }).session).toBe(true);

	// A file outside every folder the server reads from is still refused.
	const stray = join(server.root, "stray.jsonl");
	writeFileSync(stray, "{}\n");
	const sq = encodeURIComponent(stray);
	expect((await api(`/api/model-preset/session?file=${sq}`)).status).toBe(404);
	expect((await api(`/api/usage-reset-wait?file=${sq}`)).status).toBe(404);
	expect((await api("/api/usage-reset-wait/session", { file: stray, enabled: true })).status).toBe(404);
}, 120_000);

test("a conversation started with a relative --session-dir is listed, from the folder it runs in", async () => {
	const file = await chatWith(["--session-dir=rel-sessions"], "probe-relative");
	// omp resolves the folder against the one the conversation runs in.
	expect(file.startsWith(join(realpathSync(server.work), "rel-sessions"))).toBe(true);
	await pollUntil(async () => (await listed()).some((s) => s.file === file), "the conversation to be listed", 30_000);
	expect(await transcript(file)).toContain("probe-relative");
}, 120_000);

test("a --session-dir that is a file does not take the sidebar down", async () => {
	const stray = join(server.root, "pasted-transcript.jsonl");
	writeFileSync(stray, "{}\n");
	made.push(stray);
	liveId = await openLive({ kind: "new", cwd: server.work, args: [`--session-dir=${stray}`] });
	// The list of every conversation is still answered, and nothing remembers the file as a folder.
	const response = await api("/api/sessions");
	expect(response.status).toBe(200);
	const written = join(server.root, "data", "session-roots.json");
	const roots = existsSync(written)
		? (JSON.parse(readFileSync(written, "utf8")) as { roots: { dir: string }[] }).roots
		: [];
	expect(roots.map((r) => r.dir)).not.toContain(realpathSync(stray));
}, 120_000);
