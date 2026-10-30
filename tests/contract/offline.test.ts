import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CORE_TOOLS, type ContextReport, type ModeState, OFFLINE_TOOLS } from "../../shared/offline.ts";
import type { LiveInfo, SessionSummary } from "../../shared/protocol.ts";
import { newestOfflineAgent } from "../support/offline-agent.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type StubChat, type StubOmlx, startStubOmlx } from "../support/stub-omlx.ts";
import { connect, request } from "../support/ws.ts";

/**
 * Light mode against the real server and the real omp, with a stub standing in for oMLX (no local or cloud model is
 * called): which model, tools and MCP servers a Light process has on a local server's models and on the person's own,
 * where its conversation is saved, and that none of this touches the user's own omp configuration.
 */

let s: TestServer;
let omlx: StubOmlx;
const stubMcp = join(import.meta.dir, "..", "support", "stub-mcp.ts");
const userFiles = ["models.yml", "mcp.json", "config.yml", "AGENTS.md"];
const offlineDir = () => newestOfflineAgent(join(s.root, "data", "offline-agent"));

const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
const modelsYml = (baseUrl: string) =>
	`providers:\n  omlx:\n    baseUrl: ${baseUrl}\n    api: openai-completions\n    apiKey: ${omlx.apiKey}\n    discovery:\n      type: openai-models-list\n  ollama:\n    baseUrl: http://127.0.0.1:1/v1\n    apiKey: sk-other-provider-key\n`;

function http(path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`${s.url}${path}`, {
		...init,
		headers: { "x-omp-webui-token": s.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
	});
}
const getMode = async (): Promise<ModeState> => (await http("/api/mode")).json();
const postMode = (body: unknown) => http("/api/mode", { method: "POST", body: JSON.stringify(body) });
/** Measuring runs a process of each mode: a POST (a GET of it is refused). */
const measureContext = async (): Promise<ContextReport> =>
	(await http("/api/offline/context", { method: "POST" })).json();

type Message = { t: string; frame?: { type: string; [key: string]: unknown } };

/** An open omp process, and everything the server has sent on its socket. */
async function open(target: object) {
	const ws = await connect(s);
	const messages: Message[] = [];
	const watchers = new Set<() => void>();
	ws.addEventListener("message", (ev) => {
		messages.push(JSON.parse(String(ev.data)));
		for (const check of watchers) check();
	});
	/** Resolves once `condition` holds of what has arrived; looked at again with every message. */
	const until = (what: string, condition: () => boolean, ms = 30_000) =>
		new Promise<void>((resolve, reject) => {
			const check = () => {
				if (!condition()) return;
				watchers.delete(check);
				clearTimeout(guard);
				resolve();
			};
			const guard = setTimeout(() => {
				watchers.delete(check);
				reject(new Error(`gave up waiting for ${what}`));
			}, ms);
			watchers.add(check);
			check();
		});
	const frames = () => messages.flatMap((m) => (m.frame ? [m.frame] : []));
	const info = await request<LiveInfo>(ws, { t: "open", target });
	const rpc = <T>(command: Record<string, unknown>) => request<T>(ws, { t: "rpc", liveId: info.liveId, command });
	return {
		info,
		messages,
		frames,
		rpc,
		until,
		/** Prompt (once the MCP server `mounted` has registered its tools) and wait for the turn to end. */
		async ask(message: string, mounted: string) {
			await until(`${mounted} to mount`, () =>
				frames().some((f) => f.type === "notice" && String(f.message).includes(`mcp__${mounted}_`)),
			);
			const turns = frames().filter((f) => f.type === "agent_end").length;
			await rpc({ type: "prompt", message });
			await until("the turn to end", () => frames().filter((f) => f.type === "agent_end").length > turns);
		},
		async close() {
			await request(ws, { t: "close", liveId: info.liveId }).catch(() => {});
			ws.close();
		},
	};
}

