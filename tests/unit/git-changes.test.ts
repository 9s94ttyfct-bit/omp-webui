import { describe, expect, test } from "bun:test";
import {
	EMPTY_TREE,
	gitArgs,
	listChanges,
	mergeChanges,
	newFileDiff,
	parseUnifiedDiff,
	scanDiffList,
	scanStatus,
} from "../../server/git-changes.ts";
import { type Ran, run } from "../../server/omp/run.ts";
import { CHANGES_LIMITS } from "../../shared/changes.ts";

/** What git prints for `git status --porcelain=v2 -z --branch` and `git diff --raw --numstat -z -M`, as written by git itself. */
const SHA = "0123456789abcdef0123456789abcdef01234567";
const ZERO = "0000000000000000000000000000000000000000";
const status = (...records: string[]) => `${records.join("\0")}\0`;

describe("the status", () => {
	test("reads the commit, the branch, what is staged, what is in conflict and what is new (a path may hold spaces)", () => {
		const scan = scanStatus(
			status(
				`# branch.oid ${SHA}`,
				"# branch.head main",
				`1 M. N... 100644 100644 100644 ${SHA} ${SHA} staged one.txt`,
				`1 .M N... 100644 100644 100644 ${SHA} ${SHA} worktree.txt`,
				`2 R. N... 100644 100644 100644 ${SHA} ${SHA} R100 renamed to.txt`,
				"renamed from.txt",
				`u UU N... 100644 100644 100644 100644 ${SHA} ${SHA} ${SHA} both sides.txt`,
				"? new file.txt",
				"! ignored.txt",
			),
		);
		expect(scan.oid).toBe(SHA);
		expect(scan.head).toBe("main");
		expect([...scan.staged]).toEqual(["staged one.txt", "renamed to.txt"]);
		expect([...scan.conflicts]).toEqual(["both sides.txt"]);
		expect(scan.untracked).toEqual(["new file.txt"]);
	});

	test("a repository without a commit says so, and text that is not a status has no branch", () => {
		expect(scanStatus(status("# branch.oid (initial)", "# branch.head main")).oid).toBe("(initial)");
		expect(scanStatus("fatal: not a git repository").head).toBeNull();
	});
});

describe("the list of changes", () => {
	const raw = (modes: string, letter: string, ...paths: string[]) =>
		`:${modes} ${SHA.slice(0, 7)} ${ZERO.slice(0, 7)} ${letter}\0${paths.join("\0")}\0`;

	test("reads the raw records, then the counts, with renames, binaries and paths that hold tabs", () => {
		const text =
			raw("100644 100644", "M", "a b.txt") +
			raw("100644 100755", "M", "run.sh") +
			raw("000000 100644", "A", "bin.dat") +
			raw("100644 000000", "D", "gone.txt") +
			raw("100644 100644", "R087", "old.txt", "new.txt") +
			"1\t2\ta b.txt\0" +
			"0\t0\trun.sh\0" +
			"-\t-\tbin.dat\0" +
			"0\t4\tgone.txt\0" +
			"3\t1\t\0old.txt\0new.txt\0";
		const { raws, counts } = scanDiffList(text);
		expect(raws.map((r) => [r.letter, r.path, r.from])).toEqual([
			["M", "a b.txt", undefined],
			["M", "run.sh", undefined],
			["A", "bin.dat", undefined],
			["D", "gone.txt", undefined],
			["R", "new.txt", "old.txt"],
		]);
		expect(raws[1]).toMatchObject({ oldMode: "100644", newMode: "100755" });
		expect(counts.get("a b.txt")).toEqual({ added: 1, removed: 2 });
		expect(counts.get("bin.dat")).toEqual({ added: null, removed: null });
		expect(counts.get("new.txt")).toEqual({ added: 3, removed: 1 });
	});

	test("a record cut short by the limit is not read, and nothing before it is lost", () => {
		const whole = raw("100644 100644", "M", "a.txt") + raw("100644 100644", "R050", "x.txt", "y.txt");
		const cut = whole.slice(0, whole.length - 8);
		expect(scanDiffList(cut).raws.map((r) => r.path)).toEqual(["a.txt"]);
		expect(scanDiffList("").raws).toEqual([]);
	});

	test("puts changed files by path before new ones, relative to the folder, leaving out what is beside it", () => {
		const scan = scanStatus(
			status(
				`# branch.oid ${SHA}`,
				"# branch.head main",
				`1 M. N... 100644 100644 100644 ${SHA} ${SHA} pkg/b.txt`,
				"? pkg/z-new.txt",
				"? pkg/a-new.txt",
				"? elsewhere/new.txt",
			),
		);
		const { raws, counts } = scanDiffList(
			raw("100644 100644", "M", "pkg/b.txt") +
				raw("100644 100644", "M", "pkg/a.txt") +
				raw("100644 100644", "M", "other/o.txt") +
				"1\t0\tpkg/b.txt\0" +
				"1\t0\tpkg/a.txt\0" +
				"1\t0\tother/o.txt\0",
		);
		const files = mergeChanges(scan, raws, counts, "pkg");
		expect(files.map((f) => [f.path, f.state, f.staged])).toEqual([
			["a.txt", "modified", false],
			["b.txt", "modified", true],
			["a-new.txt", "untracked", false],
			["z-new.txt", "untracked", false],
		]);
	});

	test("a conflict the list does not name is still listed, and a binary change has no counts", () => {
		const scan = scanStatus(
			status("# branch.head main", `u DD N... 100644 100644 100644 100644 ${SHA} ${SHA} ${SHA} gone.txt`),
		);
		const files = mergeChanges(
			scan,
			scanDiffList(`${raw("100644 100644", "M", "d.bin")}-\t-\td.bin\0`).raws,
			new Map([["d.bin", { added: null, removed: null }]]),
			"",
		);
		expect(files).toEqual([
			{ path: "d.bin", state: "modified", staged: false, binary: true },
			{ path: "gone.txt", state: "conflict", staged: false },
		]);
	});
});

