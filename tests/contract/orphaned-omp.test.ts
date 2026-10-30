import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { processTree } from "../../server/omp/process-tree.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
import { startAppServer } from "../support/app-server.ts";
import { isolatedEnv } from "../support/omp-env.ts";
import { pollUntil, processExists } from "../support/poll.ts";
import { connect, request } from "../support/ws.ts";

/**
 * A server that vanishes without running its shutdown (SIGKILL, an out-of-memory kill, a crash) must not leave work
 * running that nobody can see or stop, and the next server must not start a second writer on its session file (#350).
 * An omp that is working ignores a closed stdin until its turn is over, so the relay that holds its pipes stops it.
 * Real server, real omp and a real tool process (a `!command` over RPC); no model calls.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-orphan-"));
const work = join(root, "work");
let env: Record<string, string>;
const procs: Subprocess[] = [];
/** Processes a failing test may leave behind. */
const strays = new Set<number>();

beforeAll(async () => {
	env = await isolatedEnv(root, { login: false });
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

/** The parent of a process (omp's is its relay). */
const parentOf = (pid: number): number =>
	Number(
		Bun.spawnSync(["ps", "-o", "ppid=", "-p", String(pid)])
			.stdout.toString()
			.trim(),
	);

/** The command line of a process, "" once it is gone. */
const commandOf = (pid: number): string =>
	Bun.spawnSync(["ps", "-o", "command=", "-p", String(pid)])
		.stdout.toString()
		.trim();

/** A server on `dataDir` and one new conversation in it, with omp running a `!command` when `working`. */
async function serverWithConversation(dataDir: string, working: boolean) {
	mkdirSync(dataDir, { recursive: true });
	const server = await startAppServer(env, dataDir, 0);
	procs.push(server.proc);
	const url = `http://127.0.0.1:${server.port}`;
	const ws = await connect({ url, accessToken: server.token });
	const live = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: work } });
	const omp = live.pid as number;
	const relay = parentOf(omp);
	strays.add(omp);
	strays.add(relay);
	let tool = 0;
	if (working) {
		// omp answers `!command` only when the command ends, so it is busy for as long as that takes, and it ignores a closed
		// stdin meanwhile. omp starts the command in a session of its own.
		request(ws, { t: "rpc", liveId: live.liveId, command: { type: "bash", command: "/bin/sleep 300" } }).catch(
			() => {},
		);
		// The tool is the `sleep` itself: omp also starts short-lived helpers that a loaded machine can catch alive.
		await pollUntil(async () => {
			tool = (await processTree(omp)).find((p) => p !== omp && commandOf(p).startsWith("/bin/sleep 300")) ?? 0;
			return tool > 0;
		}, "omp's tool process");
		strays.add(tool);
	}
	return { server, live, omp, relay, tool };
}

test("a server killed while omp works leaves nothing running, and the next server serves only once it is gone", async () => {
	const dataDir = join(root, "data-working");
	const first = await serverWithConversation(dataDir, true);
	expect(processExists(first.omp) && processExists(first.tool) && processExists(first.relay)).toBe(true);

	first.server.proc.kill("SIGKILL");
	await first.server.proc.exited;

	// Started at once on the same data dir: it listens only when what the killed one left has been stopped, or it would
	// open the conversation of that omp on a second one while the first still writes to its session file.
	const next = await startAppServer(env, dataDir, 0);
	procs.push(next.proc);
	expect([first.omp, first.tool, first.relay].map(processExists)).toEqual([false, false, false]);
}, 90_000);

test("a server killed while omp is idle leaves nothing running either: a closed stdin ends it", async () => {
	const first = await serverWithConversation(join(root, "data-idle"), false);
	first.server.proc.kill("SIGKILL");
	await first.server.proc.exited;
	await pollUntil(() => !processExists(first.omp) && !processExists(first.relay), "omp and its relay to be gone");
}, 90_000);
