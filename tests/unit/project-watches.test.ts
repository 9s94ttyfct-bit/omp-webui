import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Live, LivePool } from "../../server/live.ts";
import type { ConversationModels } from "../../shared/model-config.ts";
import { fakeConfig, writeFakeOmp } from "../support/fake-omp.ts";

/**
 * The project config of a folder is watched (for a change of roles) while a live or paused conversation switched to a
 * preset runs in it, and not longer: one watcher per folder in use, however many conversations come and go.
 */

const dirs: string[] = [];
const pools: LivePool[] = [];

afterEach(async () => {
	for (const pool of pools.splice(0)) await pool.shutdown();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const dir = () => {
	const d = mkdtempSync(join(tmpdir(), "ompw-watch-"));
	dirs.push(d);
	return d;
};

const switched: ConversationModels = { preset: "fast", roles: { default: "omlx/stub" } };

function setup() {
	const base = dir();
	const pool = new LivePool(fakeConfig(base, writeFakeOmp(base, {})));
	pools.push(pool);
	let n = 0;
	/** A new conversation in `cwd` (each its own process: the arguments differ), switched to a preset as the pool is told. */
	const open = async (cwd: string, switchIt = true): Promise<Live> => {
		const live = await pool.open({ kind: "new", cwd, args: ["--no-session", `--n=${n++}`] }, async () => null);
		if (switchIt) {
			live.info.models = switched;
			pool.announce(live);
		}
		return live;
	};
	/** Close a conversation and wait until the pool has forgotten it. */
	const close = async (live: Live) => {
		live.client.close();
		await live.client.whenExited;
		while (pool.get(live.info.liveId)) {
			const next = Promise.withResolvers<void>();
			setImmediate(next.resolve);
			await next.promise;
		}
	};
	return { pool, open, close };
}

test("the watchers stay flat over open, switch and close cycles in the same and in different folders", async () => {
	const { pool, open, close } = setup();
	const kept = dir();
	const keeper = await open(kept);
	const watched = pool.watchedProjects;
	expect(watched).toEqual([keeper.info.cwd]);

	// The same folder as a conversation that stays: its watcher is shared, and stays when the others close.
	for (let i = 0; i < 3; i++) {
		const again = await open(kept);
		expect(pool.watchedProjects).toEqual(watched);
		await close(again);
		expect(pool.watchedProjects).toEqual(watched);
	}

	// A different folder each time: its watcher goes with its last conversation.
	for (let i = 0; i < 3; i++) {
		const elsewhere = await open(dir());
		expect(pool.watchedProjects).toHaveLength(2);
		await close(elsewhere);
		expect(pool.watchedProjects).toEqual(watched);
	}

	// A folder with two conversations keeps its watcher until the second one closes too.
	const other = dir();
	const first = await open(other);
	const second = await open(other);
	expect(pool.watchedProjects).toHaveLength(2);
	await close(first);
	expect(pool.watchedProjects).toHaveLength(2);
	await close(second);
	expect(pool.watchedProjects).toEqual(watched);

	await close(keeper);
	expect(pool.watchedProjects).toEqual([]);
});

test("a conversation that is not switched, or no longer is, does not hold a watcher", async () => {
	const { pool, open, close } = setup();
	const plain = await open(dir(), false);
	expect(pool.watchedProjects).toEqual([]);

	const live = await open(dir());
	expect(pool.watchedProjects).toEqual([live.info.cwd]);
	// Unswitched: the process keeps running, the folder is not watched for it any more.
	delete live.info.models;
	pool.announce(live);
	expect(pool.watchedProjects).toEqual([]);

	live.info.models = switched;
	pool.announce(live);
	expect(pool.watchedProjects).toEqual([live.info.cwd]);
	await close(live);
	await close(plain);
	expect(pool.watchedProjects).toEqual([]);
});
