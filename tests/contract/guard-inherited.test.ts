import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ParkedRecord } from "../../server/omp/parked.ts";
import type { LiveAttached, LiveInfo, LiveListing } from "../../shared/protocol.ts";
import { watchFrames } from "../support/frames.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type ScriptedRequest, type StubScripted, startScriptedStub } from "../support/stub-scripted.ts";
import { connect, request } from "../support/ws.ts";

/**
 * "Guard dangerous commands" (#609) and a conversation that this server did not start: the real omp (18.12), a scripted model, the
 * real server restarted over a paused conversation. A process the next server takes over (an older version started it, or a server
 * that is gone) has no gate until it is opened again: it is not refused a turn for that (a refusal would strand every paused
 * conversation after an update, and its resumed turn would run unguarded anyway), and says so (`LiveInfo.ungated`). One this server
 * started without the gate is refused, as before.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-guard-inherited-"));
let s: TestServer;
let agent: StubScripted;

const agentScript = (req: ScriptedRequest) => ({ text: req.tools.includes("write") ? "Main done." : "A title" });

beforeAll(async () => {
	agent = await startScriptedStub(agentScript);
	s = await startTestServer(0, {}, { login: false });
	writeFileSync(
		join(s.agentDir, "models.yml"),
		[
			"providers:",
			"  omlx:",
			`    baseUrl: ${agent.url}`,
			"    api: openai-completions",
			`    apiKey: ${agent.apiKey}`,
			"    models:",
			"      - id: stub-model",
			"",
		].join("\n"),
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
	const res = await fetch(`${s.url}/api/guard`, {
		method: "POST",
		headers: { ...authed(), "content-type": "application/json" },
		body: JSON.stringify({ mode: "reviewer", reviewer: "" }),
	});
	expect(res.status).toBe(200);
}, 120_000);

afterAll(async () => {
	await s?.stop();
	await agent?.stop();
	rmSync(root, { recursive: true, force: true });
});

const authed = () => ({ "x-omp-webui-token": s.accessToken, "x-omp-webui": "1" });
const lives = async (): Promise<LiveListing[]> =>
	(await (await fetch(`${s.url}/api/lives`, { headers: authed() })).json()) as LiveListing[];
const listed = async (liveId: string): Promise<LiveListing | undefined> =>
	(await lives()).find((l) => l.liveId === liveId);
const record = (liveId: string): ParkedRecord =>
	JSON.parse(readFileSync(join(s.root, "data", "parked", `${liveId}.json`), "utf8"));

async function open(args: string[] = []): Promise<{ ws: WebSocket; live: LiveInfo }> {
	const ws = await connect(s);
	const live = await request<LiveInfo>(ws, {
		t: "open",
		target: { kind: "new", cwd: s.work, approvalMode: "yolo", args },
	});
	return { ws, live };
}

/** A tab on the restarted server: attached to the conversation, and told of its frames. */
async function reattach(liveId: string) {
	const ws = await connect(s);
	const frames = watchFrames(ws, liveId);
	const attached = await request<LiveAttached>(ws, { t: "attach", liveId });
	return { ws, frames, attached };
}

const prompt = (ws: WebSocket, liveId: string) =>
	request(ws, { t: "rpc", liveId, command: { type: "prompt", message: "go" } });

test("a paused conversation that started without the gate is adopted as `inherited`, and is given its turn while the guard is on", async () => {
	// What a version without the gate started: no extension on its command line, so no note that the gate ran.
	const own = join(root, "trusted.ts");
	writeFileSync(own, "export default function () {}\n");
	const first = await open(["--trusted-extension", own]);
	const { liveId } = first.live;
	expect(first.live.args).not.toContain("--extension");
	// This server started it without the gate (the user's own flags): its choice, and refused as it has been.
	await pollUntil(async () => (await listed(liveId))?.ungated === "chosen", "the process to be said ungated by choice");
	await expect(prompt(first.ws, liveId)).rejects.toThrow(/Guard dangerous commands is on/);
	await request(first.ws, { t: "pause", liveId });
	first.ws.close();

	await s.restart();
	const adopted = await listed(liveId);
	expect(adopted).toMatchObject({ liveId, ungated: "inherited", exited: false });
	expect(adopted?.pausedAt).not.toBeNull();

	const { ws, frames, attached } = await reattach(liveId);
	expect(attached.ungated).toBe("inherited");
	await request(ws, { t: "resume", liveId });
	const ended = frames.after("agent_end");
	await prompt(ws, liveId);
	await ended;
	// The conversation went on: nothing stopped its turn, and it is still said to run without the gate.
	expect(await listed(liveId)).toMatchObject({ ungated: "inherited" });
	await request(ws, { t: "close", liveId }).catch(() => {});
	ws.close();
}, 180_000);

