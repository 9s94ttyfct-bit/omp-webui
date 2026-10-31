import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SETTINGS_PROMPTED_TOOLS } from "../../server/settings-help/service.ts";
import { SETTINGS_TOOL, type SettingsHelpState } from "../../shared/settings-help.ts";
import { writeFakeHostOmp } from "../support/fake-host-omp.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect, request } from "../support/ws.ts";

/**
 * Ask agent for help against the real server (its routes, its pool, its sockets, the real setters and files) and a scripted
 * omp that logs everything it is sent and calls the tools it is told to (`tool <name> <json>`, `fake-host-omp.ts`): only
 * the conversation started from Settings is given `webui_settings`; a normal change applies at once; a security change
 * waits for the person's Allow / Deny and Deny leaves it; a page that is not this computer's is refused; the access ends
 * by itself (the server is started with a short one, `OMP_WEBUI_SETTINGS_HELP_MS`) and with Revoke now; Undo restores; and
 * the conversation asks the person before omp's file-writing and command tools whatever its permission mode.
 *
 * What omp itself does with the overlay's `prompt` policy (it asks in Auto-approve too) is checked against a real omp by
 * `remote-ai-live.test.ts` for the same mechanism; here the overlay is what omp is given.
 */

/** The access of a conversation in this server: long enough for the specs, short enough to watch it end. */
const GRANT_MS = 8000;

let root: string;
let log: string;
let s: TestServer;

beforeAll(async () => {
	root = mkdtempSync(join(tmpdir(), "ompw-settings-help-contract-"));
	log = join(root, "omp.log");
	writeFileSync(log, "");
	s = await startTestServer(
		0,
		{ OMP_BIN: writeFakeHostOmp(root, log, { configured: "write" }), OMP_WEBUI_SETTINGS_HELP_MS: String(GRANT_MS) },
		{ login: false },
	);
}, 60_000);

afterAll(async () => {
	await s?.stop();
	rmSync(root, { recursive: true, force: true });
});

// ------------------------------------------------------------------ what reached omp

interface Logged {
	argv?: string[];
	in?: Record<string, unknown>;
}

const logged = (): Logged[] =>
	readFileSync(log, "utf8")
		.split("\n")
		.slice(0, -1)
		.filter(Boolean)
		.map((l) => JSON.parse(l) as Logged);
const received = (type: string) => logged().flatMap((l) => (l.in?.type === type ? [l.in] : []));
const toolNames = (f: Record<string, unknown>) => (f.tools as { name: string }[]).map((t) => t.name);

interface ToolResult {
	text: string;
	isError: boolean;
}
const results = (): ToolResult[] =>
	received("host_tool_result").map((r) => ({
		text: (r.result as { content: { text: string }[] }).content[0]?.text ?? "",
		isError: r.isError === true,
	}));

// ------------------------------------------------------------------ the person at this computer, and elsewhere

const api = (path: string, body?: unknown, headers: Record<string, string> = {}) =>
	fetch(`${s.url}${path}`, {
		method: body === undefined ? "GET" : "POST",
		headers: {
			"x-omp-webui-token": s.accessToken,
			"x-omp-webui": "1",
			"content-type": "application/json",
			...headers,
		},
		body: body === undefined ? undefined : JSON.stringify(body),
	});
const state = async (): Promise<SettingsHelpState> => (await api("/api/settings-help")).json();
const prefs = async (): Promise<Record<string, string | null>> =>
	((await (await api("/api/prefs")).json()) as { values: Record<string, string | null> }).values;
const guardMode = async (): Promise<string> =>
	((await (await api("/api/guard")).json()) as { config: { mode: string } }).config.mode;

async function start(): Promise<string> {
	const res = await api("/api/settings-help/start", {});
	expect(res.status).toBe(200);
	return ((await res.json()) as { liveId: string }).liveId;
}

/** The agent of `liveId` calls the tool (the scripted omp does); resolves with what omp was sent back. */
async function agentCalls(ws: WebSocket, liveId: string, args: unknown): Promise<ToolResult> {
	const before = results().length;
	await request(ws, {
		t: "rpc",
		liveId,
		command: { type: "prompt", message: `tool ${SETTINGS_TOOL} ${JSON.stringify(args)}` },
	});
	await pollUntil(() => results().length > before, "the tool's result");
	return results()[before] as ToolResult;
}

/** The same, without waiting for the answer: a security change waits for the person. */
async function agentAsks(ws: WebSocket, liveId: string, args: unknown): Promise<() => Promise<ToolResult>> {
	const before = results().length;
	await request(ws, {
		t: "rpc",
		liveId,
		command: { type: "prompt", message: `tool ${SETTINGS_TOOL} ${JSON.stringify(args)}` },
	});
	return async () => {
		await pollUntil(() => results().length > before, "the tool's result");
		return results()[before] as ToolResult;
	};
}