/** The request that carried a conversation (omp also asks the model for other things, without tools). */
function conversation(): StubChat {
	const chat = omlx.chats.findLast((c) => c.body.tools?.length);
	if (!chat) throw new Error("the stub oMLX was not asked for a conversation turn");
	return chat;
}

beforeAll(async () => {
	omlx = await startStubOmlx();
	s = await startTestServer();
	// The user's omp setup: oMLX (and another provider with its own key), two MCP servers, an AGENTS.md.
	writeFileSync(join(s.agentDir, "models.yml"), modelsYml(omlx.url));
	writeFileSync(
		join(s.agentDir, "mcp.json"),
		JSON.stringify({
			mcpServers: {
				alpha: { type: "stdio", command: "bun", args: [stubMcp, "alpha"] },
				beta: { type: "stdio", command: "bun", args: [stubMcp, "beta"] },
			},
		}),
	);
	writeFileSync(join(s.agentDir, "AGENTS.md"), "Always answer in OFFLINE-AGENTS-MARKER style.\n");
}, 60_000);

afterAll(async () => {
	await s?.stop();
	await omlx?.stop();
});

/** Fingerprints of the user's files before Light mode did anything. */
const before: Record<string, string> = {};

test("by default the server is in Full, with Light on the person's own models, and offers the user's MCP servers", async () => {
	for (const f of userFiles) before[f] = sha(join(s.agentDir, f));
	const state = await getMode();
	expect(state.mode).toBe("full");
	expect(state.lightModels).toBe("yours");
	expect(state.mcpServers).toEqual(["alpha", "beta"]);
	// `rea` is selected for Light by default, and this mcp.json does not have it.
	expect(state.missingMcp).toEqual(["rea"]);
	// Before there was a choice of backend, oMLX was all there was: still the default, at the address in models.yml.
	expect(state.offline.backend).toBe("omlx");
	expect(state.backends.omlx).toEqual({ baseUrl: omlx.url, source: "models.yml" });
	expect(state.offline.tools).toEqual([...CORE_TOOLS]);
	expect(state.offline.mcp).toEqual(["rea"]);
	expect(state.offline.skills).toEqual(["reverse-engineer-anything"]);
	expect(state.offline.agentsMd).toBe(false);
	// The key is for the Light process on a local server only: no answer carries it.
	expect(JSON.stringify(state)).not.toContain(omlx.apiKey);
});

