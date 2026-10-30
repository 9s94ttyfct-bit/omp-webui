import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	appendFileSync,
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { RpcClient } from "../../server/omp/rpc-client.ts";
import type { LiveInfo, LiveListing } from "../../shared/protocol.ts";
import { writeSimpleSession } from "../support/fixtures.ts";
import { isolatedEnv } from "../support/omp-env.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect, request } from "../support/ws.ts";

/**
 * Pins are omp's own (`<agent dir>/session-pins.json`, by session id, what its resume picker puts first): `/pin` typed in
 * a conversation shows in the sidebar's list, and a pin made from the sidebar is omp's. No model is called.
 */

let s: TestServer;
beforeAll(async () => {
	s = await startTestServer();
}, 60_000);
afterAll(async () => {
	await s?.stop();
});

const read = () => ({ "x-omp-webui-token": s.accessToken });
const write = () => ({ ...read(), "x-omp-webui": "1", "content-type": "application/json" });
const pinned = async (): Promise<string[]> => (await fetch(`${s.url}/api/pins`, { headers: read() })).json();
const setPin = (file: string, on: boolean) =>
	fetch(`${s.url}/api/pins`, { method: "POST", headers: write(), body: JSON.stringify({ file, pinned: on }) });
/** What the server calls the file: omp's canonical path (the test dir is under a symlink on macOS). */
const session = (n: number, title: string): string => realpathSync(writeSimpleSession(s.agentDir, n, title));
const idOf = (file: string): string => /_([0-9a-f-]{36})\.jsonl$/.exec(file)?.[1] as string;
const ompPins = (): string[] => JSON.parse(readFileSync(join(s.agentDir, "session-pins.json"), "utf8"));

test("/pin in a conversation pins it in the sidebar, and a sidebar pin is omp's: the same list on both sides", async () => {
	const typed = session(0x41, "Pinned in omp");
	const clicked = session(0x42, "Pinned in the sidebar");
	const ws = await connect(s);
	try {
		expect(await pinned()).toEqual([]);

		// omp's own command, as the composer sends it.
		const live = await request<LiveInfo>(ws, {
			t: "open",
			target: { kind: "resume", sessionFile: typed, model: "anthropic/claude-haiku-5-5" },
		});
		await request(ws, { t: "rpc", liveId: live.liveId, command: { type: "prompt", message: "/pin" } });
		await pollUntil(
			async () => (await pinned()).includes(typed),
			"the conversation pinned in omp to be pinned in the sidebar",
		);
		expect(ompPins()).toEqual([idOf(typed)]);

		// From the sidebar: omp's list gets the id, the newest pin comes first in the sidebar.
		const res = await setPin(clicked, true);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([clicked, typed]);
		expect(ompPins()).toEqual([idOf(typed), idOf(clicked)]);
		// Pinning what is pinned changes nothing.
		expect(await (await setPin(clicked, true)).json()).toEqual([clicked, typed]);
		expect(ompPins()).toEqual([idOf(typed), idOf(clicked)]);

		// Unpinning from the sidebar also unpins in omp, and does not end or write to the conversation that has a process.
		const before = statSync(typed).mtimeMs;
		expect(await (await setPin(typed, false)).json()).toEqual([clicked]);
		expect(ompPins()).toEqual([idOf(clicked)]);
		const mine = ((await (await fetch(`${s.url}/api/lives`, { headers: read() })).json()) as LiveListing[]).find(
			(l) => l.liveId === live.liveId,
		);
		expect(mine?.exited).toBe(false);
		expect(statSync(typed).mtimeMs).toBe(before);

		// Typed `/pin` again toggles it back.
		await request(ws, { t: "rpc", liveId: live.liveId, command: { type: "prompt", message: "/pin" } });
		await pollUntil(async () => (await pinned()).includes(typed), "the pin made in omp to show again");
		expect(ompPins()).toEqual([idOf(clicked), idOf(typed)]);
	} finally {
		ws.close();
		rmSync(typed, { force: true });
		rmSync(clicked, { force: true });
	}
}, 120_000);

