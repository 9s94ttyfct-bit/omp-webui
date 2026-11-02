// needs: posixShell
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * The Mac app's side of the CEF engine on a real server (`OMP_WEBUI_BROWSER_ENGINE=cef`): `/browser-engine` lets in the
 * app that started the server, with its token and no page's Origin, and nothing else; a conversation's CDP endpoint then
 * works over what the app says, and ends when the app's connection does. The app is scripted here (macos/browserlink.swift
 * is the real one).
 */

const data = mkdtempSync(join(tmpdir(), "ompw-browser-engine-"));
const A = "/sessions/a.jsonl";
const TA = "a".repeat(43);
let server: TestServer;

beforeAll(async () => {
	mkdirSync(join(data, "browser"), { recursive: true });
	writeFileSync(
		join(data, "browser", "owners.json"),
		JSON.stringify({ generation: null, tokens: { [A]: TA }, targets: {} }),
	);
	server = await startTestServer(0, { OMP_WEBUI_DATA_DIR: data, OMP_WEBUI_BROWSER_ENGINE: "cef" }, { login: false });
}, 60_000);

afterAll(async () => {
	await server?.stop();
	rmSync(data, { recursive: true, force: true });
});

const wsUrl = (path: string) => `${server.url.replace(/^http/, "ws")}${path}`;

/** Whether a WebSocket with these headers is let in (`open`) or refused. */
function opens(path: string, headers: Record<string, string>): Promise<WebSocket | null> {
	return new Promise((resolve) => {
		const ws = new WebSocket(wsUrl(path), { headers } as unknown as string[]);
		ws.onopen = () => resolve(ws);
		ws.onerror = () => resolve(null);
		ws.onclose = () => resolve(null);
	});
}

test("only the app, with the token it started the server with and no page's Origin, is let in as the engine", async () => {
	expect(await opens("/browser-engine", {})).toBeNull();
	expect(await opens("/browser-engine", { "x-omp-webui-token": "not-the-token" })).toBeNull();
	expect(
		await opens("/browser-engine", { "x-omp-webui-token": server.accessToken, origin: new URL(server.url).origin }),
	).toBeNull();
	const app = await opens("/browser-engine", { "x-omp-webui-token": server.accessToken });
	expect(app).not.toBeNull();
	app?.close();
});

test("a conversation's endpoint works over the app's pages, and ends when the app's connection does", async () => {
	const app = await opens("/browser-engine", { "x-omp-webui-token": server.accessToken });
	if (!app) throw new Error("the app was not let in");
	const said: { t: string; req?: number; url?: string; targetId?: string; message?: string }[] = [];
	app.onmessage = (e) => {
		const m = JSON.parse(String(e.data));
		said.push(m);
		// The app makes the page it is asked for, and every page command is answered.
		if (m.t === "create") {
			app.send(JSON.stringify({ t: "page", page: { targetId: "P1", url: m.url, title: "" } }));
			app.send(JSON.stringify({ t: "created", req: m.req, targetId: "P1" }));
		}
		if (m.t === "cdp") {
			const { id } = JSON.parse(m.message);
			app.send(JSON.stringify({ t: "cdp", targetId: m.targetId, message: JSON.stringify({ id, result: {} }) }));
		}
	};
	app.send(JSON.stringify({ t: "hello", run: "run-1", version: "156.0.0", pages: [] }));

	const conversation = await opens(`/browser-cdp/${TA}/devtools/browser`, {});
	if (!conversation) throw new Error("the conversation was not let in");
	const answers = new Map<number, unknown>();
	let closed = false;
	conversation.onmessage = (e) => {
		const m = JSON.parse(String(e.data));
		if (m.id) answers.set(m.id, m.result);
	};
	conversation.onclose = () => {
		closed = true;
	};
	conversation.send(JSON.stringify({ id: 1, method: "Target.getTargets", params: {} }));
	await waitFor(() => answers.has(1));
	// Its first page was made by the app, on the server's request.
	expect(said.some((m) => m.t === "create")).toBe(true);
	const infos = (answers.get(1) as { targetInfos: { targetId: string; type: string }[] }).targetInfos;
	expect(infos.map((t) => [t.targetId, t.type])).toEqual([["P1", "page"]]);

	app.close();
	await waitFor(() => closed);
});

async function waitFor(ok: () => boolean, ms = 10_000): Promise<void> {
	const end = Date.now() + ms;
	while (!ok()) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 20));
	}
}
