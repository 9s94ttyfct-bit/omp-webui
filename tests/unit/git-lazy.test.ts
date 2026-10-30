import { afterAll, beforeAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LazyGit } from "../../server/git-lazy.ts";

/** What the status line and the Files tab ask of git, through the loader that brings `git.ts` in on the first ask (`git-lazy.ts`). */

let folder: string;
let repository: string;
beforeAll(() => {
	folder = realpathSync(mkdtempSync(join(tmpdir(), "ompw-git-lazy-")));
	repository = join(folder, "repo");
	execFileSync("git", ["init", "-q", "-b", "main", repository]);
	writeFileSync(join(repository, "new.txt"), "x");
});
afterAll(() => rmSync(folder, { recursive: true, force: true }));

test("the folder is told as git.ts tells it, and what is not one is refused as it refuses it", async () => {
	const lazy = new LazyGit();
	expect(await lazy.directoryOf(folder)).toBe(folder);
	await expect(lazy.directoryOf("relative/folder")).rejects.toThrow("Not a directory");
	await expect(lazy.directoryOf(join(folder, "missing"))).rejects.toThrow("Not a directory");
});

test("a folder that is no repository has no status and no marks", async () => {
	const lazy = new LazyGit();
	expect((await lazy.report(folder)).git).toBeNull();
	expect(await lazy.marks(folder)).toBeNull();
});

test("a repository's branch, changes and marks are read through the one probe", async () => {
	const lazy = new LazyGit();
	const [report, marks] = await Promise.all([lazy.report(repository), lazy.marks(repository)]);
	expect(report.git?.branch).toBe("main");
	expect(report.git?.untracked).toBe(1);
	expect(marks).not.toBeNull();
});
