import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { RpcClient } from "../../server/omp/rpc-client.ts";
import type { SessionSummary } from "../../shared/protocol.ts";
import { writeSimpleSession } from "../support/fixtures.ts";
import { isolatedEnv } from "../support/omp-env.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * A conversation that another omp process has open for writing (a terminal's; here a process of the test's own, outside
 * the server's pool) belongs to that process: omp gives a session one writer. A rename sent to a short-lived omp is written
 * to a fresh copy of the conversation (the sidebar then lists two, and says it worked), and a delete removes the file
 * under the owner. Both are refused instead, with the reason; once the other omp is gone they work. No model is called.
 */

let s: TestServer;
const terminals: RpcClient[] = [];
beforeAll(async () => {
	s = await startTestServer();
}, 60_000);
afterAll(async () => {
	for (const t of terminals) t.kill("SIGKILL");
	await s?.stop();
});

const read = () => ({ "x-omp-webui-token": s.accessToken });
const post = async (path: string, body: unknown) => {
	const res = await fetch(`${s.url}${path}`, {
		method: "POST",
		headers: { ...read(), "x-omp-webui": "1", "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const sessions = async (): Promise<SessionSummary[]> =>
	(await fetch(`${s.url}/api/sessions`, { headers: read() })).json();
const titleOf = async (file: string) => (await sessions()).find((x) => x.file === file)?.title;

/** An omp of the test's own on `file` that has written to it, which is what takes a session's lease. */
async function terminalOn(file: string): Promise<RpcClient> {
	const env = await isolatedEnv(s.root);
	const terminal = new RpcClient({ bin: "omp", args: ["--resume", file], cwd: s.root, env, onFrame() {}, onExit() {} });
	terminals.push(terminal);
	await terminal.ready;
	await terminal.call({ type: "set_session_name", name: "Named in the terminal" }, 30_000);
	return terminal;
}

test("renaming or deleting a conversation that a terminal's omp has open is refused, and works once it is closed", async () => {
	const file = realpathSync(writeSimpleSession(s.agentDir, 0x61, "Held by a terminal"));
	const bucket = dirname(file);
	const files = () => readdirSync(bucket).filter((f) => f.endsWith(".jsonl"));
	const before = files();
	const terminal = await terminalOn(file);
	await pollUntil(async () => (await titleOf(file)) === "Named in the terminal", "the terminal's name to be listed");

	const rename = await post("/api/session/rename", { file, title: "Renamed in the web UI" });
	expect(rename.status).toBe(409);
	expect(String(rename.body.error)).toMatch(/another omp process/);
	// Nothing was written anywhere: not to the conversation, and not to a copy of it.
	expect(files()).toEqual(before);
	expect(await titleOf(file)).toBe("Named in the terminal");

	const remove = await post("/api/session/delete", { file });
	expect(remove.status).toBe(409);
	expect(String(remove.body.error)).toMatch(/another omp process/);
	expect(existsSync(file)).toBe(true);

	// In bulk it is reported as not deleted, with the same reason.
	const bulk = await post("/api/sessions/delete", { files: [file] });
	expect(bulk.body.deleted).toEqual([]);
	expect(bulk.body.failed).toMatchObject([{ file, error: remove.body.error }]);
	expect(existsSync(file)).toBe(true);

	// The terminal's omp ends (its lease goes with it): the rename is the conversation's own, and so is the delete.
	terminal.kill("SIGKILL");
	await terminal.whenExited;
	const renamed = await post("/api/session/rename", { file, title: "Renamed in the web UI" });
	expect(renamed.status).toBe(200);
	await pollUntil(async () => (await titleOf(file)) === "Renamed in the web UI", "the new name to be listed");
	expect(files()).toEqual(before);

	const removed = await post("/api/session/delete", { file });
	expect(removed.status).toBe(200);
	expect(existsSync(file)).toBe(false);
}, 120_000);
