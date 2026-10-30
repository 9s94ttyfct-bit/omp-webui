import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import type { LiveInfo } from "../../shared/protocol.ts";
import { startAppServer } from "../support/app-server.ts";
import { writeFakeOmp } from "../support/fake-omp.ts";
import { isolatedEnv } from "../support/omp-env.ts";
import { pollUntil } from "../support/poll.ts";
import { connect, request } from "../support/ws.ts";

/**
 * How a conversation's omp ended has to reach a page that is not subscribed to it.
 *
 * The idle reaper only ever closes a process nobody watches (`surplus` filters on `subscribers.size === 0`), and
 * `Live.broadcast` writes only to the subscribers — so the `live_exit` frame that carries the reason went to nobody,
 * and a page that asked about the process afterwards was told only "Live session not found". The page then fell back to
 * a fixed reason ("the server went away"), which is wrong for a reaper close and just as wrong for a process that
 * crashed on its own: a fault of omp's was blamed on the server (#515).
 *
 * The server therefore remembers how each recently ended process ended, and says so when a page asks about it
 * (`attach`) and in the `live` frame every page is told of. A real server over a real WebSocket, with a real (scripted)
 * omp process: the path that failed in production is the one exercised here — no frame is injected by hand, and the
 * broadcast is not replaced by a recorder.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-exit-record-"));
let env: Record<string, string>;
const procs: Subprocess[] = [];

beforeAll(async () => {
	env = await isolatedEnv(root);
});
afterEach(() => {
	for (const p of procs.splice(0)) p.kill("SIGKILL");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A server with a scripted omp, and a socket to it. */
async function server() {
	const bin = writeFakeOmp(root, {});
	const dataDir = join(root, `data-${procs.length}-${Date.now()}`);
	mkdirSync(dataDir, { recursive: true });
	const started = await startAppServer(env, dataDir, 0, { OMP_BIN: bin });
	procs.push(started.proc);
	const url = `http://127.0.0.1:${started.port}`;
	return { url, token: started.token, ws: await connect({ url, accessToken: started.token }) };
}

/** A folder of its own: a New chat in a folder the server already has a process for reuses that one. */
function folder(name: string): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

/** What the server says of a process that is gone, when a page asks about it. */
type Ended = { exited: boolean; exit?: { by?: string; reason?: string; signal?: string; code?: number | null } };

test("a process the idle reaper closed is remembered as the server's doing, and a page that asks is told", async () => {
	const { ws } = await server();
	// Five unwatched processes, one per folder: the reaper keeps the four most recently active and closes the rest.
	const opened: LiveInfo[] = [];
	for (let i = 0; i < 5; i++) {
		const live = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: folder(`w${i}`) } });
		opened.push(live);
		// Nobody watches it: the page let go of it, as it does with an idle conversation off screen.
		ws.send(JSON.stringify({ t: "detach", liveId: live.liveId }));
	}
	// The reaper leaves a process younger than `STARTING_MS` (30 s) alone: it may still be starting.
	await Bun.sleep(31_000);
	// Any announce reaps: a detach is one, and the pool reaps on every one. The oldest process is the one that is
	// surplus: the reaper keeps the four most recently active of the five.
	ws.send(JSON.stringify({ t: "detach", liveId: opened[0].liveId }));
	const reaped = opened[0];
	await pollUntil(
		async () => {
			const listed = await request<LiveInfo[]>(ws, { t: "list_lives" });
			return !listed.some((l) => l.liveId === reaped.liveId);
		},
		"the idle reaper to close a process",
		30_000,
	);

	// The page asks about the process it let go of. The server knows how it ended, and says so.
	const attached = await request<Ended>(ws, { t: "attach", liveId: reaped.liveId });
	expect(attached.exited).toBe(true);
	expect(attached.exit).toMatchObject({ by: "server", reason: "idle" });
	ws.close();
}, 120_000);

test("a process that crashed on its own is remembered as omp's own end, not the server's", async () => {
	const { ws } = await server();
	const live = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: folder("crash") } });
	ws.send(JSON.stringify({ t: "detach", liveId: live.liveId }));
	// The process is killed from outside: it ends on its own, and the server did not ask for it.
	process.kill(live.pid as number, "SIGKILL");
	await pollUntil(
		async () => {
			const listed = await request<LiveInfo[]>(ws, { t: "list_lives" });
			return !listed.some((l) => l.liveId === live.liveId);
		},
		"the killed process to be gone from the pool",
		30_000,
	);

	const attached = await request<Ended>(ws, { t: "attach", liveId: live.liveId });
	expect(attached.exited).toBe(true);
	expect(attached.exit).toMatchObject({ by: "omp", signal: "SIGKILL" });
	expect(attached.exit).not.toHaveProperty("reason");
	ws.close();
}, 90_000);