/** A turn that ran `eval` (its call and its result), after the entry `parentId`, as omp saves it. */
function evalTurn(parentId: string, n: number): string {
	const at = new Date().toISOString();
	const call = `e${n}call0`;
	const toolCallId = `toolu_eval_${n}`;
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	const entries = [
		{
			type: "message",
			id: call,
			parentId,
			timestamp: at,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: toolCallId, name: "eval", arguments: { language: "js", code: "1" } }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-haiku-5-5",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: zero },
				stopReason: "toolUse",
				timestamp: Date.parse(at),
			},
		},
		{
			type: "message",
			id: `e${n}result`,
			parentId: call,
			timestamp: at,
			message: {
				role: "toolResult",
				toolCallId,
				toolName: "eval",
				content: [{ type: "text", text: "1" }],
				isError: false,
				timestamp: Date.parse(at),
			},
		},
	];
	return entries.map((e) => `${JSON.stringify(e)}\n`).join("");
}

test("pinning from the sidebar a conversation another omp writes to, whose history used eval, pins it and does not fork it (#686)", async () => {
	const file = session(0x45, "Used eval");
	const id = idOf(file);
	appendFileSync(file, evalTurn("s45000002", 1));
	const conversations = () =>
		readdirSync(dirname(file))
			.filter((f) => f.endsWith(".jsonl"))
			.sort();
	const existing = conversations();
	// An omp of the test's own (a terminal's, or this server's) that has written to it holds omp's write claim.
	const terminal = new RpcClient({
		bin: "omp",
		args: ["--resume", file],
		cwd: s.root,
		env: await isolatedEnv(s.root),
		onFrame() {},
		onExit() {},
	});
	try {
		await terminal.ready;
		await terminal.call({ type: "set_session_name", name: "Held by a terminal" }, 30_000);
		await pollUntil(async () => readFileSync(file, "utf8").includes("Held by a terminal"), "the terminal to write");
		// Its model ran `eval` since it noted on starting that no eval kernel was restored: an omp resumed on it now would
		// note that again, a write, which omp saves to a fresh sibling file while another process holds the claim.
		const lines = readFileSync(file, "utf8").trimEnd().split("\n");
		appendFileSync(file, evalTurn(JSON.parse(lines[lines.length - 1] as string).id, 2));
		const files = conversations();
		expect(files).toContain(basename(file));

		const res = await setPin(file, true);
		expect(conversations()).toEqual(files);
		expect(res.status).toBe(200);
		expect(await res.json()).toContain(file);
		expect(ompPins()).toContain(id);
	} finally {
		terminal.kill("SIGKILL");
		await setPin(file, false);
		// A fork the bug made, if any.
		for (const f of conversations()) if (!existing.includes(f)) rmSync(join(dirname(file), f), { force: true });
		rmSync(file, { force: true });
	}
}, 120_000);

test("pins that earlier versions kept in the data dir are omp's after a restart, and the old file is gone", async () => {
	const old = session(0x43, "Pinned before");
	const older = session(0x44, "Pinned long before");
	try {
		// Newest first, as the old list was kept; `old` was pinned after `older`. Read when the server starts.
		writeFileSync(join(s.root, "data", "pins.json"), JSON.stringify([old, older, "/gone/deleted.jsonl"]));
		await s.restart();
		await pollUntil(async () => !existsSync(join(s.root, "data", "pins.json")), "the old list to be moved");
		// (What the other test left pinned may still be listed: its files are removed while the server is looking.)
		expect((await pinned()).filter((f) => f === old || f === older)).toEqual([old, older]);
		expect(ompPins().slice(-2)).toEqual([idOf(older), idOf(old)]);
	} finally {
		rmSync(old, { force: true });
		rmSync(older, { force: true });
	}
}, 120_000);
