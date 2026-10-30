import { afterAll, beforeAll, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveInfo } from "../../shared/protocol.ts";
import { watchFrames } from "../support/frames.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type ScriptedTurn, type StubScripted, startScriptedStub } from "../support/stub-scripted.ts";
import { connect, request } from "../support/ws.ts";

/**
 * omp's fourth permission mode, "Ask and remember" (`tools.approvalMode: always-ask-cached`), against the real omp and
 * the real server, the model a scripted provider (no model call): the overlay the server writes puts omp in it, so a
 * file read waits for the user, with the choices omp offers a host without a dialog; and switching to Ask every time
 * lets the same read run freely.
 */

let server: TestServer;
let backend: StubScripted;

/** The main agent reads `hello.txt` for every prompt; its other requests (titles) get a text. */
const script = (req: { text: string; tools: string[] }): ScriptedTurn => {
	if (!req.tools.includes("read")) return { text: "A title" };
	const messages = JSON.parse(req.text) as { role?: string }[];
	return messages.at(-1)?.role === "tool"
		? { text: "Read it." }
		: { call: { name: "read", args: { path: "hello.txt" } } };
};

beforeAll(async () => {
	backend = await startScriptedStub(script);
	server = await startTestServer();
	writeFileSync(
		join(server.agentDir, "models.yml"),
		`providers:\n  omlx:\n    baseUrl: ${backend.url}\n    api: openai-completions\n    apiKey: ${backend.apiKey}\n    discovery:\n      type: openai-models-list\n`,
	);
	writeFileSync(
		join(server.agentDir, "config.yml"),
		[
			"modelRoles:",
			...["default", "smol", "slow", "tiny", "commit"].map((r) => `  ${r}: omlx/stub-model`),
			"spelling:",
			"  autocomplete: ngram",
			"",
		].join("\n"),
	);
	writeFileSync(join(server.work, "hello.txt"), "hello from the folder\n");
}, 120_000);

afterAll(async () => {
	await server?.stop();
	await backend?.stop();
});

test("Ask and remember puts omp in the mode that asks before a file read; Ask every time lets the same read run", async () => {
	const ws = await connect(server);
	const live = await request<LiveInfo>(ws, {
		t: "open",
		target: { kind: "new", cwd: server.work, approvalMode: "always-ask-cached" },
	});
	expect(live.approvalMode).toBe("always-ask-cached");
	const frames = watchFrames(ws, live.liveId);
	/** Every approval omp asked, with the choices it offered; each is answered with `answer`. */
	const asked: { title: string; options: string[] }[] = [];
	ws.addEventListener("message", (ev) => {
		const m = JSON.parse(String(ev.data));
		const f = m.t === "frame" && m.liveId === live.liveId ? m.frame : null;
		if (f?.type !== "extension_ui_request" || f.method !== "select") return;
		asked.push({ title: String(f.title), options: f.options as string[] });
		const value = (f.options as string[]).find((o) => o === "Approve Once") ?? "Approve";
		ws.send(JSON.stringify({ t: "ui_response", liveId: live.liveId, response: { id: f.id, value } }));
	});
	const read = async () => {
		const settled = frames.after("agent_end");
		await request(ws, { t: "rpc", liveId: live.liveId, command: { type: "prompt", message: "Read hello.txt" } });
		await settled;
	};

	await read();
	expect(asked).toHaveLength(1);
	expect(asked[0].title).toMatch(/^Allow tool: read\b/);
	// A host without omp's dialog gets the grant choices as separate answers, beside approving once and denying.
	expect(asked[0].options).toContain("Approve Once");
	expect(asked[0].options.some((o) => /^Approve File/.test(o))).toBe(true);
	expect(asked[0].options.some((o) => /^Always Approve File/.test(o))).toBe(true);
	expect(asked[0].options.some((o) => /^Deny/.test(o))).toBe(true);

	await request(ws, { t: "approval_mode", liveId: live.liveId, mode: "always-ask" });
	await read();
	expect(asked).toHaveLength(1);

	await request(ws, { t: "approval_mode", liveId: live.liveId, mode: "always-ask-cached" });
	await read();
	expect(asked).toHaveLength(2);

	await request(ws, { t: "close", liveId: live.liveId });
	ws.close();
}, 120_000);

test("a conversation started with omp's own setting on Ask and remember reports it", async () => {
	const ws = await connect(server);
	const configPath = join(server.agentDir, "config.yml");
	const before = await Bun.file(configPath).text();
	writeFileSync(configPath, `${before}tools:\n  approvalMode: always-ask-cached\n`);
	try {
		const live = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: server.work } });
		expect(live.approvalMode).toBe("always-ask-cached");
		const saved = await fetch(`${server.url}/api/approval`, {
			headers: { "x-omp-webui-token": server.accessToken, "x-omp-webui": "1" },
		});
		expect(await saved.json()).toEqual({ mode: null, omp: "always-ask-cached" });
		await request(ws, { t: "close", liveId: live.liveId });
	} finally {
		writeFileSync(configPath, before);
		ws.close();
	}
}, 60_000);
