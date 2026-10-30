import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DirError } from "../../server/dirs.ts";
import { ProjectError, ProjectsFolder } from "../../server/projects.ts";
import { PROJECT_NAME_MAX, projectNameProblem } from "../../shared/projects.ts";
import { tempDir } from "../support/temp-dirs.ts";

/**
 * The projects folder (Settings › Projects folder) and "New project folder" in a new chat's folder picker (#615): what a
 * name may be, where a folder is made, and that nothing is ever made outside the projects folder or over what is there.
 * Everything happens in a temporary root.
 */

const root = tempDir("ompw-projects-");
// A test makes nothing outside the root; the root goes when the tests end.

/** A server's world: a home folder, and a data dir for the setting. */
let worlds = 0;
function world() {
	const base = join(root, `world-${++worlds}`);
	const home = join(base, "home");
	const data = join(base, "data");
	mkdirSync(home, { recursive: true });
	mkdirSync(data, { recursive: true });
	return { base, home, data, projects: new ProjectsFolder(data, home) };
}

/** Everything under `dir`, relative, folders and files: what a refused name must leave exactly as it was. */
function tree(dir: string, prefix = ""): string[] {
	return readdirSync(dir, { withFileTypes: true })
		.flatMap((e) => [`${prefix}${e.name}`, ...(e.isDirectory() ? tree(join(dir, e.name), `${prefix}${e.name}/`) : [])])
		.sort();
}

const problemOf = (fn: () => unknown) => {
	try {
		fn();
	} catch (e) {
		if (e instanceof ProjectError) return e.problem;
		throw e;
	}
	return null;
};

test("a name is one plain folder name: what else is refused, and why", () => {
	expect(projectNameProblem("my-project")).toBeNull();
	expect(projectNameProblem("My Project 2")).toBeNull();
	expect(projectNameProblem("项目_一")).toBeNull();
	expect(projectNameProblem("a.b")).toBeNull();
	expect(projectNameProblem("")).toBe("empty");
	for (const bad of ["a/b", "/abs", "..\\x", "a\\b", "x/", "../x", "~/x/../.."]) {
		expect(projectNameProblem(bad)).toBe("separator");
	}
	for (const bad of [".", "..", ".hidden", "...", ".git"]) expect(projectNameProblem(bad)).toBe("dot");
	for (const bad of [" lead", "trail ", "\tx", "dots.", "dots.."]) expect(projectNameProblem(bad)).toBe("space");
	for (const bad of ["a\nb", "a\0b", "a\u007fb", "a:b", "a*b", 'a"b', "a<b", "a>b", "a|b", "a?b"]) {
		expect(projectNameProblem(bad)).toBe("invalid");
	}
});

test("a name has at most 100 characters and 255 bytes", () => {
	expect(projectNameProblem("a".repeat(PROJECT_NAME_MAX))).toBeNull();
	expect(projectNameProblem("a".repeat(PROJECT_NAME_MAX + 1))).toBe("tooLong");
	// 100 characters that are 300 bytes: the file system's limit is in bytes.
	expect(projectNameProblem("项".repeat(PROJECT_NAME_MAX))).toBe("tooLong");
	expect(projectNameProblem("项".repeat(80))).toBeNull();
});

test("nothing chosen is ~/omp, shown while it is not there, and made by the first project folder", () => {
	const w = world();
	const usual = join(w.home, "omp");
	// Looking does not make it, however often.
	expect(w.projects.info()).toEqual({ folder: usual, isDefault: true, exists: true });
	expect(w.projects.info().folder).toBe(usual);
	expect(tree(w.home)).toEqual([]);
	const made = w.projects.create("first");
	expect(made.path).toBe(join(usual, "first"));
	expect(tree(w.home)).toEqual(["omp", "omp/first"]);
	expect(w.projects.info()).toEqual({ folder: usual, isDefault: true, exists: true });
	// Once there, it is used as it is.
	expect(w.projects.create("second").path).toBe(join(usual, "second"));
	expect(tree(w.home)).toEqual(["omp", "omp/first", "omp/second"]);
});