test("a change that is not valid is refused whole, and leaves everything as it was", async () => {
	const refuse = async (body: unknown, message: RegExp) => {
		const res = await postMode(body);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toMatch(message);
	};
	await refuse({ mode: "sideways" }, /mode must be/);
	await refuse({ mode: "offline" }, /mode must be full or light/);
	await refuse({ mode: "online" }, /mode must be full or light/);
	await refuse({ lightModels: "cloud" }, /lightModels must be yours or local/);
	await refuse({ offline: { tools: ["read", "nonexistent_tool"] } }, /Unknown tool: nonexistent_tool/);
	await refuse({ offline: { tools: [] } }, /at least one tool/);
	await refuse({ offline: { model: "anthropic/claude-haiku-5-5" } }, /model must be null or omlx\//);
	await refuse({ offline: { skills: ["has space"] } }, /Invalid name in skills/);
	await refuse({ offline: { color: "red" } }, /Unknown offline setting/);
	await refuse({ extra: 1 }, /Unknown field/);
	await refuse({ mode: "light", lightModels: "local", offline: { thinking: "extreme" } }, /thinking level/);
	await refuse({ offline: { baseUrls: { omlx: "http://169.254.169.254/v1" } } }, /link-local address/);
	expect(await getMode()).toMatchObject({ mode: "full", lightModels: "yours" });
});

test("Light on a local server: every model is oMLX's, only the allowed tools and the selected MCP server load, the conversation is saved in the user's sessions", async () => {
	const watcher = await open({ kind: "new", cwd: s.work });
	// A tab that is open hears of the change; the process it started before the change keeps its mode.
	expect(watcher.info.mode).toBe("full");
	const heard = watcher.until("the mode announcement", () => watcher.messages.some((m) => m.t === "mode_settings"));
	const res = await postMode({ mode: "light", lightModels: "local", offline: { mcp: ["alpha"] } });
	expect(res.status).toBe(200);
	expect((await res.json()) as ModeState).toMatchObject({
		mode: "light",
		lightModels: "local",
		offline: { mcp: ["alpha"] },
	});
	await heard;
	expect(watcher.messages.find((m) => m.t === "mode_settings")).toMatchObject({
		state: { mode: "light", lightModels: "local", offline: { mcp: ["alpha"] } },
	});
	await watcher.close();

	const chat = await open({ kind: "new", cwd: s.work });
	try {
		expect(chat.info).toMatchObject({ mode: "light", lightModels: "local" });
		const state = await chat.rpc<{ model: { provider: string; id: string } }>({ type: "get_state" });
		expect(`${state.model.provider}/${state.model.id}`).toBe("omlx/stub-model");
		// Word prediction reads the prompt history it shares with the Full processes.
		await chat.rpc({ type: "predict_word", text: "hel", cursor: 3 });
		// The environment holds an Anthropic key, yet only oMLX's models are on offer.
		const { models } = await chat.rpc<{ models: { provider: string }[] }>({ type: "get_available_models" });
		expect([...new Set(models.map((m) => m.provider))]).toEqual(["omlx"]);

		await chat.ask("Say hello, in Light mode.", "alpha");
		const asked = conversation();
		expect(asked.authorization).toBe(`Bearer ${omlx.apiKey}`);
		expect(asked.body.model).toBe("stub-model");
		// The tools the model is given are the allowlist, nothing else: no MCP tool at the top level, no web search…
		expect(asked.body.tools?.map((t) => t.function?.name).sort()).toEqual([...CORE_TOOLS].sort());
		// MCP tools are mounted under xd:// and listed in the system prompt: the selected server's, not the other's.
		const system = String(asked.body.messages?.find((m) => m.role === "system")?.content);
		expect(system).toContain("Replies pong (test server alpha)");
		expect(system).not.toContain("test server beta");
		// The user's own AGENTS.md stays out unless asked for.
		expect(JSON.stringify(asked.body)).not.toContain("OFFLINE-AGENTS-MARKER");
		// omp's reply came from the stub.
		expect(JSON.stringify(chat.frames())).toContain("STUB-REPLY");

		// The conversation is a file in the user's sessions, so history lists it like any other.
		const { sessionFile } = await chat.rpc<{ sessionFile: string }>({ type: "get_state" });
		const file = realpathSync(sessionFile);
		expect(file.startsWith(`${realpathSync(join(s.agentDir, "sessions"))}/`)).toBe(true);
		await chat.until("the sessions to be indexed", () => chat.messages.some((m) => m.t === "sessions_changed"));
		const listed = (await (await http("/api/sessions")).json()) as SessionSummary[];
		expect(listed.some((x) => realpathSync(x.file) === file)).toBe(true);
	} finally {
		await chat.close();
	}
}, 120_000);

test("the Light agent directory holds only what Light mode needs, its secrets are private, and the user's files are unchanged", () => {
	const dir = offlineDir();
	const mode = (name: string) => statSync(join(dir, name)).mode & 0o777;
	expect(mode("models.yml")).toBe(0o600);
	expect(mode("mcp.json")).toBe(0o600);
	expect(mode("config.yml")).toBe(0o600);

	// Only the oMLX provider, with its key; the other provider (and its key) is not copied.
	const models = readFileSync(join(dir, "models.yml"), "utf8");
	expect(models).toContain(omlx.apiKey);
	expect(models).not.toContain("ollama");
	expect(models).not.toContain("sk-other-provider-key");
	// Only the selected server, as the user wrote it.
	expect(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8"))).toEqual({
		mcpServers: { alpha: { type: "stdio", command: "bun", args: [stubMcp, "alpha"] } },
	});
	const config = readFileSync(join(dir, "config.yml"), "utf8");
	for (const role of ["default", "smol", "slow", "vision", "plan", "commit", "tiny", "memory", "task", "advisor"])
		expect(config).toContain(`${role}: omlx/stub-model`);
	expect(config).toContain("omlx/**");
	expect(config).toContain("enableProjectConfig: false");
	// Nothing the model could read the key from, and no AGENTS.md.
	expect(config).not.toContain(omlx.apiKey);
	expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
	// Conversations and the images in them are the user's.
	expect(realpathSync(join(dir, "sessions"))).toBe(realpathSync(join(s.agentDir, "sessions")));
	expect(realpathSync(join(dir, "blobs"))).toBe(realpathSync(join(s.agentDir, "blobs")));
	// The prompt history word prediction reads is the user's too.
	expect(realpathSync(join(dir, "history.db"))).toBe(realpathSync(join(s.agentDir, "history.db")));

	for (const f of userFiles) expect(sha(join(s.agentDir, f))).toBe(before[f]);
});