/** A request that came in over a proxy (the tunnel, a reverse proxy): not this computer's, whatever token it holds. */
const ELSEWHERE = { "x-forwarded-for": "203.0.113.7" };

// ------------------------------------------------------------------ the specs

describe("only the dedicated conversation", () => {
	test("an ordinary conversation is never given webui_settings", async () => {
		const ws = await connect(s);
		const live = await request<{ liveId: string }>(ws, { t: "open", target: { kind: "new", cwd: s.work } });
		await request(ws, { t: "rpc", liveId: live.liveId, command: { type: "get_state" } });
		expect(received("set_host_tools").filter((f) => toolNames(f).includes(SETTINGS_TOOL))).toEqual([]);
		await request(ws, { t: "close", liveId: live.liveId });
		ws.close();
	}, 60_000);

	test("Ask agent for help starts one in its own folder with the tool, and the access the state shows", async () => {
		const liveId = await start();
		const sets = received("set_host_tools");
		expect(toolNames(sets.at(-1) as Record<string, unknown>)).toEqual([SETTINGS_TOOL]);
		const now = await state();
		expect(now.grants.map((g) => g.liveId)).toEqual([liveId]);
		expect(now.folder.endsWith("settings-help")).toBe(true);
		// It runs in that folder, apart from every project.
		const lives = (await (await api("/api/lives")).json()) as { liveId: string; cwd: string }[];
		expect(lives.find((l) => l.liveId === liveId)?.cwd).toBe(now.folder);
		await api("/api/settings-help/revoke", { liveId });
	}, 60_000);

	test("omp's file-writing and command tools ask the person there, in Auto-approve too; the tool itself does not", async () => {
		// The person's default for new conversations is Auto-approve.
		expect((await api("/api/approval", { mode: "yolo" })).status).toBe(200);
		const liveId = await start();
		try {
			const argv = logged().findLast((l) => l.argv)?.argv ?? [];
			const overlay = argv[argv.lastIndexOf("--config") + 1] as string;
			const config = Bun.YAML.parse(readFileSync(overlay, "utf8")) as {
				tools: { approval: Record<string, string>; approvalMode?: string };
			};
			expect(config.tools.approvalMode).toBe("yolo");
			for (const tool of SETTINGS_PROMPTED_TOOLS) expect(config.tools.approval[tool], tool).toBe("prompt");
			expect(config.tools.approval[SETTINGS_TOOL]).toBe("allow");
		} finally {
			await api("/api/approval", { mode: null });
			await api("/api/settings-help/revoke", { liveId });
		}
	}, 60_000);
});

