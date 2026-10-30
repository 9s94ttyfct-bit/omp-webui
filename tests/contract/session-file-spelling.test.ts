import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { LiveInfo, LiveListing } from "../../shared/protocol.ts";
import { watchFrames } from "../support/frames.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type StubScripted, startScriptedStub } from "../support/stub-scripted.ts";
import { connect, request } from "../support/ws.ts";

/**
 * The name a conversation's session file is known by: one spelling, however the links on the way are named (on macOS
 * `/var` is a link to `/private/var`, and a test's home is under it). The reply to `open` and the live announces
 * must agree: a page that reads a change of the file as a change of the conversation refetches the whole transcript
 * and drops what the conversation held (#448).
 */

let s: TestServer;
let backend: StubScripted;
let ws: WebSocket;

beforeAll(async () => {
	// A scripted provider stands in for the model: the real omp runs the turn and writes the session file.
	backend = await startScriptedStub(() => ({ text: "Done." }));
	s = await startTestServer(0, {}, { login: false });
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
	ws = await connect(s);
}, 120_000);

afterAll(async () => {
	ws?.close();
	await s?.stop();
	await backend?.stop();
});

test("the reply to `open` and the live announces name a conversation's file the same way (#448)", async () => {
	/** Every session file the server named, in order (null: announced before omp said which file it is). */
	const named: (string | null)[] = [];
	const collect = (ev: MessageEvent) => {
		const m = JSON.parse(String(ev.data)) as { t?: string; info?: { sessionFile?: string | null } };
		if (m.t === "live") named.push(m.info?.sessionFile ?? null);
	};
	ws.addEventListener("message", collect);
	try {
		const opened = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: s.work } });
		const file = opened.sessionFile as string;
		expect(file).not.toBeNull();

		// The name is the file's real path: the links on the way resolved, the file's own name as it is.
		expect(file).toBe(join(realpathSync(dirname(file)), basename(file)));

		// A turn writes the file (omp has not written it before). The server asks omp for its state when the turn ends
		// and announces the conversation if the name changed.
		const frames = watchFrames(ws, opened.liveId);
		const settled = frames.after("session_settled");
		await request(ws, { t: "rpc", liveId: opened.liveId, command: { type: "prompt", message: "Say hello" } });
		await settled;
		await pollUntil(() => existsSync(file), "omp to write the session file", 30_000);
		// omp answers in order: the server's own `get_state` (sent when it saw the settle) is answered before this one, so
		// anything it announced has been sent before this reply comes.
		await request(ws, { t: "rpc", liveId: opened.liveId, command: { type: "get_state" } });

		// One spelling, everywhere: a page that reads a change of the name as a change of the conversation is wrong. A new
		// conversation is announced without a file while omp has not yet said which it is (how many of those come before
		// omp's first `get_state` answer depends on how busy the machine is); once it has one, every announce names it so.
		const bound = named.findIndex((n) => n !== null);
		expect(bound).toBeGreaterThanOrEqual(0);
		expect(named.slice(bound)).toEqual(named.slice(bound).map(() => file));
		const listed = (await request<LiveListing[]>(ws, { t: "list_lives" })).find((l) => l.liveId === opened.liveId);
		expect(listed?.sessionFile).toBe(file);
	} finally {
		ws.removeEventListener("message", collect);
	}
}, 90_000);