test("a process whose gate was seen to start is not taken for one without, though its note is gone when the next server takes it over", async () => {
	const first = await open();
	const { liveId } = first.live;
	expect(first.live.args).toContain("--extension");
	await pollUntil(
		async () => (await listed(liveId)) !== undefined && (await listed(liveId))?.ungated === undefined,
		"the gate to be seen",
	);
	await request(first.ws, { t: "pause", liveId });
	await pollUntil(
		() => existsSync(join(s.root, "data", "parked", `${liveId}.json`)),
		"the record of the paused conversation",
	);
	// The gate ran in the process (the server saw its note), and the record says so.
	expect(record(liveId).gated).toBe(true);
	// A cleaner of the temp folder takes the note beside the overlay while the conversation is kept.
	const note = `${record(liveId).overlay?.file}.risk.loaded`;
	expect(existsSync(note)).toBe(true);
	rmSync(note);
	first.ws.close();

	await s.restart();
	const adopted = await listed(liveId);
	expect(adopted).toMatchObject({ liveId, exited: false });
	expect(adopted?.ungated).toBeUndefined();

	const { ws, frames, attached } = await reattach(liveId);
	expect(attached.ungated).toBeUndefined();
	await request(ws, { t: "resume", liveId });
	const ended = frames.after("agent_end");
	await prompt(ws, liveId);
	await ended;
	expect((await listed(liveId))?.ungated).toBeUndefined();
	await request(ws, { t: "close", liveId }).catch(() => {});
	ws.close();
}, 180_000);

test("a gated process is adopted by the next server with its gate: the note beside the overlay stays, the command line names the gate, and its word is the new server's", async () => {
	const first = await open();
	const { liveId } = first.live;
	await pollUntil(
		async () => (await listed(liveId)) !== undefined && (await listed(liveId))?.ungated === undefined,
		"the gate to be seen",
	);
	await request(first.ws, { t: "pause", liveId });
	await pollUntil(
		() => existsSync(join(s.root, "data", "parked", `${liveId}.json`)),
		"the record of the paused conversation",
	);
	// What the record keeps of it: the gate on its command line, and that the gate ran. The note itself stays where it is.
	const kept = record(liveId);
	const at = kept.args.indexOf("--extension");
	expect(at).toBeGreaterThan(-1);
	expect(kept.gated).toBe(true);
	const word = `${kept.overlay?.file}.risk`;
	expect(existsSync(`${word}.loaded`)).toBe(true);
	first.ws.close();

	await s.restart();
	const adopted = await listed(liveId);
	expect(adopted).toMatchObject({ liveId, exited: false });
	// Gated, not `inherited`: the extension on its command line is the one this server installs, and its note is there.
	expect(adopted?.ungated).toBeUndefined();
	const read = (): { armed: boolean; ports?: number[]; guard?: { mode: string } } =>
		JSON.parse(readFileSync(word, "utf8"));
	// The word the gate reads is the new server's: it knows this server's own port among the ports of an omp-webui API (the old server's may have been another).
	const port = Number(new URL(s.url).port);
	await pollUntil(() => existsSync(word) && read().ports?.includes(port) === true, "the new server's word to the gate");
	expect(read().guard?.mode).toBe("reviewer");
	// Overwritten behind the server's back: put right at the next look.
	writeFileSync(word, JSON.stringify({ armed: false }));
	await pollUntil(
		() => read().ports?.includes(port) === true && read().guard?.mode === "reviewer",
		"the word to be written again",
	);

	const { ws, frames, attached } = await reattach(liveId);
	expect(attached.ungated).toBeUndefined();
	await request(ws, { t: "resume", liveId });
	const ended = frames.after("agent_end");
	await prompt(ws, liveId);
	await ended;
	expect((await listed(liveId))?.ungated).toBeUndefined();
	await request(ws, { t: "close", liveId }).catch(() => {});
	ws.close();
}, 180_000);
