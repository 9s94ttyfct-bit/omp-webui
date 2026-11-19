import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LiveInfo } from "../../shared/protocol.ts";
import { watchFrames } from "../support/frames.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type StubScripted, startScriptedStub } from "../support/stub-scripted.ts";
import { connect, request } from "../support/ws.ts";

/**
 * omp's XDG layout (`omp config init-xdg`): with the default agent directory and an existing `$XDG_DATA_HOME/omp`, omp
 * writes its conversations there, not under `~/.omp/agent/sessions`. The server must list them where omp writes them, or
 * every conversation drops out of the sidebar once its tab closes (#303). Real omp, real server, a scripted provider.
 */

let s: TestServer;
let backend: StubScripted;
let xdg: string;

beforeAll(async () => {
	backend = await startScriptedStub(() => ({ text: "Done." }));
	xdg = realpathSync(mkdtempSync(join(tmpdir(), "ompw-xdg-")));
	mkdirSync(join(xdg, "omp"));
	s = await startTestServer(0, { XDG_DATA_HOME: xdg }, { login: false });
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
	rmSync(xdg, { recursive: true, force: true });
});

const listedFiles = async (): Promise<string[]> => {
	const res = await fetch(`${s.url}/api/sessions`, { headers: { "x-omp-webui-token": s.accessToken } });
	return ((await res.json()) as { file: string }[]).map((x) => x.file);
};

test("a conversation omp writes under $XDG_DATA_HOME/omp is listed, also after a restart", async () => {
	const ws = await connect(s);
	const opened = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: s.work } });
	const frames = watchFrames(ws, opened.liveId);
	const settled = frames.after("session_settled");
	await request(ws, { t: "rpc", liveId: opened.liveId, command: { type: "prompt", message: "Say hello" } });
	await settled;
	const file = opened.sessionFile as string;
	expect(file.startsWith(join(xdg, "omp", "sessions"))).toBe(true);
	await pollUntil(() => existsSync(file), "omp to write the session file", 30_000);
	await pollUntil(async () => (await listedFiles()).includes(file), "the server to list the conversation", 30_000);
	await request(ws, { t: "close", liveId: opened.liveId });
	ws.close();

	await s.restart();
	await pollUntil(async () => (await listedFiles()).includes(file), "the restarted server to list it", 30_000);
}, 120_000);
