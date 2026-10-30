import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../../server/config.ts";
import { type Live, LivePool, surplus } from "../../server/live.ts";
import type { OmpFrame } from "../../shared/protocol.ts";
import { isolatedEnv } from "../support/omp-env.ts";

/** The idle reaper and "open in terminal" never close an omp that is busy (real omp, no model calls). */

const root = mkdtempSync(join(tmpdir(), "ompw-reaper-"));
const saved = { ...process.env };
let pool: LivePool;
let live: Live;
const longAgo = () => Date.now() - 60 * 60_000;
/** Whether the pool would close this unwatched process now. */
const reapable = (l: Live) => surplus([l], Date.now()).includes(l);

beforeAll(async () => {
	Object.assign(process.env, await isolatedEnv(root), { OMP_WEBUI_DATA_DIR: join(root, "data") });
	const work = join(root, "work");
	mkdirSync(work, { recursive: true });
	pool = new LivePool(loadConfig());
	live = await pool.open({ kind: "new", cwd: work }, async () => null);
}, 60_000);

afterAll(async () => {
	await pool?.shutdown();
	process.env = saved;
	rmSync(root, { recursive: true, force: true });
});

test("a running !command is not idle, however long it runs", async () => {
	const running = live.rpc({ type: "bash", command: "sleep 2" });
	live.lastActivity = longAgo();
	expect(reapable(live)).toBe(false);
	await expect(pool.release({ by: "file", file: live.info.sessionFile as string })).rejects.toThrow(
		"This conversation is working",
	);
	expect(live.holding).toBe("working");
	await running;
	// Finishing counts as activity.
	expect(reapable(live)).toBe(false);
	live.lastActivity = longAgo();
	expect(reapable(live)).toBe(true);
}, 30_000);

test("a dialog omp is waiting on keeps the process until it is answered", async () => {
	// The frame omp sends for ask/confirm; Live records it as pending.
	const onFrame = (live as unknown as { onFrame(f: OmpFrame): void }).onFrame.bind(live);
	onFrame({ type: "extension_ui_request", method: "confirm", id: "q1", title: "Proceed?" } as OmpFrame);
	live.lastActivity = longAgo();
	expect(reapable(live)).toBe(false);
	expect(live.holding).toBe("asking");
	await expect(pool.release({ by: "file", file: live.info.sessionFile as string })).rejects.toThrow(
		"waiting for your answer",
	);

	live.respondUI({ id: "q1", confirmed: false });
	live.lastActivity = longAgo();
	expect(reapable(live)).toBe(true);
});

test("a paused process is never reaped or released; RPC is refused until it resumes", async () => {
	await live.pause();
	live.lastActivity = longAgo();
	expect(reapable(live)).toBe(false);
	// What it says is that it is paused, not that it is working or waiting for an answer.
	await expect(pool.release({ by: "file", file: live.info.sessionFile as string })).rejects.toThrow(
		"This conversation is paused",
	);
	await expect(pool.release({ by: "file", file: live.info.sessionFile as string })).rejects.toThrow(
		"resume it or end it",
	);
	expect(live.holding).toBe("paused");
	expect(pool.list().find((l) => l.liveId === live.info.liveId)).toMatchObject({ busy: true, holding: "paused" });
	expect(await pool.endIfIdle(live)).toBe("paused");
	const refused = await live.rpc({ type: "get_state" });
	expect(refused).toMatchObject({ success: false, code: "paused" });

	await live.resume();
	expect((await live.rpc({ type: "get_state" })).success).toBe(true);
});

test("a user's action on a paused process is answered by omp itself, and leaves it frozen and still paused", async () => {
	await live.pause();
	const pausedAt = live.info.pausedAt;

	const reply = await live.rpc({ type: "set_thinking_level", level: "off" }, { user: true });

	expect(reply.success).toBe(true);
	expect(live.info.pausedAt).toBe(pausedAt);
	expect(
		Bun.spawnSync(["ps", "-o", "stat=", "-p", String(live.info.pid)])
			.stdout.toString()
			.trim(),
	).toStartWith("T");
	expect(await live.rpc({ type: "get_state" })).toMatchObject({ success: false, code: "paused" });
	await live.resume();
});
