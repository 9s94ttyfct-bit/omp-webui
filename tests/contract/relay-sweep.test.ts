import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { relayDir, relayDirPath } from "../../server/omp/relay-client.ts";
import type { LiveInfo } from "../../shared/protocol.ts";
import { startAppServer } from "../support/app-server.ts";
import { writeFakeOmp } from "../support/fake-omp.ts";
import { isolatedEnv } from "../support/omp-env.ts";
import { pollUntil, processExists } from "../support/poll.ts";
import { removeRelayDir } from "../support/relay-dirs.ts";
import { connect, request } from "../support/ws.ts";

/**
 * A relay removes its unix socket when it ends, and cannot when it is killed (SIGKILL, an out-of-memory kill). Nothing
 * used to remove what it left, for good: the file stayed in `<data dir>/relay` across every later start and stop, and the
 * directory with it (#317). The real server sweeps the sockets that no relay listens on: at start, while it runs, and
 * when it stops. A scripted omp; no model.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-sweep-"));
const work = join(root, "work");
let env: Record<string, string>;
const procs: Subprocess[] = [];
const strays = new Set<number>();
const dataDirs: string[] = [];

beforeAll(async () => {
	env = await isolatedEnv(root);
	env.OMP_BIN = writeFakeOmp(root);
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
	for (const dir of dataDirs.splice(0)) removeRelayDir(dir);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const sockets = (dataDir: string): string[] => {
	const dir = relayDirPath(dataDir);
	return existsSync(dir) ? readdirSync(dir).filter((name) => name.endsWith(".sock")) : [];
};

/** The relay processes of `dataDir`, by pid. */
function relays(dataDir: string): number[] {
	const dir = relayDirPath(dataDir);
	return Bun.spawnSync(["ps", "-A", "-ww", "-o", "pid=,command="])
		.stdout.toString()
		.split("\n")
		.filter((line) => line.includes("--ompw-relay") && line.includes(dir))
		.map((line) => Number(line.trim().split(/\s+/)[0]));
}

async function boot(dataDir: string) {
	mkdirSync(dataDir, { recursive: true });
	if (!dataDirs.includes(dataDir)) dataDirs.push(dataDir);
	const server = await startAppServer(env, dataDir);
	procs.push(server.proc);
	const ws = await connect({ url: `http://127.0.0.1:${server.port}`, accessToken: server.token });
	return { server, ws };
}

test("a socket left by a killed relay is swept when the next server starts, and one that is left meanwhile when it stops", async () => {
	const dataDir = join(root, "data-sweep");
	const a = await boot(dataDir);
	const opened: LiveInfo[] = [];
	for (const name of ["one", "two", "three"]) {
		const cwd = join(work, name);
		mkdirSync(cwd, { recursive: true });
		const live = await request<LiveInfo>(a.ws, { t: "open", target: { kind: "new", cwd } });
		strays.add(live.pid as number);
		opened.push(live);
	}
	expect(sockets(dataDir)).toHaveLength(3);
	const [first, second] = relays(dataDir);
	strays.add(first);
	strays.add(second);
	// Two of the three relays are killed under the running server.
	process.kill(first, "SIGKILL");
	process.kill(second, "SIGKILL");
	await pollUntil(() => !processExists(first) && !processExists(second), "the killed relays to be gone");
	expect(sockets(dataDir)).toHaveLength(3);

	// The server stops: the sockets of the two dead relays go, the third relay removes its own.
	a.server.proc.kill("SIGTERM");
	expect(await a.server.proc.exited).toBe(0);
	await pollUntil(() => sockets(dataDir).length === 0, "the relay directory to be swept");
	expect(existsSync(relayDirPath(dataDir))).toBe(false);
}, 90_000);

test("a socket that nobody listens on is gone once the next server is up", async () => {
	const dataDir = join(root, "data-start");
	mkdirSync(dataDir, { recursive: true });
	dataDirs.push(dataDir);
	// What a relay killed before the server went away left behind: a socket file, and no process. A listener that is
	// killed (not stopped) cannot unlink it.
	const socket = join(relayDir(dataDir), "L9-stale.sock");
	const listener = Bun.spawn(
		[
			"bun",
			"-e",
			"Bun.listen({ unix: process.argv[1], socket: { data() {} } }); process.kill(process.pid, 'SIGKILL');",
			socket,
		],
		{ stdout: "ignore", stderr: "ignore" },
	);
	await listener.exited;
	expect(sockets(dataDir)).toEqual(["L9-stale.sock"]);

	const a = await boot(dataDir);
	expect(a.server.proc.exitCode).toBeNull();
	await pollUntil(() => sockets(dataDir).length === 0, "the stale socket to be swept");
}, 60_000);
