import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FolderWatches } from "../../server/folder-routes.ts";

/**
 * What a page watches. The page's messages are handled at once, not in order, and a `set` looks up the folder and each
 * path before it watches anything: a socket that closes, or a newer ask, in that time must be the last word.
 */

let root: string;
const DIRS = Array.from({ length: 21 }, (_, i) => `d${i}`);
beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "ompw-watches-")));
	for (const d of DIRS) mkdirSync(join(root, d));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const cwd = async () => root;
const quiet = () => {};
/** A lookup of the conversation's folder that answers when the test says. */
function gate() {
	const { promise, resolve } = Promise.withResolvers<string | null>();
	return { cwdOf: () => promise, open: () => resolve(root) };
}

describe("a set that is still looking things up", () => {
	test("is ended by the owner being dropped: a closed socket watches nothing", async () => {
		const watches = new FolderWatches();
		const owner = {};
		const setting = watches.set(owner, cwd, ["", "d0", "d1"], quiet);
		// The socket closes before the lookups have come back.
		watches.drop(owner);
		await setting;
		expect(watches.size).toBe(0);
	});

	test("is ended by the owner being gone, even when no drop reaches it (the message came after the close)", async () => {
		const watches = new FolderWatches();
		await watches.set({}, cwd, ["", "d0"], quiet, () => false);
		expect(watches.size).toBe(0);
		// Gone while the folder was being looked up.
		const owner = {};
		let alive = true;
		const held = gate();
		const setting = watches.set(owner, held.cwdOf, ["", "d0"], quiet, () => alive);
		alive = false;
		held.open();
		await setting;
		expect(watches.size).toBe(0);
	});

	test("gives way to a newer one: the older ask, which finishes last, does not overwrite it", async () => {
		const watches = new FolderWatches();
		const owner = {};
		const older = gate();
		const first = watches.set(owner, older.cwdOf, ["", ...DIRS.slice(0, 20)], quiet);
		// The newer one is for one folder, and is answered at once.
		await watches.set(owner, cwd, ["d0"], quiet);
		expect(watches.size).toBe(1);
		older.open();
		await first;
		expect(watches.size).toBe(1);
	});

	test("gives way to an empty ask (the tab closed): nothing is watched when it comes back", async () => {
		const watches = new FolderWatches();
		const owner = {};
		const older = gate();
		const first = watches.set(owner, older.cwdOf, ["", "d0", "d1"], quiet);
		await watches.set(owner, cwd, [], quiet);
		older.open();
		await first;
		expect(watches.size).toBe(0);
	});

	test("does not take a number a dropped one had: an older ask is never taken for a newer one", async () => {
		const watches = new FolderWatches();
		const owner = {};
		const older = gate();
		const first = watches.set(owner, older.cwdOf, [...DIRS.slice(0, 5)], quiet);
		watches.drop(owner);
		await watches.set(owner, cwd, ["d0"], quiet);
		expect(watches.size).toBe(1);
		older.open();
		await first;
		expect(watches.size).toBe(1);
	});

	test("one owner's drop does not touch another's", async () => {
		const watches = new FolderWatches();
		const [a, b] = [{}, {}];
		await watches.set(a, cwd, ["d0", "d1"], quiet);
		await watches.set(b, cwd, ["d2"], quiet);
		expect(watches.size).toBe(3);
		watches.drop(a);
		expect(watches.size).toBe(1);
		watches.drop(b);
		expect(watches.size).toBe(0);
	});
});

describe("a set that has found its folder", () => {
	test("watches at most what a page may, and only what is inside the folder", async () => {
		const watches = new FolderWatches();
		const owner = {};
		await watches.set(owner, cwd, [...DIRS, ...Array.from({ length: 80 }, (_, i) => `missing${i}`)], quiet);
		expect(watches.size).toBe(DIRS.length);
		watches.drop(owner);
		await watches.set(owner, cwd, ["..", "/etc", "d0/../../"], quiet);
		expect(watches.size).toBe(0);
	});

	test("a conversation that has no folder is watched for nothing, and what it watched is let go", async () => {
		const watches = new FolderWatches();
		const owner = {};
		await watches.set(owner, cwd, ["d0"], quiet);
		expect(watches.size).toBe(1);
		await watches.set(owner, async () => null, ["d0"], quiet);
		expect(watches.size).toBe(0);
		await watches.set(owner, async () => Promise.reject(new Error("gone")), ["d0"], quiet);
		expect(watches.size).toBe(0);
	});

	test("a newer ask replaces the folders: the ones it does not name are let go", async () => {
		const watches = new FolderWatches();
		const owner = {};
		await watches.set(owner, cwd, ["d0", "d1", "d2"], quiet);
		await watches.set(owner, cwd, ["d2", "d3"], quiet);
		expect(watches.size).toBe(2);
	});
});

describe("a change made as the watch begins", () => {
	test("is told of too: the system may start a watch after the file was made, and the folder is looked at once more", async () => {
		const watches = new FolderWatches();
		const total = 24;
		const told = new Set<number>();
		const owners = Array.from({ length: total }, () => ({}));
		// A folder of its own for each, made now: a fresh watch is the one that can begin late.
		const dirs = owners.map((_, i) => {
			const dir = `late${i}`;
			mkdirSync(join(root, dir));
			return dir;
		});
		await Promise.all(owners.map((owner, i) => watches.set(owner, cwd, [dirs[i]], () => told.add(i))));
		// Straight after `watch` returned, with nothing waited for: the file system may not be listening yet.
		for (const dir of dirs) writeFileSync(join(root, dir, "n.txt"), "x");
		const stop = Date.now() + 10_000;
		while (told.size < total && Date.now() < stop) await new Promise((r) => setTimeout(r, 50));
		for (const owner of owners) watches.drop(owner);
		expect(told.size).toBe(total);
	}, 15_000);
});