test("the user's AGENTS.md is loaded when asked for, and left out again when not", async () => {
	expect((await postMode({ offline: { agentsMd: true } })).status).toBe(200);
	const chat = await open({ kind: "new", cwd: s.work });
	try {
		expect(readFileSync(join(offlineDir(), "AGENTS.md"), "utf8")).toContain("OFFLINE-AGENTS-MARKER");
		await chat.ask("Hello again.", "alpha");
		expect(JSON.stringify(conversation().body)).toContain("OFFLINE-AGENTS-MARKER");
	} finally {
		await chat.close();
	}
	expect((await postMode({ offline: { agentsMd: false } })).status).toBe(200);
	await (await open({ kind: "new", cwd: s.work })).close();
	expect(existsSync(join(offlineDir(), "AGENTS.md"))).toBe(false);
}, 120_000);

test("a conversation that used a cloud model is resumed on the oMLX model, not on the cloud model", async () => {
	// The fixture was written with anthropic/claude-haiku-5-5, and this environment has credentials for it.
	const chat = await open({ kind: "resume", sessionFile: s.fixtures.alpha });
	try {
		expect(chat.info).toMatchObject({ mode: "light", lightModels: "local" });
		const state = await chat.rpc<{ model: { provider: string } }>({ type: "get_state" });
		expect(state.model.provider).toBe("omlx");
	} finally {
		await chat.close();
	}
}, 60_000);

test("every tool Settings offers is one omp accepts", async () => {
	expect((await postMode({ offline: { tools: [...OFFLINE_TOOLS] } })).status).toBe(200);
	const chat = await open({ kind: "new", cwd: s.work });
	try {
		await chat.ask("Hello with every tool.", "alpha");
		expect(new Set(conversation().body.tools?.map((t) => t.function?.name))).toEqual(new Set(OFFLINE_TOOLS));
	} finally {
		await chat.close();
		await postMode({ offline: { tools: [...CORE_TOOLS] } });
	}
}, 120_000);

test("oMLX not answering is said plainly, and the key is not in the message", async () => {
	const path = join(s.agentDir, "models.yml");
	writeFileSync(path, modelsYml("http://127.0.0.1:1/v1"));
	try {
		const ws = await connect(s);
		const error = await request(ws, { t: "open", target: { kind: "new", cwd: s.work } }).catch((e: Error) => e.message);
		ws.close();
		expect(error).toMatch(
			/^oMLX is not reachable at http:\/\/127\.0\.0\.1:1\/v1 \(connection refused\)\. Start the oMLX server/,
		);
		expect(error).not.toContain(omlx.apiKey);

		const res = await http("/api/offline/models");
		expect(res.status).toBe(502);
		expect(((await res.json()) as { error: string }).error).toContain("oMLX is not reachable");

		// The resume dialog lists oMLX's models for a conversation on it, so it fails the same way rather than offering cloud ones;
		// omp's own list does not ask it.
		expect((await http("/api/models?scope=local")).status).toBe(500);
	} finally {
		writeFileSync(path, modelsYml(omlx.url));
	}
	const models = (await (await http("/api/offline/models")).json()) as { models: string[] };
	expect(models.models).toEqual(["stub-model"]);
	const picker = (await (await http("/api/models?scope=local")).json()) as {
		provider: string;
		id: string;
		name: string;
	}[];
	expect(picker).toEqual([{ provider: "omlx", id: "stub-model", name: "stub-model" }]);
}, 60_000);

