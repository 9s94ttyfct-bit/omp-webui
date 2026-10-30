import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, rmSync } from "node:fs";
import type { LiveInfo, LiveListing } from "../../shared/protocol.ts";
import { writeSimpleSession } from "../support/fixtures.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect, request } from "../support/ws.ts";

/**
 * Deleting a conversation whose omp is busy. omp refuses to delete a session that is streaming but still answers the
 * command as if it ran; the server used to kill the process anyway and then report that omp did not delete it.
 * Now it is refused up front, and the process is ended only after a delete that happened. No model is called: the
 * conversation is busy with a `!command`.
 */

let s: TestServer;
beforeAll(async () => {
	s = await startTestServer();
}, 60_000);
afterAll(async () => {
	await s?.stop();
});

async function post(path: string, body: unknown) {
	const res = await fetch(`${s.url}${path}`, {
		method: "POST",
		headers: { "x-omp-webui-token": s.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}
const listing = async (): Promise<LiveListing[]> =>
	(await fetch(`${s.url}/api/lives`, { headers: { "x-omp-webui-token": s.accessToken } })).json();

test("a busy conversation is not deleted (409, nothing ended); once idle it is, and its process ends", async () => {
	const file = writeSimpleSession(s.agentDir, 0x25, "Delete while busy");
	const ws = await connect(s);
	try {
		const live = await request<LiveInfo>(ws, {
			t: "open",
			target: { kind: "resume", sessionFile: file, model: "anthropic/claude-haiku-5-5" },
		});
		const mine = async () => (await listing()).find((l) => l.liveId === live.liveId);
		// omp answers `!command` only when it ends: the conversation is busy for as long as it runs.
		const command = request(ws, { t: "rpc", liveId: live.liveId, command: { type: "bash", command: "sleep 4" } });
		await pollUntil(async () => (await mine())?.busy === true, "the process to be busy");

		const refused = await post("/api/session/delete", { file });
		expect(refused.status).toBe(409);
		expect(String(refused.body.error)).toMatch(/stop it first/i);
		expect(existsSync(file)).toBe(true);
		expect((await mine())?.exited).toBe(false);

		// In bulk the busy one is reported as not deleted, with the same reason, and nothing is ended either.
		const bulk = await post("/api/sessions/delete", { files: [file] });
		expect(bulk.status).toBe(200);
		expect(bulk.body.deleted).toEqual([]);
		expect(bulk.body.failed).toMatchObject([{ error: refused.body.error }]);
		expect(existsSync(file)).toBe(true);
		expect((await mine())?.exited).toBe(false);

		// The command ends on its own; the conversation is idle and can be deleted.
		await command;
		await pollUntil(async () => (await mine())?.busy === false, "the process to be idle");
		const done = await post("/api/session/delete", { file });
		expect(done.status).toBe(200);
		expect(existsSync(file)).toBe(false);
		await pollUntil(async () => (await mine())?.exited !== false, "the process of the deleted conversation to end");
	} finally {
		ws.close();
		rmSync(file, { force: true });
	}
}, 120_000);
