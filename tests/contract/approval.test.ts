import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import type { LiveInfo } from "../../shared/protocol.ts";
import { messageWhere, watchFrames } from "../support/frames.ts";
import { canCallModel } from "../support/omp-env.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect, request } from "../support/ws.ts";

/**
 * Tool approval per conversation, against the real omp and the real server (no model call): the overlay omp is started
 * with is accepted, a mode change leaves omp healthy, the user's choices persist, and the default is served over REST.
 * That a running omp then really applies a changed mode is checked with a model in `approval-live.test.ts`.
 */

let s: TestServer;
beforeAll(async () => {
	s = await startTestServer();
}, 60_000);
afterAll(async () => {
	await s?.stop();
});

const MODEL = "anthropic/claude-haiku-5-5";

const api = (path: string, init: RequestInit = {}) =>
	fetch(`${s.url}${path}`, {
		...init,
		headers: { "x-omp-webui-token": s.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
	});

async function openNew(ws: WebSocket, extra: Record<string, unknown> = {}): Promise<LiveInfo> {
	return request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: s.work, ...extra } });
}

/** omp answers: the process is alive and has not choked on its overlay. */
async function healthy(ws: WebSocket, liveId: string): Promise<boolean> {
	const state = await request<{ sessionFile?: string }>(ws, {
		t: "rpc",
		liveId,
		command: { type: "get_state" },
	});
	return typeof state === "object";
}

test("a conversation started in a mode comes up in it, with omp's own mode as the fallback", async () => {
	const ws = await connect(s);
	const asked = await openNew(ws, { approvalMode: "always-ask" });
	expect(asked.approvalMode).toBe("always-ask");
	expect(await healthy(ws, asked.liveId)).toBe(true);

	// Nothing asked, nothing chosen: what `omp config get tools.approvalMode` says (omp's default is yolo).
	const plain = await openNew(ws);
	expect(plain.approvalMode).toBe("yolo");
	const lives = await request<LiveInfo[]>(ws, { t: "list_lives" });
	expect(lives.find((l) => l.liveId === asked.liveId)?.approvalMode).toBe("always-ask");
	for (const l of [asked, plain]) await request(ws, { t: "close", liveId: l.liveId });
	ws.close();
}, 90_000);

test("flags that set the mode for the whole process are not passed on: the overlay would lose to them", async () => {
	const ws = await connect(s);
	const live = await openNew(ws, { approvalMode: "always-ask", args: ["--approval-mode=yolo", "--yolo"] });
	expect(live.approvalMode).toBe("always-ask");
	expect(live.args.join(" ")).not.toMatch(/yolo|approval-mode/);
	expect(await healthy(ws, live.liveId)).toBe(true);
	await request(ws, { t: "close", liveId: live.liveId });
	ws.close();
}, 60_000);

test("changing the mode answers once it is in force, tells every tab, and leaves omp healthy", async () => {
	const ws = await connect(s);
	const watcher = await connect(s);
	const live = await openNew(ws, { approvalMode: "yolo" });
	const announced = messageWhere(
		watcher,
		(m) =>
			m.t === "live" &&
			(m.info as LiveInfo).liveId === live.liveId &&
			(m.info as LiveInfo).approvalMode === "always-ask",
	);
	const changed = await request<LiveInfo>(ws, { t: "approval_mode", liveId: live.liveId, mode: "always-ask" });
	expect(changed.approvalMode).toBe("always-ask");
	expect(((await announced).info as LiveInfo).approvalMode).toBe("always-ask");
	expect(await healthy(ws, live.liveId)).toBe(true);

	await expect(request(ws, { t: "approval_mode", liveId: live.liveId, mode: "reckless" })).rejects.toThrow(
		/Bad approval mode/,
	);
	await expect(request(ws, { t: "approval_mode", liveId: "L0-nope", mode: "yolo" })).rejects.toThrow(/not found/);
	expect(await healthy(ws, live.liveId)).toBe(true);
	await request(ws, { t: "close", liveId: live.liveId });
	ws.close();
	watcher.close();
}, 60_000);

test("a conversation comes back in the mode the user picked for it, however its process ended", async () => {
	const ws = await connect(s);
	const target = { kind: "resume", sessionFile: s.fixtures.beta, model: MODEL };
	const first = await request<LiveInfo>(ws, { t: "open", target });
	expect(first.approvalMode).toBe("yolo");
	await request(ws, { t: "approval_mode", liveId: first.liveId, mode: "always-ask" });
	const exited = messageWhere(ws, (m) => m.t === "live_exit" && m.liveId === first.liveId);
	await request(ws, { t: "close", liveId: first.liveId });
	await exited;

	const second = await request<LiveInfo>(ws, { t: "open", target });
	expect(second.liveId).not.toBe(first.liveId);
	expect(second.approvalMode).toBe("always-ask");
	await request(ws, { t: "close", liveId: second.liveId });
	ws.close();
}, 90_000);

