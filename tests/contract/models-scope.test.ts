import { afterAll, beforeAll, expect, test } from "bun:test";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type StubOmlx, startStubOmlx } from "../support/stub-omlx.ts";

/**
 * `GET /api/models` is omp's own list of models (the roles and presets of Settings are made of those, and so are the models
 * of Full and of Light on the person's own models); `?scope=local` is the models of the local server Light's models can be,
 * whatever mode new conversations start in, since a conversation of one page may run in another mode (#441). A stub stands
 * in for Ollama; no model is called.
 */

let s: TestServer;
let ollama: StubOmlx;
beforeAll(async () => {
	s = await startTestServer();
	ollama = await startStubOmlx({ models: ["stub-llama", "stub-qwen"], apiKey: null, ollama: true });
}, 60_000);
afterAll(async () => {
	await ollama?.stop();
	await s?.stop();
});

async function call(path: string, body?: unknown) {
	const res = await fetch(`${s.url}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			"x-omp-webui-token": s.accessToken,
			"x-omp-webui": "1",
			...(body === undefined ? {} : { "content-type": "application/json" }),
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
	return { status: res.status, body: await res.json() };
}

const providers = (list: { provider: string }[]) => [...new Set(list.map((m) => m.provider))];

test("with a local server as Light's models, omp's own list is still what /api/models gives, and the server's is there to ask for", async () => {
	const entered = await call("/api/mode", {
		mode: "light",
		lightModels: "local",
		offline: { backend: "ollama", baseUrls: { ollama: ollama.url } },
	});
	expect(entered.status).toBe(200);

	const local = await call("/api/models?scope=local");
	expect(local.status).toBe(200);
	expect(providers(local.body)).toEqual(["ollama"]);
	expect(local.body.map((m: { id: string }) => m.id)).toEqual(["stub-llama", "stub-qwen"]);

	const own = await call("/api/models");
	expect(own.status).toBe(200);
	// omp's own list (which may hold an Ollama of the machine's own) has none of the stub backend's models.
	expect(own.body.map((m: { id: string }) => m.id)).not.toContain("stub-llama");
}, 120_000);

test("in Full the local server's list is asked for in the same way, and omp's list does not change with the mode", async () => {
	const light = await call("/api/models");
	await call("/api/mode", { mode: "full" });
	const full = await call("/api/models");
	expect(full.body).toEqual(light.body);
	expect(full.body.map((m: { id: string }) => m.id)).not.toContain("stub-llama");
	const local = await call("/api/models?scope=local");
	expect(local.body.map((m: { id: string }) => m.id)).toEqual(["stub-llama", "stub-qwen"]);
}, 120_000);
