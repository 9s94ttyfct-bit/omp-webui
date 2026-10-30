import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isFailure, type LoadedData, type LoadedTools } from "../../shared/loaded.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
import { FIXTURE_CWD, writeSimpleSession } from "../support/fixtures.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type StubOmlx, startStubOmlx } from "../support/stub-omlx.ts";
import { connect, request } from "../support/ws.ts";

/**
 * `GET /api/loaded` against the real server and the real omp, no model call: the tools, MCP servers, commands and
 * skills of a conversation's own process, and the plugins and rules omp's CLI reports for its folder, in the agent
 * directory it was started with (an offline conversation's is not the user's).
 */

let s: TestServer;
let omlx: StubOmlx;
const stubMcp = join(import.meta.dir, "..", "support", "stub-mcp.ts");

const http = (path: string, init: RequestInit = {}) =>
	fetch(`${s.url}${path}`, {
		...init,
		headers: { "x-omp-webui-token": s.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
	});
const loaded = async (query: string): Promise<LoadedData> => {
	const res = await http(`/api/loaded?${query}`);
	expect(res.status).toBe(200);
	return res.json();
};
const toolsOf = (d: LoadedData) => {
	expect(isFailure(d.tools) || d.tools === null).toBe(false);
	return d.tools as LoadedTools;
};

/** An open omp process, and the frames the server sent its socket. */
async function open(target: object) {
	const ws = await connect(s);
	const frames: { type: string; [key: string]: unknown }[] = [];
	const watchers = new Set<() => void>();
	ws.addEventListener("message", (ev) => {
		const m = JSON.parse(String(ev.data));
		if (m.frame) frames.push(m.frame);
		for (const check of watchers) check();
	});
	const info = await request<LiveInfo>(ws, { t: "open", target });
	/** omp announces each MCP tool it mounts (`xd://: mounted mcp__alpha_ping`) as its server registers. */
	const mounted = (server: string) =>
		new Promise<void>((resolve, reject) => {
			const check = () => {
				if (!frames.some((f) => f.type === "notice" && String(f.message).includes(`mcp__${server}_`))) return;
				watchers.delete(check);
				clearTimeout(guard);
				resolve();
			};
			const guard = setTimeout(() => {
				watchers.delete(check);
				reject(new Error(`${server} did not mount its tool`));
			}, 30_000);
			watchers.add(check);
			check();
		});
	return {
		info,
		frames,
		mounted,
		pause: () => request<LiveInfo>(ws, { t: "pause", liveId: info.liveId }),
		resume: () => request<LiveInfo>(ws, { t: "resume", liveId: info.liveId }),
		rpc: <T>(command: Record<string, unknown>) => request<T>(ws, { t: "rpc", liveId: info.liveId, command }),
		async close() {
			await request(ws, { t: "close", liveId: info.liveId }).catch(() => {});
			ws.close();
		},
	};
}

beforeAll(async () => {
	omlx = await startStubOmlx();
	s = await startTestServer();
	writeFileSync(
		join(s.agentDir, "models.yml"),
		`providers:\n  omlx:\n    baseUrl: ${omlx.url}\n    api: openai-completions\n    apiKey: ${omlx.apiKey}\n    discovery:\n      type: openai-models-list\n`,
	);
	writeFileSync(
		join(s.agentDir, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				alpha: { type: "stdio", command: "bun", args: [stubMcp, "alpha"] },
				beta: { type: "stdio", command: "bun", args: [stubMcp, "beta"] },
				resting: { type: "stdio", command: "bun", args: [stubMcp, "resting"], enabled: false },
			},
		}),
	);
	// The folder's own rule and skill, and a plugin of the user's.
	mkdirSync(join(s.work, ".omp", "rules"), { recursive: true });
	writeFileSync(
		join(s.work, ".omp", "rules", "no-foo.md"),
		'---\ndescription: Stop writing foo\ncondition: ["\\\\bfoo\\\\b"]\nscope: ["tool:edit(*.ts)"]\n---\nDo not write foo.\n',
	);
	mkdirSync(join(s.work, ".omp", "skills", "demo-skill"), { recursive: true });
	writeFileSync(
		join(s.work, ".omp", "skills", "demo-skill", "SKILL.md"),
		"---\nname: demo-skill\ndescription: A skill of this folder\n---\nSay hi.\n",
	);
	const plugin = join(s.root, "demo-plugin");
	mkdirSync(plugin, { recursive: true });
	writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "demo-plugin", version: "1.2.3", omp: {} }));
	const link = Bun.spawnSync([process.env.OMP_BIN ?? "omp", "plugin", "link", plugin], {
		cwd: s.work,
		env: { ...process.env, HOME: s.home, PI_CODING_AGENT_DIR: s.agentDir },
		stdout: "pipe",
		stderr: "pipe",
	});
	if (link.exitCode !== 0) throw new Error(`omp plugin link failed: ${link.stderr.toString()}`);
}, 90_000);

afterAll(async () => {
	await s?.stop();
	await omlx?.stop();
});

