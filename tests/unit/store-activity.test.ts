import { afterAll, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { SessionStore } from "../../server/sessions/store.ts";
import { removeScratch } from "../support/scratch.ts";

/** A conversation is dated by its last message, so renaming one (omp rewrites the file) does not move it (#359). */

const root = mkdtempSync(join(tmpdir(), "ompw-activity-"));
const stores: SessionStore[] = [];
afterAll(() => {
	for (const s of stores) s.close();
	removeScratch(root);
});

const id = (n: number) => `01a00000-0000-7000-8000-${n.toString(16).padStart(12, "0")}`;
const message = (n: number, at: string, role: "user" | "assistant") =>
	`${JSON.stringify({
		type: "message",
		id: `${role[0]}${n}-${at}`,
		parentId: null,
		timestamp: at,
		message: { role, content: [{ type: "text", text: `${role} ${n}` }] },
	})}\n`;

let cases = 0;
function open(files: { n: number; at: string }[]) {
	const dir = join(root, `case-${cases++}`);
	const sessions = join(dir, "sessions");
	mkdirSync(join(sessions, "-tmp-p"), { recursive: true });
	const paths = files.map(({ n, at }) => {
		const file = join(sessions, "-tmp-p", `2026-01-01T00-00-00-000Z_${id(n)}.jsonl`);
		const header = { type: "session", version: 3, id: id(n), timestamp: at, cwd: "/tmp/x" };
		writeFileSync(file, `${JSON.stringify(header)}\n${message(n, at, "user")}`);
		return file;
	});
	// The watcher is the test's: the store scans the files it is told about.
	let saw: (name: string) => void = () => undefined;
	const watch = (_dir: string, _options: unknown, fn: (event: string, name: string | null) => void) => {
		saw = (name) => fn("change", name);
		return { close: () => undefined, on: () => undefined };
	};
	const store = new SessionStore(sessions, join(dir, "index.db"), { watch });
	stores.push(store);
	return { store, paths, changed: (file: string) => saw(relative(sessions, file)) };
}

test("a conversation is dated by its newest message, and what omp writes at a rename does not move it", async () => {
	const { store, paths, changed } = open([
		{ n: 1, at: "2026-01-02T10:00:00.000Z" },
		{ n: 2, at: "2026-01-05T10:00:00.000Z" },
	]);
	const [older, newer] = paths as [string, string];
	// The files' own times are all "now", as after a restore or a sync.
	const now = new Date();
	for (const p of paths) utimesSync(p, now, now);
	const first = await store.list();
	expect(first.map((s) => [s.file, s.modifiedAt])).toEqual([
		[newer, Date.parse("2026-01-05T10:00:00.000Z")],
		[older, Date.parse("2026-01-02T10:00:00.000Z")],
	]);

	// A rename: omp rewrites the title and appends a `title_change` and, closing, a `session_exit` record, both stamped now.
	const stamp = new Date().toISOString();
	appendFileSync(
		older,
		`${JSON.stringify({ type: "title_change", id: "t1", parentId: null, timestamp: stamp, title: "Renamed" })}\n` +
			`${JSON.stringify({ type: "custom", id: "x1", parentId: null, timestamp: stamp, customType: "session_exit", data: { reason: "dispose" } })}\n`,
	);
	changed(older);
	await store.refresh();
	const renamed = await store.list();
	// The store did read the rename (the file's own time moved with it), and the order stands.
	expect(renamed.find((s) => s.file === older)?.title).toBe("Renamed");
	expect(renamed.map((s) => s.file)).toEqual([newer, older]);
	expect(renamed.find((s) => s.file === older)?.modifiedAt).toBe(Date.parse("2026-01-02T10:00:00.000Z"));

	// A message does move it, to the top.
	appendFileSync(older, message(1, "2026-01-09T10:00:00.000Z", "assistant"));
	changed(older);
	await store.refresh();
	const said = await store.list();
	expect(said.map((s) => s.file)).toEqual([older, newer]);
	expect(said[0]?.modifiedAt).toBe(Date.parse("2026-01-09T10:00:00.000Z"));
});

test("a conversation with no message is dated by its header, not by its file", async () => {
	const { store, paths } = open([{ n: 3, at: "2026-01-03T10:00:00.000Z" }]);
	writeFileSync(
		paths[0] as string,
		`${JSON.stringify({ type: "session", version: 3, id: id(3), timestamp: "2026-01-03T10:00:00.000Z", cwd: "/tmp/x" })}\n`,
	);
	expect((await store.list())[0]?.modifiedAt).toBe(Date.parse("2026-01-03T10:00:00.000Z"));
});
