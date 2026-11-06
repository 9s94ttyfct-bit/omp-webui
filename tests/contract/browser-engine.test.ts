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

/** The app, let in and saying hello: it makes the page it is asked for (`targetId`) and answers every page command. */
async function scriptedApp(targetId: string) {
	const app = await opens("/browser-engine", { "x-omp-webui-token": server.accessToken });
	if (!app) throw new Error("the app was not let in");
	const said: { t: string; req?: number; url?: string; targetId?: string; message?: string; id?: string }[] = [];
	app.onmessage = (e) => {
		const m = JSON.parse(String(e.data));
		said.push(m);
		if (m.t === "create") {
			app.send(JSON.stringify({ t: "page", page: { targetId, url: m.url, title: "" } }));
			app.send(JSON.stringify({ t: "created", req: m.req, targetId }));
		}
		if (m.t === "cdp") {
			const { id } = JSON.parse(m.message);
			app.send(JSON.stringify({ t: "cdp", targetId: m.targetId, message: JSON.stringify({ id, result: {} }) }));
		}
	};
	app.send(JSON.stringify({ t: "hello", run: `run-${targetId}`, version: "156.0.0", pages: [] }));
	// The hello is on another socket than the conversation's: a server that has not taken it yet answers the conversation's
	// first request "the app's browser is not connected" (503) and ends the connection. Said by the endpoint's discovery,
	// which is 200 once it has (#23).
	await waitFor(
		async () => (await fetch(`${server.url}/browser-cdp/${TA}/json/version`).catch(() => null))?.status === 200,
	);
	return { app, said };
}

/** Conversation A's endpoint, and its answer to `Target.getTargets` (its first page is made then). */
async function conversationTargets() {
	const conversation = await opens(`/browser-cdp/${TA}/devtools/browser`, {});
	if (!conversation) throw new Error("the conversation was not let in");
	const answers = new Map<number, unknown>();
	let closed: string | null = null;
	conversation.onmessage = (e) => {
		const m = JSON.parse(String(e.data));
		if (m.id) answers.set(m.id, m.result);
	};
	conversation.onclose = (e) => {
		closed = `${e.code} ${e.reason}`;
	};
	conversation.send(JSON.stringify({ id: 1, method: "Target.getTargets", params: {} }));
	// A connection the server ended says why, rather than leaving the wait to time out (#23).
	await waitFor(() => {
		if (closed !== null && !answers.has(1)) throw new Error(`the conversation's endpoint closed first: ${closed}`);
		return answers.has(1);
	});
	return {
		conversation,
		infos: (answers.get(1) as { targetInfos: { targetId: string; type: string }[] }).targetInfos,
		closed: () => closed,
	};
}

test("a conversation's endpoint works over the app's pages, and ends when the app's connection does", async () => {
	const { app, said } = await scriptedApp("P1");
	const { infos, closed } = await conversationTargets();
	// Its first page was made by the app, on the server's request.
	expect(said.some((m) => m.t === "create")).toBe(true);
	expect(infos.map((t) => [t.targetId, t.type])).toEqual([["P1", "page"]]);

	app.close();
	await waitFor(() => closed() !== null);
});

