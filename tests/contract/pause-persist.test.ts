import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { type ParkedRecord, ParkedStore, referenceTo } from "../../server/omp/parked.ts";
import { processTree } from "../../server/omp/process-tree.ts";
import { relayDir } from "../../server/omp/relay-client.ts";
import type { LiveInfo, LiveListing } from "../../shared/protocol.ts";
import { type AppServer, startAppServer } from "../support/app-server.ts";
import { writeFakeOmp } from "../support/fake-omp.ts";
import { isolatedEnv } from "../support/omp-env.ts";
import { pollUntil, processExists } from "../support/poll.ts";
import { connect, request } from "../support/ws.ts";

/**
 * A paused conversation outlives the server: quitting the app, or the server dying, leaves its omp frozen behind
 * the relay that holds its pipes, and the next server on the same data dir takes it over and can unpause it.
 * The real server, a scripted fake omp (with a tool process under it, as omp has while running one), no model.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-persist-"));
let env: Record<string, string>;
const procs: Subprocess[] = [];
const dataDirs: string[] = [];
/** Processes a failing test may leave behind. */
const strays = new Set<number>();
const work = join(root, "work");

beforeAll(async () => {
	env = await isolatedEnv(root);
	mkdirSync(work, { recursive: true });
});
afterEach(() => {
	for (const p of procs.splice(0)) p.kill("SIGKILL");
	for (const dir of dataDirs.splice(0)) for (const pid of relayPids(dir)) strays.add(pid);
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

/** The relays running for `dataDir`, whatever their conversations. */
function relayPids(dataDir: string): number[] {
	const dir = relayDir(dataDir);
	const listing = Bun.spawnSync(["ps", "-A", "-o", "pid=,command="]).stdout.toString();
	return listing
		.split("\n")
		.filter((line) => line.includes("--ompw-relay") && line.includes(dir))
		.map((line) => Number(line.trim().split(/\s+/)[0]));
}

const state = (pid: number): string =>
	Bun.spawnSync(["ps", "-o", "stat=", "-p", String(pid)])
		.stdout.toString()
		.trim();
const frozen = (pid: number): boolean => state(pid).startsWith("T");

interface Boot {
	server: AppServer;
	url: string;
	ws: WebSocket;
	/** Frames the server sent this socket. */
	frames: { liveId: string; frame: Record<string, unknown> }[];
	lives(): Promise<LiveListing[]>;
}

/** A server like the app's on `dataDir`, with a socket to it. `extra` is added to its environment. */
async function boot(dataDir: string, port: number, extra: Record<string, string> = {}): Promise<Boot> {
	mkdirSync(dataDir, { recursive: true });
	if (!dataDirs.includes(dataDir)) dataDirs.push(dataDir);
	const server = await startAppServer(env, dataDir, port, extra);
	procs.push(server.proc);
	const url = `http://127.0.0.1:${server.port}`;
	const ws = await connect({ url, accessToken: server.token });
	const frames: Boot["frames"] = [];
	ws.addEventListener("message", (ev) => {
		const m = JSON.parse(String(ev.data));
		if (m.t === "frame") frames.push(m);
	});
	const lives = async (): Promise<LiveListing[]> =>
		(await fetch(`${url}/api/lives`, { headers: { "x-omp-webui-token": server.token } })).json();
	return { server, url, ws, frames, lives };
}

/** Stop the server as the app does when it quits. */
async function quit(b: Boot): Promise<void> {
	b.ws.close();
	b.server.proc.kill("SIGTERM");
	expect(await b.server.proc.exited).toBe(0);
}

const record = (dataDir: string, liveId: string): ParkedRecord =>
	JSON.parse(readFileSync(join(dataDir, "parked", `${liveId}.json`), "utf8"));

/** Open a new conversation on `b` and note its processes: omp, the tool under it, and its relay. */
async function openNew(b: Boot, dataDir: string) {
	const live = await request<LiveInfo>(b.ws, { t: "open", target: { kind: "new", cwd: work } });
	const omp = live.pid as number;
	strays.add(omp);
	const tool = (await processTree(omp)).find((p) => p !== omp) as number;
	expect(tool).toBeGreaterThan(0);
	strays.add(tool);
	const relay = relayPids(dataDir).find((p) => p !== omp) as number;
	expect(relay).toBeGreaterThan(0);
	strays.add(relay);
	return { live, omp, tool, relay };
}

test("a paused conversation survives the server, is adopted by the next one, and unpausing continues it", async () => {
	const bin = writeFakeOmp(root, { tool: true, streaming: true });
	const dataDir = join(root, "data-adopt");
	const a = await boot(dataDir, 0, { OMP_BIN: bin });
	const { live, omp, tool, relay } = await openNew(a, dataDir);
	// A dialog omp is waiting on, which no later frame repeats; and a mode the user picked.
	await request(a.ws, {
		t: "rpc",
		liveId: live.liveId,
		command: {
			type: "emit_frames",
			frames: [{ type: "extension_ui_request", id: "dlg-1", method: "confirm", title: "Run it?", message: "rm -rf" }],
		},
	});
	await request(a.ws, { t: "approval_mode", liveId: live.liveId, mode: "yolo" });
	const paused = await request<LiveInfo>(a.ws, { t: "pause", liveId: live.liveId });
	expect(frozen(omp) && frozen(tool)).toBe(true);
	expect(frozen(relay)).toBe(false);
	const overlay = record(dataDir, live.liveId).overlay?.file as string;
	expect(readFileSync(overlay, "utf8")).toContain("approvalMode: yolo");

	// Quitting leaves it frozen, with its tool, its relay and its overlay.
	await quit(a);
	expect([omp, tool, relay].every(processExists)).toBe(true);
	expect(frozen(omp) && frozen(tool)).toBe(true);
	expect(record(dataDir, live.liveId).owner).toBeNull();
	expect(existsSync(overlay)).toBe(true);

	const b = await boot(dataDir, 0, { OMP_BIN: bin });
	const [adopted] = (await b.lives()).filter((l) => l.liveId === live.liveId);
	expect(adopted).toMatchObject({
		pid: omp,
		pausedAt: paused.pausedAt,
		streaming: true,
		approvalMode: "yolo",
		busy: true,
		exited: false,
		subscribers: 0,
	});
	// Still frozen: adopting it did not run it.
	expect(frozen(omp) && frozen(tool)).toBe(true);

	// A tab that attaches is shown the dialog, and can answer it.
	await request(b.ws, { t: "attach", liveId: live.liveId });
	await pollUntil(() => b.frames.some((f) => f.frame.id === "dlg-1"), "the dialog to be shown again");
	b.ws.send(JSON.stringify({ t: "ui_response", liveId: live.liveId, response: { id: "dlg-1", confirmed: true } }));
	await pollUntil(() => b.frames.some((f) => f.frame.targetId === "dlg-1"), "the dialog to be settled");

	// While paused it refuses background requests; unpausing runs the very same processes, and omp answers.
	await expect(request(b.ws, { t: "rpc", liveId: live.liveId, command: { type: "get_state" } })).rejects.toThrow(
		/paused/,
	);
	const resumed = await request<LiveInfo>(b.ws, { t: "resume", liveId: live.liveId });
	expect(resumed.pausedAt).toBeNull();
	// The server says when it ran again, for a page that attaches after (#602).
	expect(paused.resumedAt).toBeUndefined();
	expect(resumed.resumedAt).toBeGreaterThanOrEqual(paused.pausedAt as number);
	await pollUntil(() => !frozen(omp) && !frozen(tool), "omp and its tool to run again");
	expect(await processTree(omp)).toContain(tool);
	expect(await request(b.ws, { t: "rpc", liveId: live.liveId, command: { type: "get_state" } })).toMatchObject({
		sessionId: "fake",
	});
	expect(existsSync(join(dataDir, "parked", `${live.liveId}.json`))).toBe(false);
	expect(existsSync(`${overlay}.parked`)).toBe(false);

	// Closing it ends everything, relay included.
	await request(b.ws, { t: "close", liveId: live.liveId });
	await pollUntil(() => ![omp, tool, relay].some(processExists), "omp, its tool and the relay to be gone");
	await pollUntil(() => !existsSync(overlay), "the overlay to be removed");
	await quit(b);
}, 90_000);

test("a conversation paused again after being adopted survives the next server too", async () => {
	const bin = writeFakeOmp(root, { tool: true });
	const dataDir = join(root, "data-twice");
	const a = await boot(dataDir, 0, { OMP_BIN: bin });
	const { live, omp, tool } = await openNew(a, dataDir);
	await request(a.ws, { t: "pause", liveId: live.liveId });
	await quit(a);

	const b = await boot(dataDir, 0, { OMP_BIN: bin });
	await request(b.ws, { t: "resume", liveId: live.liveId });
	await pollUntil(() => !frozen(omp), "omp to run");
	await request(b.ws, { t: "pause", liveId: live.liveId });
	expect(frozen(omp) && frozen(tool)).toBe(true);
	// While the second server runs it holds the conversation: the record names it.
	expect(record(dataDir, live.liveId).owner?.pid).toBe(b.server.proc.pid);
	await quit(b);

	const c = await boot(dataDir, 0, { OMP_BIN: bin });
	expect((await c.lives()).find((l) => l.liveId === live.liveId)).toMatchObject({ pid: omp, exited: false });
	expect(frozen(omp)).toBe(true);
	await quit(c);
}, 90_000);

test("what a conversation was told of auto-retry and cache warming is written to its record when it is paused, and the server that adopts it tells every page, again after another pause (#597)", async () => {
	const bin = writeFakeOmp(root, { tool: true });
	const dataDir = join(root, "data-told");
	const a = await boot(dataDir, 0, { OMP_BIN: bin });
	const { live, omp } = await openNew(a, dataDir);
	// omp never reports either back: what it was told is all there is of what the process uses, and the server keeps it.
	const told = { autoRetry: "off", cacheWarming: "streaming" };
	await request(a.ws, { t: "rpc", liveId: live.liveId, command: { type: "set_auto_retry", enabled: false } });
	await request(a.ws, { t: "rpc", liveId: live.liveId, command: { type: "set_cache_warming", mode: "streaming" } });
	await request(a.ws, { t: "pause", liveId: live.liveId });
	expect(record(dataDir, live.liveId).sessionSettings).toEqual(told);
	await quit(a);

	const b = await boot(dataDir, 0, { OMP_BIN: bin });
	expect((await b.lives()).find((l) => l.liveId === live.liveId)?.sessionSettings).toEqual(told);
	// A page that comes to it later is told as well, with the rest of what the server knows of it.
	expect((await request<LiveInfo>(b.ws, { t: "attach", liveId: live.liveId })).sessionSettings).toEqual(told);

	// The adopted conversation carries them on: paused again, its record still says what the process was told.
	await request(b.ws, { t: "resume", liveId: live.liveId });
	await pollUntil(() => !frozen(omp), "omp to run");
	await request(b.ws, { t: "pause", liveId: live.liveId });
	expect(record(dataDir, live.liveId).sessionSettings).toEqual(told);
	await quit(b);

	const c = await boot(dataDir, 0, { OMP_BIN: bin });
	expect((await c.lives()).find((l) => l.liveId === live.liveId)?.sessionSettings).toEqual(told);
	await quit(c);
}, 90_000);

test("what omp had of the session panel's settings when it was paused is in its record and in the reply to an attach on the server that adopts it, and what a user's action changes meanwhile follows (#619)", async () => {
	const bin = writeFakeOmp(root, {
		tool: true,
		state: {
			model: { id: "claude-opus-5-5", name: "Opus 5.5", provider: "anthropic", api: "anthropic-messages" },
			steeringMode: "all",
			followUpMode: "one-at-a-time",
			interruptMode: "wait",
			autoCompactionEnabled: false,
			fastModeEnabled: true,
			todoPhases: [],
			systemPrompt: "x".repeat(500),
		},
	});
	const dataDir = join(root, "data-panel-state");
	const a = await boot(dataDir, 0, { OMP_BIN: bin });
	const { live, omp } = await openNew(a, dataDir);
	const attached = (b: Boot) =>
		request<LiveInfo & { state?: Record<string, unknown> }>(b.ws, { t: "attach", liveId: live.liveId });
	const panel = {
		model: { id: "claude-opus-5-5", name: "Opus 5.5", provider: "anthropic", api: "anthropic-messages" },
		steeringMode: "all",
		followUpMode: "one-at-a-time",
		interruptMode: "wait",
		autoCompactionEnabled: false,
		fastModeEnabled: true,
	};
	// A conversation that runs is asked for its state by the page itself.
	expect((await attached(a)).state).toBeUndefined();
	await request(a.ws, { t: "pause", liveId: live.liveId });
	expect(record(dataDir, live.liveId).state).toEqual(panel);
	expect((await attached(a)).state).toEqual(panel);
	await quit(a);

	// The next server cannot ask the frozen omp: the record is what it tells a page that attaches.
	const b = await boot(dataDir, 0, { OMP_BIN: bin });
	expect(frozen(omp)).toBe(true);
	expect((await attached(b)).state).toEqual(panel);
	// A user's action runs omp for a moment and freezes it again; the record follows it.
	await request(b.ws, {
		t: "rpc",
		liveId: live.liveId,
		command: { type: "set_steering_mode", mode: "one-at-a-time" },
		user: true,
	});
	await pollUntil(() => frozen(omp), "omp to be frozen again");
	expect(record(dataDir, live.liveId).state).toEqual({ ...panel, steeringMode: "one-at-a-time" });
	await quit(b);

	const c = await boot(dataDir, 0, { OMP_BIN: bin });
	expect((await attached(c)).state).toEqual({ ...panel, steeringMode: "one-at-a-time" });
	// Resumed, omp answers for itself again and the reply carries none of it.
	await request(c.ws, { t: "resume", liveId: live.liveId });
	await pollUntil(() => !frozen(omp), "omp to run");
	expect((await attached(c)).state).toBeUndefined();
	await quit(c);
}, 90_000);

test("a server that is killed leaves a paused conversation behind for the next one", async () => {
	const bin = writeFakeOmp(root, { tool: true });
	const dataDir = join(root, "data-killed");
	const a = await boot(dataDir, 0, { OMP_BIN: bin });
	const { live, omp, tool } = await openNew(a, dataDir);
	await request(a.ws, { t: "pause", liveId: live.liveId });

	a.server.proc.kill("SIGKILL");
	await a.server.proc.exited;
	expect(frozen(omp) && frozen(tool)).toBe(true);

	const b = await boot(dataDir, 0, { OMP_BIN: bin });
	expect((await b.lives()).find((l) => l.liveId === live.liveId)).toMatchObject({ pid: omp, exited: false });
	await request(b.ws, { t: "resume", liveId: live.liveId });
	await pollUntil(() => !frozen(omp), "omp to run");
	await request(b.ws, { t: "close", liveId: live.liveId });
	await pollUntil(() => !processExists(omp), "omp to be gone");
	await quit(b);
}, 90_000);

test("a server that runs beside another one does not take its overlay away", async () => {
	// The servers of a test run each have a temp dir of their own (tests/support/tmp.ts), so the overlay directory a
	// dead server left behind is swept by nobody but the server that takes that data dir over. Without that, a server
	// of another test file running in parallel would sweep this one, and the paused conversation would lose the
	// overlay that holds the mode it was given (#461).
	const bin = writeFakeOmp(root, { tool: true, streaming: true });
	const first = join(root, "data-beside");
	const second = join(root, "data-beside-other");
	const a = await boot(first, 0, { OMP_BIN: bin });
	const { live } = await openNew(a, first);
	await request(a.ws, { t: "pause", liveId: live.liveId });
	const overlay = record(first, live.liveId).overlay?.file as string;
	expect(existsSync(overlay)).toBe(true);

	// The server is killed: its overlay directory is left behind, as a dead server's is.
	a.server.proc.kill("SIGKILL");
	await a.server.proc.exited;
	expect(existsSync(overlay)).toBe(true);

	// Another server, on another data dir, starts a conversation: it sweeps the overlay directories of the servers
	// that are gone, and this one is not its to sweep.
	const b = await boot(second, 0, { OMP_BIN: bin });
	await openNew(b, second);
	expect(existsSync(overlay)).toBe(true);
	await quit(b);
}, 90_000);

test("a conversation whose relay died is ended, and opening it starts an ordinary one", async () => {
	const bin = writeFakeOmp(root, { tool: true });
	const dataDir = join(root, "data-relay-killed");
	const a = await boot(dataDir, 0, { OMP_BIN: bin });
	const { live, omp, tool, relay } = await openNew(a, dataDir);
	await request(a.ws, { t: "pause", liveId: live.liveId });
	await quit(a);
	// omp is frozen with no stdin and nobody to answer: there is nothing to adopt.
	process.kill(relay, "SIGKILL");
	await pollUntil(() => !processExists(relay), "the relay to be gone");
	expect(processExists(omp)).toBe(true);

	const b = await boot(dataDir, 0, { OMP_BIN: bin });
	expect(await b.lives()).toEqual([]);
	await pollUntil(() => !processExists(omp) && !processExists(tool), "the orphaned omp and its tool to be ended");
	expect(existsSync(join(dataDir, "parked", `${live.liveId}.json`))).toBe(false);

	// Opening the conversation resumes it from its session file, as any that has no process.
	const again = await request<LiveInfo>(b.ws, {
		t: "open",
		target: { kind: "resume", sessionFile: live.sessionFile, cwd: work },
	});
	expect(again.liveId).not.toBe(live.liveId);
	expect(again.pausedAt).toBeNull();
	expect(await request(b.ws, { t: "rpc", liveId: again.liveId, command: { type: "get_state" } })).toMatchObject({
		sessionId: "fake",
	});
	await quit(b);
}, 90_000);

test("a relay that dies under a running server takes its paused conversation with it: nothing is left frozen", async () => {
	const bin = writeFakeOmp(root, { tool: true });
	const dataDir = join(root, "data-relay-dies");
	const a = await boot(dataDir, 0, { OMP_BIN: bin });
	const { live, omp, tool, relay } = await openNew(a, dataDir);
	await request(a.ws, { t: "pause", liveId: live.liveId });
	process.kill(relay, "SIGKILL");
	// omp and its tool are frozen with no one to talk to them: they are ended, not left behind.
	await pollUntil(() => !processExists(omp) && !processExists(tool), "the frozen omp and its tool to be ended");
	await pollUntil(async () => (await a.lives()).length === 0, "the conversation to leave the list");
	expect(existsSync(join(dataDir, "parked", `${live.liveId}.json`))).toBe(false);
	await quit(a);
}, 90_000);

test("a conversation whose omp was killed meanwhile is forgotten, its relay goes, and the tool it left frozen goes with it", async () => {
	const bin = writeFakeOmp(root, { tool: true });
	const dataDir = join(root, "data-omp-killed");
	const a = await boot(dataDir, 0, { OMP_BIN: bin });
	const { live, omp, tool, relay } = await openNew(a, dataDir);
	await request(a.ws, { t: "pause", liveId: live.liveId });
	await quit(a);
	// Only omp: the relay is the one that ends what it left.
	process.kill(omp, "SIGKILL");
	await pollUntil(() => !processExists(relay) && !processExists(tool), "the relay of the dead omp and its tool to end");

	const b = await boot(dataDir, 0, { OMP_BIN: bin });
	expect(await b.lives()).toEqual([]);
	expect(existsSync(join(dataDir, "parked", `${live.liveId}.json`))).toBe(false);
	await quit(b);
}, 90_000);

test("a tool in a session of its own outlives a killed omp until the next server ends it", async () => {
	const bin = writeFakeOmp(root, { tool: true, toolDetached: true });
	const dataDir = join(root, "data-tool-detached");
	const a = await boot(dataDir, 0, { OMP_BIN: bin });
	const { live, omp, tool, relay } = await openNew(a, dataDir);
	await request(a.ws, { t: "pause", liveId: live.liveId });
	expect(record(dataDir, live.liveId).descendants.map((d) => d.pid)).toEqual([tool]);
	await quit(a);
	process.kill(omp, "SIGKILL");
	await pollUntil(() => !processExists(relay), "the relay of the dead omp to end");
	// Out of reach of omp's process group, and nobody to resume it.
	expect(frozen(tool)).toBe(true);

	const b = await boot(dataDir, 0, { OMP_BIN: bin });
	expect(await b.lives()).toEqual([]);
	await pollUntil(() => !processExists(tool), "the tool to be ended when the record is found");
	expect(existsSync(join(dataDir, "parked", `${live.liveId}.json`))).toBe(false);
	await quit(b);
}, 90_000);

test("an omp that dies under a running server while paused leaves nothing frozen, tools in sessions of their own included", async () => {
	const bin = writeFakeOmp(root, { tool: true, toolDetached: true });
	const dataDir = join(root, "data-omp-dies");
	const a = await boot(dataDir, 0, { OMP_BIN: bin });
	const { live, omp, tool } = await openNew(a, dataDir);
	await request(a.ws, { t: "pause", liveId: live.liveId });
	process.kill(omp, "SIGKILL");
	await pollUntil(() => !processExists(tool), "the frozen tool to be ended");
	await pollUntil(async () => (await a.lives()).length === 0, "the conversation to leave the list");
	expect(existsSync(join(dataDir, "parked", `${live.liveId}.json`))).toBe(false);
	await quit(a);
}, 90_000);

test("records that name processes that are not the recorded ones touch nothing", async () => {
	const bin = writeFakeOmp(root);
	const dataDir = join(root, "data-stale");
	mkdirSync(dataDir, { recursive: true });
	dataDirs.push(dataDir);
	const sleepers = [0, 1, 2, 3, 4].map(() => {
		const p = Bun.spawn(["sleep", "600"], { stdout: "ignore", stderr: "ignore" });
		procs.push(p);
		return p.pid;
	});
	const [reusedOmp, reusedRelay, ownerPid, heldOmp, heldRelay] = sleepers;
	const gone = Bun.spawn(["true"]);
	await gone.exited;
	const wrong = (pid: number) => ({ pid, identity: "Thu Jan  1 00:00:00 1970 /usr/bin/omp --mode rpc-ui" });
	/** A process that is running, as a record names it. */
	const running = async (pid: number) => {
		const ref = await referenceTo(pid);
		if (!ref) throw new Error(`process ${pid} is not running`);
		return ref;
	};
	const base = (liveId: string): ParkedRecord => ({
		version: 1,
		liveId,
		omp: wrong(gone.pid),
		relay: wrong(gone.pid),
		socket: join(dataDir, "none.sock"),
		owner: null,
		cwd: work,
		args: [],
		env: {},
		mode: "full",
		startedAt: Date.now(),
		pausedAt: Date.now(),
		sessionFile: null,
		sessionId: null,
		streaming: false,
		overlay: null,
		interviewing: false,
		pendingUI: [],
		descendants: [],
	});
	const store = new ParkedStore(dataDir);
	// Its processes ended, and one of the pids is reused by something else: neither is touched.
	store.save({ ...base("L1-dead") });
	store.save({ ...base("L2-reused"), omp: wrong(reusedOmp), relay: wrong(reusedRelay) });
	// Held by a server that is running: not left over, so not taken (and not ended).
	store.save({
		...base("L3-held"),
		omp: await running(heldOmp),
		relay: await running(heldRelay),
		owner: await running(ownerPid),
	});
	expect(existsSync(join(dataDir, "parked", "L3-held.json"))).toBe(true);

	const a = await boot(dataDir, 0, { OMP_BIN: bin });
	expect(await a.lives()).toEqual([]);
	expect(existsSync(join(dataDir, "parked", "L1-dead.json"))).toBe(false);
	expect(existsSync(join(dataDir, "parked", "L2-reused.json"))).toBe(false);
	expect(existsSync(join(dataDir, "parked", "L3-held.json"))).toBe(true);
	expect(sleepers.every(processExists)).toBe(true);
	await quit(a);

	// The recorded processes, but a relay that does not answer: they are the recorded ones, so they are ended.
	process.kill(ownerPid, "SIGKILL");
	const b = await boot(dataDir, 0, { OMP_BIN: bin });
	expect(await b.lives()).toEqual([]);
	await pollUntil(
		() => !processExists(heldOmp) && !processExists(heldRelay),
		"the unreachable pair to be ended",
		20_000,
	);
	expect(existsSync(join(dataDir, "parked", "L3-held.json"))).toBe(false);
	expect(processExists(reusedOmp) && processExists(reusedRelay)).toBe(true);
	await quit(b);
}, 90_000);

test("conversations that are not paused end with the server, relay and all", async () => {
	const bin = writeFakeOmp(root, { tool: true });
	const dataDir = join(root, "data-plain");
	const a = await boot(dataDir, 0, { OMP_BIN: bin });
	const { live, omp, tool, relay } = await openNew(a, dataDir);
	// Paused, then resumed: not paused when the server ends.
	await request(a.ws, { t: "pause", liveId: live.liveId });
	await request(a.ws, { t: "resume", liveId: live.liveId });
	expect(existsSync(join(dataDir, "parked", `${live.liveId}.json`))).toBe(false);
	await quit(a);
	await pollUntil(() => ![omp, tool, relay].some(processExists), "omp, its tool and its relay to be gone");
	expect(existsSync(join(dataDir, "server.pid"))).toBe(false);
	expect(relayPids(dataDir)).toEqual([]);
}, 90_000);

test("ending the paused conversations leaves nothing for the next server", async () => {
	const bin = writeFakeOmp(root, { tool: true });
	const dataDir = join(root, "data-end");
	const a = await boot(dataDir, 0, { OMP_BIN: bin });
	const { live, omp, tool, relay } = await openNew(a, dataDir);
	await request(a.ws, { t: "pause", liveId: live.liveId });
	const ended = await fetch(`${a.url}/api/lives/end-kept`, {
		method: "POST",
		headers: { "x-omp-webui-token": a.server.token, "x-omp-webui": "1" },
	});
	expect(await ended.json()).toEqual({ ended: 1 });
	await pollUntil(() => ![omp, tool, relay].some(processExists), "the paused conversation to end");
	await quit(a);
	const b = await boot(dataDir, 0, { OMP_BIN: bin });
	expect(await b.lives()).toEqual([]);
	await quit(b);
}, 90_000);
