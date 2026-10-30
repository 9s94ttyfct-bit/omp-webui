import { afterEach, expect, test } from "bun:test";
import { once } from "node:events";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { processTree } from "../../server/omp/process-tree.ts";
import { HIGH_WATER } from "../../server/omp/relay.ts";
import { pruneRelayDir, relaySocket, sweepRelayDir } from "../../server/omp/relay-client.ts";
import { encodeFrame, FROM_RELAY, FrameDecoder, TO_RELAY } from "../../server/omp/relay-protocol.ts";
import { RpcClient } from "../../server/omp/rpc-client.ts";
import type { OmpFrame } from "../../shared/protocol.ts";
import { writeFakeOmp } from "../support/fake-omp.ts";
import { pollUntil, processExists } from "../support/poll.ts";
import { removeRelayDir } from "../support/relay-dirs.ts";

/**
 * The relay that holds omp's pipes (server/omp/relay.ts), driven through `RpcClient` against a scripted fake omp:
 * what omp writes while no server is connected, who owns the connection, and how omp's end is reported.
 */

const dirs: string[] = [];
const clients: RpcClient[] = [];
/** Processes a failing test may leave behind. */
const strays: number[] = [];

afterEach(() => {
	for (const c of clients.splice(0)) {
		c.kill("SIGKILL");
		const relay = c.relay?.pid;
		if (relay) {
			try {
				process.kill(relay, "SIGKILL");
			} catch {
				// already gone
			}
		}
	}
	for (const pid of strays.splice(0)) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// already gone
		}
	}
	for (const d of dirs.splice(0)) {
		removeRelayDir(d);
		rmSync(d, { recursive: true, force: true });
	}
});

function setup(options: Parameters<typeof writeFakeOmp>[1] = {}) {
	const dir = mkdtempSync(join(tmpdir(), "ompw-relay-"));
	dirs.push(dir);
	return { dir, bin: writeFakeOmp(dir, options), socket: relaySocket(dir, "L1-relay") };
}

function start(
	s: { dir: string; bin: string; socket: string },
	via: "relay" | "adopt",
	onFrame: (f: OmpFrame) => void = () => {},
	onExit: (code: number | null, stderr: string, signal: NodeJS.Signals | null) => void = () => {},
): RpcClient {
	const c = new RpcClient({
		bin: s.bin,
		args: [],
		cwd: s.dir,
		via: { kind: via, socket: s.socket },
		onFrame,
		onExit,
	});
	clients.push(c);
	return c;
}

test("what omp writes while no server is connected reaches the next one, in order, however much it is", async () => {
	const s = setup();
	const first = start(s, "relay");
	await first.ready;
	// 300 frames of 8 KB, sent 400 ms from now: more than a pipe holds, and written while nobody is connected.
	const pad = "x".repeat(8000);
	const frames = Array.from({ length: 300 }, (_, i) => ({ type: "bulk", n: i, pad }));
	const marker = join(s.dir, "written");
	await first.call({ type: "emit_frames", frames, afterMs: 400, marker });
	first.hold(true);
	first.detach();
	const omp = first.pid as number;
	await pollUntil(() => existsSync(marker), "omp to have written its frames with nobody connected");
	expect(processExists(omp)).toBe(true);

	const seen: number[] = [];
	const second = start(s, "adopt", (f) => {
		if (f.type === "bulk") seen.push(Number(f.n));
	});
	await second.ready;
	await pollUntil(() => seen.length === 300, "every frame to arrive");
	expect(seen).toEqual(frames.map((f) => f.n));
	expect(second.pid).toBe(omp);

	// And the process is the one it was: it answers.
	expect(await second.call({ type: "get_state" })).toMatchObject({ sessionId: "fake" });
	second.hold(false);
	second.close();
	await second.whenExited;
	await pollUntil(() => !processExists(omp) && !existsSync(s.socket), "omp and its relay to be gone");
});

