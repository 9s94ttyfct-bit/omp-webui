import { afterAll, beforeAll, expect, test } from "bun:test";
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import type { LiveInfo } from "../../shared/protocol.ts";
import { FIXTURE_CWD, writeSimpleSession } from "../support/fixtures.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect, request } from "../support/ws.ts";

/**
 * omp moves itself to a temp directory when it is started in the user's home folder, unless it is given `--allow-home`:
 * the page then shows `~` while omp's `bash`, `edit` and `write` tools run in `/tmp`. A conversation in the home folder
 * (new, or resumed from a file that recorded it) must run there. Real omp and server, in an isolated HOME; no model call.
 */

let s: TestServer;
beforeAll(async () => {
	s = await startTestServer();
}, 60_000);
afterAll(async () => {
	await s?.stop();
});

/** Where omp's `!pwd` runs for the conversation `liveId`. */
async function workingDir(ws: WebSocket, liveId: string): Promise<string> {
	const ran = await request<{ workingDir?: string }>(ws, {
		t: "rpc",
		liveId,
		command: { type: "bash", command: "pwd" },
	});
	return realpathSync(String(ran.workingDir));
}

test("a new chat in the home folder runs omp there, not in a temp directory", async () => {
	const ws = await connect(s);
	const live = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: s.home } });
	expect(live.cwd).toBe(s.home);
	expect(await workingDir(ws, live.liveId)).toBe(realpathSync(s.home));
	await request(ws, { t: "close", liveId: live.liveId });
	ws.close();
}, 60_000);

test("a conversation that ran in the home folder is resumed there", async () => {
	const ws = await connect(s);
	const file = writeSimpleSession(s.agentDir, 0x51, "Home folder probe");
	writeFileSync(file, readFileSync(file, "utf8").replace(`"cwd":"${FIXTURE_CWD}"`, `"cwd":${JSON.stringify(s.home)}`));
	const live = await request<LiveInfo>(ws, { t: "open", target: { kind: "resume", sessionFile: file } });
	expect(live.cwd).toBe(s.home);
	expect(await workingDir(ws, live.liveId)).toBe(realpathSync(s.home));
	await request(ws, { t: "close", liveId: live.liveId });
	ws.close();
}, 60_000);
