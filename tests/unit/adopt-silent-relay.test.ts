// needs: relay
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LivePool } from "../../server/live.ts";
import { ApprovalStore } from "../../server/omp/approval.ts";
import { type ParkedRecord, type ProcessRef, referenceTo } from "../../server/omp/parked.ts";
import { relaySocket } from "../../server/omp/relay-client.ts";
import { encodeFrame, FROM_RELAY } from "../../server/omp/relay-protocol.ts";
import { fakeConfig, writeFakeOmp } from "../support/fake-omp.ts";
import { removeScratch } from "../support/scratch.ts";

/**
 * A server that starts takes over the paused conversations a former one left (`LivePool.adopt`) before it listens. One
 * whose relay accepts the connection and then says nothing — a relay that is stuck, frozen, or some other program on
 * its socket — must not keep the server from ever listening: it counts as not there, like a relay that refuses the
 * connection (#420).
 */

const dirs: string[] = [];
const stops: (() => void)[] = [];

afterEach(() => {
	for (const stop of stops.splice(0)) stop();
	for (const d of dirs.splice(0)) removeScratch(d);
});

test("a parked conversation whose relay accepts the connection and never greets is dropped, and adopt returns", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-silent-"));
	dirs.push(dir);
	const pool = new LivePool(fakeConfig(dir, writeFakeOmp(dir)));

	// A relay that holds the connection open and never greets.
	const socket = relaySocket(dir, "L9-silent");
	const silent = Bun.listen({ unix: socket, socket: { open() {}, data() {} } });
	stops.push(() => silent.stop(true));
	// The record is only taken over while both processes it names still run as recorded: two that do stand in for them.
	const relay = Bun.spawn(["sleep", "600"]);
	const omp = Bun.spawn(["sleep", "600"]);
	stops.push(() => relay.kill("SIGKILL"));
	stops.push(() => omp.kill("SIGKILL"));
	const record: ParkedRecord = {
		version: 1,
		liveId: "L9-silent",
		omp: (await referenceTo(omp.pid)) as ProcessRef,
		relay: (await referenceTo(relay.pid)) as ProcessRef,
		socket,
		owner: null,
		cwd: dir,
		args: [],
		env: {},
		mode: "full",
		startedAt: 0,
		pausedAt: 1,
		sessionFile: null,
		sessionId: null,
		streaming: false,
		overlay: null,
		interviewing: false,
		pendingUI: [],
		descendants: [],
	};
	pool.parked.save(record);

	// Without a bound this never returns: the test fails here instead of hanging for its whole timeout.
	const adopted = await Promise.race([pool.adopt(), Bun.sleep(15_000).then(() => "hung")]);
	expect(adopted).toBe(0);

	// Dropped as a refused connection is: what the record named is ended and the record is forgotten.
	expect(pool.parked.list()).toEqual([]);
	expect(pool.list()).toEqual([]);
	await Promise.all([relay.exited, omp.exited]);
});

test("a parked conversation whose relay holds another process leaves no overlay behind, and none is written again", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-other-omp-"));
	dirs.push(dir);
	const bin = writeFakeOmp(dir);
	// Overlays looked at every 20 ms: one kept by a timer that outlived its conversation would be back at once.
	const pool = new LivePool(fakeConfig(dir, bin), null, null, new ApprovalStore(bin, dir, 0, 20));
	// A relay that greets at once, holding a process that is not the recorded omp: taking it over fails without its end.
	const socket = relaySocket(dir, "L8-other");
	const other = Bun.listen({
		unix: socket,
		socket: {
			open(s) {
				s.write(encodeFrame(FROM_RELAY.hello, JSON.stringify({ pid: 1, relayPid: 2 })));
			},
			data() {},
		},
	});
	stops.push(() => other.stop(true));
	const relay = Bun.spawn(["sleep", "600"]);
	const omp = Bun.spawn(["sleep", "600"]);
	stops.push(() => relay.kill("SIGKILL"));
	stops.push(() => omp.kill("SIGKILL"));
	// The server's overlay folder, which holds its other conversations' overlays too (so it stays when this one's go).
	const overlays = join(dir, "overlays");
	mkdirSync(overlays);
	writeFileSync(join(overlays, "L1.yml"), "");
	const file = join(overlays, "L8-other.yml");
	pool.parked.save({
		version: 1,
		liveId: "L8-other",
		omp: (await referenceTo(omp.pid)) as ProcessRef,
		relay: (await referenceTo(relay.pid)) as ProcessRef,
		socket,
		owner: null,
		cwd: dir,
		args: [],
		env: {},
		mode: "full",
		startedAt: 0,
		pausedAt: 1,
		sessionFile: null,
		sessionId: null,
		streaming: false,
		overlay: { file, mode: null },
		interviewing: false,
		pendingUI: [],
		descendants: [],
	});

	expect(await pool.adopt()).toBe(0);
	await Bun.sleep(200);
	expect(existsSync(file)).toBe(false);
	expect(existsSync(`${file}.parked`)).toBe(false);
	expect(existsSync(`${file}.adopted`)).toBe(false);
});
