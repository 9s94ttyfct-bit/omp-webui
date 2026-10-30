import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveInfo } from "../../shared/protocol.ts";
import { RISK_DENY } from "../../shared/risk-confirm.ts";
import { type Frame, watchFrames } from "../support/frames.ts";
import { lanAddress, type NetSocket, rawSocket } from "../support/lan-peer.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type ScriptedTurn, type StubScripted, startScriptedStub } from "../support/stub-scripted.ts";
import { connect, request } from "../support/ws.ts";

/**
 * "Confirm risky commands from remote pages" for a page on the network (#621): the setting is about every page that is
 * not this computer's, and a server that listens on a network address has such pages that are no tunnel's. The page is
 * made as in `lan-local.test.ts`: a real socket from this computer's network address, to a server on the loopback. The
 * model is a scripted provider (no model call), omp is the real one.
 */

const LAN = lanAddress();
if (LAN === undefined) {
	console.warn("lan-confirm: this computer has no IPv4 address on a network, so its cases are skipped");
}
const networkOnly = LAN === undefined ? describe.skip : describe;

const root = mkdtempSync(join(tmpdir(), "ompw-lan-confirm-"));
const settingsFile = join(root, "remote.json");
const outside = join(root, "outside");
let s: TestServer;
let backend: StubScripted;

/** What the scripted model does next: one tool call (the first request of a turn that has none to answer). */
let plan: { name: string; args: unknown } | null = null;
/** What the tools answered, as the model was told. */
const told: string[] = [];

const script = async (req: { text: string; tools: string[] }): Promise<ScriptedTurn> => {
	if (!req.tools.includes("write")) return { text: "A title" };
	const messages = JSON.parse(req.text) as { role?: string; content?: unknown }[];
	const last = messages.at(-1);
	if (last?.role === "tool") {
		told.push(String(last.content));
		return { text: "Done." };
	}
	const next = plan;
	plan = null;
	return next ? { call: next } : { text: "Nothing to do." };
};

beforeAll(async () => {
	mkdirSync(outside, { recursive: true });
	// The switch is on; remote access itself is not: no tunnel is involved, the page comes over the network.
	writeFileSync(settingsFile, JSON.stringify({ confirmRisky: true }));
	backend = await startScriptedStub(script);
	s = await startTestServer(0, { OMP_WEBUI_REMOTE_CONFIG: settingsFile }, { login: false });
	writeFileSync(
		join(s.agentDir, "models.yml"),
		`providers:\n  omlx:\n    baseUrl: ${backend.url}\n    api: openai-completions\n    apiKey: ${backend.apiKey}\n    discovery:\n      type: openai-models-list\n`,
	);
	writeFileSync(
		join(s.agentDir, "config.yml"),
		[
			"modelRoles:",
			...["default", "smol", "slow", "tiny", "commit"].map((r) => `  ${r}: omlx/stub-model`),
			"spelling:",
			"  autocomplete: ngram",
			"",
		].join("\n"),
	);
}, 120_000);

afterAll(async () => {
	await s?.stop();
	await backend?.stop();
	rmSync(root, { recursive: true, force: true });
});

/** The helpers of the specs take a `WebSocket`; the socket of a page on the network answers the part of it they use. */
const asWebSocket = (socket: NetSocket): WebSocket => socket as unknown as WebSocket;

const isConfirmation = (f: Frame): boolean =>
	f.type === "extension_ui_request" && f.method === "select" && String(f.title ?? "").startsWith("Confirm risky call:");

/** A write outside the project folder: risky, and visible in the file system. */
const outsideWrite = (name: string) => ({
	name: "write",
	args: { path: join(outside, name), content: "from the agent" },
});

/** A conversation in yolo mode opened by a page on this computer, and a page on the network attached to it. */
async function conversation() {
	const local = await connect(s);
	const socket = await rawSocket({
		host: "127.0.0.1",
		port: Number(new URL(s.url).port),
		from: LAN,
		headers: { origin: s.url, cookie: `ompw_token=${s.accessToken}` },
	});
	if (!socket) throw new Error("the server refused the socket of a page on the network");
	const away = asWebSocket(socket);
	const live = await request<LiveInfo>(local, {
		t: "open",
		target: { kind: "new", cwd: s.work, approvalMode: "yolo" },
	});
	await request(away, { t: "attach", liveId: live.liveId });
	return {
		live,
		local,
		away,
		here: watchFrames(local, live.liveId),
		there: watchFrames(away, live.liveId),
		close: async () => {
			await request(local, { t: "close", liveId: live.liveId }).catch(() => {});
			local.close();
			away.close();
		},
	};
}

const prompt = (ws: WebSocket, liveId: string) =>
	request(ws, { t: "rpc", liveId, command: { type: "prompt", message: "go" } });

networkOnly("a page on the network and the setting that confirms risky commands", () => {
	test("a risky call of a turn it sent waits for it, and denying refuses the call", async () => {
		const c = await conversation();
		const target = join(outside, "from-the-network.txt");
		told.length = 0;
		plan = outsideWrite("from-the-network.txt");
		const ended = c.here.after("agent_end");
		const ask = c.there.next(isConfirmation);
		await prompt(c.away, c.live.liveId);
		const frame = await ask;
		// It waits: nothing ran.
		expect(existsSync(target)).toBe(false);
		c.away.send(
			JSON.stringify({ t: "ui_response", liveId: c.live.liveId, response: { id: frame.id, value: RISK_DENY } }),
		);
		await ended;
		expect(existsSync(target)).toBe(false);
		expect(told.at(-1)).toMatch(/did not allow this high-risk call \(write_outside\)/);
		await c.close();
	}, 90_000);

	test("a risky call of a turn this computer's page sent runs without a question, the page on the network attached or not", async () => {
		const c = await conversation();
		const target = join(outside, "from-this-computer.txt");
		plan = outsideWrite("from-this-computer.txt");
		const ended = c.here.after("agent_end");
		await prompt(c.local, c.live.liveId);
		await ended;
		expect(existsSync(target)).toBe(true);
		expect([...c.here.seen, ...c.there.seen].filter(isConfirmation)).toEqual([]);
		await c.close();
	}, 90_000);
});
