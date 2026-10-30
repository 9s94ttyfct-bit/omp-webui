import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveInfo } from "../../shared/protocol.ts";
import { type AppServer, startAppServer } from "../support/app-server.ts";
import { writeFakeOmp } from "../support/fake-omp.ts";
import { isolatedEnv } from "../support/omp-env.ts";
import { connect, request } from "../support/ws.ts";

/**
 * The server's side of a slim state read: an `rpc` message that asks for it is answered without the system prompt
 * and without the bodies of the tool schemas, and one that does not ask for it is answered whole (#467). The page
 * reads the tools' names alone, so what is left is what it needs.
 *
 * The scripted omp answers with a state that has both, so that what the server leaves out is what omp really sent.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-slim-"));
const work = join(root, "work");
let server: AppServer;
let ws: WebSocket;
let live: LiveInfo;

const TOOLS = [
	{
		name: "read",
		description: "Read a file.",
		parameters: { type: "object", properties: { path: { type: "string" } } },
	},
	{
		name: "propose_goal",
		description: "Propose a goal.",
		parameters: { type: "object", properties: { objective: {} } },
	},
];
const SYSTEM_PROMPT = ["RFC 2119 keywords: MUST, SHOULD.", "You are omp's trusted coding assistant."];

interface RpcState {
	systemPrompt?: unknown;
	dumpTools?: { name: string; description?: string; parameters?: unknown }[];
	[key: string]: unknown;
}

const state = (slim = false): Promise<RpcState> =>
	request<RpcState>(ws, {
		t: "rpc",
		liveId: live.liveId,
		command: { type: "get_state" },
		...(slim ? { slim: true } : {}),
	});

beforeAll(async () => {
	mkdirSync(work, { recursive: true });
	const env = await isolatedEnv(root, { login: false });
	// The scripted omp's state carries a prompt and a schema per tool: what a slim read leaves out.
	const bin = writeFakeOmp(root, { state: { systemPrompt: SYSTEM_PROMPT, dumpTools: TOOLS } });
	server = await startAppServer(env, join(root, "data"), 0, { OMP_BIN: bin });
	ws = await connect({ url: `http://127.0.0.1:${server.port}`, accessToken: server.token });
	live = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: work } });
}, 60_000);

afterAll(async () => {
	ws?.close();
	server?.proc.kill("SIGKILL");
	rmSync(root, { recursive: true, force: true });
});

test("a slim read is answered without the system prompt and with the tool names alone", async () => {
	const slim = await state(true);
	expect(slim.systemPrompt).toBeUndefined();
	expect(slim.dumpTools).toEqual([{ name: "read" }, { name: "propose_goal" }]);
	// The rest of the state is there: what the page reads of it.
	expect(slim.sessionId).toBe("fake");
}, 30_000);

test("a read that does not ask for a slim one is answered whole", async () => {
	const whole = await state();
	expect(whole.systemPrompt).toEqual(SYSTEM_PROMPT);
	expect(whole.dumpTools).toEqual(TOOLS);
}, 30_000);

test("a slim read is much smaller than the whole one", async () => {
	const bytes = (s: RpcState) => new TextEncoder().encode(JSON.stringify(s)).length;
	expect(bytes(await state(true))).toBeLessThan(bytes(await state()));
}, 30_000);