test("an omp that writes far more than a pipe holds while no server is connected is not held back by it, and the next server gets it all, in order (#462)", async () => {
	const s = setup();
	const first = start(s, "relay");
	await first.ready;
	// 12 MB in frames of 8 KB, each written once the pipe has taken the one before: omp gets through them only while
	// the relay reads. More than the relay keeps in memory (the rest goes to its file); much more than a pipe holds.
	const count = 1500;
	const progress = join(s.dir, "progress");
	const marker = join(s.dir, "written");
	first.hold(true);
	await first.call({ type: "emit_bulk", count, bytes: 8000, progress, marker, afterMs: 400 });
	first.detach();
	const omp = first.pid as number;
	await pollUntil(() => existsSync(marker), "omp to have written all 12 MB with nobody connected", 30_000);
	expect(processExists(omp)).toBe(true);

	const seen: number[] = [];
	const second = start(s, "adopt", (f) => {
		if (f.type === "bulk") seen.push(Number(f.n));
	});
	await second.ready;
	await pollUntil(() => seen.length === count, "every frame to arrive", 30_000);
	expect(seen).toEqual(Array.from({ length: count }, (_, i) => i));
	// And it goes on in order after the kept frames: omp answers, and its answer comes after them.
	expect(await second.call({ type: "get_state" })).toMatchObject({ sessionId: "fake" });
	expect(second.pid).toBe(omp);
	second.hold(false);
	second.close();
	await second.whenExited;
	await pollUntil(() => !processExists(omp) && !existsSync(s.socket), "omp and its relay to be gone");
}, 60_000);

test("a connection that ends while omp is not held ends it as a closed pipe does, and the relay goes with it", async () => {
	const s = setup();
	const c = start(s, "relay");
	await c.ready;
	const omp = c.pid as number;
	const relay = c.relay?.pid as number;
	c.detach();
	await pollUntil(() => !processExists(omp) && !processExists(relay), "omp and the relay to be gone");
	expect(existsSync(s.socket)).toBe(false);
});

test("a working omp does not outlive its server: when the connection ends it is stopped, with the tool it started (#350)", async () => {
	// A working omp ignores a closed stdin until its turn is over; its tool runs in a session of its own, as omp's do.
	const s = setup({ ignoreClose: true, tool: true, toolDetached: true });
	const c = start(s, "relay");
	await c.ready;
	const omp = c.pid as number;
	const relay = c.relay?.pid as number;
	let tool = 0;
	await pollUntil(async () => {
		tool = (await processTree(omp)).find((p) => p !== omp) ?? 0;
		return tool > 0;
	}, "omp's tool");
	strays.push(tool);

	// What a killed server does to the relay: its connection ends, and nothing says the conversation is paused.
	c.detach();
	await pollUntil(
		() => !processExists(omp) && !processExists(relay) && !processExists(tool),
		"omp, its tool and the relay to be gone",
		30_000,
	);
	expect(existsSync(s.socket)).toBe(false);
}, 60_000);

test("a held omp is left running when the connection ends, however long no server comes (#350)", async () => {
	const s = setup({ ignoreClose: true });
	const c = start(s, "relay");
	await c.ready;
	const omp = c.pid as number;
	c.hold(true);
	c.detach();
	// Absence of an effect has no event to await: a relay that stopped a working omp would have done it within three
	// seconds (its grace and its SIGTERM grace), so this waits for twice that.
	await Bun.sleep(6_000);
	expect(processExists(omp)).toBe(true);
	// And a server that comes finds it where it was.
	const next = start(s, "adopt");
	await next.ready;
	expect(next.pid).toBe(omp);
}, 60_000);

test("a server that connects takes the relay over from the one that held it", async () => {
	const s = setup();
	let firstEnd = "";
	const first = start(
		s,
		"relay",
		() => {},
		(_code, stderr) => {
			firstEnd = stderr;
		},
	);
	await first.ready;
	first.hold(true);
	const second = start(s, "adopt");
	await second.ready;
	await pollUntil(() => first.isExited, "the first server's client to be told");
	expect(firstEnd).toMatch(/another server took over/);
	expect(await second.call({ type: "get_state" })).toMatchObject({ sessionId: "fake" });
	second.hold(false);
	second.close();
	await second.whenExited;
});

