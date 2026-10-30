import { afterAll, afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
	appendFileSync,
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { canonical, profileAgentDir, profileSessionsDir, SessionRoots } from "../../server/sessions/roots.ts";
import { SessionStore } from "../../server/sessions/store.ts";
import { writeSimpleSession } from "../support/fixtures.ts";
import { appendCall, writeTranscript } from "../support/subagent-fixtures.ts";

/**
 * A conversation started with `--session-dir <dir>` or `--profile <name>` keeps its transcript outside omp's own agent
 * directory: in the folder the user named, or in the profile's own agent directory. The server remembers the folders it
 * has started omp with, so that those conversations are listed, searched and reopened like the others, instead of
 * running and then being lost to the page.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-roots-"));
const stores: SessionStore[] = [];
let warned: ReturnType<typeof spyOn>;
beforeEach(() => {
	// The store says in the log that it cannot watch; that is not the test's output.
	warned = spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => warned.mockRestore());
afterAll(() => {
	for (const s of stores) s.close();
	rmSync(root, { recursive: true, force: true });
});

let cases = 0;
/** A world of its own: a data dir (where the roots are kept), a home (where the profiles are) and an agent dir. */
function world() {
	const dir = join(root, `case-${cases++}`);
	const home = join(dir, "home");
	const agentDir = join(home, ".omp", "agent");
	const dataDir = join(dir, "data");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(dataDir, { recursive: true });
	return { dir, home, agentDir, dataDir, sessions: join(agentDir, "sessions") };
}

/** A store that reads the sessions dir and the roots the registry knows. */
function store(w: ReturnType<typeof world>, roots: SessionRoots): SessionStore {
	const s = new SessionStore(w.sessions, join(w.dataDir, "index.db"), {}, () => roots.folders());
	stores.push(s);
	return s;
}

/** A watcher that is told what happened, so the test drives the store instead of the operating system. */
function fakeWatcher() {
	const listeners = new Map<string, (event: string, name: string | null) => void>();
	return {
		watch: (dir: string, _options: unknown, fn: (event: string, name: string | null) => void) => {
			listeners.set(dir, fn);
			return { close: () => undefined, on: () => undefined };
		},
		/** The store's watcher of the folder `dir` saw `name`, a path relative to it. */
		saw(dir: string, name: string) {
			const listener = listeners.get(dir);
			if (!listener) throw new Error(`the store watches no folder ${dir}`);
			listener("rename", name);
		},
	};
}

/** A store over the sessions dir and the folders the registry knows, whose watchers `watcher` drives. */
function watchedStore(w: ReturnType<typeof world>, roots: SessionRoots, watcher: ReturnType<typeof fakeWatcher>) {
	const s = new SessionStore(w.sessions, join(w.dataDir, "index.db"), { watch: watcher.watch }, () => roots.folders());
	stores.push(s);
	return s;
}

test("the folder a --session-dir names is remembered, and the conversation in it is listed", async () => {
	const w = world();
	const roots = new SessionRoots(w.dataDir, w.home, w.agentDir);
	const elsewhere = join(w.dir, "elsewhere");
	mkdirSync(elsewhere, { recursive: true });

	// Before the flag is used, the folder is not one the server looks in.
	const before = store(w, roots);
	expect(await before.list()).toHaveLength(0);

	roots.note([`--session-dir=${elsewhere}`], w.dir);
	const after = store(w, roots);
	// A conversation in the flat layout omp writes into a --session-dir: the file is in the folder itself.
	const file = join(elsewhere, "2026-01-09T00-00-00-000Z_01a00000-0000-7000-8000-0000000000aa.jsonl");
	writeFileSync(
		file,
		[
			JSON.stringify({ type: "title", v: 1, title: "", updatedAt: "2026-01-09T00:00:00.000Z" }),
			JSON.stringify({
				type: "session",
				version: 3,
				id: "01a00000-0000-7000-8000-0000000000aa",
				timestamp: "2026-01-09T00:00:00.000Z",
				cwd: w.dir,
			}),
			JSON.stringify({
				type: "message",
				id: "e1",
				parentId: null,
				timestamp: "2026-01-09T00:00:01.000Z",
				message: { role: "user", content: [{ type: "text", text: "in another folder" }] },
			}),
			"",
		].join("\n"),
	);
	const list = await after.list();
	// The file is listed under the path it really is at (a link in the path is resolved).
	expect(list.map((s) => s.file)).toContain(realpathSync(file));
	// And it can be reopened: the server serves the file, not just names it.
	expect(after.resolveSessionPath(file)).toBe(realpathSync(file));
});

test("a profile's own agent directory is remembered, and its conversation is listed", async () => {
	const w = world();
	const roots = new SessionRoots(w.dataDir, w.home, w.agentDir);
	roots.note(["--profile=work"], w.dir);
	expect(roots.list().map((r) => r.dir)).toEqual([profileSessionsDir("work", w.home)]);

	// A profile keeps its conversations in buckets under its own agent directory.
	const bucket = join(profileSessionsDir("work", w.home), "-tmp-project");
	mkdirSync(bucket, { recursive: true });
	const file = join(bucket, "2026-01-09T00-00-00-000Z_01a00000-0000-7000-8000-0000000000bb.jsonl");
	writeFileSync(
		file,
		[
			JSON.stringify({ type: "title", v: 1, title: "", updatedAt: "2026-01-09T00:00:00.000Z" }),
			JSON.stringify({
				type: "session",
				version: 3,
				id: "01a00000-0000-7000-8000-0000000000bb",
				timestamp: "2026-01-09T00:00:00.000Z",
				cwd: w.dir,
			}),
			"",
		].join("\n"),
	);
	const s = store(w, roots);
	const list = await s.list();
	expect(list.map((x) => x.file)).toContain(realpathSync(file));
	expect(s.resolveSessionPath(file)).toBe(realpathSync(file));
});

test("a profile's conversation is resumed with its own profile, and its images are read from there", () => {
	const w = world();
	const roots = new SessionRoots(w.dataDir, w.home, w.agentDir);
	roots.note(["--profile=work"], w.dir);
	const file = join(profileSessionsDir("work", w.home), "-tmp-project", "a.jsonl");
	// The flags omp must be started with: the profile, whose auth, settings and images are its own.
	expect(roots.flagsFor(file)).toEqual(["--profile=work"]);
	// And the agent directory that belongs to it.
	expect(roots.agentDirFor(file)).toBe(profileAgentDir("work", w.home));
});

test("a conversation in a named session directory is resumed with that directory", () => {
	const w = world();
	const elsewhere = join(w.dir, "elsewhere");
	const roots = new SessionRoots(w.dataDir, w.home, w.agentDir);
	roots.note([`--session-dir=${elsewhere}`], w.dir);
	const file = join(elsewhere, "a.jsonl");
	expect(roots.flagsFor(file)).toEqual([`--session-dir=${canonical(elsewhere)}`]);
	// Its images are the server's own: only the transcripts move.
	expect(roots.agentDirFor(file)).toBe(w.agentDir);
});

test("a conversation of the server's own folder is resumed without any of those flags", () => {
	const w = world();
	const roots = new SessionRoots(w.dataDir, w.home, w.agentDir);
	const file = join(w.sessions, "-tmp", "a.jsonl");
	expect(roots.flagsFor(file)).toEqual([]);
	expect(roots.agentDirFor(file)).toBe(w.agentDir);
});

test("the roots survive a restart: they are written down in the server's own data dir", () => {
	const w = world();
	const elsewhere = join(w.dir, "elsewhere");
	const first = new SessionRoots(w.dataDir, w.home, w.agentDir);
	first.note([`--session-dir=${elsewhere}`], w.dir);
	first.note(["--profile=work"], w.dir);

	// A server that starts later reads them from the file.
	const second = new SessionRoots(w.dataDir, w.home, w.agentDir);
	expect(
		second
			.list()
			.map((r) => r.dir)
			.sort(),
	).toEqual([canonical(elsewhere), profileSessionsDir("work", w.home)].sort());
	// The file is written whole, and privately: it names the user's own folders.
	const written = JSON.parse(readFileSync(join(w.dataDir, "session-roots.json"), "utf8"));
	expect(written.roots).toHaveLength(2);
});

test("a conversation outside every known folder is still refused", async () => {
	const w = world();
	const roots = new SessionRoots(w.dataDir, w.home, w.agentDir);
	const stranger = join(w.dir, "stranger");
	mkdirSync(stranger, { recursive: true });
	const file = join(stranger, "2026-01-09T00-00-00-000Z_01a00000-0000-7000-8000-0000000000cc.jsonl");
	writeFileSync(file, "{}\n");
	const s = store(w, roots);
	expect(s.resolveSessionPath(file)).toBeNull();
	// A file that is not a session file is refused too.
	const other = join(w.sessions, "not-a-session.txt");
	mkdirSync(w.sessions, { recursive: true });
	writeFileSync(other, "x");
	expect(s.resolveSessionPath(other)).toBeNull();
});

test("a flag that names nothing is not a folder", () => {
	const w = world();
	const roots = new SessionRoots(w.dataDir, w.home, w.agentDir);
	// An empty value: there is no folder to look in.
	roots.note(["--session-dir=", "--profile="], w.dir);
	expect(roots.list()).toHaveLength(0);
});

test("a root that is not there yet does not make the list fail", async () => {
	const w = world();
	const roots = new SessionRoots(w.dataDir, w.home, w.agentDir);
	roots.note([`--session-dir=${join(w.dir, "not-made-yet")}`], w.dir);
	const s = store(w, roots);
	expect(await s.list()).toHaveLength(0);
});

test("the same root twice is one root, and the newest use is what it remembers", () => {
	const w = world();
	const elsewhere = join(w.dir, "elsewhere");
	const roots = new SessionRoots(w.dataDir, w.home, w.agentDir);
	roots.note([`--session-dir=${elsewhere}`], w.dir);
	roots.note([`--session-dir=${elsewhere}`], w.dir);
	expect(roots.list()).toHaveLength(1);
});

test("a conversation written in a folder the server knows is found without a scan of everything", async () => {
	const w = world();
	const elsewhere = join(w.dir, "elsewhere");
	mkdirSync(elsewhere, { recursive: true });
	const roots = new SessionRoots(w.dataDir, w.home, w.agentDir);
	roots.note([`--session-dir=${elsewhere}`], w.dir);
	const watcher = fakeWatcher();
	const s = watchedStore(w, roots, watcher);
	expect(await s.list()).toHaveLength(0);
	// The conversation is written after the first scan: the watcher of that folder says so, and that is the one file
	// the next scan looks at (not every file of the library).
	const file = join(elsewhere, "2026-01-09T00-00-00-000Z_01a00000-0000-7000-8000-0000000000dd.jsonl");
	writeFileSync(
		file,
		[
			JSON.stringify({ type: "title", v: 1, title: "", updatedAt: "2026-01-09T00:00:00.000Z" }),
			JSON.stringify({
				type: "session",
				version: 3,
				id: "01a00000-0000-7000-8000-0000000000dd",
				timestamp: "2026-01-09T00:00:00.000Z",
				cwd: w.dir,
			}),
			"",
		].join("\n"),
	);
	watcher.saw(canonical(elsewhere), basename(file));
	expect((await s.list()).map((x) => x.file)).toContain(realpathSync(file));
});

test("a conversation in the server's own folder is still listed, with the others", async () => {
	const w = world();
	const roots = new SessionRoots(w.dataDir, w.home, w.agentDir);
	roots.note([`--session-dir=${join(w.dir, "elsewhere")}`], w.dir);
	mkdirSync(join(w.agentDir, "sessions", "-tmp-ompw-fixture-project"), { recursive: true });
	writeSimpleSession(w.agentDir, 0x21, "In the own folder");
	const s = store(w, roots);
	const list = await s.list();
	expect(list.map((x) => x.title)).toContain("In the own folder");
});

test("a relative --session-dir is a folder of the conversation's own folder, as omp reads it", () => {
	const w = world();
	const roots = new SessionRoots(w.dataDir, w.home, w.agentDir);
	const cwd = join(w.dir, "project");
	mkdirSync(cwd, { recursive: true });
	roots.note(["--session-dir=sessions"], cwd);
	roots.note(["--session-dir=../shared-sessions"], cwd);
	// omp does not expand `~`: it makes the folder `~` under the one it runs in.
	roots.note(["--session-dir=~/sessions"], cwd);
	expect(roots.list().map((r) => r.dir)).toEqual(
		expect.arrayContaining([
			canonical(join(cwd, "sessions")),
			canonical(join(w.dir, "shared-sessions")),
			canonical(join(cwd, "~", "sessions")),
		]),
	);
	expect(roots.list()).toHaveLength(3);
});

const DAY = 24 * 60 * 60 * 1000;

/** A conversation file as omp writes it into a `--session-dir`: flat, `<dir>/<name>.jsonl`. */
function flatSession(dir: string, n: number): string {
	const id = `01a00000-0000-7000-8000-0000000001${n.toString(16).padStart(2, "0")}`;
	const file = join(dir, `2026-01-09T00-00-${String(n).padStart(2, "0")}-000Z_${id}.jsonl`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		file,
		[
			JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-09T00:00:00.000Z", cwd: "/tmp/p" }),
			JSON.stringify({
				type: "message",
				id: `m${n}`,
				parentId: null,
				timestamp: "2026-01-09T00:00:01.000Z",
				message: { role: "user", content: [{ type: "text", text: "hello" }] },
			}),
			"",
		].join("\n"),
	);
	return file;
}

test("a folder that holds conversations stays a root, however long ago it was used", async () => {
	const w = world();
	const roots = new SessionRoots(w.dataDir, w.home, w.agentDir);
	const kept = join(w.dir, "kept");
	const file = flatSession(kept, 1);
	// Used eight days ago, and not since: a month of work in it would look the same to the server.
	roots.add({ dir: kept, kind: "session-dir", name: kept, agentDir: w.agentDir, usedAt: Date.now() - 8 * DAY });
	// Another root is added, which is when the old ones used to be forgotten.
	roots.note(["--profile=work"], w.dir);
	expect(roots.list().map((r) => r.dir)).toContain(canonical(kept));
	expect(new SessionRoots(w.dataDir, w.home, w.agentDir).list().map((r) => r.dir)).toContain(canonical(kept));

	const s = store(w, roots);
	expect((await s.list()).map((x) => x.file)).toContain(realpathSync(file));
	expect(s.resolveSessionPath(file)).toBe(realpathSync(file));
});

test("a folder that holds nothing and has not been used for a week is forgotten, a new one is not", () => {
	const w = world();
	const roots = new SessionRoots(w.dataDir, w.home, w.agentDir);
	const empty = join(w.dir, "empty");
	mkdirSync(empty, { recursive: true });
	roots.add({ dir: empty, kind: "session-dir", name: empty, agentDir: w.agentDir, usedAt: Date.now() - 8 * DAY });
	// The folder omp has not written its first conversation to yet is not made yet: it is just new, and stays.
	roots.note([`--session-dir=${join(w.dir, "not-made-yet")}`], w.dir);
	roots.note(["--profile=work"], w.dir);
	expect(roots.list().map((r) => r.dir)).not.toContain(canonical(empty));
	expect(roots.list().map((r) => r.dir)).toContain(canonical(join(w.dir, "not-made-yet")));
});

test("a roots file that cannot be read is kept aside, and the roots in it are not written over", () => {
	const w = world();
	const first = new SessionRoots(w.dataDir, w.home, w.agentDir);
	first.note([`--session-dir=${join(w.dir, "one")}`], w.dir);
	const file = join(w.dataDir, "session-roots.json");
	const text = readFileSync(file, "utf8");
	// Unreadable for a reason that is not "no such file": a directory stands where the file is.
	rmSync(file);
	mkdirSync(file);
	writeFileSync(join(file, "was-here"), text);

	const second = new SessionRoots(w.dataDir, w.home, w.agentDir);
	second.note(["--profile=work"], w.dir);
	expect(readFileSync(join(`${file}.broken`, "was-here"), "utf8")).toBe(text);
	expect(JSON.parse(readFileSync(file, "utf8")).roots).toHaveLength(1);
});

/** A store over a flat folder that holds one conversation with a subagent and an advisor transcript. */
function flatFolderWithArtifacts() {
	const w = world();
	const roots = new SessionRoots(w.dataDir, w.home, w.agentDir);
	const dir = join(w.dir, "flat");
	const file = flatSession(dir, 5);
	const artifacts = file.replace(/\.jsonl$/, "");
	writeTranscript(join(artifacts, "0-Scout.jsonl"), [7]);
	writeTranscript(join(artifacts, "__advisor.jsonl"), [3]);
	roots.note([`--session-dir=${dir}`], w.dir);
	return { w, roots, dir, file: realpathSync(file), scout: join(realpathSync(artifacts), "0-Scout.jsonl") };
}

test("a flat folder lists its conversations, not the subagent and advisor transcripts in their artifacts folders", async () => {
	const { w, roots, file } = flatFolderWithArtifacts();
	const s = store(w, roots);
	const list = await s.list();
	expect(list.map((x) => x.file)).toEqual([file]);
	// They are counted once, as the conversation's own subagent and advisor share.
	expect(list[0]?.subagentCount).toBe(1);
	expect(list[0]?.subagentUsage.requests).toBe(1);
	expect(list[0]?.advisorUsage.requests).toBe(1);
});

test("a subagent that writes in a flat folder changes its conversation, and the conversation's totals follow", async () => {
	const { w, roots, dir, file, scout } = flatFolderWithArtifacts();
	const watcher = fakeWatcher();
	const s = watchedStore(w, roots, watcher);
	const first = await s.changes(null);
	expect(first.sessions.find((x) => x.file === file)?.subagentUsage.requests).toBe(1);

	appendCall(scout, 9);
	watcher.saw(canonical(dir), `${basename(file, ".jsonl")}/0-Scout.jsonl`);
	const delta = await s.changes(first.cursor);
	// The conversation is what changed, with the subagent's new request in its totals; the transcript is no session.
	expect(delta.sessions.map((x) => x.file)).toEqual([file]);
	expect(delta.sessions[0]?.subagentUsage.requests).toBe(2);
	expect(delta.removed).toEqual([]);
});

test("a conversation written into a folder the server knows, whose event has not arrived, is found by the look", async () => {
	const w = world();
	const roots = new SessionRoots(w.dataDir, w.home, w.agentDir);
	const flat = join(w.dir, "flat");
	mkdirSync(flat, { recursive: true });
	roots.note([`--session-dir=${flat}`, "--profile=work"], w.dir);
	const bucket = join(profileSessionsDir("work", w.home), "-tmp-project");
	mkdirSync(bucket, { recursive: true });
	const watcher = fakeWatcher();
	const s = watchedStore(w, roots, watcher);
	const first = await s.changes(null);
	expect(first.sessions).toHaveLength(0);

	// Written, and the watchers have said nothing: the store asks, finds nothing to send, and looks for itself.
	const inFlat = realpathSync(flatSession(flat, 6));
	const inProfile = realpathSync(flatSession(bucket, 7));
	const announced = new Promise<void>((resolve) => s.onChange(resolve));
	await s.changes(first.cursor);
	await announced;
	const again = await s.changes(first.cursor);
	expect(again.sessions.map((x) => x.file).sort()).toEqual([inFlat, inProfile].sort());
	expect(existsSync(inFlat)).toBe(true);
});

/** A `--session-dir` value that names something that is not a readable folder: a file, or a folder without permission. */
function badRoot(w: ReturnType<typeof world>): string {
	const file = join(w.dir, "not-a-folder.txt");
	writeFileSync(file, "x\n");
	return file;
}

test("a root that cannot be read does not take the library down: the other conversations are still listed", async () => {
	const w = world();
	const roots = new SessionRoots(w.dataDir, w.home, w.agentDir);
	// A conversation of the server's own folder, which must still be listed.
	mkdirSync(join(w.agentDir, "sessions", "-tmp-ompw-fixture-project"), { recursive: true });
	writeSimpleSession(w.agentDir, 0x31, "In the own folder");
	// And a root that is a file, not a folder.
	roots.add({ dir: badRoot(w), kind: "session-dir", name: badRoot(w), agentDir: w.agentDir });

	const s = store(w, roots);
	const list = await s.list();
	expect(list.map((x) => x.title)).toContain("In the own folder");
});

test("a root that cannot be read is said once, and the library is still listed", async () => {
	const w = world();
	const roots = new SessionRoots(w.dataDir, w.home, w.agentDir);
	roots.add({ dir: badRoot(w), kind: "session-dir", name: badRoot(w), agentDir: w.agentDir });
	const s = store(w, roots);
	await s.list();
	await s.list();
	// Said once, not on every request: the log of a working server does not grow with the number of polls.
	const said = warned.mock.calls.filter((c: unknown[]) => String(c[0]).includes("not-a-folder.txt"));
	expect(said).toHaveLength(1);
});

test("a --session-dir that names a file is not remembered as a folder of conversations", () => {
	const w = world();
	const roots = new SessionRoots(w.dataDir, w.home, w.agentDir);
	const file = badRoot(w);
	roots.note([`--session-dir=${file}`], w.dir);
	expect(roots.list()).toHaveLength(0);
});

test("a root that cannot be read is not kept for ever", () => {
	const w = world();
	const roots = new SessionRoots(w.dataDir, w.home, w.agentDir);
	const file = badRoot(w);
	// Remembered by an earlier version, and used eight days ago.
	roots.add({ dir: file, kind: "session-dir", name: file, agentDir: w.agentDir, usedAt: Date.now() - 8 * DAY });
	// Another root is added, which is when the old ones are pruned.
	roots.note(["--profile=work"], w.dir);
	expect(roots.list().map((r) => r.dir)).not.toContain(canonical(file));
});

test("a folder that stops being readable keeps its conversations in the list, and the others are listed as before", async () => {
	const w = world();
	const roots = new SessionRoots(w.dataDir, w.home, w.agentDir);
	const locked = join(w.dir, "locked");
	const file = realpathSync(flatSession(locked, 8));
	roots.note([`--session-dir=${locked}`], w.dir);
	mkdirSync(join(w.agentDir, "sessions", "-tmp-ompw-fixture-project"), { recursive: true });
	writeSimpleSession(w.agentDir, 0x32, "In the own folder");
	const s = store(w, roots);
	expect((await s.list()).map((x) => x.file)).toContain(file);

	chmodSync(locked, 0o000);
	try {
		await s.refresh(true);
		const list = await s.list();
		// The permission may come back: what is known of the folder is not dropped, and the library is not taken down.
		expect(list.map((x) => x.file)).toContain(file);
		expect(list.map((x) => x.title)).toContain("In the own folder");
	} finally {
		chmodSync(locked, 0o755);
	}
});

test("a root whose folder is made after the store started is watched once it is there, and its later writes are seen", async () => {
	const w = world();
	const roots = new SessionRoots(w.dataDir, w.home, w.agentDir);
	// Noted before omp has written its first conversation: the folder is not made yet.
	const later = join(w.dir, "made-later");
	roots.note([`--session-dir=${later}`], w.dir);
	mkdirSync(join(w.agentDir, "sessions", "-tmp-ompw-fixture-project"), { recursive: true });
	writeSimpleSession(w.agentDir, 0x33, "In the own folder");
	const watcher = fakeWatcher();
	const s = watchedStore(w, roots, watcher);
	const first = await s.changes(null);

	// omp makes the folder with its first write; the next request finds the conversation.
	const file = realpathSync(flatSession(later, 9));
	const second = await s.changes(first.cursor);
	expect(second.sessions.map((x) => x.file)).toContain(file);
	expect(second.sessions.find((x) => x.file === file)?.messageCount).toBe(1);

	// The conversation goes on: its later writes come by the folder's watcher, which must be attached by now.
	appendFileSync(
		file,
		`${JSON.stringify({ type: "message", id: "m-late", parentId: "m9", timestamp: "2026-01-09T00:00:02.000Z", message: { role: "user", content: [{ type: "text", text: "and more" }] } })}\n`,
	);
	watcher.saw(canonical(later), basename(file));
	const third = await s.changes(second.cursor);
	expect(third.sessions.find((x) => x.file === file)?.messageCount).toBe(2);
});

test("a root that cannot be watched is left out of the watchers, and the rest of the library keeps them", async () => {
	const w = world();
	const roots = new SessionRoots(w.dataDir, w.home, w.agentDir);
	// A root the server may not read: `fs.watch` on it throws (EACCES).
	const locked = join(w.dir, "locked");
	mkdirSync(locked, { recursive: true });
	roots.note([`--session-dir=${locked}`], w.dir);
	mkdirSync(join(w.agentDir, "sessions", "-tmp-ompw-fixture-project"), { recursive: true });
	writeSimpleSession(w.agentDir, 0x34, "In the own folder");
	chmodSync(locked, 0o000);
	const watched: string[] = [];
	const watcher = fakeWatcher();
	const s = new SessionStore(
		w.sessions,
		join(w.dataDir, "index.db"),
		{
			watch: (dir, options, fn) => {
				// A folder the server may not read cannot be watched: the real `fs.watch` throws EACCES there.
				if (dir === canonical(locked)) {
					const e = new Error(`EACCES: permission denied, watch '${dir}'`) as NodeJS.ErrnoException;
					e.code = "EACCES";
					throw e;
				}
				watched.push(dir);
				return watcher.watch(dir, options, fn);
			},
		},
		() => roots.folders(),
	);
	stores.push(s);
	try {
		// The library is listed, and the other folders keep their watchers.
		expect((await s.list()).map((x) => x.title)).toContain("In the own folder");
		expect(watched).toContain(w.sessions);
		// The library is not put on the 3 s poller for one root that cannot be watched.
		expect((s as unknown as { poller?: unknown }).poller).toBeUndefined();
		// The warning names the root that could not be watched, and not omp's own folder.
		expect(warned.mock.calls.some((c: unknown[]) => String(c[0]).includes(w.sessions))).toBe(false);
		// Said once, not on every request: the log of a working server does not grow with the number of polls.
		await s.refresh(true);
		await s.list();
		const said = warned.mock.calls.filter((c: unknown[]) => String(c[0]).includes("cannot be watched"));
		expect(said).toHaveLength(1);
		// And it names the root that could not be watched.
		expect(String(said[0]?.[0])).toContain("locked");
	} finally {
		chmodSync(locked, 0o755);
	}
});

test("a root that cannot be watched does not make the library rescan everything on every request", async () => {
	const w = world();
	const roots = new SessionRoots(w.dataDir, w.home, w.agentDir);
	const locked = join(w.dir, "locked");
	mkdirSync(locked, { recursive: true });
	roots.note([`--session-dir=${locked}`], w.dir);
	// omp's own folder is there and is watched, as it is on any server that has a conversation.
	mkdirSync(join(w.agentDir, "sessions", "-tmp-ompw-fixture-project"), { recursive: true });
	const watcher = fakeWatcher();
	const s = new SessionStore(
		w.sessions,
		join(w.dataDir, "index.db"),
		{
			watch: (dir, options, fn) => {
				if (dir === canonical(locked)) {
					const e = new Error(`EACCES: permission denied, watch '${dir}'`) as NodeJS.ErrnoException;
					e.code = "EACCES";
					throw e;
				}
				return watcher.watch(dir, options, fn);
			},
		},
		() => roots.folders(),
	);
	stores.push(s);
	await s.list();
	expect((s as unknown as { poller?: unknown }).poller).toBeUndefined();

	// A conversation written in omp's own folder, without the watcher saying so: only a scan of everything finds it.
	// The path is the one the store knows it by (its sessions dir is not resolved).
	const quiet = writeSimpleSession(w.agentDir, 0x35, "Written quietly");
	expect((await s.list()).map((x) => x.file)).not.toContain(quiet);
});

test("a watch that fails for any other reason puts the library on the poller, as it does for omp's own folder", async () => {
	const w = world();
	const roots = new SessionRoots(w.dataDir, w.home, w.agentDir);
	const extra = join(w.dir, "extra-root");
	mkdirSync(extra, { recursive: true });
	roots.note([`--session-dir=${extra}`], w.dir);
	mkdirSync(join(w.agentDir, "sessions", "-tmp-ompw-fixture-project"), { recursive: true });
	const watcher = fakeWatcher();
	const s = new SessionStore(
		w.sessions,
		join(w.dataDir, "index.db"),
		{
			watch: (dir, options, fn) => {
				// The limit on watches is reached: not a permission, so the library is polled instead.
				if (dir === canonical(extra)) {
					const e = new Error("ENOSPC: no space left on device, watch") as NodeJS.ErrnoException;
					e.code = "ENOSPC";
					throw e;
				}
				return watcher.watch(dir, options, fn);
			},
		},
		() => roots.folders(),
	);
	stores.push(s);
	await s.list();
	// The whole library is read again every few seconds, which is what the poller is for.
	expect((s as unknown as { poller?: unknown }).poller).toBeDefined();
});