test("~/omp is made alone: never its parents, and never over a file or a link that is there", () => {
	const w = world();
	// A home that is not there: only ~/omp itself would be made, so nothing is.
	const away = join(w.base, "no-home");
	expect(problemOf(() => new ProjectsFolder(w.data, away).create("x"))).toBe("folderGone");
	expect(tree(w.base)).toEqual(["data", "home"]);

	const before = tree(w.base);
	// A file is at ~/omp, then a link to nothing, then a link to a folder (which is a folder, and is used).
	writeFileSync(join(w.home, "omp"), "mine");
	expect(w.projects.info()).toEqual({ folder: join(w.home, "omp"), isDefault: true, exists: false });
	expect(problemOf(() => w.projects.create("x"))).toBe("notFolder");
	expect(readFileSync(join(w.home, "omp"), "utf8")).toBe("mine");
	expect(tree(w.base)).toEqual([...before, "home/omp"].sort());

	const w2 = world();
	symlinkSync(join(w2.base, "nowhere"), join(w2.home, "omp"));
	const before2 = tree(w2.base);
	expect(w2.projects.info().exists).toBe(false);
	expect(problemOf(() => w2.projects.create("x"))).toBe("notFolder");
	expect(tree(w2.base)).toEqual(before2);
	expect(existsSync(join(w2.base, "nowhere"))).toBe(false);

	const w3 = world();
	mkdirSync(join(w3.base, "real"));
	symlinkSync(join(w3.base, "real"), join(w3.home, "omp"));
	expect(w3.projects.create("y").path).toBe(join(w3.home, "omp", "y"));
	expect(readdirSync(join(w3.base, "real"))).toEqual(["y"]);
});

test("a chosen folder is kept, `~` is the home folder, and null goes back to the default", () => {
	const w = world();
	mkdirSync(join(w.home, "work", "apps"), { recursive: true });
	expect(w.projects.set("~/work")).toEqual({ folder: join(w.home, "work"), isDefault: false, exists: true });
	// Kept by the file, not by the object: a second server on the data dir sees it.
	expect(new ProjectsFolder(w.data, w.home).info().folder).toBe(join(w.home, "work"));
	expect(w.projects.set(join(w.home, "work", "apps")).folder).toBe(join(w.home, "work", "apps"));
	expect(w.projects.set("  ~/work/apps/../  ").folder).toBe(join(w.home, "work"));
	expect(w.projects.set(null)).toEqual({ folder: join(w.home, "omp"), isDefault: true, exists: true });
	expect(w.projects.set("").isDefault).toBe(true);
});

test("a folder that cannot be a projects folder is refused with the folder picker's own reasons, and the setting stays", () => {
	const w = world();
	mkdirSync(join(w.home, "work"));
	writeFileSync(join(w.home, "file.txt"), "x");
	w.projects.set("~/work");
	const refused = (path: string) => {
		try {
			w.projects.set(path);
		} catch (e) {
			if (e instanceof DirError) return { code: e.code, status: e.status };
			throw e;
		}
		return null;
	};
	expect(refused("work")).toEqual({ code: "dirRelative", status: 400 });
	expect(refused("~/missing")).toEqual({ code: "dirNotFound", status: 404 });
	expect(refused("~/file.txt")).toEqual({ code: "dirNotFolder", status: 400 });
	expect(w.projects.info().folder).toBe(join(w.home, "work"));
});

test("a folder that cannot be written to is refused, when the tests are not run as root", () => {
	if (process.getuid?.() === 0) return;
	const w = world();
	const locked = join(w.base, "readonly");
	mkdirSync(locked);
	chmodSync(locked, 0o555);
	try {
		w.projects.set(locked);
		throw new Error("a folder that cannot be written to was accepted");
	} catch (e) {
		expect(e).toBeInstanceOf(DirError);
		expect(e).toMatchObject({ code: "dirNotWritable", status: 403 });
	}
	chmodSync(locked, 0o755);
});