test("a wrong API key is reported as such", async () => {
	const path = join(s.agentDir, "models.yml");
	writeFileSync(path, modelsYml(omlx.url).replace(omlx.apiKey, "sk-wrong"));
	try {
		const res = await http("/api/offline/models");
		expect(res.status).toBe(502);
		const { error } = (await res.json()) as { error: string };
		expect(error).toContain("refused its API key (HTTP 401)");
		expect(error).not.toContain("sk-wrong");
	} finally {
		writeFileSync(path, modelsYml(omlx.url));
	}
});

test("the mode and the settings outlive the server", async () => {
	expect((await postMode({ offline: { mcp: ["alpha", "beta"], thinking: "low" } })).status).toBe(200);
	await s.restart();
	const state = await getMode();
	expect(state).toMatchObject({ mode: "light", lightModels: "local" });
	expect(state.offline).toMatchObject({ mcp: ["alpha", "beta"], thinking: "low", tools: [...CORE_TOOLS] });
});

test("the saving is measured with omp's own /context: a fresh Light process starts with less than a Full one", async () => {
	expect((await postMode({ offline: { mcp: ["alpha"], thinking: "medium" } })).status).toBe(200);
	expect((await http("/api/offline/context")).status).toBe(405);
	const first = await measureContext();
	if (!first.full.ok || !first.light.ok) throw new Error(JSON.stringify(first));
	const [full, light] = [first.full.breakdown, first.light.breakdown];
	expect(light.items.map((i) => i.label)).toEqual(expect.arrayContaining(["System prompt", "System tools", "Free"]));
	expect(light.startTokens).toBeGreaterThan(0);
	expect(light.startTokens).toBeLessThan(full.startTokens);
	// What fills a fresh process is the tool schemas first: the allowlist is much smaller than every tool.
	const tools = (b: typeof full) => b.items.find((i) => i.label === "System tools")?.tokens ?? 0;
	expect(tools(light)).toBeLessThan(tools(full));
	expect(full.incomplete).toBe(false);
	expect(light.incomplete).toBe(false);

	// Nothing changed: the same numbers, without starting omp again.
	const again = await measureContext();
	expect(again.full.at).toBe(first.full.at);
	expect(again.light.at).toBe(first.light.at);

	// A different selection changes the Light side only.
	expect((await postMode({ offline: { tools: ["read"] } })).status).toBe(200);
	const changed = await measureContext();
	expect(changed.full.at).toBe(first.full.at);
	expect(changed.light.at).toBeGreaterThan(first.light.at);
	if (!changed.light.ok) throw new Error(changed.light.error);
	expect(changed.light.breakdown.startTokens).toBeLessThan(light.startTokens);
	await postMode({ offline: { tools: [...CORE_TOOLS] } });
}, 240_000);

