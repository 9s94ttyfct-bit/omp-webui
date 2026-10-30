import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type Live, LivePool } from "../../server/live.ts";
import { fakeConfig, writeFakeOmp } from "../support/fake-omp.ts";

/** The pool closes surplus idle processes, but never one that is still starting. */

const dirs: string[] = [];
const pools: LivePool[] = [];

afterEach(async () => {
	for (const pool of pools.splice(0)) await pool.shutdown();
	for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("a process started a moment ago is kept however many idle ones are more recently active; once settled it counts", async () => {
	const dir = mkdtempSync(join(tmpdir(), "ompw-starting-"));
	dirs.push(dir);
	const pool = new LivePool(fakeConfig(dir, writeFakeOmp(dir)));
	pools.push(pool);
	// Six processes nobody watches, one per folder (a New chat in the same folder would reuse its unused process):
	// the pool keeps four of them warm.
	const lives: Live[] = [];
	for (let i = 0; i < 6; i++) {
		const cwd = join(dir, `w${i}`);
		mkdirSync(cwd);
		lives.push(await pool.open({ kind: "new", cwd }, async () => null));
	}
	pool.announce(lives[0]);
	expect(lives.filter((l) => l.client.closing)).toEqual([]);

	// Older than any start takes, the two least recently active of them are surplus.
	lives.forEach((l, i) => {
		l.info.startedAt -= 60_000;
		l.lastActivity = Date.now() - (6 - i) * 1000;
	});
	pool.announce(lives[0]);
	expect(lives.filter((l) => l.client.closing).map((l) => lives.indexOf(l))).toEqual([0, 1]);
});
