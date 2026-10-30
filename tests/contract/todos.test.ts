import { afterAll, beforeAll, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import type { LiveInfo } from "../../shared/protocol.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect, request } from "../support/ws.ts";

/**
 * `POST /api/controls/todos` against the real server and the real omp, no model call: the page's edit of the todo
 * list is omp's own `/todo import`, so omp's rules apply (one task in progress), omp's parse errors come back, and the
 * edit is recorded in the conversation, where the process's memory alone would be lost on a resume.
 */

let s: TestServer;
const MODEL = "anthropic/claude-haiku-5-5";

const post = (path: string, body: unknown, method = "POST") =>
	fetch(`${s.url}${path}`, {
		method,
		headers: { "x-omp-webui-token": s.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
		body: method === "POST" ? JSON.stringify(body) : undefined,
	});
const putTodos = (live: string, markdown: string) => post("/api/controls/todos", { live, markdown });

interface Phase {
	name: string;
	tasks: { content: string; status: string; blocker?: string }[];
}

async function open(target: object) {
	const ws = await connect(s);
	const info = await request<LiveInfo>(ws, { t: "open", target });
	const exited = new Promise<void>((resolve) =>
		ws.addEventListener("message", (ev) => {
			const m = JSON.parse(String(ev.data));
			if (m.t === "live_exit" && m.liveId === info.liveId) resolve();
		}),
	);
	return {
		info,
		todos: async () =>
			(await request<{ todoPhases: Phase[] }>(ws, { t: "rpc", liveId: info.liveId, command: { type: "get_state" } }))
				.todoPhases,
		pause: () => request<LiveInfo>(ws, { t: "pause", liveId: info.liveId }),
		listing: async () => (await request<LiveInfo[]>(ws, { t: "list_lives" })).find((l) => l.liveId === info.liveId),
		async close() {
			await request(ws, { t: "close", liveId: info.liveId }).catch(() => {});
			await exited;
			ws.close();
		},
	};
}

beforeAll(async () => {
	s = await startTestServer();
}, 90_000);
afterAll(async () => {
	await s?.stop();
});

test("the markdown becomes the list, with omp's own rule that exactly one task is in progress", async () => {
	const chat = await open({ kind: "new", cwd: s.work });
	try {
		expect(await chat.todos()).toEqual([]);
		const res = await putTodos(chat.info.liveId, "# Plan\n- [ ] Write it\n- [ ] Ship it\n\n# Later\n- [x] Think\n");
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		// Nothing was in progress: omp makes the first pending task so.
		expect(await chat.todos()).toEqual([
			{
				name: "Plan",
				tasks: [
					{ content: "Write it", status: "in_progress" },
					{ content: "Ship it", status: "pending" },
				],
			},
			{ name: "Later", tasks: [{ content: "Think", status: "completed" }] },
		]);

		// A blocked task keeps its reason; a second edit replaces the whole list; no text clears it.
		await putTodos(chat.info.liveId, "# Plan\n- [/] Write it\n- [!] Ship it <!-- blocker: waiting for review -->\n");
		expect(await chat.todos()).toEqual([
			{
				name: "Plan",
				tasks: [
					{ content: "Write it", status: "in_progress" },
					{ content: "Ship it", status: "blocked", blocker: "waiting for review" },
				],
			},
		]);
		expect((await putTodos(chat.info.liveId, "")).status).toBe(200);
		expect(await chat.todos()).toEqual([]);
	} finally {
		await chat.close();
	}
}, 90_000);

test("omp's own words come back when it cannot read the list, which stays as it was; the temp file is gone", async () => {
	const chat = await open({ kind: "new", cwd: s.work });
	try {
		await putTodos(chat.info.liveId, "# Plan\n- [ ] Keep me\n");
		const res = await putTodos(chat.info.liveId, "# Plan\n- [?] odd marker\nnot a task line\n");
		expect(res.status).toBe(422);
		const { error } = (await res.json()) as { error: string };
		expect(error).toContain('unknown status marker "[?]"');
		expect(error).toContain('unrecognized syntax "not a task line"');
		// Where the file was is not the user's business.
		expect(error).not.toContain("ompw-todo-");
		expect(error).toContain("Could not parse the list");
		expect(await chat.todos()).toEqual([{ name: "Plan", tasks: [{ content: "Keep me", status: "in_progress" }] }]);
		expect(readdirSync(s.tmpDir).filter((n) => n.startsWith("ompw-todo-"))).toEqual([]);
	} finally {
		await chat.close();
	}
}, 90_000);

test("a paused conversation takes the edit and stays paused", async () => {
	const chat = await open({ kind: "new", cwd: s.work });
	try {
		await chat.pause();
		const pausedAt = (await chat.listing())?.pausedAt;
		expect(pausedAt).toBeTruthy();
		const res = await putTodos(chat.info.liveId, "# While paused\n- [ ] One\n");
		expect(res.status).toBe(200);
		expect((await chat.listing())?.pausedAt).toBe(pausedAt as number);
	} finally {
		await chat.close();
	}
}, 90_000);

test("the edit is recorded in the conversation: a resumed one has it", async () => {
	const target = { kind: "resume", sessionFile: s.fixtures.alpha, model: MODEL };
	const chat = await open(target);
	const file = chat.info.sessionFile as string;
	try {
		expect(await chat.todos()).toEqual([]);
		expect(
			(await putTodos(chat.info.liveId, "# Resumed\n- [/] Still here\n- [!] Stuck <!-- blocker: later -->\n")).status,
		).toBe(200);
	} finally {
		await chat.close();
	}
	expect(readFileSync(file, "utf8")).toContain('"customType":"user_todo_edit"');

	const again = await open(target);
	try {
		expect(await again.todos()).toEqual([
			{
				name: "Resumed",
				tasks: [
					{ content: "Still here", status: "in_progress" },
					{ content: "Stuck", status: "blocked", blocker: "later" },
				],
			},
		]);
	} finally {
		await again.close();
	}
}, 120_000);

test("bad requests: no such process, no text, too much text, wrong method", async () => {
	expect((await putTodos("nope", "# A\n")).status).toBe(404);
	const chat = await open({ kind: "new", cwd: s.work });
	try {
		const none = await post("/api/controls/todos", { live: chat.info.liveId });
		expect(none.status).toBe(400);
		expect((await putTodos(chat.info.liveId, "x".repeat(300 * 1024))).status).toBe(413);
		expect((await post("/api/controls/todos", {}, "GET")).status).toBe(405);
		expect((await post("/api/controls/unknown", {})).status).toBe(404);
		expect(await chat.todos()).toEqual([]);
	} finally {
		await chat.close();
	}
}, 90_000);
