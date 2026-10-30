import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DirError, listDirs } from "../../server/dirs.ts";
import { DIR_LIST_MAX } from "../../shared/dirs.ts";

/**
 * The folder picker's listing. It lists what a person can click into: `~` is their home, a symlink to a folder is a
 * folder (project folders on other volumes are often links), a list that was cut says how much it left out, and a path
 * that cannot be listed is told in a short sentence rather than as the system's ENOENT with the server's own path (#438).
 */

const root = mkdtempSync(join(tmpdir(), "ompw-dirs-"));
afterAll(() => {
	chmodSync(join(root, "locked"), 0o755);
	rmSync(root, { recursive: true, force: true });
});
const home = join(root, "home");
mkdirSync(join(home, "work", "proj"), { recursive: true });
mkdirSync(join(root, "locked"));

test("`~` and `~/x` are the home folder and a folder in it, an empty path is the home folder", () => {
	expect(listDirs("~", home)).toMatchObject({ path: home, dirs: ["work"] });
	expect(listDirs("~/work", home)).toMatchObject({ path: join(home, "work"), parent: home, dirs: ["proj"] });
	expect(listDirs("", home).path).toBe(home);
	expect(listDirs("~/work/../work/", home).path).toBe(join(home, "work"));
});

test("a relative path is refused, not resolved against wherever the server happens to run", () => {
	for (const bad of ["work", "./work", "../x", "~user/x", "~work"]) {
		expect(() => listDirs(bad, home)).toThrow(DirError);
		try {
			listDirs(bad, home);
		} catch (e) {
			expect(e).toMatchObject({ status: 400, code: "dirRelative", params: { path: bad } });
		}
	}
});

test("a symlink to a folder is listed, one to a file or to nothing is not, and dot folders stay hidden", () => {
	const dir = join(root, "links");
	mkdirSync(join(dir, "real"), { recursive: true });
	mkdirSync(join(dir, ".hidden"));
	writeFileSync(join(dir, "file.txt"), "x");
	symlinkSync(join(dir, "real"), join(dir, "linkproj"));
	symlinkSync(join(dir, "file.txt"), join(dir, "linkfile"));
	symlinkSync(join(dir, "gone"), join(dir, "dangling"));
	expect(listDirs(dir, home).dirs).toEqual(["linkproj", "real"]);
});

test("more folders than the list holds: the first ones, in order, and how many were left out", () => {
	const dir = join(root, "many");
	const total = DIR_LIST_MAX + 120;
	for (let i = 1; i <= total; i++) mkdirSync(join(dir, `proj${String(i).padStart(4, "0")}`), { recursive: true });
	const listing = listDirs(dir, home);
	expect(listing.dirs).toHaveLength(DIR_LIST_MAX);
	expect(listing.dirs[0]).toBe("proj0001");
	expect(listing.dirs.at(-1)).toBe(`proj${String(DIR_LIST_MAX).padStart(4, "0")}`);
	expect(listing.omitted).toBe(120);
	expect(listDirs(join(root, "links"), home).omitted).toBe(0);
});

test("a path that cannot be listed says why in a few words, with the status that fits", () => {
	const file = join(root, "links", "file.txt");
	const cases: [string, number, string][] = [
		[join(root, "nowhere", "x"), 404, "dirNotFound"],
		[file, 400, "dirNotFolder"],
	];
	// Whoever runs the tests as root can open any folder.
	if (process.getuid?.() !== 0) {
		chmodSync(join(root, "locked"), 0o000);
		cases.push([join(root, "locked"), 403, "dirNoAccess"]);
	}
	for (const [path, status, code] of cases) {
		try {
			listDirs(path, home);
			throw new Error(`${path} was listed`);
		} catch (e) {
			if (!(e instanceof DirError)) throw e;
			expect(e).toMatchObject({ status, code, params: { path } });
			// Not the system's wording, which names the call that failed.
			expect(e.message).not.toMatch(/ENOENT|ENOTDIR|EACCES|scandir/);
		}
	}
});