test("a page's download is its conversation's: only that conversation's Browser tab sees it, by name, and can stop it", async () => {
	const { app, said } = await scriptedApp("D1");
	const { conversation } = await conversationTargets();
	type Downloads = { t: string; owner?: string; downloads?: Record<string, unknown>[] };
	const tab = async (owner: string) => {
		const ws = await opens("/ws/browser", { "x-omp-webui-token": server.accessToken });
		if (!ws) throw new Error("the Browser tab was not let in");
		const lists: Record<string, unknown>[][] = [];
		const told: Record<string, unknown>[] = [];
		ws.onmessage = (e) => {
			const m = JSON.parse(String(e.data)) as Downloads;
			told.push(m);
			if (m.t === "downloads" && m.downloads) lists.push(m.downloads);
		};
		ws.send(JSON.stringify({ t: "watch", owner, targetId: null, panel: { w: 800, h: 600 } }));
		await waitFor(() => lists.length > 0);
		return { ws, lists, told };
	};
	const mine = await tab(A);
	const other = await tab("/sessions/b.jsonl");
	expect(mine.lists.at(-1)).toEqual([]);

	const download = { id: "7", targetId: "D1", name: "report.pdf", path: join(data, "report.pdf"), received: 10 };
	app.send(JSON.stringify({ t: "download", download: { ...download, state: "progress", total: 100 } }));
	await waitFor(() => (mine.lists.at(-1)?.length ?? 0) > 0);
	const [item] = mine.lists.at(-1) ?? [];
	// Known by the app's CEF run (`scriptedApp` says hello as run-D1) and CEF's id in it.
	expect(item).toMatchObject({ id: "run-D1.7", name: "report.pdf", state: "progress", received: 10, total: 100 });
	expect(item).not.toHaveProperty("path");

	// Another conversation's tab neither hears of it nor stops it; its own does.
	other.ws.send(JSON.stringify({ t: "download_cancel", id: "run-D1.7" }));
	mine.ws.send(JSON.stringify({ t: "download_cancel", id: "run-D1.7" }));
	await waitFor(() => said.some((m) => m.t === "download_cancel"));
	await new Promise((r) => setTimeout(r, 200));
	expect(said.filter((m) => m.t === "download_cancel")).toEqual([{ t: "download_cancel", id: "7" }]);
	expect(other.lists.every((l) => l.length === 0)).toBe(true);

	// Once it ended, it is not stopped any more.
	app.send(JSON.stringify({ t: "download", download: { ...download, state: "cancelled", total: 100 } }));
	await waitFor(() => mine.lists.at(-1)?.[0]?.state === "cancelled");
	mine.ws.send(JSON.stringify({ t: "download_cancel", id: "run-D1.7" }));
	await new Promise((r) => setTimeout(r, 200));
	expect(said.filter((m) => m.t === "download_cancel")).toHaveLength(1);

	// A finished one's file is fetched by its id; one that is running, or none at all, is not.
	const file = (id: string) =>
		fetch(`${server.url}/api/browser/downloads/${id}/file`, { headers: { "x-omp-webui-token": server.accessToken } });
	const saved = { ...download, id: "8", name: "notes.txt", path: join(data, "notes.txt") };
	writeFileSync(saved.path, "the notes");
	app.send(JSON.stringify({ t: "download", download: { ...saved, state: "progress", total: 9 } }));
	await waitFor(() => mine.lists.at(-1)?.[0]?.id === "run-D1.8");
	expect((await file("run-D1.8")).status).toBe(409);
	expect((await file("run-D1.9")).status).toBe(404);
	app.send(JSON.stringify({ t: "download", download: { ...saved, state: "done", received: 9, total: 9 } }));
	await waitFor(() => mine.lists.at(-1)?.[0]?.state === "done");
	const fetched = await file("run-D1.8");
	expect(fetched.status, await fetched.clone().text()).toBe(200);
	expect(fetched.headers.get("content-disposition")).toStartWith('attachment; filename="notes.txt"');
	expect(await fetched.text()).toBe("the notes");

	// Show in Finder of one whose file is gone (moved or deleted) is told to the tab that asked, which says so; `open`
	// is never run for it.
	const gone = { ...download, id: "9", name: "gone.zip", path: join(data, "gone.zip") };
	app.send(JSON.stringify({ t: "download", download: { ...gone, state: "done", received: 10, total: 10 } }));
	await waitFor(() => mine.lists.at(-1)?.[0]?.id === "run-D1.9");
	other.ws.send(JSON.stringify({ t: "download_reveal", id: "run-D1.9" }));
	mine.ws.send(JSON.stringify({ t: "download_reveal", id: "run-D1.9" }));
	await waitFor(() => mine.told.some((m) => m.t === "download_reveal_failed"));
	expect(mine.told.filter((m) => m.t === "download_reveal_failed")).toEqual([
		{ t: "download_reveal_failed", owner: A, id: "run-D1.9", gone: true },
	]);
	await new Promise((r) => setTimeout(r, 200));
	expect(other.told.some((m) => m.t === "download_reveal_failed")).toBe(false);

	for (const ws of [mine.ws, other.ws, conversation, app]) ws.close();
});

async function waitFor(ok: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
	const end = Date.now() + ms;
	while (!(await ok())) {
		if (Date.now() > end) throw new Error("timed out");
		await new Promise((r) => setTimeout(r, 20));
	}
}
