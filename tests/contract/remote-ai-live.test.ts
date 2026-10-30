import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveInfo } from "../../shared/protocol.ts";
import type { RemoteSnapshot } from "../../shared/remote.ts";
import { REMOTE_AI_READ_ONLY, REMOTE_AI_TOOL, REMOTE_AI_TOOL_NAMES } from "../../shared/remote-ai.ts";
import { makeFakeCloudflared } from "../support/fake-cloudflared.ts";
import { type Frame, watchFrames } from "../support/frames.ts";
import { canCallModel } from "../support/omp-env.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect, request } from "../support/ws.ts";

/**
 * The AI help for remote access with the real omp and a real model (Claude Haiku 5.5, a few short turns): the agent of a
 * conversation started with "Set up with AI" finds the tools, reads the status without being asked to allow it, is asked
 * before it saves anything, and the conversation's own file (the transcript, which pages show and the migration exports)
 * never holds the access token of the app, however the call went.
 */

const LOGIN_URL =
	"https://dash.cloudflare.com/argotunnel?aud=&callback=https%3A%2F%2Flogin.example.com%2Fone-time-secret";

let root: string;
let s: TestServer;
beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "ompw-remote-ai-live-"));
	const program = makeFakeCloudflared(join(root, "cf"), { installed: false });
	program.setLoginUrl(LOGIN_URL);
	s = await startTestServer(0, { OMP_WEBUI_CLOUDFLARED: program.bin, OMP_WEBUI_BREW: program.brew });
}, 60_000);
afterAll(async () => {
	await s?.stop();
	rmSync(root, { recursive: true, force: true });
});

