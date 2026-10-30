import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { changesEnv } from "../../server/git-changes.ts";
import { CHANGES_LIMITS, type FileDiff, type FolderChanges } from "../../shared/changes.ts";
import { writeChatSession } from "../support/chat-session.ts";
import { startTestServer, type TestServer } from "../support/server.ts";

/**
 * `/api/folder/changes` and `/api/folder/diff` against the real server: a conversation's folder in a repository, what it
 * lists and shows, the bounds it keeps, that it writes nothing, that a page that is not this computer's is not told what
 * the Files tab would not show it, and, above all, that a repository prepared by somebody else (a hook, an fsmonitor, an
 * external diff program, a textconv, a clean filter, a work tree that is another folder) runs nothing and lists nothing.
 * Every repository is made under the server's own directory, which goes with it.
 */

let s: TestServer;
let work: string;
let n = 0x90;

const headers = () => ({ "x-omp-webui-token": s.accessToken, "x-omp-webui": "1" });
/** A proxy in front of the server: the page is not on this computer, whatever it names. */
const proxied = () => ({ ...headers(), "x-forwarded-for": "203.0.113.9" });

/** git as a person runs it in the folder, with the server's home (which is where the user's own configuration is). */
function git(cwd: string, ...args: string[]): string {
	const ran = Bun.spawnSync(
		["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
		{ cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, HOME: s.home, GIT_CONFIG_NOSYSTEM: "1" } },
	);
	if (ran.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${ran.stderr.toString()}`);
	return ran.stdout.toString();
}

const write = (dir: string, rel: string, data: string | Uint8Array) => {
	const path = join(dir, rel);
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, data);
};

/** A repository with `files` committed, and a conversation that works in `folder` (the repository's top by default). */
function repository(
	name: string,
	files: Record<string, string | Uint8Array>,
	folder = "",
): { dir: string; file: string } {
	const dir = join(work, name);
	mkdirSync(dir, { recursive: true });
	git(dir, "init", "-q", "-b", "main");
	for (const [rel, data] of Object.entries(files)) write(dir, rel, data);
	git(dir, "add", ".");
	git(dir, "commit", "-q", "-m", "first");
	return { dir, file: conversation(folder ? join(dir, folder) : dir) };
}

/** A conversation that works in `cwd`, by its session file. */
const conversation = (cwd: string): string =>
	writeChatSession(s.agentDir, { n: n++, title: `Changes probe ${n}`, cwd, turns: [{ prompt: "hi", reply: "ok" }] });

async function ask(
	file: string,
	route: "changes" | "diff",
	query: Record<string, string> = {},
	opts: { method?: string; as?: () => Record<string, string> } = {},
) {
	const params = new URLSearchParams({ file, ...query });
	return fetch(`${s.url}/api/folder/${route}?${params}`, { method: opts.method, headers: (opts.as ?? headers)() });
}
const changes = async (file: string, as?: () => Record<string, string>) =>
	(await (await ask(file, "changes", {}, { as })).json()) as FolderChanges & { error?: string };
const diff = async (file: string, path: string, as?: () => Record<string, string>) => {
	const res = await ask(file, "diff", { path }, { as });
	return { status: res.status, body: (await res.json()) as FileDiff & { error?: string } };
};
const paths = (c: FolderChanges) => c.files.map((f) => f.path);

beforeAll(async () => {
	s = await startTestServer(0, {}, { login: false });
	work = realpathSync(s.work);
}, 90_000);
afterAll(async () => {
	await s?.stop();
});

describe("what it lists and shows", () => {
	test("changed, staged, new, deleted, renamed, binary and mode-changed files, with their lines counted", async () => {
		const { dir, file } = repository("basic", {
			"a.txt": "one\ntwo\nthree\n",
			"gone.txt": "bye\n",
			"old name.txt": `${"same line\n".repeat(20)}`,
			"run.sh": "#!/bin/sh\n",
			"data.bin": new Uint8Array([0, 1, 2, 3]),
			"keep.txt": "untouched\n",
		});
		write(dir, "a.txt", "one\nTWO\nthree\nfour\n");
		git(dir, "rm", "-q", "gone.txt");
		git(dir, "mv", "old name.txt", "new name.txt");
		write(dir, "new name.txt", `${"same line\n".repeat(20)}added\n`);
		chmodSync(join(dir, "run.sh"), 0o755);
		write(dir, "data.bin", new Uint8Array([0, 9, 9, 9, 0]));
		write(dir, "fresh.txt", "brand new\n");
		git(dir, "add", "fresh.txt");
		write(dir, "untracked.txt", "x\n");

		const c = await changes(file);
		expect(c).toMatchObject({ root: dir, state: "ok", branch: "main", truncated: false, omitted: 0 });
		expect(c.guarded).toBeUndefined();
		const by = Object.fromEntries(c.files.map((f) => [f.path, f]));
		expect(by["a.txt"]).toEqual({ path: "a.txt", state: "modified", staged: false, added: 2, removed: 1 });
		expect(by["gone.txt"]).toMatchObject({ state: "deleted", staged: true, added: 0, removed: 1 });
		expect(by["new name.txt"]).toMatchObject({ state: "renamed", from: "old name.txt", added: 1, removed: 0 });
		expect(by["run.sh"]).toMatchObject({ state: "modified", mode: { from: "100644", to: "100755" } });
		expect(by["data.bin"]).toMatchObject({ state: "modified", binary: true });
		expect(by["fresh.txt"]).toMatchObject({ state: "added", staged: true });
		expect(by["untracked.txt"]).toEqual({ path: "untracked.txt", state: "untracked", staged: false });
		expect(by["keep.txt"]).toBeUndefined();
		// The changed files by path, then the new ones.
		expect(paths(c)).toEqual(["a.txt", "data.bin", "fresh.txt", "gone.txt", "new name.txt", "run.sh", "untracked.txt"]);

		const a = (await diff(file, "a.txt")).body;
		expect(a.view).toBe("text");
		expect(a.hunks).toHaveLength(1);
		expect(a.hunks[0]?.rows).toEqual([
			{ kind: "ctx", old: 1, new: 1, text: "one" },
			{ kind: "del", old: 2, text: "two" },
			{ kind: "add", new: 2, text: "TWO" },
			{ kind: "ctx", old: 3, new: 3, text: "three" },
			{ kind: "add", new: 4, text: "four" },
		]);
		expect([a.added, a.removed]).toEqual([2, 1]);
		expect((await diff(file, "data.bin")).body.view).toBe("binary");
		expect((await diff(file, "gone.txt")).body.hunks[0]?.rows.map((r) => r.kind)).toEqual(["del"]);
		const renamed = (await diff(file, "new name.txt")).body;
		expect(renamed).toMatchObject({ state: "renamed", from: "old name.txt", added: 1 });
		expect((await diff(file, "run.sh")).body).toMatchObject({ view: "empty", mode: { to: "100755" } });
		const fresh = (await diff(file, "untracked.txt")).body;
		expect(fresh).toMatchObject({ state: "untracked", view: "text", added: 1, removed: 0 });
		expect(fresh.hunks[0]?.rows).toEqual([{ kind: "add", new: 1, text: "x" }]);
	});

	test("a folder below the repository's top lists its own files, with paths relative to it", async () => {
		const { dir, file } = repository(
			"nested",
			{ "top.txt": "t\n", "pkg/in.txt": "i\n", "pkg/deep/d.txt": "d\n", "other/o.txt": "o\n" },
			"pkg",
		);
		write(dir, "top.txt", "T\n");
		write(dir, "pkg/in.txt", "I\n");
		write(dir, "pkg/deep/d.txt", "D\n");
		write(dir, "pkg/new.txt", "n\n");
		write(dir, "other/o.txt", "O\n");
		const c = await changes(file);
		expect(paths(c)).toEqual(["deep/d.txt", "in.txt", "new.txt"]);
		expect((await diff(file, "deep/d.txt")).body.hunks[0]?.rows).toContainEqual({ kind: "add", new: 1, text: "D" });
		// What is above or beside the folder is not a change of it.
		expect((await diff(file, "../top.txt")).status).toBe(403);
		expect((await diff(file, "top.txt")).status).toBe(404);
	});

	test("a repository without a commit lists what is staged, and a folder outside any repository says so", async () => {
		const dir = join(work, "unborn");
		mkdirSync(dir);
		git(dir, "init", "-q", "-b", "trunk");
		write(dir, "a.txt", "a\n");
		git(dir, "add", "a.txt");
		write(dir, "b.txt", "b\n");
		const file = conversation(dir);
		const c = await changes(file);
		expect(c).toMatchObject({ state: "ok", branch: "trunk" });
		expect(c.files).toEqual([
			{ path: "a.txt", state: "added", staged: true, added: 1, removed: 0 },
			{ path: "b.txt", state: "untracked", staged: false },
		]);
		const plain = join(work, "plain");
		mkdirSync(plain);
		expect(await changes(conversation(plain))).toMatchObject({ state: "none", files: [] });
	});

	test("a repository that is a git file pointing at a separate git directory, with its work tree set, is looked at", async () => {
		const dir = join(work, "separate");
		const gitDir = join(work, "separate.git");
		mkdirSync(dir);
		git(work, "init", "-q", "-b", "main", "--separate-git-dir", gitDir, dir);
		write(dir, "a.txt", "a\n");
		git(dir, "add", ".");
		git(dir, "commit", "-q", "-m", "first");
		write(dir, "a.txt", "A\n");
		expect(await changes(conversation(dir))).toMatchObject({ state: "ok", files: [{ path: "a.txt" }] });
	});

	test("a line that looks like a diff header, an empty added line and a file without a final newline come back as rows", async () => {
		const { dir, file } = repository("tricky", { "t.txt": "keep\n" });
		write(dir, "t.txt", "keep\n@@ -1 +1 @@\n--- a/t.txt\n\n+++ b/t.txt\nlast");
		const rows = (await diff(file, "t.txt")).body.hunks.flatMap((h) => h.rows);
		expect(rows.map((r) => r.text)).toEqual(["keep", "@@ -1 +1 @@", "--- a/t.txt", "", "+++ b/t.txt", "last"]);
		expect(rows.at(-1)).toMatchObject({ kind: "add", noEol: true });
		expect(rows.slice(1).every((r) => r.kind === "add")).toBe(true);
	});
});

describe("its bounds", () => {
	test("a diff of far more lines than the page shows is cut, and so is a line far longer than a row", async () => {
		const { dir, file } = repository("big", { "big.txt": "x\n", "wide.txt": "x\n" });
		write(dir, "big.txt", Array.from({ length: CHANGES_LIMITS.rows * 3 }, (_, i) => `line ${i}`).join("\n"));
		write(dir, "wide.txt", `${"w".repeat(CHANGES_LIMITS.rowChars * 5)}\n`);
		const big = (await diff(file, "big.txt")).body;
		expect(big.truncated).toBe(true);
		expect(big.hunks.flatMap((h) => h.rows)).toHaveLength(CHANGES_LIMITS.rows);
		// What the list counts is the whole change, not the cut.
		expect(big.added).toBe(CHANGES_LIMITS.rows * 3);
		const wide = (await diff(file, "wide.txt")).body.hunks[0]?.rows.find((r) => r.kind === "add");
		expect(wide?.clipped).toBe(true);
		expect(wide?.text).toHaveLength(CHANGES_LIMITS.rowChars);
	});

	test("a file larger than git diffs is binary for it, and a new file that large is cut", async () => {
		const { dir, file } = repository("large", { "log.txt": "start\n" });
		write(dir, "log.txt", `${"a log line\n".repeat(CHANGES_LIMITS.fileBytes / 11 + 1000)}`);
		write(dir, "huge-new.txt", `${"a log line\n".repeat(CHANGES_LIMITS.fileBytes / 11 + 1000)}`);
		const c = await changes(file);
		expect(c.files.find((f) => f.path === "log.txt")).toMatchObject({ binary: true });
		expect((await diff(file, "log.txt")).body.view).toBe("binary");
		const fresh = (await diff(file, "huge-new.txt")).body;
		expect(fresh.view).toBe("text");
		expect(fresh.truncated).toBe(true);
		expect(fresh.hunks[0]?.rows.length).toBeLessThanOrEqual(CHANGES_LIMITS.rows);
	});

	test("more files than the list holds: the first of them, and it says there are more", async () => {
		const { dir, file } = repository("many", { "seed.txt": "s\n" });
		for (let i = 0; i < CHANGES_LIMITS.files + 40; i++) write(dir, `f/${String(i).padStart(4, "0")}.txt`, "x\n");
		const c = await changes(file);
		expect(c.files).toHaveLength(CHANGES_LIMITS.files);
		expect(c.truncated).toBe(true);
	});

	test("a link that is new is not followed, and neither is anything that is not a file", async () => {
		const { dir, file } = repository("links", { "a.txt": "a\n" });
		write(work, "outside-secret.txt", "OUTSIDE-ONLY\n");
		symlinkSync(join(work, "outside-secret.txt"), join(dir, "to-outside.txt"));
		symlinkSync(join(dir, "a.txt"), join(dir, "to-inside.txt"));
		const c = await changes(file);
		expect(paths(c)).toEqual(["to-inside.txt", "to-outside.txt"]);
		for (const name of ["to-outside.txt", "to-inside.txt"]) {
			const res = await diff(file, name);
			expect(res.status).toBe(200);
			expect(res.body).toMatchObject({ view: "unreadable", reason: "link", hunks: [] });
			expect(JSON.stringify(res.body)).not.toContain("OUTSIDE-ONLY");
		}
	});

	test("far more output than git's answer is read to: the first files are listed, it says there are more, and it is not 'not a repository'", async () => {
		const { dir, file } = repository("flood", { "seed.txt": "s\n" });
		// Paths of nearly 500 characters: ten thousand of them are well over the bytes `git status` is read to.
		const deep = ["a", "b", "c", "d"].map((c) => c.repeat(120)).join("/");
		mkdirSync(join(dir, deep), { recursive: true });
		const count = Math.ceil((CHANGES_LIMITS.listBytes * 1.2) / (deep.length + 12));
		for (let i = 0; i < count; i++) writeFileSync(join(dir, deep, String(i).padStart(8, "0")), "x");
		const c = await changes(file);
		expect(c.state).toBe("ok");
		expect(c.truncated).toBe(true);
		expect(c.files).toHaveLength(CHANGES_LIMITS.files);
		expect(c.files[0]?.path).toBe(`${deep}/00000000`);
		expect(c.files.every((f) => f.state === "untracked")).toBe(true);
	}, 60_000);

	test("a change git writes more of than is read is cut, and is still a change of lines", async () => {
		// Each file is under what git diffs as text (1 MiB); rewriting every line makes a diff of about 3 MB, read to 2 MiB.
		const { dir, file } = repository("heavy", { "x.txt": "a\n".repeat(500_000) });
		write(dir, "x.txt", "b\n".repeat(500_000));
		const res = await diff(file, "x.txt");
		expect(res.status).toBe(200);
		expect(res.body.view).toBe("text");
		expect(res.body.truncated).toBe(true);
		expect(res.body.hunks.flatMap((h) => h.rows)).toHaveLength(CHANGES_LIMITS.rows);
	}, 60_000);

	test("a repository git cannot read the changes of (an object it needs is gone) is said to be unreadable, not 'not a repository'", async () => {
		const { dir, file } = repository("damaged", { "a.txt": "one\ntwo\n" });
		write(dir, "a.txt", "one\nTWO\n");
		const blob = git(dir, "rev-parse", "HEAD:a.txt").trim();
		rmSync(join(dir, ".git", "objects", blob.slice(0, 2), blob.slice(2)));
		expect(await changes(file)).toMatchObject({ state: "unreadable", files: [], truncated: false });
	});
});

describe("what a page may ask for", () => {
	test("only a path the list names, relative to the folder: nothing that climbs out, is absolute or is not changed", async () => {
		const { dir, file } = repository("confined", { "a.txt": "a\n", "kept.txt": "k\n", ".gitignore": "ignored.txt\n" });
		write(dir, "a.txt", "A\n");
		write(dir, "ignored.txt", "IGNORED-ONLY\n");
		write(work, "elsewhere.txt", "ELSEWHERE\n");
		for (const [path, status] of [
			["../elsewhere.txt", 403],
			["a.txt/../../elsewhere.txt", 403],
			[join(work, "elsewhere.txt"), 403],
			["", 400],
			["a.txt\0", 400],
			["kept.txt", 404],
			["ignored.txt", 404],
			["missing.txt", 404],
			[".git/config", 404],
			["*.txt", 404],
			["a.*", 404],
		] as const) {
			const res = await diff(file, path);
			expect(res.status, JSON.stringify(path)).toBe(status);
			expect(JSON.stringify(res.body)).not.toMatch(/ELSEWHERE|IGNORED-ONLY/);
		}
		expect((await diff(file, "a.txt")).status).toBe(200);
		expect(paths(await changes(file))).toEqual(["a.txt"]);
	});

	test("a repository inside the folder is one entry that is a folder: its diff says so, and a hidden one is hidden from a page that is not this computer's as a folder", async () => {
		const { dir, file } = repository("nest", { "a.txt": "a\n" });
		for (const name of ["inner", "node_modules"]) {
			const inner = join(dir, name);
			mkdirSync(inner);
			git(inner, "init", "-q", "-b", "main");
			write(inner, "f.txt", "f\n");
			git(inner, "add", ".");
			git(inner, "commit", "-q", "-m", "inner");
		}
		expect(paths(await changes(file))).toEqual(["inner/", "node_modules/"]);
		for (const asked of ["inner/", "inner"]) {
			const res = await diff(file, asked);
			expect(res.status).toBe(200);
			expect(res.body).toMatchObject({ path: "inner/", view: "unreadable", reason: "notFile", hunks: [] });
		}
		const guarded = await changes(file, proxied);
		expect(paths(guarded)).toEqual(["inner/"]);
		expect(guarded.omitted).toBe(1);
		expect((await diff(file, "inner/", proxied)).status).toBe(200);
		expect((await diff(file, "node_modules/", proxied)).status).toBe(403);
		expect((await diff(file, "node_modules", proxied)).status).toBe(403);
	});

	test("the conversation is named and never a folder; a look that skips what is kept is a POST; no token, no answer", async () => {
		const { file } = repository("methods", { "a.txt": "a\n" });
		expect((await ask(file, "changes", { fresh: "1" })).status).toBe(405);
		expect((await ask(file, "changes", { fresh: "1" }, { method: "POST" })).status).toBe(200);
		expect((await ask(file, "diff", { path: "a.txt" }, { method: "POST" })).status).toBe(405);
		expect((await ask(join(work, "no-such-session.jsonl"), "changes")).status).toBe(404);
		const bare = await fetch(`${s.url}/api/folder/changes?file=${encodeURIComponent(file)}`);
		expect(bare.status).toBe(401);
		// A folder named by the page is ignored: the one of the conversation answers.
		const named = await fetch(`${s.url}/api/folder/changes?file=${encodeURIComponent(file)}&cwd=/&root=/`, {
			headers: headers(),
		});
		expect(((await named.json()) as FolderChanges).root).toBe(join(work, "methods"));
	});

	test("a page that is not this computer's is not told of what looks like a secret or is hidden, in the list or in a diff", async () => {
		const { dir, file } = repository("guarded", {
			"a.txt": "a\n",
			".env": "TOKEN=old\n",
			".hidden/note.txt": "old\n",
			"node_modules/dep/index.js": "old\n",
			"config/id_rsa": "old\n",
			"notes.txt": "old\n",
			"plain old.txt": "plain\n",
			".github/ci.yml": "ci\n",
		});
		write(dir, "a.txt", "A\n");
		write(dir, ".env", "TOKEN=SECRET-NEW\n");
		write(dir, ".hidden/note.txt", "HIDDEN-NEW\n");
		write(dir, "node_modules/dep/index.js", "DEP-NEW\n");
		write(dir, "config/id_rsa", "KEY-NEW\n");
		write(dir, "notes.txt", "-----BEGIN OPENSSH PRIVATE KEY-----\nPEM-NEW\n");
		write(dir, ".dotfile-new", "DOTFILE-NEW\n");
		write(dir, "secrets.json", "SECRETS-NEW\n");
		write(dir, ".github/ci.yml", "ci2\n");
		git(dir, "mv", "plain old.txt", ".env.moved");
		write(dir, ".env.moved", "plain\nmore\n");

		const local = await changes(file);
		expect(paths(local)).toEqual(
			expect.arrayContaining([".env", ".hidden/note.txt", "config/id_rsa", ".dotfile-new", "secrets.json"]),
		);
		expect(local.guarded).toBeUndefined();

		const guarded = await changes(file, proxied);
		expect(guarded.guarded).toBe(true);
		// What is listed is what the Files tab would show: the key in `notes.txt` is not known until it is read.
		expect(paths(guarded)).toEqual([".github/ci.yml", "a.txt", "notes.txt"]);
		expect(guarded.omitted).toBe(local.files.length - 3);
		expect(JSON.stringify(guarded)).not.toMatch(/SECRET|HIDDEN|DEP-NEW|KEY-NEW|PEM-NEW|DOTFILE|\.env|id_rsa/);

		for (const path of [
			".env",
			".hidden/note.txt",
			"node_modules/dep/index.js",
			"config/id_rsa",
			".dotfile-new",
			"secrets.json",
			".env.moved",
			"notes.txt",
		]) {
			const res = await diff(file, path, proxied);
			expect(res.status, path).toBe(403);
			expect(JSON.stringify(res.body), path).not.toMatch(/SECRET|HIDDEN|DEP-NEW|KEY-NEW|PEM-NEW|DOTFILE/);
		}
		expect((await diff(file, "a.txt", proxied)).status).toBe(200);
		expect((await diff(file, ".github/ci.yml", proxied)).status).toBe(200);
		// The page on this computer is given all of it.
		expect((await diff(file, ".env")).body.hunks[0]?.rows).toContainEqual({
			kind: "add",
			new: 1,
			text: "TOKEN=SECRET-NEW",
		});
	});
});

describe("what it never does", () => {
	test("it writes nothing: the index and the folder are as they were, and a repository another git holds the lock of is read all the same", async () => {
		const { dir, file } = repository("quiet", { "a.txt": "a\n", "b.txt": "b\n" });
		// A change newer than the index: a look that refreshed the index would write it.
		write(dir, "a.txt", "A\n");
		write(dir, "u.txt", "u\n");
		const stamp = (path: string) => {
			const info = statSync(join(dir, path));
			return `${info.size}:${info.mtimeMs}:${info.ino}`;
		};
		const before = [".git/index", ".git/HEAD", ".git/config", "a.txt", "b.txt", "u.txt"].map(stamp);
		// The agent's own git holds the index lock while it works.
		writeFileSync(join(dir, ".git", "index.lock"), "");
		for (let i = 0; i < 3; i++) {
			expect((await ask(file, "changes", { fresh: "1" }, { method: "POST" })).status).toBe(200);
			expect((await diff(file, "a.txt")).status).toBe(200);
			expect((await diff(file, "u.txt")).status).toBe(200);
		}
		expect(paths(await changes(file))).toEqual(["a.txt", "u.txt"]);
		expect([".git/index", ".git/HEAD", ".git/config", "a.txt", "b.txt", "u.txt"].map(stamp)).toEqual(before);
		expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("A\n");
		expect(statSync(join(dir, ".git", "index.lock")).size).toBe(0);
	});
});

// ---------------------------------------------------------------------------------------------------------------
// A folder prepared by someone else: git does what a repository's own configuration says.

/** A program that leaves `marker` behind and prints what a git of that kind expects of it. */
function program(name: string, marker: string, body = ""): string {
	const path = join(work, name);
	writeFileSync(path, `#!/bin/sh\n/usr/bin/touch ${marker}\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

/** What an unguarded `git diff` (what the page's own tools would run) does in `dir`. */
const unguarded = (dir: string, ...args: string[]) =>
	Bun.spawnSync(["git", "--no-pager", ...args], {
		cwd: dir,
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, HOME: s.home, GIT_CONFIG_NOSYSTEM: "1" },
	});

describe("a repository prepared to run a program", () => {
	interface Hostile {
		name: string;
		/** Prepare the repository so that git, asked for its status or a diff, would run `marker`'s program. */
		setup(dir: string, marker: string): void;
		/** Whether the repository's own settings are what the look refuses (state `unsafe`), or the look's own arguments are what stop the program (state `ok`). */
		refused: boolean;
		/** What git run without those arguments does in the repository (absent: it does not run the program by itself, only for a person at a terminal). */
		control?: (dir: string) => void;
	}

	/** A repository with one changed file (and another that only looks changed), prepared by `h`. */
	function prepared(name: string, h: Hostile, marker: string) {
		const { dir, file } = repository(name, { "a.txt": "a\n", "b.txt": "b\n" });
		write(dir, "a.txt", "A\n");
		h.setup(dir, marker);
		// Newer than the index and of the same size: to tell whether it differs, git has to read it through its filters.
		for (const rel of ["a.txt", "b.txt"]) Bun.spawnSync(["touch", "-t", "203001010000", join(dir, rel)]);
		return { dir, file };
	}

	const hostile: Hostile[] = [
		{
			name: "core.fsmonitor naming a program",
			setup: (dir, marker) => git(dir, "config", "core.fsmonitor", program("fsmonitor.sh", marker, "printf '\\0'")),
			refused: true,
			control: (dir) => unguarded(dir, "status", "--porcelain=v2"),
		},
		{
			name: "a clean filter in the configuration, chosen in .git/info/attributes",
			setup(dir, marker) {
				git(dir, "config", "filter.evil.clean", `/usr/bin/touch ${marker}; /bin/cat`);
				writeFileSync(join(dir, ".git", "info", "attributes"), "* filter=evil\n");
			},
			refused: true,
			control: (dir) => unguarded(dir, "status", "--porcelain=v2"),
		},
		{
			name: "an external diff program (diff.external)",
			setup: (dir, marker) => git(dir, "config", "diff.external", program("external.sh", marker)),
			refused: true,
			control: (dir) => unguarded(dir, "diff", "HEAD"),
		},
		{
			name: "a textconv driver chosen in .git/info/attributes",
			setup(dir, marker) {
				git(dir, "config", "diff.evil.textconv", program("textconv.sh", marker, 'exec /bin/cat "$1"'));
				writeFileSync(join(dir, ".git", "info", "attributes"), "* diff=evil\n");
			},
			refused: true,
			control: (dir) => unguarded(dir, "diff", "HEAD"),
		},
		{
			name: "an included file that defines a clean filter",
			setup(dir, marker) {
				writeFileSync(
					join(dir, ".git", "extra.cfg"),
					`[filter "evil"]\n\tclean = /usr/bin/touch ${marker}; /bin/cat\n`,
				);
				git(dir, "config", "include.path", "extra.cfg");
				writeFileSync(join(dir, ".git", "info", "attributes"), "* filter=evil\n");
			},
			refused: true,
			control: (dir) => unguarded(dir, "status", "--porcelain=v2"),
		},
		{
			name: "a pager and an editor (core.pager, core.editor)",
			setup(dir, marker) {
				git(dir, "config", "core.pager", program("pager.sh", marker, "cat"));
				git(dir, "config", "core.editor", program("editor.sh", marker));
			},
			refused: true,
		},
		{
			name: "hooks of its own (core.hooksPath), which git runs when it writes the index",
			setup(dir, marker) {
				const hooks = join(dir, ".git", "evil-hooks");
				mkdirSync(hooks);
				const path = join(hooks, "post-index-change");
				writeFileSync(path, `#!/bin/sh\n/usr/bin/touch ${marker}\n`);
				chmodSync(path, 0o755);
				git(dir, "config", "core.hooksPath", hooks);
			},
			refused: false,
			control: (dir) => unguarded(dir, "add", "a.txt"),
		},
	];

	for (const h of hostile) {
		const slug = h.name.replace(/\W+/g, "-");
		test(`${h.name}: ${h.refused ? "not looked at" : "looked at with it switched off"}, and the program is not run`, async () => {
			if (h.control) {
				// The setup is one that runs something: git without the look's arguments does (so that what follows can fail).
				const control = join(work, `control-${slug}`);
				h.control(prepared(`control-${slug}`, h, control).dir);
				expect(existsSync(control), "the control repository's program ran").toBe(true);
			}
			const marker = join(work, `marker-${slug}`);
			const { file } = prepared(`evil-${slug}`, h, marker);
			const lists = await Promise.all([
				changes(file),
				ask(file, "changes", { fresh: "1" }, { method: "POST" }).then((r) => r.json() as Promise<FolderChanges>),
			]);
			const one = await diff(file, "a.txt");
			for (const list of lists) {
				if (h.refused) expect(list).toMatchObject({ state: "unsafe", files: [] });
				else expect(list).toMatchObject({ state: "ok", files: [{ path: "a.txt" }] });
			}
			expect(one.status).toBe(h.refused ? 404 : 200);
			expect(existsSync(marker), "the program ran").toBe(false);
		});
	}

	test("a .gitattributes of the folder that names a driver, and one of the user's own: neither is run for a diff", async () => {
		const textconv = join(work, "marker-global-textconv");
		const cleanMarker = join(work, "marker-global-clean");
		// The user's own configuration (the server's home) holds the drivers; the repository only names them.
		writeFileSync(
			join(s.home, ".gitconfig"),
			[
				'[diff "mine"]',
				`\ttextconv = ${program("global-textconv.sh", textconv, 'exec /bin/cat "$1"')}`,
				'[filter "mine"]',
				`\tclean = /usr/bin/touch ${cleanMarker}; /bin/cat`,
				"",
			].join("\n"),
		);
		const { dir, file } = repository("attributes", { "a.txt": "a\n", ".gitattributes": "" });
		write(dir, ".gitattributes", "a.txt diff=mine filter=mine\n");
		write(dir, "a.txt", "A\n");
		expect(await changes(file)).toMatchObject({ state: "ok" });
		const res = await diff(file, "a.txt");
		expect(res.status).toBe(200);
		expect(res.body.hunks[0]?.rows).toContainEqual({ kind: "add", new: 1, text: "A" });
		expect(existsSync(textconv)).toBe(false);
		expect(existsSync(cleanMarker)).toBe(false);
		// The same repository, as an unguarded diff would have it: the driver is run (so that the check above can fail).
		unguarded(dir, "diff", "HEAD");
		expect(existsSync(textconv)).toBe(true);
	});

	test("what names a directory, a program or a pager in the environment is not what git is given", () => {
		const env = changesEnv({
			GIT_DIR: "/elsewhere",
			GIT_WORK_TREE: "/elsewhere",
			GIT_EXTERNAL_DIFF: "/bin/evil",
			PAGER: "evil",
			PATH: "/bin",
		});
		expect(env).toMatchObject({ PATH: "/bin", GIT_PAGER: "cat", GIT_LITERAL_PATHSPECS: "1", GIT_NO_LAZY_FETCH: "1" });
		for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_EXTERNAL_DIFF", "PAGER"]) expect(env[key]).toBeUndefined();
	});
});

describe("a repository whose work tree is another folder", () => {
	test("core.worktree pointing elsewhere: not looked at, and what is there is not listed or read", async () => {
		const other = join(work, "other-tree");
		write(other, "loot.txt", "LOOT-ONLY\n");
		const { dir, file } = repository("redirected", { "a.txt": "a\n" });
		git(dir, "config", "core.worktree", other);
		// The check can fail: git itself, asked in the folder, reads the other one.
		expect(unguarded(dir, "ls-files", "-o").stdout.toString()).toContain("loot.txt");
		const list = await changes(file);
		expect(list).toMatchObject({ state: "unsafe", files: [] });
		expect(JSON.stringify(list)).not.toContain("loot");
		for (const path of ["loot.txt", "a.txt"]) {
			const res = await diff(file, path);
			expect(res.status).toBe(404);
			expect(JSON.stringify(res.body)).not.toContain("LOOT-ONLY");
		}
	});

	test("a work tree that is inside the folder, and not the folder, is another folder too", async () => {
		const { dir } = repository("inner", { "a.txt": "a\n", "sub/b.txt": "b\n" });
		git(dir, "config", "core.worktree", join(dir, "sub"));
		// The conversation works at the top, the work tree is below it: git's own listing is of `sub`.
		expect(await changes(conversation(dir))).toMatchObject({ state: "unsafe", files: [] });
		expect(unguarded(dir, "rev-parse", "--show-toplevel").stdout.toString().trim()).toBe(join(dir, "sub"));
	});
});