test("why omp ended before any server was connected is still reported", async () => {
	const s = setup({ failWhenArgs: ["--boom"] });
	let reported = "";
	const c = new RpcClient({
		bin: s.bin,
		args: ["--boom"],
		cwd: s.dir,
		via: { kind: "relay", socket: s.socket },
		onFrame: () => {},
		onExit: (_code, stderr) => {
			reported = stderr;
		},
	});
	clients.push(c);
	await expect(c.ready).rejects.toThrow(/omp exited \(code 1\).*Could not restore model --boom/);
	expect(reported).toContain("Could not restore model --boom");
});

test("an omp that cannot be started reports why", async () => {
	const s = setup();
	const c = new RpcClient({
		bin: join(s.dir, "no-such-omp"),
		args: [],
		cwd: s.dir,
		via: { kind: "relay", socket: s.socket },
		onFrame: () => {},
		onExit: () => {},
	});
	clients.push(c);
	await expect(c.ready).rejects.toThrow(/omp exited \(code 127\).*could not start/);
});

test("an omp that ends while its conversation is held takes what it started with it", async () => {
	const s = setup({ tool: true });
	const c = start(s, "relay");
	await c.ready;
	const omp = c.pid as number;
	const relay = c.relay?.pid as number;
	const tool = (await processTree(omp)).find((p) => p !== omp) as number;
	expect(tool).toBeGreaterThan(0);
	strays.push(tool);
	c.hold(true);
	// The relay has the hold once omp answers: the frames are in order.
	await c.call({ type: "get_state" });
	process.kill(omp, "SIGKILL");
	await pollUntil(() => !processExists(tool) && !processExists(relay), "the tool and the relay to be gone");
	expect(existsSync(s.socket)).toBe(false);
});

test("an omp killed by a signal is reported with the signal, not as an exit with a made-up code", async () => {
	const s = setup({ hold: ["stuck"] });
	const reported: { code: number | null; signal: string | null }[] = [];
	const c = start(
		s,
		"relay",
		() => {},
		(code, _stderr, signal) => {
			reported.push({ code, signal });
		},
	);
	await c.ready;
	// A request omp never answers: what a page's action is waiting on when omp is killed.
	const pending = c.call({ type: "stuck" }).catch((e: Error) => e);
	process.kill(c.pid as number, "SIGKILL");
	expect(((await pending) as Error).message).toContain("omp exited (killed by SIGKILL)");
	await pollUntil(() => reported.length > 0, "the client to be told");
	expect(reported).toEqual([{ code: null, signal: "SIGKILL" }]);
});

/** What sits between omp and a relay's backlog that is not the relay's: omp's pipe, and the socket to the server. */
const PIPES = 1 << 20;

/**
 * omp writes `count` frames of `bytes` each while the only server connected never reads (a connection that is open and
 * paused), then the server reads on. Returns how many frames omp got written meanwhile — what the relay took from it:
 * one that reads without limit takes them all — and the frames that came once the server read on.
 *
 * What is measured is how far omp got, not the relay's memory: the resident size of a process also holds the garbage its
 * collector has not freed yet, which depends on how much CPU the relay got, not on what it holds.
 */
async function bulkToAServerThatDoesNotRead(count: number, bytes: number) {
	const s = setup();
	const first = start(s, "relay");
	await first.ready;
	first.hold(true);
	// The relay has the hold once omp answers: the frames are in order.
	await first.call({ type: "get_state" });
	first.detach();
	const idle = connect(s.socket);
	idle.pause();
	await once(idle, "connect");
	const progress = join(s.dir, "progress");
	const marker = join(s.dir, "written");
	// The connection that does not read is the one that tells omp to write: nothing is written before it is there.
	const command = { id: "bulk", type: "emit_bulk", count, bytes, progress, marker };
	idle.write(encodeFrame(TO_RELAY.stdin, `${JSON.stringify(command)}\n`));

	// omp writes as long as the relay takes it. A relay that reads without limit takes everything (the marker appears, or
	// omp is past the most any relay may hold); one that stops at its high-water mark leaves omp stopped on its full pipe.
	// There is no event for a read that does not happen: omp is stopped when it has not moved for a second. A relay that
	// is not stopping is seen to move all the same; only one starved of CPU for that second could pass for stopped.
	const written = (): number => (existsSync(progress) ? statSync(progress).size : 0);
	const mostItMayHold = HIGH_WATER + 2 * bytes + PIPES;
	let last = -1;
	let still = 0;
	while (!existsSync(marker) && still < 20 && written() * bytes <= mostItMayHold) {
		const now = written();
		still = now === last ? still + 1 : 0;
		last = now;
		await Bun.sleep(50);
	}
	const taken = written();
	const everythingTaken = existsSync(marker);

	const decoder = new FrameDecoder();
	const order: number[] = [];
	let rest = "";
	for await (const chunk of idle) {
		for (const frame of decoder.push(chunk)) {
			if (frame.type !== FROM_RELAY.stdout) continue;
			const lines = (rest + frame.payload.toString()).split("\n");
			rest = lines.pop() as string;
			for (const line of lines) if (line.includes('"type":"bulk"')) order.push(JSON.parse(line).n);
		}
		if (order.length === count) break;
	}
	idle.destroy();
	await pollUntil(() => existsSync(marker), "omp to have written everything");
	return { taken, everythingTaken, order };
}

