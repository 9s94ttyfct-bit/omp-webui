import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { LazyFolder } from "../../server/folder-lazy.ts";
import type { FolderListing } from "../../shared/folder.ts";

/**
 * The Files tab's server side, loaded by the first request or watch that names a folder (`folder-lazy.ts`): it answers
 * as the routes it loads do, and a watch is still ended by what ends it when the code was not there yet.
 */

let root: string;
beforeAll(() => {
	root = realpathSync(mkdtempSync(join(tmpdir(), "ompw-folder-lazy-")));
	mkdirSync(join(root, "sub"));
	writeFileSync(join(root, "a.txt"), "hello");
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

const context = (cwd: string | null) => ({
	cwdOf: async () => cwd,
	marks: async () => null,
	changes: async () => ({
		root: cwd ?? "",
		state: "none" as const,
		branch: "",
		files: [],
		truncated: false,
		omitted: 0,
	}),
	diff: async () => null,
	local: true,
});
const cwd = async () => root;
let written = 0;
/** A file made in the watched folder: a change the watch tells of. */
const change = () => writeFileSync(join(root, "sub", `n${written++}.txt`), "x");
/**
 * Waits for `done` (a watch tells of a change after a quarter of a second at the soonest). The bound only stops a
 * watch that never tells: under the parallel suite's load the file event itself can take seconds (#584), so it is the
 * suite's own test timeout less a margin, not a guess at how long a change takes.
 */
async function until(done: () => boolean): Promise<void> {
	const stop = Date.now() + 25_000;
	while (!done() && Date.now() < stop) await sleep(50);
}
/** Long enough for a change to be told twice over, were it told at all. */
const quietFor = () => sleep(700);

describe("the routes", () => {
	test("answer as the loaded routes do", async () => {
		const lazy = new LazyFolder();
		const url = new URL("http://127.0.0.1/api/folder/list?live=L1");
		const listing = (await (await lazy.handle(new Request(url), url, context(root))).json()) as FolderListing;
		expect(listing.root).toBe(root);
		expect(listing.entries.map((e) => e.name)).toEqual(["sub", "a.txt"]);

		const unknown = await lazy.handle(new Request(url), url, context(null));
		expect(unknown.status).toBe(404);
	});

	test("are loaded once for requests that come together", async () => {
		const lazy = new LazyFolder();
		const url = new URL("http://127.0.0.1/api/folder/list?live=L1");
		const answers = await Promise.all(
			[1, 2, 3].map(() => lazy.handle(new Request(url), url, context(root)).then((r) => r.status)),
		);
		expect(answers).toEqual([200, 200, 200]);
	});
});

describe("the watches", () => {
	test("tell a page of a change in a folder it watches, until it is dropped", async () => {
		const lazy = new LazyFolder();
		const owner = {};
		const told: string[] = [];
		await lazy.watch(owner, cwd, ["sub"], (r) => told.push(r));
		change();
		await until(() => told.length > 0);
		expect(told).toEqual([root]);

		lazy.drop(owner);
		told.length = 0;
		change();
		await quietFor();
		expect(told).toEqual([]);
	});

	test("an empty ask that comes first loads nothing and watches nothing", async () => {
		const lazy = new LazyFolder();
		const owner = {};
		const told: string[] = [];
		await lazy.watch(owner, cwd, [], (r) => told.push(r));
		await lazy.watch(owner, cwd, "not a list", (r) => told.push(r));
		lazy.drop(owner);
		change();
		await quietFor();
		expect(told).toEqual([]);
	});

	test("an empty ask that comes while the code is loading is still the newest word", async () => {
		const lazy = new LazyFolder();
		const owner = {};
		const told: string[] = [];
		// The first has to wait for the code; the second, which closes the tab again, comes behind it and must win.
		const first = lazy.watch(owner, cwd, ["sub"], (r) => told.push(r));
		const second = lazy.watch(owner, cwd, [], (r) => told.push(r));
		await Promise.all([first, second]);
		change();
		await quietFor();
		expect(told).toEqual([]);
	});

	test("a socket that ended while the code was loading is given no watch", async () => {
		const lazy = new LazyFolder();
		const owner = {};
		const told: string[] = [];
		let alive = true;
		const asked = lazy.watch(
			owner,
			cwd,
			["sub"],
			(r) => told.push(r),
			() => alive,
		);
		// The page's socket closes: `drop` finds nothing to release yet, and `alive` is what ends the ask.
		alive = false;
		lazy.drop(owner);
		await asked;
		change();
		await quietFor();
		expect(told).toEqual([]);
	});
});