const api = (path: string, body?: unknown) =>
	fetch(`${s.url}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: { "x-omp-webui-token": s.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
	});
const snapshot = async (): Promise<RemoteSnapshot> => (await api("/api/remote")).json();

/** What omp waits on: a tool's own prompt to be allowed (a `select` titled `Allow tool: <name>`). */
const approval = (f: Frame) => f.type === "extension_ui_request" && /^Allow tool:/.test(String(f.title ?? ""));
const approvalOf = (f: Frame) =>
	String(f.title ?? "")
		.split("\n")[0]
		?.replace(/^Allow tool:\s*/, "");

/** The conversation, as the card's button starts it, asking before every tool. */
async function startAsking(ws: WebSocket): Promise<LiveInfo> {
	const started = (await (await api("/api/remote/ai/start", {})).json()) as LiveInfo;
	await request(ws, { t: "attach", liveId: started.liveId });
	return request<LiveInfo>(ws, { t: "approval_mode", liveId: started.liveId, mode: "always-ask" });
}

const rpc = <T>(ws: WebSocket, liveId: string, command: Record<string, unknown>) =>
	request<T>(ws, { t: "rpc", liveId, command });

/** The file the conversation is written to, once omp has written it. */
async function transcript(ws: WebSocket, liveId: string): Promise<string> {
	const state = await rpc<{ sessionFile?: string }>(ws, liveId, { type: "get_state" });
	expect(state.sessionFile && existsSync(state.sessionFile)).toBeTruthy();
	return readFileSync(state.sessionFile as string, "utf8");
}

const READ_FIRST =
	"Use only your remote_access_* tools. First call remote_access_status. Then call remote_access_save with " +
	'hostname "omp.example.com" and nothing else. When the save has been answered, reply with the single word DONE.';

test.if(canCallModel())(
	"the agent has the tools, reads the status without a prompt, is asked before it saves, and saves after it is approved",
	async () => {
		const ws = await connect(s);
		const live = await startAsking(ws);
		expect(live.approvalMode).toBe("always-ask");
		const state = await rpc<{ dumpTools?: { name: string }[] }>(ws, live.liveId, { type: "get_state" });
		const names = (state.dumpTools ?? []).map((t) => t.name);
		for (const tool of REMOTE_AI_TOOL_NAMES) expect(names, tool).toContain(tool);

		const watch = watchFrames(ws, live.liveId);
		await rpc(ws, live.liveId, { type: "prompt", message: READ_FIRST });
		// The first thing omp waits on is the save: the status is allowed without asking, whatever the mode.
		const asked = await watch.next(approval);
		expect(approvalOf(asked)).toBe(REMOTE_AI_TOOL.save);
		expect(watch.seen.some((f) => approval(f) && approvalOf(f) !== REMOTE_AI_TOOL.save)).toBe(false);
		// Nothing is saved while it waits.
		expect((await snapshot()).config.hostname).toBe("");

		const settled = watch.after("session_settled");
		ws.send(JSON.stringify({ t: "ui_response", liveId: live.liveId, response: { id: asked.id, value: "Approve" } }));
		await settled;
		expect((await snapshot()).config.hostname).toBe("omp.example.com");

		// The conversation's own file: both calls are in it, and nothing that opens the app is.
		const written = await transcript(ws, live.liveId);
		for (const tool of [REMOTE_AI_TOOL.status, REMOTE_AI_TOOL.save]) expect(written, tool).toContain(tool);
		for (const secret of [s.accessToken, "x-omp-webui-token", LOGIN_URL, "one-time-secret"])
			expect(written, `the transcript must not hold ${secret}`).not.toContain(secret);
		// And the read-only tools are the ones that were allowed without a prompt.
		expect(REMOTE_AI_READ_ONLY).toContain(REMOTE_AI_TOOL.status);
		await request(ws, { t: "close", liveId: live.liveId });
		ws.close();
	},
	180_000,
);

test.if(canCallModel())(
	"a save the person denies changes nothing, and the agent is told it was denied",
	async () => {
		const ws = await connect(s);
		const live = await startAsking(ws);
		const watch = watchFrames(ws, live.liveId);
		await rpc(ws, live.liveId, {
			type: "prompt",
			message:
				'Use only your remote_access_* tools. Call remote_access_save with hostname "denied.example.com" and nothing else. ' +
				"If it is denied, do not try again: reply with the single word DENIED.",
		});
		const asked = await watch.next(approval);
		expect(approvalOf(asked)).toBe(REMOTE_AI_TOOL.save);
		const settled = watch.after("session_settled");
		ws.send(JSON.stringify({ t: "ui_response", liveId: live.liveId, response: { id: asked.id, value: "Deny" } }));
		await settled;
		expect((await snapshot()).config.hostname).toBe("omp.example.com");
		await request(ws, { t: "close", liveId: live.liveId });
		ws.close();
	},
	180_000,
);

test.if(canCallModel())(
	"in Auto-approve the agent still reads the status without a prompt and is still asked before it saves",
	async () => {
		const ws = await connect(s);
		const live = await startAsking(ws);
		// Auto-approve: omp runs every other tool without asking, and its own overlay says so.
		const auto = await request<LiveInfo>(ws, { t: "approval_mode", liveId: live.liveId, mode: "yolo" });
		expect(auto.approvalMode).toBe("yolo");
		const watch = watchFrames(ws, live.liveId);
		await rpc(ws, live.liveId, {
			type: "prompt",
			message:
				"Use only your remote_access_* tools. First call remote_access_status. Then call remote_access_save with " +
				'hostname "auto.example.com" and nothing else. If it is denied, do not try again: reply with the single word DENIED.',
		});
		const asked = await watch.next(approval);
		expect(approvalOf(asked)).toBe(REMOTE_AI_TOOL.save);
		// Nothing is saved while it waits, and the status was not asked about.
		expect((await snapshot()).config.hostname).not.toBe("auto.example.com");
		expect(watch.seen.some((f) => approval(f) && approvalOf(f) !== REMOTE_AI_TOOL.save)).toBe(false);
		const settled = watch.after("session_settled");
		ws.send(JSON.stringify({ t: "ui_response", liveId: live.liveId, response: { id: asked.id, value: "Deny" } }));
		await settled;
		expect((await snapshot()).config.hostname).not.toBe("auto.example.com");
		await request(ws, { t: "close", liveId: live.liveId });
		ws.close();
	},
	180_000,
);

test.if(canCallModel())(
	"turned off, the conversation's agent is left without the tools",
	async () => {
		const ws = await connect(s);
		const live = await startAsking(ws);
		expect(
			((await rpc<{ dumpTools?: { name: string }[] }>(ws, live.liveId, { type: "get_state" })).dumpTools ?? []).map(
				(t) => t.name,
			),
		).toContain(REMOTE_AI_TOOL.status);
		await api("/api/remote/ai", { enabled: false });
		const after = await rpc<{ dumpTools?: { name: string }[] }>(ws, live.liveId, { type: "get_state" });
		const left = (after.dumpTools ?? []).map((t) => t.name).filter((n) => n.startsWith("remote_access_"));
		expect(left).toEqual([]);
		await request(ws, { t: "close", liveId: live.liveId });
		ws.close();
	},
	120_000,
);
