import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveInfo, LiveListing } from "../../shared/protocol.ts";
import { messageWhere } from "../support/frames.ts";
import { has } from "../support/needs.ts";
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

/** "Change folder…" (v0.17.0): `POST /api/session/move`, which has omp `/move` the conversation. */
const move = async (body: { file?: string | null; liveId?: string | null; folder: string }) => {
	const res = await fetch(`${s.url}/api/session/move`, {
		method: "POST",
		headers: { "x-omp-webui-token": s.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: (await res.json()) as { file?: string | null; cwd?: string; error?: string } };
};

/** What a folder holds, file by file with its text: a move must not touch it. */
const contents = (dir: string) =>
	Object.fromEntries(
		[...new Bun.Glob("**/*").scanSync({ cwd: dir, dot: true })]
			.sort()
			.map((f) => [f, readFileSync(join(dir, f), "utf8")]),
	);

test("Change folder moves a conversation that has no process: omp's /move, no process left after, nothing of the folders touched", async () => {
	const there = project("changed-saved");
	writeFileSync(join(there, "notes.txt"), "the project's own file\n");
	const before = contents(there);
	const ws = await connect(s);
	const running = async () => (await request<LiveListing[]>(ws, { t: "list_lives" })).filter((l) => !l.exited);
	const runningBefore = (await running()).length;

	const r = await move({ file: s.fixtures.beta, folder: there });
	expect(r.status).toBe(200);
	expect(r.body.cwd).toBe(there);
	// omp filed the transcript under the new folder's group of its sessions directory, and the old file is gone.
	expect(r.body.file).toContain("changed-saved");
	expect(existsSync(s.fixtures.beta)).toBe(false);
	expect(contents(there)).toEqual(before);
	// The process started for the move has ended.
	await pollUntil(async () => (await running()).length === runningBefore, "the move's process to end");
	// Opened again, it is in the new folder.
	const again = await request<LiveInfo>(ws, {
		t: "open",
		target: { kind: "resume", sessionFile: r.body.file as string, model: HAIKU },
	});
	expect(again.cwd).toBe(there);
	await request(ws, { t: "close", liveId: again.liveId });
	ws.close();
}, 90_000);

test("Change folder moves a running conversation and a new chat with no file yet; a folder that is not there is refused", async () => {
	const ws = await connect(s);
	// A name with spaces is one folder to `/move` (it takes the rest of the line).
	const there = project("changed live");
	const live = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: s.work } });

	const missing = await move({ liveId: live.liveId, folder: join(s.root, "not-there") });
	expect(missing.status).toBe(400);
	expect((await listing(ws, live.liveId))?.cwd).toBe(s.work);

	const r = await move({ file: null, liveId: live.liveId, folder: there });
	expect(r.status).toBe(200);
	expect(r.body.cwd).toBe(there);
	// The process is the conversation's own: it goes on, in the new folder.
	const after = await listing(ws, live.liveId);
	expect(after?.exited).toBeFalsy();
	expect(after?.cwd).toBe(there);
	await request(ws, { t: "close", liveId: live.liveId });
	ws.close();
}, 90_000);

test.skipIf(!has.notWindowsYet)(
	"`/wt` takes a conversation into a new worktree, and the folder it shows is the worktree",
	async () => {
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
	},
	90_000,
);