describe("one file's diff", () => {
	const hunk = (...lines: string[]) =>
		["diff --git a/f b/f", "index 1..2 100644", "--- a/f", "+++ b/f", ...lines].join("\n");

	test("numbers each row from the hunk's header, and keeps what the function line says", () => {
		const parsed = parseUnifiedDiff(
			hunk("@@ -10,3 +10,4 @@ function f() {", " ctx", "-old", "+new", "+more", " tail", ""),
		);
		expect(parsed.hunks).toHaveLength(1);
		expect(parsed.hunks[0]).toMatchObject({
			oldStart: 10,
			oldLines: 3,
			newStart: 10,
			newLines: 4,
			section: "function f() {",
		});
		expect(parsed.hunks[0]?.rows).toEqual([
			{ kind: "ctx", old: 10, new: 10, text: "ctx" },
			{ kind: "del", old: 11, text: "old" },
			{ kind: "add", new: 11, text: "new" },
			{ kind: "add", new: 12, text: "more" },
			{ kind: "ctx", old: 12, new: 13, text: "tail" },
		]);
		expect([parsed.added, parsed.removed]).toEqual([2, 1]);
	});

	test("a line of the file that looks like a header or a hunk is a line of the file; the counts decide where a hunk ends", () => {
		const parsed = parseUnifiedDiff(
			hunk("@@ -1 +1,3 @@", " keep", "+@@ -5 +5 @@", "+--- a/other", "@@ -20 +20 @@", "-x", "+y", ""),
		);
		expect(parsed.hunks).toHaveLength(2);
		expect(parsed.hunks[0]?.rows.map((r) => r.text)).toEqual(["keep", "@@ -5 +5 @@", "--- a/other"]);
		expect(parsed.hunks[1]?.rows.map((r) => [r.kind, r.text])).toEqual([
			["del", "x"],
			["add", "y"],
		]);
	});

	test("no newline at the end of a file marks the row before it, and a carriage return is not part of the text", () => {
		const parsed = parseUnifiedDiff(
			hunk("@@ -1 +1 @@", "-a\r", "\\ No newline at end of file", "+b", "\\ No newline at end of file", ""),
		);
		expect(parsed.hunks[0]?.rows).toEqual([
			{ kind: "del", old: 1, text: "a", noEol: true },
			{ kind: "add", new: 1, text: "b", noEol: true },
		]);
	});

	test("a binary notice has no hunks; a diff of more rows than the limit is cut and says so; a long row is clipped", () => {
		expect(parseUnifiedDiff("diff --git a/x b/x\nBinary files a/x and b/x differ\n")).toMatchObject({
			binary: true,
			hunks: [],
		});
		const many = Array.from({ length: CHANGES_LIMITS.rows + 50 }, (_, i) => `+line ${i}`);
		const cut = parseUnifiedDiff(hunk(`@@ -0,0 +1,${many.length} @@`, ...many, ""));
		expect(cut.truncated).toBe(true);
		expect(cut.hunks.flatMap((h) => h.rows)).toHaveLength(CHANGES_LIMITS.rows);
		const wide = parseUnifiedDiff(hunk("@@ -0,0 +1 @@", `+${"w".repeat(CHANGES_LIMITS.rowChars + 10)}`, ""));
		expect(wide.hunks[0]?.rows[0]).toMatchObject({ clipped: true });
		expect(wide.hunks[0]?.rows[0]?.text).toHaveLength(CHANGES_LIMITS.rowChars);
		// Text git itself was cut in is marked cut, whatever it holds.
		expect(parseUnifiedDiff(hunk("@@ -1 +1 @@", "-a", "+b", ""), true).truncated).toBe(true);
	});

	test("a new file is all added: an empty one, one without a final newline, a long one and what cannot be read", () => {
		const file = { path: "n.txt", state: "untracked" as const, staged: false };
		expect(newFileDiff(file, { text: "", cut: false }).view).toBe("empty");
		const noEol = newFileDiff(file, { text: "a\nb", cut: false });
		expect(noEol.hunks[0]?.rows).toEqual([
			{ kind: "add", new: 1, text: "a" },
			{ kind: "add", new: 2, text: "b", noEol: true },
		]);
		expect(newFileDiff(file, { text: "a\nb\n", cut: false }).hunks[0]?.rows.at(-1)?.noEol).toBeUndefined();
		const long = newFileDiff(file, { text: `${"x\n".repeat(CHANGES_LIMITS.rows + 5)}`, cut: false });
		expect(long.truncated).toBe(true);
		expect(long.hunks[0]?.rows).toHaveLength(CHANGES_LIMITS.rows);
		expect(newFileDiff(file, { binary: true }).view).toBe("binary");
		expect(newFileDiff(file, { reason: "link" })).toMatchObject({ view: "unreadable", reason: "link", hunks: [] });
	});
});

