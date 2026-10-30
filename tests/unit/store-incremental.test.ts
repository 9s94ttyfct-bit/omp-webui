import { afterAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { SessionStore, type StoreOptions } from "../../server/sessions/store.ts";

/**
 * A change to one conversation costs what that conversation does, not what the library is: the scan after it looks at the
 * files the watcher named. What it finds is what a scan of every file finds.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-incremental-"));
const stores: SessionStore[] = [];
afterAll(() => {
	for (const s of stores) s.close();
	rmSync(root, { recursive: true, force: true });
});

const STAMP = "2026-01-09T00:00:00.000Z";
const id = (n: number) => `01a00000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0.001 } };
const turn = (n: number, parentId: string | null, role: "user" | "assistant") =>
	`${JSON.stringify({
		type: "message",
		id: `${role[0]}${n}`,
		parentId,
		timestamp: STAMP,
		message:
			role === "user"
				? { role, content: [{ type: "text", text: `question ${n}` }] }
				: { role, content: [{ type: "text", text: "answer" }], provider: "anthropic", model: "m", usage },
	})}\n`;

interface Library {
	dir: string;
	sessions: string;
	files: string[];
	/** Write conversation `n`; returns its file. */
	write(n: number): string;
	open(options?: StoreOptions): SessionStore;
}

let cases = 0;
/** `count` conversations in buckets of ten. */
function library(count: number): Library {
	const dir = join(root, `case-${cases++}`);
	const sessions = join(dir, "sessions");
	const files: string[] = [];
	const write = (n: number): string => {
		const bucket = join(sessions, `-tmp-p${n % 10}`);
		mkdirSync(bucket, { recursive: true });
		const file = join(bucket, `2026-01-09T00-00-00-000Z_${id(n)}.jsonl`);
		const header = { type: "session", version: 3, id: id(n), timestamp: STAMP, cwd: "/tmp/x" };
		writeFileSync(file, `${JSON.stringify(header)}\n${turn(n, null, "user")}${turn(n, `u${n}`, "assistant")}`);
		return file;
	};
	for (let n = 0; n < count; n++) files.push(write(n));
	const open = (options?: StoreOptions) => {
		const store = new SessionStore(sessions, join(dir, "index.db"), options);
		stores.push(store);
		return store;
	};
	return { dir, sessions, files, write, open };
}

/** Wait for the watcher to announce a change (every write is announced after a short quiet). */
const announced = (store: SessionStore) => new Promise<void>((resolve) => store.onChange(resolve));

/** A watcher that is told what happened, so the test drives the store and not the operating system. */
function fakeWatcher() {
	let listener: ((event: string, name: string | null) => void) | null = null;
	return {
		watch: (_dir: string, _options: unknown, fn: (event: string, name: string | null) => void) => {
			listener = fn;
			return { close: () => undefined, on: () => undefined };
		},
		/** The watcher saw `name` (a path under the sessions dir) change. */
		saw(name: string) {
			listener?.("change", name);
		},
	};
}

/** What a scan of every file says: a store on a copy of the database, which has nothing to go by. */
async function fullScan(t: Library) {
	const fresh = new SessionStore(t.sessions, join(t.dir, `fresh-${cases++}.db`));
	try {
		return await fresh.list();
	} finally {
		fresh.close();
	}
}

test("after a write to one conversation of three hundred, one conversation is looked at", async () => {
	const t = library(300);
	// The watcher is the test's: the operating system's reports the files written just before it was attached too (up to
	// a hundred of the three hundred, when the machine is busy), and the store scans every file it is told of.
	const watcher = fakeWatcher();
	const store = t.open({ watch: watcher.watch });
	await store.refresh();
	const held = (await store.changes(null)).cursor;
	const target = t.files[123] as string;
	appendFileSync(target, turn(900, "a123", "user"));
	watcher.saw(relative(t.sessions, target));

	// The spies are the process's: a store that another test file left open is not this library's cost, so only what is
	// asked of this library's paths is counted.
	const own = (spy: { mock: { calls: unknown[][] } }) =>
		spy.mock.calls.filter(([path]) => String(path).startsWith(t.dir)).length;
	const stat = spyOn(fs, "statSync");
	const dirs = spyOn(fs, "readdirSync");
	const exists = spyOn(fs, "existsSync");
	try {
		// What is measured is this refresh, the scan after the write.
		await store.refresh();
		expect(own(stat)).toBeLessThanOrEqual(3);
		expect(own(dirs) + own(exists)).toBeLessThanOrEqual(6);
	} finally {
		stat.mockRestore();
		dirs.mockRestore();
		exists.mockRestore();
	}
	// It looked at the conversation that was written, and the page is sent that one alone.
	const answer = await store.changes(held);
	expect(answer.full).toBe(false);
	expect(answer.sessions.map((s) => s.file)).toEqual([target]);
});

test("what the scans of single files find is what a scan of every file finds", async () => {
	const t = library(40);
	const store = t.open();
	const before = await store.list();
	expect(before.length).toBe(40);
	const cursor = (await store.changes(null)).cursor;

	// A conversation grows; its subagent writes; another is created in a bucket that did not exist; one is removed.
	const target = t.files[7] as string;
	const parent = t.files[0] as string;
	const gone = t.files[9] as string;
	let changed = announced(store);
	appendFileSync(target, turn(901, "a7", "user") + turn(901, "u901", "assistant"));
	const artifacts = parent.replace(/\.jsonl$/, "");
	mkdirSync(artifacts, { recursive: true });
	writeFileSync(join(artifacts, "Scout.jsonl"), turn(902, null, "user") + turn(902, "u902", "assistant"));
	await changed;
	const seen = await store.changes(cursor);
	expect(seen.full).toBe(false);
	// Only what changed is in the answer: the conversation that grew and the one whose subagent wrote.
	expect(seen.sessions.map((s) => s.file).sort()).toEqual([parent, target].sort());
	expect(seen.sessions.find((s) => s.file === parent)?.subagentCount).toBe(1);
	expect(seen.sessions.find((s) => s.file === target)?.messageCount).toBe(4);

	changed = announced(store);
	const created = t.write(500);
	rmSync(gone);
	await changed;
	const later = await store.changes(seen.cursor);
	expect(later.full).toBe(false);
	expect(later.sessions.map((s) => s.file)).toEqual([created]);
	expect(later.removed).toEqual([gone]);

	const scanned = await fullScan(t);
	expect((await store.list()).map((s) => [s.file, s.messageCount, s.subagentCount, s.usage.requests])).toEqual(
		scanned.map((s) => [s.file, s.messageCount, s.subagentCount, s.usage.requests]),
	);
	// The full-text index followed: the new conversation is searchable, the removed one is not.
	await store.indexed();
	expect((await store.search("question 500")).map((h) => h.file)).toEqual([created]);
	expect(await store.search("question 9")).not.toContainEqual(expect.objectContaining({ file: gone }));
});
