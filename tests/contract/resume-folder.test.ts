import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveInfo, LiveListing } from "../../shared/protocol.ts";
import { FIXTURE_CWD, writeSimpleSession } from "../support/fixtures.ts";
import { messageWhere } from "../support/frames.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect, request } from "../support/ws.ts";

/**
 * Opening a conversation whose folder is gone. omp's tools (`bash`, `edit`, `write`) run in the folder its process is
 * started in, so the server must never pick one itself (it used to start omp in omp's own sessions directory): it refuses,
 * says which folder it was and where to look instead, and starts omp in a folder the user chose. Real omp and server.
 */

let s: TestServer;
beforeAll(async () => {
	s = await startTestServer();
	mkdirSync(join(s.agentDir, "sessions", "-tmp-ompw-fixture-project"), { recursive: true });
}, 60_000);
afterAll(async () => {
	await s?.stop();
});

/** A saved conversation whose header names `cwd` (nothing at all when `cwd` is null). */
function savedIn(n: number, cwd: string | null): string {
	const file = writeSimpleSession(s.agentDir, n, `Folder probe ${n}`);
	const text = readFileSync(file, "utf8");
	writeFileSync(
		file,
		text.replace(`"cwd":"${FIXTURE_CWD}"`, cwd === null ? `"nocwd":true` : `"cwd":${JSON.stringify(cwd)}`),
	);
	return file;
}

/** An `open` request's whole reply: the error code and parameters travel beside the sentence. */
async function open(ws: WebSocket, target: Record<string, unknown>) {
	const req = crypto.randomUUID();
	const reply = messageWhere(ws, (m) => m.t === "reply" && m.req === req);
	ws.send(JSON.stringify({ t: "open", req, target }));
	return (await reply) as unknown as {
		ok: boolean;
		error?: string;
		code?: string;
		params?: Record<string, string>;
		data?: LiveInfo;
	};
}

const lives = (ws: WebSocket) => request<LiveListing[]>(ws, { t: "list_lives" });

test("a conversation whose folder is gone is refused with the folder and the closest one that exists, and no omp is started", async () => {
	const ws = await connect(s);
	const gone = join(s.root, "was-here", "deleted", "project");
	const file = savedIn(0x41, gone);
	const refused = await open(ws, { kind: "resume", sessionFile: file });
	expect(refused.ok).toBe(false);
	expect(refused.code).toBe("sessionFolderGone");
	expect(refused.params).toEqual({ folder: gone, nearest: s.root });
	expect(refused.error).toContain(gone);
	// Nothing runs for it, least of all in omp's own session storage.
	expect((await lives(ws)).filter((l) => l.sessionFile?.endsWith(file.split("/").pop() as string))).toEqual([]);

	// A pick from a page that does not know the folder is gone does nothing either while the recorded folder exists.
	ws.close();
}, 60_000);

test("the folder the user chooses is where omp is started, and its tools run there", async () => {
	const ws = await connect(s);
	const file = savedIn(0x42, join(s.root, "also", "gone"));
	const chosen = join(s.root, "chosen");
	mkdirSync(chosen, { recursive: true });

	const refusedAgain = await open(ws, { kind: "resume", sessionFile: file, folder: join(s.root, "not-there-either") });
	expect(refusedAgain.ok).toBe(false);
	expect(refusedAgain.error).toMatch(/Directory does not exist/);

	const reply = await open(ws, { kind: "resume", sessionFile: file, folder: chosen });
	expect(reply.ok).toBe(true);
	const live = reply.data as LiveInfo;
	expect(live.cwd).toBe(chosen);
	const ran = await request<{ workingDir?: string }>(ws, {
		t: "rpc",
		liveId: live.liveId,
		command: { type: "bash", command: "pwd" },
	});
	expect(realpathSync(String(ran.workingDir))).toBe(realpathSync(chosen));
	await request(ws, { t: "close", liveId: live.liveId });
	ws.close();
}, 60_000);

test("a conversation whose file names no folder is refused the same way, and the folder it recorded wins when it exists", async () => {
	const ws = await connect(s);
	const unknown = await open(ws, { kind: "resume", sessionFile: savedIn(0x43, null) });
	expect(unknown.ok).toBe(false);
	expect(unknown.code).toBe("sessionFolderUnknown");

	// A folder that exists is used, whatever a stale choice says.
	const there = join(s.root, "still-there");
	mkdirSync(there, { recursive: true });
	const chosenElsewhere = join(s.root, "somewhere-else");
	mkdirSync(chosenElsewhere, { recursive: true });
	const reply = await open(ws, {
		kind: "resume",
		sessionFile: savedIn(0x44, there),
		folder: chosenElsewhere,
	});
	expect(reply.ok).toBe(true);
	expect(reply.data?.cwd).toBe(there);
	await request(ws, { t: "close", liveId: (reply.data as LiveInfo).liveId });
	ws.close();
}, 60_000);
