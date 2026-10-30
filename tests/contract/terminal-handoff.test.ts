import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import type { LiveInfo, LiveListing } from "../../shared/protocol.ts";
import { startAppServer } from "../support/app-server.ts";
import { type FakeOmpOptions, writeFakeOmp } from "../support/fake-omp.ts";
import { isolatedEnv } from "../support/omp-env.ts";
import { pollUntil, processExists } from "../support/poll.ts";
import { connect, request } from "../support/ws.ts";

/**
 * A terminal that runs `omp` on a conversation the web UI holds hands the session over: the web's own omp is closed
 * first, whichever way the command line names the conversation, and a terminal whose page is gone is never started.
 * Two processes writing one session make omp save the history as two files (#385, #419). Real server, a scripted omp
 * (its `--resume` terminal run stays until it is killed, as omp's screen does); no model.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-handoff-"));
const work = join(root, "work");
const elsewhere = join(root, "elsewhere");
let env: Record<string, string>;
const procs: Subprocess[] = [];
const sockets: WebSocket[] = [];
/** Processes a failing test may leave behind. */
const strays = new Set<number>();

beforeAll(async () => {
	env = await isolatedEnv(root, { login: false });
	for (const dir of [work, elsewhere]) mkdirSync(dir, { recursive: true });
});
afterEach(() => {
	for (const ws of sockets.splice(0)) ws.close();
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

/** A server on a data dir of its own, with its page's socket, and one new conversation (the scripted omp's session is `fake`). */
async function conversation(name: string, omp: FakeOmpOptions) {
	const bin = writeFakeOmp(root, omp);
	const dataDir = join(root, name);
	mkdirSync(dataDir, { recursive: true });
	const server = await startAppServer(env, dataDir, 0, { OMP_BIN: bin });
	procs.push(server.proc);
	const url = `http://127.0.0.1:${server.port}`;
	const open = async () => {
		const ws = await connect({ url, accessToken: server.token });
		sockets.push(ws);
		return ws;
	};
	const ws = await open();
	const live = await request<LiveInfo>(ws, { t: "open", target: { kind: "new", cwd: work } });
	strays.add(live.pid as number);
	const lives = async (): Promise<LiveListing[]> =>
		(await fetch(`${url}/api/lives`, { headers: { "x-omp-webui-token": server.token } })).json();
	/** `omp <args>` in a terminal started from `ws` in `cwd`: resolves with the terminal's id once the server started it. */
	const terminal = (args: string[], cwd = work, from = ws) =>
		request<{ ptyId: string }>(from, { t: "pty_open", args, cwd, cols: 80, rows: 24 });
	return { server, open, ws, live, pid: live.pid as number, lives, terminal };
}

test("a terminal that resumes by `-c`, `--continue`, an id prefix or a path closes the web's idle omp of that conversation first", async () => {
	const c = await conversation("data-forms", { terminalHolds: false });
	const forms: [string[], string][] = [
		[["-c"], "-c"],
		[["--continue"], "--continue"],
		[["-r", "fa"], "-r <id prefix>"],
		[["--resume=fa"], "--resume=<id prefix>"],
		[["--resume"], "--resume with nothing to name it"],
		[["--resume", "/nonexistent/fake.jsonl"], "--resume <path>"],
	];
	let current = c.live;
	for (const [args, form] of forms) {
		const pid = current.pid as number;
		const reply = await c.terminal(args);
		expect([form, reply.ptyId.startsWith("P")]).toEqual([form, true]);
		// The terminal started only after omp had ended: it was closed, not left to a second writer.
		expect([form, processExists(pid)]).toEqual([form, false]);
		current = await request<LiveInfo>(c.ws, { t: "open", target: { kind: "new", cwd: work } });
		strays.add(current.pid as number);
	}
}, 120_000);

test("a terminal in another folder, or for another conversation, leaves the web's omp alone", async () => {
	const c = await conversation("data-other", {});
	await c.terminal(["--continue"], elsewhere);
	await c.terminal(["-r", "01a15924"]);
	await c.terminal(["--resume", "/nonexistent/other.jsonl"]);
	// Nothing was closed: the conversation is still the one process.
	expect(processExists(c.pid)).toBe(true);
	expect((await c.lives()).map((l) => l.liveId)).toEqual([c.live.liveId]);
}, 60_000);

test("a terminal that could open a conversation which is working is refused, and the conversation goes on", async () => {
	// `!command`: omp answers only when it ends, so the conversation is busy meanwhile.
	const c = await conversation("data-busy", { hold: ["bash"] });
	request(c.ws, { t: "rpc", liveId: c.live.liveId, command: { type: "bash", command: "sleep 300" } }).catch(() => {});
	await pollUntil(
		async () => (await c.lives()).find((l) => l.liveId === c.live.liveId)?.busy === true,
		"omp to be busy",
	);
	await expect(c.terminal(["--continue"])).rejects.toThrow("This conversation is working");
	expect(processExists(c.pid)).toBe(true);
}, 60_000);

/** The terminals this server started for a session: its children running `omp --resume` on the scripted session's file. */
function terminalsOf(server: Subprocess): number[] {
	return Bun.spawnSync(["ps", "-A", "-o", "pid=,ppid=,command="])
		.stdout.toString()
		.split("\n")
		.map((line) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line))
		.filter((m): m is RegExpExecArray => m !== null)
		.filter((m) => Number(m[2]) === server.pid && m[3].includes("--resume /nonexistent/fake.jsonl"))
		.map((m) => Number(m[1]));
}

test("a terminal whose page closed while its conversation was being released is never started (#419)", async () => {
	// omp takes a while to end once it is closed: the release waits for that, and the page goes meanwhile.
	const c = await conversation("data-race", { slowClose: 2500, terminalHolds: true });
	const closedPage = await c.open();
	closedPage.send(
		JSON.stringify({
			t: "pty_open",
			req: "r1",
			args: ["--resume", "/nonexistent/fake.jsonl"],
			cwd: work,
			cols: 80,
			rows: 24,
		}),
	);
	// The request is read before the close that follows it; omp is told to end and is gone 2.5 s later.
	closedPage.close();
	await pollUntil(() => !processExists(c.pid), "omp to have ended");

	// A terminal started for that page would start right after, and stays (nothing is left to end it). One from a page that
	// is still there is started after it, so seeing that one means anything that was started earlier is visible too.
	const control = await c.terminal(["--resume", "/nonexistent/fake.jsonl"]);
	expect(control.ptyId.startsWith("P")).toBe(true);
	await pollUntil(() => terminalsOf(c.server.proc).length > 0, "the control terminal to run");
	const running = terminalsOf(c.server.proc);
	for (const pid of running) strays.add(pid);
	expect(running).toHaveLength(1);
}, 60_000);
