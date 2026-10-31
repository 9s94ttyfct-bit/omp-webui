import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, readdirSync, realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import { RpcClient } from "../../server/omp/rpc-client.ts";
import { type LeaseSystem, leaseHeldElsewhere, SESSION_LEASE_SINCE } from "../../server/sessions/lease.ts";
import { compareVersions, parseVersion } from "../../shared/omp-install.ts";
import type { LiveInfo, SessionSummary } from "../../shared/protocol.ts";
import { writeSimpleSession } from "../support/fixtures.ts";
import { isolatedEnv } from "../support/omp-env.ts";
import { pollUntil } from "../support/poll.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { connect, request } from "../support/ws.ts";

/**
 * A conversation that another omp process has open for writing (a terminal's; here a process of the test's own, outside
 * the server's pool) belongs to that process: omp gives a session one writer. A rename sent to a short-lived omp is written
 * to a fresh copy of the conversation (the sidebar then lists two, and says it worked), and a delete removes the file
 * under the owner. Both are refused instead, with the reason; once the other omp is gone they work. No model is called.
 * The server asks omp (`omp session lease`, omp 18.14.1 and later) and reads the system for an older one; both look where
 * omp keeps the lease, which `PI_CONFIG_DIR` moves (audit A-004).
 */

/** A config root of its own (`PI_CONFIG_DIR`, a folder of the home), where omp keeps its session leases then. */
const ALT = ".omp-alt";
/** The omp installed here, and whether it has `omp session lease`. */
const installed = Bun.spawnSync(["omp", "--version"]).stdout.toString().trim();
const ompAnswers = parseVersion(installed) !== null && compareVersions(installed, SESSION_LEASE_SINCE) >= 0;

let s: TestServer;
/** A server run with `PI_CONFIG_DIR`, and so its omp processes. */
let alt: TestServer;
const terminals: RpcClient[] = [];
beforeAll(async () => {
	[s, alt] = await Promise.all([startTestServer(), startTestServer(0, { PI_CONFIG_DIR: ALT })]);
}, 60_000);
afterAll(async () => {
	for (const t of terminals) t.kill("SIGKILL");
	await Promise.all([s?.stop(), alt?.stop()]);
});

const read = (server = s) => ({ "x-omp-webui-token": server.accessToken });
const post = async (path: string, body: unknown, server = s) => {
	const res = await fetch(`${server.url}${path}`, {
		method: "POST",
		headers: { ...read(server), "x-omp-webui": "1", "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const sessions = async (server = s): Promise<SessionSummary[]> =>
	(await fetch(`${server.url}/api/sessions`, { headers: read(server) })).json();
const titleOf = async (file: string, server = s) => (await sessions(server)).find((x) => x.file === file)?.title;

/** The environment of a terminal's omp in `server`'s world, with `extra` (`PI_CONFIG_DIR`). */
const terminalEnv = async (server: TestServer, extra: Record<string, string> = {}) => ({
	...(await isolatedEnv(server.root)),
	...extra,
});

/** An omp of the test's own on `file` that has written to it, which is what takes a session's lease. */
async function terminalOn(file: string, server = s, env?: Record<string, string>): Promise<RpcClient> {
	const terminal = new RpcClient({
		bin: "omp",
		args: ["--resume", file],
		cwd: server.root,
		env: env ?? (await terminalEnv(server)),
		onFrame() {},
		onExit() {},
	});
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

test("a conversation open here too: refused while a terminal's omp holds it, not while the server's own process does", async () => {
	// omp says only that the lease is held, and the server's process holds it only once it has written: an idle one
	// opened before the terminal wrote does not, and the rename it would carry out would go to a copy.
	const file = realpathSync(writeSimpleSession(s.agentDir, 0x62, "Open here and in a terminal"));
	const files = () => readdirSync(dirname(file)).filter((f) => f.endsWith(".jsonl"));
	const before = files();
	const ws = await connect(s);
	try {
		const live = await request<LiveInfo>(ws, { t: "open", target: { kind: "resume", sessionFile: file } });
		const terminal = await terminalOn(file);
		const rename = await post("/api/session/rename", { file, title: "Renamed in the web UI" });
		expect(rename.status).toBe(409);
		expect(String(rename.body.error)).toMatch(/another omp process/);
		expect(files()).toEqual(before);
		terminal.kill("SIGKILL");
		await terminal.whenExited;

		// The server's process writes the name: the lease is its own from then on, and it renames it again.
		const first = await post("/api/session/rename", { file, title: "Renamed in the web UI" });
		expect(first.status).toBe(200);
		const again = await post("/api/session/rename", { file, title: "Renamed again" });
		expect(again.status).toBe(200);
		await pollUntil(async () => (await titleOf(file)) === "Renamed again", "the new name to be listed");
		expect(files()).toEqual(before);
		await request(ws, { t: "close", liveId: live.liveId });
	} finally {
		ws.close();
	}
}, 120_000);

test("with PI_CONFIG_DIR set, a conversation a terminal's omp holds is refused as well", async () => {
	// The server and the terminal's omp run with the same PI_CONFIG_DIR; omp keeps the lease under it, not under ~/.omp.
	const file = realpathSync(writeSimpleSession(alt.agentDir, 0x63, "Held under another config root"));
	const files = () => readdirSync(dirname(file)).filter((f) => f.endsWith(".jsonl"));
	const before = files();
	const terminal = await terminalOn(file, alt, await terminalEnv(alt, { PI_CONFIG_DIR: ALT }));
	const rename = await post("/api/session/rename", { file, title: "Renamed in the web UI" }, alt);
	expect(rename.status).toBe(409);
	expect(String(rename.body.error)).toMatch(/another omp process/);
	expect(files()).toEqual(before);
	terminal.kill("SIGKILL");
	await terminal.whenExited;
}, 120_000);

test("the real omp's lease under PI_CONFIG_DIR: omp says it is held, and the system read finds it where omp keeps it", async () => {
	const file = realpathSync(writeSimpleSession(s.agentDir, 0x64, "Held, read both ways"));
	const id = basename(file, ".jsonl").split("_")[1];
	const env = await terminalEnv(s, { PI_CONFIG_DIR: ALT });
	const terminal = await terminalOn(file, s, env);
	const { PI_CONFIG_DIR: _, ...withoutConfigDir } = env;
	const system = (extra: Record<string, string>): LeaseSystem => ({
		env: { ...process.env, ...extra },
		home: env.HOME,
		platform: process.platform,
		proc: "/proc",
	});
	// An omp older than `omp session lease`: the system is read, which names the holder.
	const older = { bin: "omp", version: "18.13.3" };
	const read = await leaseHeldElsewhere(id, null, older, system(env));
	expect(read?.pids.length).toBeGreaterThan(0);
	expect(read?.pids).not.toContain(process.pid);
	// Under the default config root nobody holds it.
	expect(await leaseHeldElsewhere(id, null, older, system(withoutConfigDir))).toBeNull();
	if (ompAnswers) {
		// omp itself is asked, which names no process.
		const current = { bin: "omp", version: installed };
		expect(await leaseHeldElsewhere(id, null, current, system(env))).toEqual({ pids: [] });
		expect(await leaseHeldElsewhere(id, null, current, system(withoutConfigDir))).toBeNull();
	}
	terminal.kill("SIGKILL");
	await terminal.whenExited;
	expect(await leaseHeldElsewhere(id, null, older, system(env))).toBeNull();
	if (ompAnswers)
		expect(await leaseHeldElsewhere(id, null, { bin: "omp", version: installed }, system(env))).toBeNull();
}, 120_000);