test("a server that stops reading stops the relay reading omp: what it holds stays bounded, and the output resumes in order", async () => {
	// 60 MB in frames of 8 KB.
	const { taken, everythingTaken, order } = await bulkToAServerThatDoesNotRead(7500, 8000);
	expect(everythingTaken, "omp wrote 60 MB while nobody read: the relay took it all").toBe(false);
	expect(taken * 8000).toBeLessThanOrEqual(HIGH_WATER + 2 * 8000 + PIPES);
	expect(order).toEqual(Array.from({ length: 7500 }, (_, i) => i));
}, 60_000);

test("a line longer than a pipe's chunk is held whole: the relay stops reading omp at its backlog, and the output resumes in order", async () => {
	// 60 MB in frames of 700 KB: a line is whole before the server gets it. (That it is joined once, not at every chunk,
	// is in relay-lines.test.ts.)
	const line = 700_000;
	const { taken, everythingTaken, order } = await bulkToAServerThatDoesNotRead(86, line);
	expect(everythingTaken).toBe(false);
	expect(taken * line).toBeLessThanOrEqual(HIGH_WATER + 2 * line + PIPES);
	expect(order).toEqual(Array.from({ length: 86 }, (_, i) => i));
}, 60_000);

test("the socket of a relay that was killed is swept; a relay that runs keeps its own, and what is no socket stays (#317)", async () => {
	const s = setup();
	const dead = { ...s, socket: relaySocket(s.dir, "L2-relay") };
	const live = start(s, "relay");
	const doomed = start(dead, "relay");
	await live.ready;
	await doomed.ready;
	const doomedOmp = doomed.pid as number;
	const doomedRelay = doomed.relay?.pid as number;
	strays.push(doomedOmp);
	// SIGKILL, an out-of-memory kill: the relay cannot remove its socket.
	process.kill(doomedRelay, "SIGKILL");
	await pollUntil(() => !processExists(doomedRelay), "the killed relay to be gone");
	expect(existsSync(dead.socket)).toBe(true);
	const dir = dirname(s.socket);
	const notes = join(dir, "notes.sock");
	writeFileSync(notes, "not a socket");

	// Nothing is removed when the processes cannot be listed.
	expect(await sweepRelayDir(s.dir, undefined, async () => null)).toEqual([]);
	expect(existsSync(dead.socket)).toBe(true);

	expect(await sweepRelayDir(s.dir)).toEqual(["L2-relay.sock"]);
	expect(existsSync(dead.socket)).toBe(false);
	expect(existsSync(s.socket)).toBe(true);
	expect(existsSync(notes)).toBe(true);
	expect(await live.call({ type: "get_state" })).toMatchObject({ sessionId: "fake" });

	// Once the running relay has ended too, nothing but what is not ours is left, and the directory can go.
	live.close();
	await live.whenExited;
	await pollUntil(() => !existsSync(s.socket), "the relay to remove its socket");
	rmSync(notes);
	pruneRelayDir(s.dir);
	expect(existsSync(dir)).toBe(false);
}, 60_000);