describe("the arguments of the look", () => {
	test("tell git where the repository is and switch off everything the repository could run", () => {
		const args = gitArgs({ toplevel: "/work/tree", gitDir: "/work/tree/.git" }, "diff", "HEAD");
		expect(args.slice(0, 1)).toEqual(["git"]);
		for (const wanted of [
			"core.fsmonitor=false",
			"core.hooksPath=/dev/null",
			"--git-dir=/work/tree/.git",
			"--work-tree=/work/tree",
			`--attr-source=${EMPTY_TREE}`,
			"--no-optional-locks",
			"--no-pager",
		])
			expect(args).toContain(wanted);
		expect(args.slice(-2)).toEqual(["diff", "HEAD"]);
	});
});

describe("a command that prints more than it may", () => {
	test("is ended, and what it printed up to the limit comes back marked", async () => {
		const ran = await run(["/bin/sh", "-c", "yes 0123456789 | head -c 50000000"], {
			timeoutMs: 20_000,
			maxBytes: 1000,
		});
		expect(ran.truncated).toBe(true);
		expect(ran.stdout.length).toBeLessThanOrEqual(1000);
		expect(ran.stdout.length).toBeGreaterThan(900);
	});

	test("one that stays within it is read whole, and one without a limit is not marked", async () => {
		expect((await run(["/bin/echo", "hello"], { timeoutMs: 5000, maxBytes: 1000 })).stdout).toBe("hello\n");
		expect((await run(["/bin/echo", "hello"], { timeoutMs: 5000, maxBytes: 1000 })).truncated).toBeUndefined();
		expect((await run(["/bin/echo", "hello"], { timeoutMs: 5000 })).truncated).toBeUndefined();
	});

	test("a multibyte character cut by the limit is dropped, not shown as a replacement character", async () => {
		const ran = await run(["/usr/bin/printf", "ab\\344\\270\\255cd"], { timeoutMs: 5000, maxBytes: 4 });
		expect(ran.stdout).toBe("ab");
		expect(ran.truncated).toBe(true);
	});
});

describe("a list of changes whose git answer was cut at the byte limit", () => {
	const repo = { toplevel: "/r", gitDir: "/r/.git", prefix: "" };
	const ran = (stdout: string, over: Partial<Ran> = {}): Ran => ({ code: 0, stdout, stderr: "", ...over });
	const listOf = (...answers: Ran[]) => {
		const left = [...answers];
		return listChanges(async () => left.shift() ?? null, repo, 1000, {});
	};
	const rawRecord = (path: string) => `:100644 100644 ${SHA.slice(0, 7)} ${ZERO.slice(0, 7)} M\0${path}\0`;
	const head = [`# branch.oid ${SHA}`, "# branch.head main"];

	test("a status that was killed at the limit is the first of its files, marked, and the record it was cut in is left out", async () => {
		const cut = `${status(...head, "? a.txt", "? b.txt")}? c.tx`;
		const read = await listOf(ran(cut, { code: 137, truncated: true }), ran(""));
		expect(read).toMatchObject({ files: [{ path: "a.txt" }, { path: "b.txt" }], truncated: true });
	});

	test("so is a diff of changes killed at the limit: what it counted before is kept, and the cut record is not read", async () => {
		const diff = `${rawRecord("a.txt")}${rawRecord("b.txt")}:100644 100644 abc`;
		const read = await listOf(ran(status(...head)), ran(diff, { code: 137, truncated: true }));
		expect(read).toMatchObject({ files: [{ path: "a.txt" }, { path: "b.txt" }], truncated: true });
	});

	test("an answer that is an error without being cut is a failure, and so is one with no branch in it", async () => {
		expect(await listOf(ran("fatal: bad object", { code: 128 }))).toBe("failed");
		expect(await listOf(ran(status(...head)), ran("", { code: 128 }))).toBe("failed");
		expect(await listOf(ran("fatal: not a git repository\0"))).toBe("failed");
	});

	test("answers that are not cut and not failed are not marked", async () => {
		const read = await listOf(ran(status(...head, "? a.txt")), ran(""));
		expect(read).toMatchObject({ files: [{ path: "a.txt" }], truncated: false });
	});
});
