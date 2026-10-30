import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { processTree } from "../../server/omp/process-tree.ts";
import type { LiveInfo, LiveListing } from "../../shared/protocol.ts";
import { startAppServer } from "../support/app-server.ts";
import { writeFakeOmp } from "../support/fake-omp.ts";
import { isolatedEnv } from "../support/omp-env.ts";
import { pollUntil, processExists } from "../support/poll.ts";
import { connect, request } from "../support/ws.ts";

/**
 * Close (the Settings button, "Close it to end it") on a paused conversation ends it, as "Quit and end paused" does. An
 * idle omp runs again to read its closed stdin and exit; one paused in the middle of a turn ignores a closed stdin until
 * the turn is over, so closing it only unfroze it and the rest of the turn ran on unattended (#314). Real server, a
 * scripted omp with a tool process under it (it answers nothing to `prompt`, so that its turn never ends); no model.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-close-paused-"));
const work = join(root, "work");
let env: Record<string, string>;
const procs: Subprocess[] = [];
/** Processes a failing test may leave behind. */
const strays = new Set<number>();

beforeAll(async () => {
	env = await isolatedEnv(root);
	mkdirSync(work, { recursive: true });
});
afterEach(() => {
	for (const p of procs.splice(0)) p.kill("SIGKILL");
	for (const pid of strays) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
	strays.clear();
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const state = (pid: number): string =>
	Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
		.stdout.toString()
		.trim();

/** A server on a data dir of its own, a socket to it, and one new conversation with its omp and the tool under it. */
async function conversation(name: string, omp: Parameters<typeof writeFakeOmp>[1]) {
	const bin = writeFakeOmp(root, omp);
	const dataDir = join(root, name);
	mkdirSync(dataDir, { recursive: true });
	const server = await startAppServer(env, dataDir, 0, { OMP_BIN: bin });
	procs.push(server.proc);
	const url = `http://127.0.0.1:${server.port}`;
	const ws = await connect({ url, accessToken: server.token });
	const exits: Record<string, unknown>[] = [];
	ws.addEventListener("message", (ev) => {
		const m = JSON.parse(String(ev.data));
		if (m.t === "live_exit") exits.push(m);
	});
	const live = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: work } });
	const pid = live.pid as number;
	strays.add(pid);
	const tool = (await processTree(pid)).find((p) => p !== pid) as number;
	strays.add(tool);
	const lives = async (): Promise<LiveListing[]> =>
		(await fetch(`${url}/api/lives`, { headers: { "x-omp-webui-token": server.token } })).json();
	return { server, url, ws, live, pid, tool, exits, lives };
}

test("Close on a conversation paused in the middle of a turn ends it: omp and its tool are gone, not running on", async () => {
	// omp never answers `prompt`, so its turn never ends, and it ignores a closed stdin while it works.
	const c = await conversation("data-working", { tool: true, hold: ["prompt"], ignoreClose: true });
	void request(c.ws, { t: "rpc", liveId: c.live.liveId, command: { type: "prompt", message: "go" } }).catch(() => {});
	await pollUntil(
		async () => (await c.lives()).find((l) => l.liveId === c.live.liveId)?.busy === true,
		"omp to be busy",
	);
	await request(c.ws, { t: "pause", liveId: c.live.liveId });
	expect(state(c.pid).startsWith("T")).toBe(true);

	await request(c.ws, { t: "close", liveId: c.live.liveId });
	await pollUntil(() => !processExists(c.pid) && !processExists(c.tool), "omp and its tool to be gone");
	await pollUntil(async () => (await c.lives()).length === 0, "the conversation to leave the list");
	expect(c.exits.map((m) => m.liveId)).toEqual([c.live.liveId]);
}, 60_000);

test("Close on a conversation paused while idle lets omp end by itself: its stdin closes, nobody kills it", async () => {
	const c = await conversation("data-idle", { tool: true });
	await request(c.ws, { t: "pause", liveId: c.live.liveId });
	expect(state(c.pid).startsWith("T")).toBe(true);

	await request(c.ws, { t: "close", liveId: c.live.liveId });
	await pollUntil(() => c.exits.length === 1, "omp to exit");
	// Read the closed stdin and exited: code 0. A killed omp would report a signal.
	expect(c.exits[0]).toMatchObject({ liveId: c.live.liveId, code: 0 });
	await pollUntil(() => !processExists(c.pid) && !processExists(c.tool), "omp and its tool to be gone");
}, 60_000);
