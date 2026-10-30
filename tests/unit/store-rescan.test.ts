import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../server/sessions/store.ts";
import { seedFixtures, writeSimpleSession } from "../support/fixtures.ts";

/**
 * The session list is a scan of omp's directory. A watcher says when to scan again; without one, or after a scan that failed,
 * the list must still find its way to what the directory holds, not stay as it was until something else writes there.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-rescan-"));
const stores: SessionStore[] = [];
const undo: (() => void)[] = [];
let warned: ReturnType<typeof spyOn>;
beforeEach(() => {
	// The store says in the log that it cannot watch; that is not the test's output.
	undo.push(() => warned.mockRestore());
	warned = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
	for (const fn of undo.splice(0)) fn();
});
afterAll(() => {
	for (const s of stores) s.close();
	rmSync(root, { recursive: true, force: true });
});

let cases = 0;
function setup() {
	const dir = join(root, `case-${cases++}`);
	seedFixtures(dir);
	return { dir, sessions: join(dir, "sessions"), db: join(dir, "index.db") };
}

test("with no watcher the list is polled: a conversation written later is found and announced", async () => {
	const t = setup();
	// What a machine out of file watches does (inotify's limit, a file system that has none): `watch` throws.
	const store = new SessionStore(t.sessions, t.db, {
		watch: () => {
			throw new Error("ENOSPC: System limit for number of file watchers reached");
		},
		pollMs: 25,
	});
	stores.push(store);
	const first = (await store.list()).length;
	const announced = new Promise<void>((resolve) => store.onChange(resolve));
	writeSimpleSession(t.dir, 0x51, "Written after the first scan");
	await announced;
	const after = await store.list();
	expect(after.length).toBe(first + 1);
	expect(after.some((s) => s.title === "Written after the first scan")).toBe(true);
});

test("a watcher that fails later falls back to polling too", async () => {
	const t = setup();
	let fail: ((e: Error) => void) | undefined;
	const store = new SessionStore(t.sessions, t.db, {
		watch: () => ({
			close() {},
			on(_event, fn) {
				fail = fn;
			},
		}),
		pollMs: 25,
	});
	stores.push(store);
	const first = (await store.list()).length;
	fail?.(new Error("EMFILE: too many open files, watch"));
	const announced = new Promise<void>((resolve) => store.onChange(resolve));
	writeSimpleSession(t.dir, 0x52, "Written after the watcher failed");
	await announced;
	expect((await store.list()).length).toBe(first + 1);
});

// Permissions are no obstacle to root, which is what a container may run as.
test.skipIf(process.getuid?.() === 0)(
	"a scan that failed is tried again by the next request, which reports the failure again, and the list heals",
	async () => {
		const t = setup();
		const store = new SessionStore(t.sessions, t.db);
		stores.push(store);
		const before = (await store.list()).length;

		// A bucket omp cannot be read in: the scan fails (EACCES), as it does for a full or busy database.
		const bucket = join(t.sessions, readdirSync(t.sessions)[0] as string);
		chmodSync(bucket, 0o000);
		undo.push(() => chmodSync(bucket, 0o755));
		await expect(store.refresh(true)).rejects.toThrow();
		// Not once: every request that finds the list stale says so, instead of answering from what it had.
		await expect(store.list()).rejects.toThrow();
		await expect(store.list()).rejects.toThrow();

		chmodSync(bucket, 0o755);
		mkdirSync(join(t.sessions, "-tmp-other"), { recursive: true });
		expect((await store.list()).length).toBe(before);
	},
);