test("a corrupt or foreign settings file is the default, never an error", () => {
	const w = world();
	for (const text of ["{", "[]", "null", '{"folder": 3}', '{"folder": "relative/path"}', '{"folder": ["/x"]}']) {
		writeFileSync(join(w.data, "projects-folder.json"), text);
		expect(w.projects.info()).toEqual({ folder: join(w.home, "omp"), isDefault: true, exists: true });
	}
});

test("a project folder is made directly in the projects folder, and only there", () => {
	const w = world();
	mkdirSync(join(w.home, "omp"));
	const made = w.projects.create("alpha");
	expect(made.path).toBe(join(w.home, "omp", "alpha"));
	expect(made.info.folder).toBe(join(w.home, "omp"));
	expect(existsSync(made.path)).toBe(true);
	expect(readdirSync(made.path)).toEqual([]);
	w.projects.set("~");
	expect(w.projects.create("beta").path).toBe(join(w.home, "beta"));
	expect(tree(w.home)).toEqual(["beta", "omp", "omp/alpha"]);
});

test("a name that is a path, or goes up, makes nothing anywhere", () => {
	const w = world();
	mkdirSync(join(w.home, "omp"));
	mkdirSync(join(w.base, "outside"));
	const before = tree(w.base);
	for (const bad of ["../outside/x", "..", ".", "a/b", "/tmp/ompw-escape", "..\\x", ".x", "a/../b"]) {
		expect(problemOf(() => w.projects.create(bad))).not.toBeNull();
	}
	// Not names at all.
	for (const bad of [undefined, null, 3, ["a"], { toString: () => "a" }]) {
		expect(problemOf(() => w.projects.create(bad))).toBe("invalid");
	}
	expect(problemOf(() => w.projects.create(""))).toBe("empty");
	expect(problemOf(() => w.projects.create("x".repeat(101)))).toBe("tooLong");
	expect(tree(w.base)).toEqual(before);
});

test("a folder, a file or a link that is there is never overwritten: the name is taken", () => {
	const w = world();
	const projects = join(w.home, "omp");
	mkdirSync(join(projects, "folder"), { recursive: true });
	writeFileSync(join(projects, "folder", "keep.txt"), "mine");
	writeFileSync(join(projects, "file"), "mine");
	mkdirSync(join(w.base, "elsewhere"));
	symlinkSync(join(w.base, "elsewhere"), join(projects, "link"));
	symlinkSync(join(w.base, "nowhere"), join(projects, "dangling"));
	const before = tree(w.base);
	for (const taken of ["folder", "file", "link", "dangling"]) {
		expect(problemOf(() => w.projects.create(taken))).toBe("exists");
	}
	expect(tree(w.base)).toEqual(before);
	expect(readFileSync(join(projects, "folder", "keep.txt"), "utf8")).toBe("mine");
	expect(readFileSync(join(projects, "file"), "utf8")).toBe("mine");
});

test("the same name twice is made once", () => {
	const w = world();
	expect(w.projects.create("once").path).toBe(join(w.home, "omp", "once"));
	expect(problemOf(() => w.projects.create("once"))).toBe("exists");
});

test("a chosen projects folder that has gone is said so, and nothing is made in its place", () => {
	const w = world();
	// A folder that was chosen and is not there now: the setting is the file's, so it is written as it would stand after
	// the folder was moved away.
	writeFileSync(join(w.data, "projects-folder.json"), JSON.stringify({ folder: join(w.home, "work") }));
	expect(w.projects.info()).toEqual({ folder: join(w.home, "work"), isDefault: false, exists: false });
	expect(problemOf(() => w.projects.create("x"))).toBe("folderGone");
	expect(existsSync(join(w.home, "work"))).toBe(false);
});

test("a projects folder that cannot be written to is refused with its own reason, when the tests are not run as root", () => {
	if (process.getuid?.() === 0) return;
	const w = world();
	const locked = join(w.base, "ro");
	mkdirSync(locked);
	w.projects.set(locked);
	chmodSync(locked, 0o555);
	try {
		expect(problemOf(() => w.projects.create("x"))).toBe("noAccess");
	} finally {
		chmodSync(locked, 0o755);
	}
	expect(readdirSync(locked)).toEqual([]);
});
