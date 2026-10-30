import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isFailure, type LoadedData, type LoadedMcpServer, type LoadedTools } from "../../shared/loaded.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
import { FIXTURE_CWD, writeSimpleSession } from "../support/fixtures.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type StubOmlx, startStubOmlx } from "../support/stub-omlx.ts";
import { connect, request } from "../support/ws.ts";

/**
 * The Loaded dialog's MCP switches against the real server, the real omp and stdio MCP stubs, no model call. A switch
 * is omp's own `/mcp enable|disable` in the conversation's process, which writes `enabled` where the server is
 * configured (the user's mcp.json, or the folder's .omp/mcp.json) and nothing else; the running omp does not connect
 * or drop servers afterwards, so the change applies once the conversation's omp is started anew from its session file.
 */

let s: TestServer;
let omlx: StubOmlx;
const stubMcp = join(import.meta.dir, "..", "support", "stub-mcp.ts");
let userMcp = "";
let projectMcp = "";
const readJson = (file: string) => JSON.parse(readFileSync(file, "utf8"));
const stub = (name: string, extra: object = {}) => ({ type: "stdio", command: "bun", args: [stubMcp, name], ...extra });

const send = (path: string, body: unknown) =>
	fetch(`${s.url}${path}`, {
		method: "POST",
		headers: { "x-omp-webui-token": s.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
		body: JSON.stringify(body),
	});
const loaded = async (live: string): Promise<LoadedData> => {
	const res = await fetch(`${s.url}/api/loaded?live=${live}`, {
		headers: { "x-omp-webui-token": s.accessToken, "x-omp-webui": "1" },
	});
	expect(res.status).toBe(200);
	return res.json();
};
const serversOf = (d: LoadedData): LoadedMcpServer[] => {
	expect(isFailure(d.tools) || d.tools === null).toBe(false);
	return (d.tools as LoadedTools).servers;
};
const server = (d: LoadedData, name: string) => {
	const found = serversOf(d).find((x) => x.name === name);
	expect(found).toBeDefined();
	return found as LoadedMcpServer;
};

const hasTools = async (live: string, name: string): Promise<boolean> => {
	const res = await fetch(`${s.url}/api/loaded?live=${live}`, {
		headers: { "x-omp-webui-token": s.accessToken, "x-omp-webui": "1" },
	});
	if (res.status !== 200) return false;
	const d = (await res.json()) as LoadedData;
	return (
		!isFailure(d.tools) &&
		d.tools !== null &&
		(d.tools as LoadedTools).servers.some((x) => x.name === name && x.tools.length > 0)
	);
};
/** An open omp process, and the MCP servers whose tools it has announced (`xd://: mounted mcp__alpha_ping`). */
async function open(target: object) {
	const ws = await connect(s);
	const mounted = new Set<string>();
	ws.addEventListener("message", (ev) => {
		const m = JSON.parse(String(ev.data));
		const f = m.frame;
		if (f?.type !== "notice" || typeof f.message !== "string") return;
		for (const [, name] of f.message.matchAll(/mcp__([a-z0-9]+)_/g)) mounted.add(name);
	});
	const info = await request<LiveInfo>(ws, { t: "open", target });
	return {
		info,
		// The notice of the mount, or the tools themselves in what the dialog lists: a notice that came before this page
		// was attached to the process is not sent again, and a busy machine decides whether it did.
		mounted: (name: string) =>
			pollUntil(
				async () => mounted.has(name) || (await hasTools(info.liveId, name)),
				`${name} to mount its tools`,
				90_000,
			),
		listing: async () => (await request<LiveInfo[]>(ws, { t: "list_lives" })).find((l) => l.liveId === info.liveId),
		/** The process has exited (the server forgets one that has). */
		ended: async () => {
			const l = (await request<LiveInfo[]>(ws, { t: "list_lives" })).find((x) => x.liveId === info.liveId);
			return !l || l.exited;
		},
		pause: () => request<LiveInfo>(ws, { t: "pause", liveId: info.liveId }),
		resume: () => request<LiveInfo>(ws, { t: "resume", liveId: info.liveId }),
		rpc: <T>(command: Record<string, unknown>) => request<T>(ws, { t: "rpc", liveId: info.liveId, command }),
		async close() {
			await request(ws, { t: "close", liveId: info.liveId }).catch(() => {});
			ws.close();
		},
	};
}

/** A saved conversation in the work folder, which a restart can resume. */
function saved(n: number, title: string): string {
	const file = writeSimpleSession(s.agentDir, n, title);
	writeFileSync(file, readFileSync(file, "utf8").replace(FIXTURE_CWD, s.work));
	return file;
}
async function known(file: string) {
	// The server learns of a new session file from its watcher, a moment later.
	await pollUntil(
		async () =>
			(
				await fetch(`${s.url}/api/loaded?file=${encodeURIComponent(file)}`, {
					headers: { "x-omp-webui-token": s.accessToken, "x-omp-webui": "1" },
				})
			).status === 200,
		"the server to see the session file",
	);
}

const USER_SERVERS = {
	alpha: stub("alpha"),
	beta: stub("beta"),
	"two words": stub("spaced"),
};

beforeAll(async () => {
	omlx = await startStubOmlx();
	s = await startTestServer();
	writeFileSync(
		join(s.agentDir, "models.yml"),
		`providers:\n  omlx:\n    baseUrl: ${omlx.url}\n    api: openai-completions\n    apiKey: ${omlx.apiKey}\n    discovery:\n      type: openai-models-list\n`,
	);
	userMcp = join(s.agentDir, "mcp.json");
	projectMcp = join(s.work, ".omp", "mcp.json");
	writeFileSync(userMcp, JSON.stringify({ mcpServers: USER_SERVERS }));
	mkdirSync(join(s.work, ".omp"), { recursive: true });
	writeFileSync(projectMcp, JSON.stringify({ mcpServers: { proj: stub("proj") } }));
}, 90_000);

afterAll(async () => {
	await s?.stop();
	await omlx?.stop();
});

test("a switch writes enabled where the server is configured and nothing else; a restart applies it", async () => {
	const file = saved(0x70, "MCP restart probe");
	await known(file);
	const chat = await open({ kind: "resume", sessionFile: file });
	try {
		for (const name of ["alpha", "beta", "proj"]) await chat.mounted(name);
		const before = await loaded(chat.info.liveId);
		expect(server(before, "alpha")).toMatchObject({ enabled: true, scope: "user" });
		expect(server(before, "proj")).toMatchObject({ enabled: true, scope: "project" });
		expect(server(before, "alpha").tools.map((t) => t.label)).toEqual(["ping"]);

		// A user server: off in the user's mcp.json, the other servers as they were, the project's file untouched.
		const projectBefore = readFileSync(projectMcp, "utf8");
		const off = await send("/api/controls/mcp", { live: chat.info.liveId, name: "alpha", enabled: false });
		expect(off.status).toBe(200);
		expect(await off.json()).toEqual({ ok: true, changed: true, scope: "user" });
		const user = readJson(userMcp).mcpServers;
		expect(user.alpha).toEqual({ ...USER_SERVERS.alpha, enabled: false });
		expect({ ...user, alpha: undefined }).toEqual({ ...USER_SERVERS, alpha: undefined });
		expect(readFileSync(projectMcp, "utf8")).toBe(projectBefore);

		// A project server: off in the folder's own file, the user's untouched.
		const userBefore = readFileSync(userMcp, "utf8");
		const proj = await send("/api/controls/mcp", { live: chat.info.liveId, name: "proj", enabled: false });
		expect(await proj.json()).toEqual({ ok: true, changed: true, scope: "project" });
		expect(readJson(projectMcp).mcpServers.proj).toEqual({ ...stub("proj"), enabled: false });
		expect(readFileSync(userMcp, "utf8")).toBe(userBefore);

		// omp lists them as off now, but the running process still has their tools: it never drops a server.
		const during = await loaded(chat.info.liveId);
		expect(server(during, "alpha").enabled).toBe(false);
		expect(server(during, "proj").enabled).toBe(false);
		expect(server(during, "alpha").tools.map((t) => t.label)).toEqual(["ping"]);
		expect(server(during, "beta").enabled).toBe(true);

		// Already what was asked: said so, and nothing is written again.
		const again = await send("/api/controls/mcp", { live: chat.info.liveId, name: "alpha", enabled: false });
		expect(await again.json()).toEqual({ ok: true, changed: false, scope: "user" });

		// The restart ends this omp; the same session file resumed starts one that loads what the config says.
		const end = await send("/api/controls/restart", { live: chat.info.liveId });
		expect(end.status).toBe(200);
		expect(await chat.ended()).toBe(true);
		const fresh = await open({ kind: "resume", sessionFile: file });
		try {
			expect(fresh.info.liveId).not.toBe(chat.info.liveId);
			expect(fresh.info.sessionFile).toBe(realpathSync(file));
			await fresh.mounted("beta");
			const after = await loaded(fresh.info.liveId);
			expect(server(after, "alpha")).toMatchObject({ enabled: false, tools: [] });
			expect(server(after, "proj")).toMatchObject({ enabled: false, tools: [] });
			expect(server(after, "beta").tools.map((t) => t.label)).toEqual(["ping"]);

			// On again, the other way round.
			for (const [name, scope] of [
				["alpha", "user"],
				["proj", "project"],
			]) {
				const on = await send("/api/controls/mcp", { live: fresh.info.liveId, name, enabled: true });
				expect(await on.json()).toEqual({ ok: true, changed: true, scope });
			}
			expect(readJson(userMcp).mcpServers.alpha.enabled).toBe(true);
			expect(readJson(projectMcp).mcpServers.proj.enabled).toBe(true);
		} finally {
			await fresh.close();
		}
		// Nothing here asked the model for anything.
		expect(omlx.chats).toEqual([]);
	} finally {
		await chat.close();
	}
}, 180_000);

test("a restart is refused while omp is working or paused, and ends nothing; it works once omp is idle", async () => {
	const chat = await open({ kind: "new", cwd: s.work });
	try {
		const running = chat.rpc({ type: "bash", command: "sleep 3" });
		await pollUntil(async () => (await chat.listing()) !== undefined, "the listing");
		const busy = await send("/api/controls/restart", { live: chat.info.liveId });
		expect(busy.status).toBe(409);
		expect(await chat.ended()).toBe(false);
		await running;

		await chat.pause();
		expect((await send("/api/controls/restart", { live: chat.info.liveId })).status).toBe(409);
		expect((await chat.listing())?.pausedAt).toBeTruthy();
		await chat.resume();

		expect((await send("/api/controls/restart", { live: chat.info.liveId })).status).toBe(200);
		expect(await chat.ended()).toBe(true);
		expect((await send("/api/controls/restart", { live: chat.info.liveId })).status).toBe(404);
	} finally {
		await chat.close();
	}
}, 120_000);

test("bad requests change nothing: no process, an unknown server, a name with a space, no boolean", async () => {
	const userBefore = readFileSync(userMcp, "utf8");
	const projectBefore = readFileSync(projectMcp, "utf8");
	expect((await send("/api/controls/mcp", { live: "nope", name: "alpha", enabled: false })).status).toBe(404);
	expect((await send("/api/controls/mcp", { file: s.fixtures.alpha, name: "alpha", enabled: false })).status).toBe(404);
	const chat = await open({ kind: "new", cwd: s.work });
	try {
		const base = { live: chat.info.liveId };
		// omp's /mcp disable of a name it does not have would write it into a denylist: it is never asked.
		const unknown = await send("/api/controls/mcp", { ...base, name: "ghost", enabled: false });
		expect(unknown.status).toBe(404);
		expect(await unknown.json()).toEqual({ error: expect.stringContaining("ghost") });
		// omp reads one word after /mcp disable, so "two words" would be the server "two".
		expect(server(await loaded(chat.info.liveId), "two words").enabled).toBe(true);
		expect((await send("/api/controls/mcp", { ...base, name: "two words", enabled: false })).status).toBe(400);
		for (const name of ["", "a\nb", "alpha beta"])
			expect((await send("/api/controls/mcp", { ...base, name, enabled: false })).status).toBe(400);
		expect((await send("/api/controls/mcp", { ...base, name: "alpha" })).status).toBe(400);
		expect((await send("/api/controls/mcp", { ...base, name: "alpha", enabled: "no" })).status).toBe(400);
		expect((await send("/api/controls/mcp", { ...base, enabled: false })).status).toBe(400);
		expect(readFileSync(userMcp, "utf8")).toBe(userBefore);
		expect(readFileSync(projectMcp, "utf8")).toBe(projectBefore);
	} finally {
		await chat.close();
	}
}, 120_000);

test("a server defined in both the user's and the folder's config is marked and refused: nothing is written", async () => {
	const userBefore = readFileSync(userMcp, "utf8");
	const projectBefore = readFileSync(projectMcp, "utf8");
	// omp lists the user's entry of a name both define, but /mcp enable|disable writes the folder's.
	writeFileSync(userMcp, JSON.stringify({ mcpServers: { ...USER_SERVERS, dup: stub("dup") } }));
	writeFileSync(projectMcp, JSON.stringify({ mcpServers: { proj: stub("proj"), dup: stub("dup") } }));
	const chat = await open({ kind: "new", cwd: s.work });
	try {
		const data = await loaded(chat.info.liveId);
		expect(server(data, "dup")).toMatchObject({ enabled: true, scope: "user", inBoth: true });
		expect(server(data, "alpha").inBoth).toBeUndefined();
		expect(server(data, "proj").inBoth).toBeUndefined();

		const userDup = readFileSync(userMcp, "utf8");
		const projectDup = readFileSync(projectMcp, "utf8");
		for (const enabled of [false, true]) {
			const res = await send("/api/controls/mcp", { live: chat.info.liveId, name: "dup", enabled });
			expect(res.status).toBe(409);
			expect(await res.json()).toEqual({ error: expect.stringContaining("edit it in the terminal") });
		}
		expect(readFileSync(userMcp, "utf8")).toBe(userDup);
		expect(readFileSync(projectMcp, "utf8")).toBe(projectDup);
		expect(server(await loaded(chat.info.liveId), "dup").enabled).toBe(true);
		// Servers defined once still switch.
		expect((await send("/api/controls/mcp", { live: chat.info.liveId, name: "beta", enabled: false })).status).toBe(
			200,
		);
	} finally {
		await chat.close();
		writeFileSync(userMcp, userBefore);
		writeFileSync(projectMcp, projectBefore);
	}
}, 120_000);

test("a Light conversation loads the servers chosen in Settings: its switch is refused", async () => {
	expect((await send("/api/mode", { mode: "light", lightModels: "local", offline: { mcp: ["alpha"] } })).status).toBe(
		200,
	);
	const chat = await open({ kind: "new", cwd: s.work });
	try {
		expect(chat.info.mode).toBe("light");
		const res = await send("/api/controls/mcp", { live: chat.info.liveId, name: "alpha", enabled: false });
		expect(res.status).toBe(409);
		expect(await res.json()).toEqual({ error: expect.stringContaining("Settings") });
		expect(readJson(userMcp).mcpServers.alpha.enabled).not.toBe(false);
	} finally {
		await chat.close();
		await send("/api/mode", { mode: "full" });
	}
}, 120_000);
