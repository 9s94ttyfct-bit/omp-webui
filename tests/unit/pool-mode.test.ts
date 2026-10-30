import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LivePool } from "../../server/live.ts";
import { FULL, type Launcher, type LaunchPlan } from "../../server/offline/index.ts";
import { type ParkedRecord, referenceTo } from "../../server/omp/parked.ts";
import type { Mode } from "../../shared/offline.ts";
import { fakeConfig, writeFakeOmp } from "../support/fake-omp.ts";

/** A New chat reuses an unused process only when it was started in the mode the chat starts in (the target's, else the default). */

const dirs: string[] = [];
const pools: LivePool[] = [];
afterEach(async () => {
	for (const pool of pools.splice(0)) await pool.shutdown();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Differs from Full only in its environment (another agent dir): the command lines alone look the same. */
const LIGHT: LaunchPlan = {
	mode: "light",
	lightModels: "local",
	args: [],
	env: { PI_CODING_AGENT_DIR: "/tmp/ompw-test-light-agent" },
};

test("a New chat never gets the other mode's unused process, and a target that names its mode is started in it", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-pool-mode-"));
	dirs.push(dir);
	const launcher: Launcher & { mode: Mode } = {
		mode: "full",
		async plan(req) {
			return req.mode === "light" ? LIGHT : FULL;
		},
	};
	const pool = new LivePool(fakeConfig(dir, writeFakeOmp(dir)), null, launcher);
	pools.push(pool);
	const open = (mode?: Mode) => pool.open({ kind: "new", cwd: dir, ...(mode ? { mode } : {}) }, async () => null);

	// No mode named: the one new conversations start in.
	const full = await open();
	expect(full.info.mode).toBe("full");
	expect(await open()).toBe(full);

	// A target that names one is started in it, whatever the default is.
	const light = await open("light");
	expect(light).not.toBe(full);
	expect(light.info).toMatchObject({ mode: "light", lightModels: "local" });
	expect(await open("light")).toBe(light);
	expect(await open("full")).toBe(full);

	// The default moves: a chat that names none gets the other process.
	launcher.mode = "light";
	expect(await open()).toBe(light);
	launcher.mode = "full";
	expect(await open()).toBe(full);
});

test("an unused Light process started with other Light files (another backend) is not handed to a New chat", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-pool-mode-"));
	dirs.push(dir);
	// Each configuration has an agent directory of its own: it is what tells the files a process was started with.
	let revision = "a";
	const launcher: Launcher = {
		mode: "light",
		async plan() {
			return { ...LIGHT, env: { PI_CODING_AGENT_DIR: `${LIGHT.env.PI_CODING_AGENT_DIR}/${revision}` } };
		},
	};
	const pool = new LivePool(fakeConfig(dir, writeFakeOmp(dir)), null, launcher);
	pools.push(pool);
	const open = () => pool.open({ kind: "new", cwd: dir }, async () => null);

	const first = await open();
	expect(await open()).toBe(first);

	// Same mode, same command line, but the files the process reads say something else now.
	revision = "b";
	const second = await open();
	expect(second).not.toBe(first);
	expect(await open()).toBe(second);

	revision = "a";
	expect(await open()).toBe(first);
});

test("the pool tells the mode which agent directories are in use: those of the processes that run and of every paused conversation on record that is still held", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-pool-mode-"));
	dirs.push(dir);
	const told: string[][] = [];
	const launcher: Launcher = {
		mode: "light",
		async plan() {
			return LIGHT;
		},
		collect: (inUse) => told.push([...inUse]),
	};
	const pool = new LivePool(fakeConfig(dir, writeFakeOmp(dir)), null, launcher);
	pools.push(pool);
	await pool.open({ kind: "new", cwd: dir }, async () => null);

	const record = (liveId: string, owner: ParkedRecord["owner"], agentDir: string): ParkedRecord => ({
		version: 2,
		liveId,
		omp: { pid: 1, identity: "not the process that has this id" },
		relay: { pid: 2, identity: "nor this one" },
		descendants: [],
		socket: join(dir, `${liveId}.sock`),
		owner,
		cwd: dir,
		args: [],
		env: { PI_CODING_AGENT_DIR: agentDir },
		mode: "light",
		startedAt: 0,
		pausedAt: 1,
		sessionFile: null,
		sessionId: null,
		streaming: false,
		overlay: null,
		interviewing: false,
		pendingUI: [],
	});
	// One a server that runs holds (this one, as far as the record can tell), and one nobody can take over any more.
	pool.parked.save(record("L-held", await referenceTo(process.pid), "/data/offline-agent/0123456789abcdef"));
	pool.parked.save(record("L-lost", null, "/data/offline-agent/fedcba9876543210"));
	await pool.adopt();

	expect(told.at(-1)?.sort()).toEqual([LIGHT.env.PI_CODING_AGENT_DIR, "/data/offline-agent/0123456789abcdef"].sort());
});
