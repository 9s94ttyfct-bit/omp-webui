import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveInfo, LiveListing } from "../../shared/protocol.ts";
import { messageWhere } from "../support/frames.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect, request } from "../support/ws.ts";

/**
 * omp's `/move <folder>` takes a conversation to another folder: its session file is filed under the new one and `get_state`
 * names no folder, so the folder a conversation shows, and everything the server reads from it (project presets and
 * roles), must follow what omp reports. Real omp and server; no model is called.
 */

let s: TestServer;
beforeAll(async () => {
	s = await startTestServer();
}, 60_000);
afterAll(async () => {
	await s?.stop();
});

const HAIKU = "anthropic/claude-haiku-5-5";

/** A folder of its own, with a project preset only it has. */
function project(name: string): string {
	const dir = join(s.root, name);
	mkdirSync(join(dir, ".omp"), { recursive: true });
	writeFileSync(
		join(dir, ".omp", "config.yml"),
		["modelPresets:", `  only-${name}:`, "    modelRoles:", `      default: ${HAIKU}:low`, ""].join("\n"),
	);
	return realpathSync(dir);
}

const listing = (ws: WebSocket, liveId: string) =>
	request<LiveListing[]>(ws, { t: "list_lives" }).then((all) => all.find((l) => l.liveId === liveId));

test("a new conversation that is moved before its first reply shows the folder omp moved it to, and reads that folder's presets", async () => {
	const ws = await connect(s);
	const there = project("moved-new");
	const live = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: s.work } });
	expect(live.cwd).toBe(s.work);
	await expect(request(ws, { t: "model_preset", liveId: live.liveId, name: "only-moved-new" })).rejects.toThrow(
		/no preset/,
	);

	const announced = messageWhere(
		ws,
		(m) => m.t === "live" && (m.info as LiveInfo).liveId === live.liveId && (m.info as LiveInfo).cwd === there,
	);
	await request(ws, { t: "rpc", liveId: live.liveId, command: { type: "prompt", message: `/move ${there}` } });
	await announced;
	expect((await listing(ws, live.liveId))?.cwd).toBe(there);

	// What is looked up in the conversation's folder is looked up in the new one.
	const switched = await request<LiveInfo>(ws, { t: "model_preset", liveId: live.liveId, name: "only-moved-new" });
	expect(switched.models?.preset).toBe("only-moved-new");
	await request(ws, { t: "close", liveId: live.liveId });
	ws.close();
}, 90_000);

test("a saved conversation that is moved shows its new folder, and comes back there once its process has ended", async () => {
	const ws = await connect(s);
	const there = project("moved-saved");
	const live = await request<LiveInfo>(ws, {
		t: "open",
		target: { kind: "resume", sessionFile: s.fixtures.gamma, model: HAIKU },
	});
	expect(live.cwd).not.toBe(there);
	await request(ws, { t: "rpc", liveId: live.liveId, command: { type: "prompt", message: `/move ${there}` } });
	await pollUntil(async () => (await listing(ws, live.liveId))?.cwd === there, "the conversation's new folder");
	const moved = await listing(ws, live.liveId);
	expect(moved?.sessionFile).toContain("moved-saved");

	const exited = messageWhere(ws, (m) => m.t === "live_exit" && m.liveId === live.liveId);
	await request(ws, { t: "close", liveId: live.liveId });
	await exited;
	const again = await request<LiveInfo>(ws, {
		t: "open",
		target: { kind: "resume", sessionFile: moved?.sessionFile as string, model: HAIKU },
	});
	expect(again.cwd).toBe(there);
	await request(ws, { t: "close", liveId: again.liveId });
	ws.close();
}, 90_000);

test("`/wt` takes a conversation into a new worktree, and the folder it shows is the worktree", async () => {
	const ws = await connect(s);
	const repo = join(s.root, "worktree-source");
	mkdirSync(repo, { recursive: true });
	const git = (...args: string[]) =>
		Bun.spawnSync(["git", "-C", repo, "-c", "user.email=a@b", "-c", "user.name=n", ...args]);
	git("init", "-q");
	git("commit", "-q", "--allow-empty", "-m", "init");
	const live = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: repo } });
	await request(ws, { t: "rpc", liveId: live.liveId, command: { type: "prompt", message: "/wt" } });
	// omp makes the worktree under its own directory (the test server's HOME), named for the time.
	const worktrees = join(realpathSync(s.home), ".omp", "wt");
	await pollUntil(
		async () => (await listing(ws, live.liveId))?.cwd.startsWith(`${worktrees}/`) === true,
		"the worktree as the folder",
	);
	await request(ws, { t: "close", liveId: live.liveId });
	ws.close();
}, 90_000);