test("the overlay files of ended processes are removed", async () => {
	const ws = await connect(s);
	const live = await openNew(ws, { approvalMode: "write" });
	// The server keeps the overlays of its conversations in the temp dir of its own (see `tests/support/tmp.ts`).
	const dirs = () => readdirSync(s.tmpDir).filter((n) => n.startsWith("ompw-live-"));
	const mine = dirs().find((d) => existsSync(`${s.tmpDir}/${d}/${live.liveId}.yml`));
	expect(mine).toBeDefined();
	const exited = messageWhere(ws, (m) => m.t === "live_exit" && m.liveId === live.liveId);
	await request(ws, { t: "close", liveId: live.liveId });
	await exited;
	expect(existsSync(`${s.tmpDir}/${mine}/${live.liveId}.yml`)).toBe(false);
	ws.close();
}, 60_000);

test("the default mode of new conversations is served over REST and used by them", async () => {
	const initial = await (await api("/api/approval")).json();
	expect(initial).toEqual({ mode: null, omp: "yolo" });

	const set = await api("/api/approval", { method: "POST", body: JSON.stringify({ mode: "always-ask" }) });
	expect(await set.json()).toEqual({ mode: "always-ask", omp: "yolo" });
	expect(await (await api("/api/approval")).json()).toEqual({ mode: "always-ask", omp: "yolo" });

	const ws = await connect(s);
	const live = await openNew(ws);
	expect(live.approvalMode).toBe("always-ask");
	await request(ws, { t: "close", liveId: live.liveId });

	const back = await api("/api/approval", { method: "POST", body: JSON.stringify({ mode: null }) });
	expect(await back.json()).toEqual({ mode: null, omp: "yolo" });
	const plain = await openNew(ws);
	expect(plain.approvalMode).toBe("yolo");
	await request(ws, { t: "close", liveId: plain.liveId });
	ws.close();
}, 90_000);

test("only a real mode, from a page that sends the CSRF header, is accepted as the default", async () => {
	const bad = await api("/api/approval", { method: "POST", body: JSON.stringify({ mode: "reckless" }) });
	expect(bad.status).toBe(400);
	expect((await bad.json()).error).toMatch(/Bad approval mode/);
	const noHeader = await fetch(`${s.url}/api/approval`, {
		method: "POST",
		headers: { "x-omp-webui-token": s.accessToken, "content-type": "application/json" },
		body: JSON.stringify({ mode: "yolo" }),
	});
	expect(noHeader.status).toBe(403);
	expect(await (await api("/api/approval")).json()).toEqual({ mode: null, omp: "yolo" });
});

// ------------------------------------------------------------------ with a model (Claude Haiku 5.5)

test.if(canCallModel())(
	"a running omp applies the changed mode to its next tool call, and asks again when switched back",
	async () => {
		const ws = await connect(s);
		// Pinned: this turn is the one place this file calls a model.
		const live = await openNew(ws, { approvalMode: "always-ask", args: ["--model", MODEL] });
		const watch = watchFrames(ws, live.liveId);
		/** Every approval prompt omp sent; each is approved. */
		const prompts: string[] = [];
		ws.addEventListener("message", (ev) => {
			const m = JSON.parse(String(ev.data));
			const f = m.t === "frame" && m.liveId === live.liveId ? m.frame : null;
			if (f?.type !== "extension_ui_request" || f.method !== "select") return;
			prompts.push(String(f.title));
			ws.send(JSON.stringify({ t: "ui_response", liveId: live.liveId, response: { id: f.id, value: "Approve" } }));
		});
		/** One turn that runs a harmless command, until omp is idle again. */
		const turn = async (label: string) => {
			const settled = watch.after("session_settled");
			await request(ws, {
				t: "rpc",
				liveId: live.liveId,
				command: {
					type: "prompt",
					message: `Run exactly this with the bash tool: echo LIVE_${label}\nThen reply with just: OK`,
				},
			});
			await settled;
		};
		const ran = (label: string) =>
			watch.seen.some(
				(f) => f.type === "tool_execution_end" && JSON.stringify(f.result).includes(`LIVE_${label}`) && !f.isError,
			);

		await turn("ONE");
		expect(prompts).toHaveLength(1);
		expect(prompts[0]).toMatch(/^Allow tool: bash\nCommand: echo LIVE_ONE/);
		expect(ran("ONE")).toBe(true);

		await request(ws, { t: "approval_mode", liveId: live.liveId, mode: "yolo" });
		await turn("TWO");
		expect(prompts).toHaveLength(1);
		expect(ran("TWO")).toBe(true);

		await request(ws, { t: "approval_mode", liveId: live.liveId, mode: "always-ask" });
		await turn("THREE");
		expect(prompts).toHaveLength(2);
		expect(prompts[1]).toContain("echo LIVE_THREE");
		expect(ran("THREE")).toBe(true);
		await request(ws, { t: "close", liveId: live.liveId });
		ws.close();
	},
	180_000,
);
