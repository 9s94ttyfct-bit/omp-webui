import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type BackendModels, CORE_TOOLS, type ModeState } from "../../shared/offline.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
import { newestOfflineAgent } from "../support/offline-agent.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type StubChat, type StubOmlx, startStubOmlx } from "../support/stub-omlx.ts";
import { connect, request } from "../support/ws.ts";

/**
 * Light mode on a local server (Ollama and LM Studio besides oMLX), against the real server and the real omp, with stubs standing
 * in for the three servers (no local or cloud model is called): which backend a Light process on a local server talks to,
 * where, with which key, and that choosing one leaves the others (and the user's own files) alone.
 */

let s: TestServer;
/** The user's oMLX, as models.yml has it. */
let omlx: StubOmlx;
/** Answers as Ollama does: no key, its own model list, the Responses API. */
let ollama: StubOmlx;
/** Answers as LM Studio does: no key, chat completions. */
let lmStudio: StubOmlx;
const offlineRoot = () => join(s.root, "data", "offline-agent");
const offlineModelsFile = () => join(newestOfflineAgent(offlineRoot()), "models.yml");

function http(path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`${s.url}${path}`, {
		...init,
		headers: { "x-omp-webui-token": s.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
	});
}
const getMode = async (): Promise<ModeState> => (await http("/api/mode")).json();
const postMode = (body: unknown) => http("/api/mode", { method: "POST", body: JSON.stringify(body) });
const models = async (query = ""): Promise<Response> => http(`/api/offline/models${query}`);

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
	const frames = () => messages.flatMap((m) => (m.frame ? [m.frame] : []));
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
	const info = await request<LiveInfo>(ws, { t: "open", target });
	const rpc = <T>(command: Record<string, unknown>) => request<T>(ws, { t: "rpc", liveId: info.liveId, command });
	return {
		info,
		frames,
		rpc,
		/** The model the process runs, `provider/id`. */
		async model() {
			const { model } = await rpc<{ model: { provider: string; id: string } }>({ type: "get_state" });
			return `${model.provider}/${model.id}`;
		},
		/** The providers whose models the process offers. */
		async providers() {
			const { models } = await rpc<{ models: { provider: string }[] }>({ type: "get_available_models" });
			return [...new Set(models.map((m) => m.provider))];
		},
		/** Prompt and wait for the turn to end. */
		async ask(message: string) {
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
function conversation(stub: StubOmlx): StubChat {
	const chat = stub.chats.findLast((c) => c.body.tools?.length);
	if (!chat) throw new Error("the stub was not asked for a conversation turn");
	return chat;
}

beforeAll(async () => {
	omlx = await startStubOmlx();
	ollama = await startStubOmlx({ models: ["stub-ollama-model"], apiKey: null, ollama: true, reply: "OLLAMA-REPLY" });
	lmStudio = await startStubOmlx({
		models: ["stub/lm-model", "stub/lm-other"],
		apiKey: null,
		reply: "LM-STUDIO-REPLY",
	});
	s = await startTestServer();
	// The user's omp setup: oMLX, and Ollama at an address nothing listens at (Settings will say where it is).
	writeFileSync(
		join(s.agentDir, "models.yml"),
		`providers:
  omlx:
    baseUrl: ${omlx.url}
    api: openai-completions
    apiKey: ${omlx.apiKey}
    discovery:
      type: openai-models-list
  ollama:
    baseUrl: http://127.0.0.1:1/v1
    apiKey: sk-ollama-user-key
`,
	);
}, 60_000);

afterAll(async () => {
	await s?.stop();
	await Promise.all([omlx?.stop(), ollama?.stop(), lmStudio?.stop()]);
});

test("every backend has an address, and Settings is told where it comes from; none of the keys is in the answer", async () => {
	const state = await getMode();
	expect(state.offline.backend).toBe("omlx");
	expect(state.backends).toEqual({
		omlx: { baseUrl: omlx.url, source: "models.yml" },
		ollama: { baseUrl: "http://127.0.0.1:1/v1", source: "models.yml" },
		"lm-studio": { baseUrl: "http://127.0.0.1:1234/v1", source: "default" },
	});
	const text = JSON.stringify(state);
	expect(text).not.toContain(omlx.apiKey);
	expect(text).not.toContain("sk-ollama-user-key");
});

test("a backend, an address or a model that does not fit is refused whole", async () => {
	const refuse = async (body: unknown, message: RegExp) => {
		const res = await postMode(body);
		expect(res.status).toBe(400);
		expect(((await res.json()) as { error: string }).error).toMatch(message);
	};
	await refuse({ offline: { backend: "llama.cpp" } }, /backend must be one of omlx, ollama, lm-studio/);
	await refuse({ offline: { baseUrls: { ollama: "ftp://127.0.0.1/v1" } } }, /must be an address like http/);
	await refuse({ offline: { baseUrls: { ollama: "http://me:secret@127.0.0.1/v1" } } }, /must be an address like http/);
	await refuse({ offline: { baseUrls: { nope: "http://127.0.0.1/v1" } } }, /Unknown backend: nope/);
	// oMLX is the backend: an Ollama model is not one of its models.
	await refuse({ offline: { model: "ollama/stub-ollama-model" } }, /model must be null or omlx\//);
	await refuse({ offline: { backend: "ollama", model: "omlx/stub-model" } }, /model must be null or ollama\//);
	const state = await getMode();
	expect(state.offline.backend).toBe("omlx");
	expect(state.offline.baseUrls).toEqual({ omlx: null, ollama: null, "lm-studio": null });
});

test("Light on Ollama: the conversation runs on Ollama's model at the address from Settings, with the key of the user's entry", async () => {
	const res = await postMode({
		mode: "light",
		lightModels: "local",
		offline: { backend: "ollama", baseUrls: { ollama: ollama.url }, mcp: [] },
	});
	expect(res.status).toBe(200);
	const state = (await res.json()) as ModeState;
	expect(state.backends.ollama).toEqual({ baseUrl: ollama.url, source: "settings" });

	const chat = await open({ kind: "new", cwd: s.work });
	try {
		expect(chat.info).toMatchObject({ mode: "light", lightModels: "local" });
		expect(await chat.model()).toBe("ollama/stub-ollama-model");
		// The environment holds an Anthropic key, and omp finds the other local engines by itself: none is on offer.
		expect(await chat.providers()).toEqual(["ollama"]);

		await chat.ask("Say hello, on Ollama.");
		const asked = conversation(ollama);
		expect(asked.body.model).toBe("stub-ollama-model");
		expect(asked.authorization).toBe("Bearer sk-ollama-user-key");
		expect(asked.body.tools?.map((t) => t.function?.name).sort()).toEqual([...CORE_TOOLS].sort());
		expect(JSON.stringify(chat.frames())).toContain("OLLAMA-REPLY");
		// omp listed the models the way it does for Ollama.
		expect(ollama.requests).toContain("GET /api/tags");
	} finally {
		await chat.close();
	}

	// The Light agent directory holds Ollama's provider (the user's entry, completed) and nothing of oMLX.
	expect(statSync(offlineModelsFile()).mode & 0o777).toBe(0o600);
	expect(Bun.YAML.parse(readFileSync(offlineModelsFile(), "utf8"))).toEqual({
		providers: {
			ollama: {
				baseUrl: ollama.url,
				apiKey: "sk-ollama-user-key",
				api: "openai-responses",
				discovery: { type: "ollama", timeoutMs: 3000 },
			},
		},
	});
	const config = readFileSync(join(newestOfflineAgent(offlineRoot()), "config.yml"), "utf8");
	expect(config).toContain("default: ollama/stub-ollama-model");
	expect(config).toContain("ollama/**");
	expect(config).not.toContain("sk-ollama-user-key");
	// oMLX was not asked anything.
	expect(omlx.requests).toEqual([]);
}, 120_000);

test("Light on LM Studio needs no models.yml entry: the chosen model, whose id has a slash, runs without a key", async () => {
	const res = await postMode({
		offline: { backend: "lm-studio", baseUrls: { "lm-studio": lmStudio.url }, model: "lm-studio/stub/lm-other" },
	});
	expect(res.status).toBe(200);
	// The model is kept, since it is LM Studio's (it would have been dropped with the switch of backend if it were not).
	expect((await getMode()).offline).toMatchObject({ backend: "lm-studio", model: "lm-studio/stub/lm-other" });

	const chat = await open({ kind: "new", cwd: s.work });
	try {
		expect(await chat.model()).toBe("lm-studio/stub/lm-other");
		expect(await chat.providers()).toEqual(["lm-studio"]);
		await chat.ask("Say hello, on LM Studio.");
		const asked = conversation(lmStudio);
		expect(asked.body.model).toBe("stub/lm-other");
		expect(asked.authorization).toBeNull();
		expect(JSON.stringify(chat.frames())).toContain("LM-STUDIO-REPLY");
	} finally {
		await chat.close();
	}
	expect(Bun.YAML.parse(readFileSync(offlineModelsFile(), "utf8"))).toEqual({
		providers: {
			"lm-studio": {
				baseUrl: lmStudio.url,
				api: "openai-completions",
				discovery: { type: "lm-studio", timeoutMs: 3000 },
				auth: "none",
			},
		},
	});
	expect(omlx.requests).toEqual([]);
}, 120_000);

test("a conversation that used a cloud model is resumed on the chosen backend's model", async () => {
	const chat = await open({ kind: "resume", sessionFile: s.fixtures.alpha });
	try {
		expect(chat.info).toMatchObject({ mode: "light", lightModels: "local" });
		expect(await chat.model()).toBe("lm-studio/stub/lm-other");
	} finally {
		await chat.close();
	}
}, 60_000);

test("each backend's models can be asked for, and the model picker of a conversation on a local server lists the selected one's", async () => {
	const answer = async (query: string) => (await (await models(query)).json()) as BackendModels;
	expect(await answer("")).toEqual({
		backend: "lm-studio",
		baseUrl: lmStudio.url,
		models: ["stub/lm-model", "stub/lm-other"],
	});
	expect(await answer("?backend=ollama")).toEqual({
		backend: "ollama",
		baseUrl: ollama.url,
		models: ["stub-ollama-model"],
	});
	expect(await answer("?backend=omlx")).toEqual({ backend: "omlx", baseUrl: omlx.url, models: ["stub-model"] });
	const unknown = await models("?backend=nope");
	expect(unknown.status).toBe(400);

	const picker = (await (await http("/api/models?scope=local")).json()) as {
		provider: string;
		id: string;
		name: string;
	}[];
	expect(picker).toEqual([
		{ provider: "lm-studio", id: "stub/lm-model", name: "stub/lm-model" },
		{ provider: "lm-studio", id: "stub/lm-other", name: "stub/lm-other" },
	]);
});

test("a backend that does not answer is named with its address; the others are not affected", async () => {
	expect((await postMode({ offline: { backend: "ollama", baseUrls: { ollama: "http://127.0.0.1:1" } } })).status).toBe(
		200,
	);
	const ws = await connect(s);
	const error = await request(ws, { t: "open", target: { kind: "new", cwd: s.work } }).catch((e: Error) => e.message);
	ws.close();
	expect(error).toMatch(
		/^Ollama is not reachable at http:\/\/127\.0\.0\.1:1\/v1 \(connection refused\)\. Start the Ollama server/,
	);
	const down = await models("?backend=ollama");
	expect(down.status).toBe(502);
	expect(((await down.json()) as { error: string }).error).toContain("Ollama is not reachable");
	expect((await models("?backend=lm-studio")).status).toBe(200);
	// Clearing the address goes back to the one in models.yml.
	const state = (await (await postMode({ offline: { baseUrls: { ollama: null } } })).json()) as ModeState;
	expect(state.backends.ollama).toEqual({ baseUrl: "http://127.0.0.1:1/v1", source: "models.yml" });
}, 60_000);

test("going back to oMLX works as before: its provider and key from models.yml", async () => {
	expect((await postMode({ offline: { backend: "omlx" } })).status).toBe(200);
	const chat = await open({ kind: "new", cwd: s.work });
	try {
		expect(await chat.model()).toBe("omlx/stub-model");
		expect(await chat.providers()).toEqual(["omlx"]);
	} finally {
		await chat.close();
	}
	expect(omlx.authorizations).toContain(`Bearer ${omlx.apiKey}`);
	expect(Bun.YAML.parse(readFileSync(offlineModelsFile(), "utf8"))).toEqual({
		providers: {
			omlx: {
				baseUrl: omlx.url,
				api: "openai-completions",
				apiKey: omlx.apiKey,
				discovery: { type: "openai-models-list" },
			},
		},
	});
}, 60_000);

test("an open conversation keeps its backend when another one starts on another: each configuration has an agent directory of its own", async () => {
	expect((await postMode({ offline: { backend: "ollama", baseUrls: { ollama: ollama.url } } })).status).toBe(200);
	const first = await open({ kind: "new", cwd: s.work });
	try {
		expect(await first.model()).toBe("ollama/stub-ollama-model");
		const firstDir = newestOfflineAgent(offlineRoot());
		const firstFiles = ["models.yml", "config.yml"].map((f) => readFileSync(join(firstDir, f), "utf8"));

		// Another conversation, on another backend, started while the first is open: its settings are written meanwhile.
		expect(
			(await postMode({ offline: { backend: "lm-studio", baseUrls: { "lm-studio": lmStudio.url } } })).status,
		).toBe(200);
		const second = await open({ kind: "new", cwd: s.work });
		try {
			expect(await second.model()).toBe("lm-studio/stub/lm-model");
			const secondDir = newestOfflineAgent(offlineRoot());
			expect(secondDir).not.toBe(firstDir);
			// The first conversation's files are as they were, and the second's say what it runs on.
			expect(["models.yml", "config.yml"].map((f) => readFileSync(join(firstDir, f), "utf8"))).toEqual(firstFiles);
			expect(Bun.YAML.parse(readFileSync(join(secondDir, "models.yml"), "utf8"))).toEqual({
				providers: {
					"lm-studio": {
						baseUrl: lmStudio.url,
						api: "openai-completions",
						discovery: { type: "lm-studio", timeoutMs: 3000 },
						auth: "none",
					},
				},
			});

			// omp rebuilds its models whenever the config.yml it runs on changes. This is a real wait, for another
			// process's file watcher: long enough that, had the second's settings been written over the first's, it
			// would have lost its provider by now.
			await Bun.sleep(2500);
			expect(await first.providers()).toEqual(["ollama"]);
			expect(await first.model()).toBe("ollama/stub-ollama-model");
			const askedOllama = ollama.chats.length;
			await first.ask("Still on Ollama?");
			expect(ollama.chats.length).toBeGreaterThan(askedOllama);
			expect(JSON.stringify(first.frames())).toContain("OLLAMA-REPLY");

			const askedLmStudio = lmStudio.chats.length;
			await second.ask("And you, on LM Studio?");
			expect(lmStudio.chats.length).toBeGreaterThan(askedLmStudio);
			expect(JSON.stringify(second.frames())).toContain("LM-STUDIO-REPLY");
		} finally {
			await second.close();
		}
	} finally {
		await first.close();
	}
}, 120_000);

test("the backend and the addresses outlive the server", async () => {
	expect(
		(await postMode({ offline: { backend: "lm-studio", baseUrls: { "lm-studio": lmStudio.url, ollama: ollama.url } } }))
			.status,
	).toBe(200);
	await s.restart();
	const state = await getMode();
	expect(state.offline).toMatchObject({
		backend: "lm-studio",
		baseUrls: { omlx: null, ollama: ollama.url, "lm-studio": lmStudio.url },
	});
	expect(state.backends["lm-studio"]).toEqual({ baseUrl: lmStudio.url, source: "settings" });
}, 60_000);