describe("changes", () => {
	let liveId: string;
	let ws: WebSocket;
	const heard: { t: string; state?: SettingsHelpState }[] = [];
	/** The guard's mode before the agent changed it (this server's own default). */
	let was = "";

	beforeAll(async () => {
		ws = await connect(s);
		ws.addEventListener("message", (ev) => {
			try {
				heard.push(JSON.parse(String(ev.data)));
			} catch {
				// a part of a big reply
			}
		});
		liveId = await start();
	}, 60_000);

	afterAll(() => ws?.close());

	test("a normal change applies at once, every page is told, and it is logged", async () => {
		const result = await agentCalls(ws, liveId, {
			action: "set",
			changes: [{ key: "ompw.palette", value: "terminal" }],
		});
		expect(result.isError).toBe(false);
		expect(JSON.parse(result.text).results[0]).toMatchObject({ outcome: "applied", old: null, new: "terminal" });
		expect((await prefs())["ompw.palette"]).toBe("terminal");
		expect((await state()).changes[0]).toMatchObject({ key: "ompw.palette", confirmedBy: "agent", liveId });
		expect(heard.some((m) => m.t === "prefs")).toBe(true);
	}, 60_000);

	test("a security change waits for the person; Deny leaves the value as it was", async () => {
		was = await guardMode();
		const other = was === "ask" ? "reviewer" : "ask";
		const done = await agentAsks(ws, liveId, { action: "set", changes: [{ key: "guard.json:mode", value: other }] });
		await pollUntil(async () => (await state()).requests.length === 1, "the card");
		const [card] = (await state()).requests;
		expect(card).toMatchObject({ liveId, key: "guard.json:mode", old: was, new: other });
		// The page was told of the card, and the tool has not answered: it waits.
		expect(heard.some((m) => m.t === "settings_help" && (m.state?.requests.length ?? 0) > 0)).toBe(true);
		const answeredBefore = results().length;
		expect(await guardMode()).toBe(was);
		expect(results().length).toBe(answeredBefore);

		expect((await api("/api/settings-help/answer", { id: card?.id, allow: false })).status).toBe(200);
		const result = await done();
		expect(result.isError).toBe(true);
		expect(JSON.parse(result.text).results[0].outcome).toBe("denied");
		expect(await guardMode()).toBe(was);
	}, 60_000);

	test("Allow applies it, logged as the person's", async () => {
		// Unattended mode for new conversations: sensitive, and a change that leaves this conversation as it is.
		expect((await prefs())["ompw.unattended"]).toBeNull();
		const done = await agentAsks(ws, liveId, { action: "set", changes: [{ key: "ompw.unattended", value: "on" }] });
		await pollUntil(async () => (await state()).requests.length === 1, "the card");
		const [card] = (await state()).requests;
		expect(card).toMatchObject({ key: "ompw.unattended", old: null, new: "on" });
		await api("/api/settings-help/answer", { id: card?.id, allow: true });
		expect(JSON.parse((await done()).text).results[0].outcome).toBe("applied");
		expect((await prefs())["ompw.unattended"]).toBe("on");
		expect((await state()).changes[0]).toMatchObject({ key: "ompw.unattended", confirmedBy: "person" });
	}, 60_000);

	test("an unknown key is refused, nothing changes", async () => {
		const result = await agentCalls(ws, liveId, {
			action: "set",
			changes: [
				{ key: "ompw.theme", value: "dark" },
				{ key: "guard.json/../../token", value: "x" },
			],
		});
		expect(result.isError).toBe(true);
		expect((await prefs())["ompw.theme"]).not.toBe("dark");
	}, 60_000);

	test("a page that is not on this computer is refused every route, and is not told the folder", async () => {
		const before = await state();
		for (const [path, body] of [
			["/api/settings-help", undefined],
			["/api/settings-help/start", {}],
			["/api/settings-help/revoke", { liveId }],
			["/api/settings-help/answer", { id: "x", allow: true }],
			["/api/settings-help/undo", { id: before.changes[0]?.id }],
			["/api/settings-help/undo-all", { liveId }],
		] as const) {
			expect((await api(path, body, ELSEWHERE)).status, path).toBe(403);
		}
		const meta = (await (await api("/api/meta", undefined, ELSEWHERE)).json()) as { settingsHelpFolder?: string };
		expect(meta.settingsHelpFolder).toBeUndefined();
		const local = (await (await api("/api/meta")).json()) as { settingsHelpFolder?: string };
		expect(local.settingsHelpFolder).toBe(before.folder);
		expect((await state()).changes).toEqual(before.changes);
	}, 60_000);

	test("Undo restores the old value through the same setter", async () => {
		const change = (await state()).changes.find((c) => c.key === "ompw.unattended" && c.undoneAt === null);
		const res = await api("/api/settings-help/undo", { id: change?.id });
		expect(res.status).toBe(200);
		expect((await prefs())["ompw.unattended"]).toBeNull();
		// Undone already: refused, nothing changes.
		expect((await api("/api/settings-help/undo", { id: change?.id })).status).toBe(409);
		const all = await api("/api/settings-help/undo-all", { liveId });
		expect(all.status).toBe(200);
		expect((await prefs())["ompw.palette"]).toBeNull();
		expect((await state()).changes.every((c) => c.undoneAt !== null)).toBe(true);
	}, 60_000);

	test("the access ends by itself, and the tool then says so and changes nothing", async () => {
		await pollUntil(async () => (await state()).grants.length === 0, "the access to end", GRANT_MS + 10_000);
		expect((await state()).ended.find((e) => e.liveId === liveId)?.reason).toBe("expired");
		const result = await agentCalls(ws, liveId, { action: "set", changes: [{ key: "ompw.theme", value: "dark" }] });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("ended");
		expect((await prefs())["ompw.theme"]).not.toBe("dark");
	}, 60_000);
});

describe("Revoke now", () => {
	test("ends the access at once; the tool then refuses with a clear error", async () => {
		const ws = await connect(s);
		const liveId = await start();
		expect((await api("/api/settings-help/revoke", { liveId })).status).toBe(200);
		const result = await agentCalls(ws, liveId, { action: "get" });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("revoked");
		expect((await api("/api/settings-help/revoke", { liveId })).status).toBe(404);
		ws.close();
	}, 60_000);

	test("closing the conversation ends it too", async () => {
		const ws = await connect(s);
		const liveId = await start();
		await request(ws, { t: "close", liveId });
		await pollUntil(
			async () => (await state()).ended.some((e) => e.liveId === liveId && e.reason === "ended"),
			"the end",
		);
		ws.close();
	}, 60_000);
});
