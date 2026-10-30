import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveInfo } from "../../shared/protocol.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type StubOmlx, startStubOmlx } from "../support/stub-omlx.ts";
import { connect, request } from "../support/ws.ts";

/**
 * The unused offline process a New chat may take over, against the real server and the real omp (stubs stand in for
 * the backends, no model is called). omp applies a change to the offline files to a running process, and after the
 * backend was changed and changed back it keeps its model but offers none: such a process must not be handed over.
 */

let s: TestServer;
let omlx: StubOmlx;
let ollama: StubOmlx;
const NO_ADDRESSES = { omlx: null, ollama: null, "lm-studio": null };

function http(path: string, init: RequestInit = {}): Promise<Response> {
	return fetch(`${s.url}${path}`, {
		...init,
		headers: { "x-omp-webui-token": s.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
	});
}
const postMode = (body: unknown) => http("/api/mode", { method: "POST", body: JSON.stringify(body) });

/** A New chat as a page opens it: its process, and how to ask omp what it offers. */
async function newChat() {
	const ws = await connect(s);
	const info = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: s.work } });
	const rpc = <T>(command: Record<string, unknown>) => request<T>(ws, { t: "rpc", liveId: info.liveId, command });
	return {
		liveId: info.liveId,
		async model() {
			const { model } = await rpc<{ model: { provider: string; id: string } }>({ type: "get_state" });
			return `${model.provider}/${model.id}`;
		},
		/** `provider/id` of every model the process offers. */
		async offered() {
			const { models } = await rpc<{ models: { provider: string; id: string }[] }>({ type: "get_available_models" });
			return models.map((m) => `${m.provider}/${m.id}`);
		},
		/** The page goes away (reloaded, closed); the process is left running, unused. */
		leave() {
			ws.close();
		},
	};
}

/** Wait for the server to have noticed the page leave: the process is then unwatched and may be taken over. */
async function unwatched(liveId: string): Promise<void> {
	for (let i = 0; i < 100; i++) {
		const lives = (await (await http("/api/lives")).json()) as LiveInfo[];
		const live = lives.find((l) => l.liveId === liveId);
		if (!live?.subscribers) return;
		await Bun.sleep(50);
	}
	throw new Error(`${liveId} is still watched`);
}

beforeAll(async () => {
	omlx = await startStubOmlx({ models: ["stub-model", "stub-two"] });
	ollama = await startStubOmlx({ models: ["stub-ollama-model"], apiKey: null, ollama: true });
	s = await startTestServer();
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
`,
	);
}, 60_000);

afterAll(async () => {
	await s?.stop();
	await Promise.all([omlx?.stop(), ollama?.stop()]);
});

test("after the backend changes and changes back, a New chat on the first backend lists its models (each set of offline files has its own directory)", async () => {
	expect(
		(
			await postMode({
				mode: "light",
				lightModels: "local",
				offline: { backend: "omlx", baseUrls: NO_ADDRESSES, mcp: [] },
			})
		).status,
	).toBe(200);
	const left = await newChat();
	expect(await left.offered()).toEqual(["omlx/stub-model", "omlx/stub-two"]);
	left.leave();
	await unwatched(left.liveId);

	// Another backend for a while: a New chat then runs on it, and the unused process stays where it is.
	await postMode({ offline: { backend: "ollama", baseUrls: { ollama: ollama.url } } });
	const other = await newChat();
	expect(other.liveId).not.toBe(left.liveId);
	expect(await other.offered()).toEqual(["ollama/stub-ollama-model"]);
	other.leave();
	await unwatched(other.liveId);

	// Back on oMLX: the same files as when the first process started, in the same directory, which nothing rewrote
	// meanwhile — so that process (omp follows its files live) still offers oMLX's models and may be handed over.
	await postMode({ offline: { backend: "omlx", baseUrls: NO_ADDRESSES } });
	const again = await newChat();
	expect(await again.model()).toBe("omlx/stub-model");
	expect(await again.offered()).toEqual(["omlx/stub-model", "omlx/stub-two"]);
	again.leave();
}, 90_000);

test("an unused offline process the files did not change under is still handed over", async () => {
	const first = await newChat();
	expect(await first.offered()).toEqual(["omlx/stub-model", "omlx/stub-two"]);
	first.leave();
	await unwatched(first.liveId);
	const second = await newChat();
	expect(second.liveId).toBe(first.liveId);
	expect(await second.offered()).toEqual(["omlx/stub-model", "omlx/stub-two"]);
	second.leave();
}, 60_000);