test("Light on the person's own models: their models and roles, only the allowed tools, and no local server involved", async () => {
	// The person's own setup names the stub as its default model (a provider of their own models.yml): whatever the mode,
	// that is the model, and the local server of Light's other kind of models is not asked for it.
	const config = join(s.agentDir, "config.yml");
	const kept = readFileSync(config, "utf8");
	writeFileSync(config, `${kept}\nmodelRoles:\n  default: omlx/stub-model\n`);
	expect(
		await (await postMode({ mode: "light", lightModels: "yours", offline: { mcp: ["alpha"] } })).json(),
	).toMatchObject({
		mode: "light",
		lightModels: "yours",
	});
	const asked = omlx.requests.length;
	const chat = await open({ kind: "new", cwd: s.work });
	try {
		expect(chat.info).toMatchObject({ mode: "light", lightModels: "yours" });
		const state = await chat.rpc<{ model: { provider: string; id: string } }>({ type: "get_state" });
		expect(`${state.model.provider}/${state.model.id}`).toBe("omlx/stub-model");
		await chat.ask("Say hello, on my own models.", "alpha");
		// The tools are the allowlist, and the chosen MCP server alone is mounted.
		const turn = conversation();
		expect(turn.body.tools?.map((t) => t.function?.name).sort()).toEqual([...CORE_TOOLS].sort());
		expect(String(turn.body.messages?.find((m) => m.role === "system")?.content)).not.toContain("test server beta");
		// The conversation is a file in the user's sessions, as in Full.
		const { sessionFile } = await chat.rpc<{ sessionFile: string }>({ type: "get_state" });
		expect(realpathSync(sessionFile).startsWith(`${realpathSync(join(s.agentDir, "sessions"))}/`)).toBe(true);
		// The person's own models.yml is the very file the process reads (no second copy of their keys).
		const dir = offlineDir();
		expect(realpathSync(join(dir, "models.yml"))).toBe(realpathSync(join(s.agentDir, "models.yml")));
		expect(readFileSync(join(dir, "config.yml"), "utf8")).toContain("default: omlx/stub-model");
		expect(omlx.requests.length).toBeGreaterThan(asked);
	} finally {
		await chat.close();
		writeFileSync(config, kept);
		await postMode({ mode: "light", lightModels: "local", offline: { mcp: ["alpha"] } });
	}
}, 120_000);

test("every change of the settings is announced to every tab with the whole state, so that none builds its next change on a stale one", async () => {
	const ws = await connect(s);
	const heard: ModeState[] = [];
	const waiting = new Set<() => void>();
	ws.addEventListener("message", (ev) => {
		const msg = JSON.parse(String(ev.data)) as { t: string; state?: ModeState };
		if (msg.t !== "mode_settings" || !msg.state) return;
		heard.push(msg.state);
		for (const check of waiting) check();
	});
	const until = (condition: () => boolean) =>
		new Promise<void>((resolve) => {
			const check = () => {
				if (!condition()) return;
				waiting.delete(check);
				resolve();
			};
			waiting.add(check);
			check();
		});
	try {
		// Another tab ticks an MCP server (a list is sent whole, from the page's own state): this one is told.
		expect((await postMode({ offline: { mcp: ["alpha", "beta"] } })).status).toBe(200);
		await until(() => heard.length === 1);
		expect(heard[0].offline.mcp).toEqual(["alpha", "beta"]);
		// Every state the server says is numbered anew (`ModeState.rev`): the read is the same state with a later number.
		const read = await getMode();
		expect(read.rev).toBeGreaterThan(heard[0].rev);
		expect(heard[0]).toEqual({ ...read, rev: heard[0].rev });

		// Saving what is already saved changes nothing: nothing is announced. The next change is, and it arrives after.
		expect((await postMode({ offline: { mcp: ["alpha", "beta"] } })).status).toBe(200);
		expect((await postMode({ offline: { tools: ["read", "bash"] } })).status).toBe(200);
		await until(() => heard.length === 2);
		expect(heard[1].offline.tools).toEqual(["read", "bash"]);
		// The state carries the other tab's choice too, which is what makes a tab's next whole list right.
		expect(heard[1].offline.mcp).toEqual(["alpha", "beta"]);

		// A refused change is announced to nobody.
		expect((await postMode({ offline: { tools: [] } })).status).toBe(400);
		expect((await postMode({ offline: { thinking: "low" } })).status).toBe(200);
		await until(() => heard.length === 3);
		expect(heard[2].offline.thinking).toBe("low");
		expect(heard).toHaveLength(3);
	} finally {
		ws.close();
		await postMode({ offline: { mcp: ["alpha"], tools: [...CORE_TOOLS], thinking: "medium" } });
	}
}, 30_000);
