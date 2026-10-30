import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LivePool } from "../../server/live.ts";
import { type ParkedRecord, type ProcessRef, referenceTo } from "../../server/omp/parked.ts";
import { relaySocket } from "../../server/omp/relay-client.ts";
import { fakeConfig, writeFakeOmp } from "../support/fake-omp.ts";

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
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
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
