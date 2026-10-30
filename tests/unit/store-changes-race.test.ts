import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../server/sessions/store.ts";
import type { SessionSummary } from "../../shared/protocol.ts";
import { seedFixtures } from "../support/fixtures.ts";

/**
 * A session file that is on disk is in the list the next time the page asks for it, whatever the order of the
 * write and the scan.
 *
 * The list is sent in two parts: the whole list the first time, and only what changed after that (a cursor,
 * `epoch.rev`). What changed is stamped with a revision, and a client is sent the changes that are newer than
 * the revision it holds.
 *
 * The gap this closes: the server answered a request from what it had scanned, and a file written between the
 * client's last request and the server's next scan was not in that answer — the server did not know of it yet,
 * and the client was told that nothing had changed. The file was in the list only when something else made the
 * server look at the library again. The server now looks for the files it does not know and says so, so the page
 * asks again and the conversation is there.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-store-race-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A watcher that is told what happened, so the test drives the store instead of the operating system. */
function fakeWatcher() {
	let listener: ((event: string, name: string | null) => void) | null = null;
	return {
		watch: (_dir: string, _options: unknown, fn: (event: string, name: string | null) => void) => {
			listener = fn;
			return { close: () => undefined, on: () => undefined };
		},
		/** The store's watcher saw a file. */
		saw(name: string) {
			listener?.("rename", name);
		},
	};
}

let n = 0;
/** A session file written into the store's library: its path and its name under the sessions dir. */
function writeSession(dir: string, index: number): { file: string; name: string } {
	const id = `01a00000-0000-7000-8000-00000000e${index}`;
	const name = `2026-06-01T00-00-0${index}-000Z_${id}.jsonl`;
	const file = join(dir, "sessions", "-tmp-ompw-fixture-project", name);
	writeFileSync(
		file,
		`${JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-06-01T00:00:00.000Z", cwd: "/tmp/p" })}\n${JSON.stringify({ type: "message", id: `m${index}`, parentId: null, timestamp: "2026-06-01T00:00:00.000Z", message: { role: "user", content: [{ type: "text", text: "hello" }] } })}\n`,
	);
	return { file, name };
}

/** The store over `dir`, with a watcher the test drives. */
function storeOver(dir: string, watcher: ReturnType<typeof fakeWatcher>) {
	return new SessionStore(join(dir, "sessions"), join(dir, "index.db"), { watch: watcher.watch });
}

/** The list the page holds after the store's answers, applied the way the web UI applies them. */
function apply(held: SessionSummary[], changes: Awaited<ReturnType<SessionStore["changes"]>>): SessionSummary[] {
	if (changes.full) return changes.sessions;
	const gone = new Set(changes.removed);
	const next = new Map(held.filter((s) => !gone.has(s.file)).map((s) => [s.file, s]));
	for (const s of changes.sessions) next.set(s.file, s);
	return [...next.values()];
}

test("a conversation written while the watcher has not seen it yet is in the list the page ends up with", async () => {
	const dir = join(root, `case-${n++}`);
	seedFixtures(dir);
	const watcher = fakeWatcher();
	const store = storeOver(dir, watcher);

	// The page has the list and the cursor that goes with it.
	const first = await store.changes(null);
	expect(first.full).toBe(true);
	expect(first.sessions.length).toBeGreaterThan(0);

	// A conversation is written. The store has not been told: its watcher's event is still on its way.
	const late = writeSession(dir, 2);

	// The page asks for what changed. The store does not know the conversation yet.
	const delta = await store.changes(first.cursor);
	expect(delta.full).toBe(false);

	// The store looks at the library, finds it, and says so: the page is told to ask again.
	const announced = new Promise<void>((resolve) => store.onChange(resolve));
	await announced;

	// The page asks again, and the conversation is in the answer.
	const again = await store.changes(delta.cursor);
	expect(again.sessions.map((s) => s.file)).toContain(late.file);

	// And the list the page holds is the list the server has.
	const held = apply(first.sessions, delta);
	const list = await store.list();
	expect([...apply(held, again).map((s) => s.file)].sort()).toEqual(list.map((s) => s.file).sort());
	store.close();
});

test("a conversation written after the client's last request is in the list the page ends up with", async () => {
	const dir = join(root, `case-${n++}`);
	seedFixtures(dir);
	const watcher = fakeWatcher();
	const store = storeOver(dir, watcher);

	const first = await store.changes(null);
	expect(first.full).toBe(true);

	// The conversation is written and the watcher sees it: the store looks at it with the next scan.
	const late = writeSession(dir, 1);
	watcher.saw(`-tmp-ompw-fixture-project/${late.name}`);

	const delta = await store.changes(first.cursor);
	expect(delta.full).toBe(false);
	expect(delta.sessions.map((s) => s.file)).toContain(late.file);

	// The page asks again with the cursor it has: the conversation is in the list it holds, and it is not sent again.
	const again = await store.changes(delta.cursor);
	expect(again.full).toBe(false);
	expect(again.sessions).toEqual([]);

	// The list the page holds is the list the server has.
	const held = apply(first.sessions, delta);
	expect([...apply(held, again).map((s) => s.file)].sort()).toEqual((await store.list()).map((s) => s.file).sort());
	store.close();
});

test("a conversation written between two requests is never lost, however often the page asks", async () => {
	const dir = join(root, `case-${n++}`);
	seedFixtures(dir);
	const watcher = fakeWatcher();
	const store = storeOver(dir, watcher);

	const first = await store.changes(null);
	const late = writeSession(dir, 3);

	// The page asks again and again. The conversation is in the list it ends up with.
	let held = first.sessions;
	for (let i = 0; i < 3; i++) {
		const delta = await store.changes(first.cursor);
		held = apply(held, delta);
		if (held.some((s) => s.file === late.file)) break;
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	expect(held.some((s) => s.file === late.file)).toBe(true);
	store.close();
});