test("a running conversation lists its tools, MCP servers, commands, skills, plugins and rules, and the model is not asked anything", async () => {
	const chat = await open({ kind: "new", cwd: s.work });
	try {
		await chat.mounted("alpha");
		const data = await loaded(`live=${chat.info.liveId}`);
		expect(data.mode).toBe("full");
		expect(data.cwd).toBe(s.work);

		const tools = toolsOf(data);
		const read = tools.builtin.find((t) => t.name === "read");
		expect(read?.state).toBe("active");
		expect(read?.description).toBeTruthy();
		expect(tools.builtin.find((t) => t.name === "bash")?.state).toBe("active");
		// MCP tools are mounted as xd:// devices, not offered at the top level, and sit under their servers.
		const alpha = tools.servers.find((x) => x.name === "alpha");
		expect(alpha).toMatchObject({ transport: "stdio", enabled: true, scope: "user" });
		expect(alpha?.tools).toEqual([{ name: "mcp__alpha_ping", label: "ping", state: "mounted" }]);
		expect(tools.servers.find((x) => x.name === "beta")?.enabled).toBe(true);
		const resting = tools.servers.find((x) => x.name === "resting");
		expect(resting).toMatchObject({ enabled: false, tools: [] });
		expect(tools.builtin.some((t) => t.name.startsWith("mcp__"))).toBe(false);

		// Slash commands with where each comes from; the folder's skill is listed apart from them.
		expect(isFailure(data.commands) || data.commands === null).toBe(false);
		const commands = data.commands as { name: string; source: string; subcommands: number }[];
		expect(commands.find((c) => c.name === "mcp")).toMatchObject({ source: "builtin" });
		expect(commands.find((c) => c.name === "mcp")?.subcommands).toBeGreaterThan(5);
		expect(commands.some((c) => c.name.startsWith("skill:"))).toBe(false);
		expect(data.skills).toEqual([{ name: "demo-skill", description: "A skill of this folder", enabled: true }]);

		// omp's CLI, in the conversation's folder.
		expect(isFailure(data.plugins)).toBe(false);
		expect(data.plugins).toEqual([
			expect.objectContaining({ name: "demo-plugin", version: "1.2.3", kind: "npm", enabled: true }),
		]);
		expect(isFailure(data.rules)).toBe(false);
		const rules = data.rules as { name: string; provider: string; scope: string[]; triggers: string[] }[];
		expect(rules.find((r) => r.name === "no-foo")).toMatchObject({
			provider: "native",
			scope: ["tool:edit(*.ts)"],
			triggers: ["\\bfoo\\b"],
		});
		expect(rules.some((r) => r.provider === "builtin-defaults")).toBe(true);

		// Asking changed nothing the conversation can see: the output of /tools and /mcp list never reached its
		// viewers, and nothing was sent to the model (no message in the session, no request to the stub).
		expect(chat.frames.filter((f) => f.type === "command_output")).toEqual([]);
		expect((await chat.rpc<{ messageCount: number }>({ type: "get_state" })).messageCount).toBe(0);
		expect(omlx.chats).toEqual([]);
	} finally {
		await chat.close();
	}
}, 120_000);

test("a saved conversation without a process still has its folder's plugins and rules, and no tools to list", async () => {
	const data = await loaded(`file=${encodeURIComponent(s.fixtures.alpha)}`);
	expect([data.tools, data.commands, data.skills]).toEqual([null, null, null]);
	expect(Array.isArray(data.plugins)).toBe(true);
	expect(Array.isArray(data.rules)).toBe(true);
	expect((await http("/api/loaded?file=%2Fnowhere.jsonl")).status).toBe(404);
	expect((await http("/api/loaded?live=nope")).status).toBe(404);
});

test("an offline conversation is asked in its own agent directory: its MCP servers, not the user's", async () => {
	const res = await http("/api/mode", {
		method: "POST",
		body: JSON.stringify({ mode: "light", lightModels: "local", offline: { mcp: ["alpha"] } }),
	});
	expect(res.status).toBe(200);
	const chat = await open({ kind: "new", cwd: s.work });
	try {
		expect(chat.info).toMatchObject({ mode: "light", lightModels: "local" });
		await chat.mounted("alpha");
		const data = await loaded(`live=${chat.info.liveId}`);
		expect(data.mode).toBe("light");
		// The user's mcp.json has alpha, beta and resting; this process was given alpha alone.
		expect(toolsOf(data).servers.map((x) => x.name)).toEqual(["alpha"]);
	} finally {
		await chat.close();
		await http("/api/mode", { method: "POST", body: JSON.stringify({ mode: "full" }) });
	}
}, 120_000);

test("a conversation whose folder is gone says so for plugins and rules, not that omp is missing", async () => {
	const gone = join(s.root, "gone-folder");
	mkdirSync(gone, { recursive: true });
	const file = writeSimpleSession(s.agentDir, 90, "Folder gone");
	writeFileSync(file, readFileSync(file, "utf8").replace(FIXTURE_CWD, gone));
	rmSync(gone, { recursive: true });
	// The server learns of a new session file from its watcher, a moment later.
	const query = `file=${encodeURIComponent(file)}`;
	for (let i = 0; i < 50 && (await http(`/api/loaded?${query}`)).status === 404; i++) await Bun.sleep(100);
	const data = await loaded(query);
	expect(data.cwd).toBe(gone);
	for (const section of [data.plugins, data.rules]) {
		expect(section).toEqual({ error: `Folder no longer exists: ${gone}`, folderMissing: true });
	}
});

test("a paused conversation is not asked: not-running, with its folder's plugins and rules, and no failed sections", async () => {
	const chat = await open({ kind: "new", cwd: s.work });
	try {
		await chat.pause();
		const data = await loaded(`live=${chat.info.liveId}`);
		expect([data.tools, data.commands, data.skills]).toEqual([null, null, null]);
		expect(Array.isArray(data.plugins)).toBe(true);
		expect(Array.isArray(data.rules)).toBe(true);
		await chat.resume();
		expect(toolsOf(await loaded(`live=${chat.info.liveId}`)).builtin.length).toBeGreaterThan(0);
	} finally {
		await chat.close();
	}
}, 120_000);
