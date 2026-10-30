import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HOOKS } from "../../scripts/install-hooks.ts";

/**
 * scripts/install-hooks.ts, which `bun install` runs: it writes the hooks of a fresh clone, keeps a hook it did not write,
 * and never fails, whatever it finds (no repository, no git, a linked worktree, `core.hooksPath`).
 */

const ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, "scripts", "install-hooks.ts");
const MINE = "#!/bin/sh\necho mine\n";

/** This process's environment without git's own variables, which would point git elsewhere. */
const clean = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")));

let base: string;
beforeEach(() => {
	base = realpathSync(mkdtempSync(join(tmpdir(), "ompw-hooks-")));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): void {
	const r = Bun.spawnSync(["git", ...args], { cwd, env: clean(), stdout: "pipe", stderr: "pipe" });
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

function repo(name = "repo"): string {
	const dir = join(base, name);
	mkdirSync(dir);
	git(dir, "init", "-q", "-b", "main");
	return dir;
}

function install(cwd: string, env: Record<string, string | undefined> = clean()) {
	const r = Bun.spawnSync([process.execPath, SCRIPT], { cwd, env, stdout: "pipe", stderr: "pipe" });
	return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const hook = (dir: string, name: string) => join(dir, ".git", "hooks", name);

test("`bun install` runs it", () => {
	const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
	expect(pkg.scripts.prepare).toBe("bun scripts/install-hooks.ts");
});

test("a fresh clone gets both hooks, executable; a second run changes and prints nothing", () => {
	const dir = repo();
	const first = install(dir);
	expect(first.code).toBe(0);
	expect(first.err).toBe("");
	for (const name of Object.keys(HOOKS)) {
		expect(readFileSync(hook(dir, name), "utf8")).toBe(HOOKS[name]);
		expect(statSync(hook(dir, name)).mode & 0o111).toBe(0o111);
		expect(first.out).toContain(`Installed ${hook(dir, name)}\n`);
	}
	expect(install(dir)).toEqual({ code: 0, out: "", err: "" });

	// A hook it wrote, from an older version of the script, is replaced.
	writeFileSync(hook(dir, "pre-commit"), HOOKS["pre-commit"].replace("--staged", "--old"));
	const again = install(dir);
	expect(again.code).toBe(0);
	expect(again.out.trim().split("\n")).toEqual([`Installed ${hook(dir, "pre-commit")}`]);
	expect(readFileSync(hook(dir, "pre-commit"), "utf8")).toBe(HOOKS["pre-commit"]);
});

test("a hook it did not write is kept, with a one-line notice, and the run still succeeds", () => {
	const dir = repo();
	mkdirSync(join(dir, ".git", "hooks"), { recursive: true });
	writeFileSync(hook(dir, "pre-commit"), MINE);
	const r = install(dir);
	expect(r.code).toBe(0);
	expect(readFileSync(hook(dir, "pre-commit"), "utf8")).toBe(MINE);
	expect(r.err.trim().split("\n")).toHaveLength(1);
	expect(r.err).toContain(`${hook(dir, "pre-commit")} was not written by scripts/install-hooks.ts: left as it is`);
	expect(readFileSync(hook(dir, "pre-push"), "utf8")).toBe(HOOKS["pre-push"]);
});

test("outside a git checkout, or with no git at all, it does nothing and succeeds", () => {
	const plain = join(base, "tarball");
	mkdirSync(plain);
	expect(install(plain)).toEqual({ code: 0, out: "", err: "" });
	expect(existsSync(join(plain, ".git"))).toBe(false);

	// A copy unpacked inside some other repository: that repository's hooks are not touched.
	const outer = repo("outer");
	const inner = join(outer, "omp-webui");
	mkdirSync(inner);
	expect(install(inner)).toEqual({ code: 0, out: "", err: "" });
	expect(existsSync(hook(outer, "pre-commit"))).toBe(false);

	// No git on PATH (only bun's own folder).
	const dir = repo();
	expect(install(dir, { ...clean(), PATH: join(process.execPath, "..") })).toEqual({ code: 0, out: "", err: "" });
	expect(existsSync(hook(dir, "pre-commit"))).toBe(false);
});

test("in a linked worktree it installs into the common git dir every worktree shares", () => {
	const dir = repo();
	writeFileSync(join(dir, "f"), "x");
	git(dir, "add", "f");
	git(dir, "-c", "user.name=n", "-c", "user.email=jdoe@example.com", "commit", "-q", "-m", "c");
	const wt = join(base, "wt");
	git(dir, "worktree", "add", "-q", wt, "-b", "side");
	const r = install(wt);
	expect(r.code).toBe(0);
	expect(r.err).toBe("");
	for (const name of Object.keys(HOOKS)) expect(readFileSync(hook(dir, name), "utf8")).toBe(HOOKS[name]);
	expect(install(wt)).toEqual({ code: 0, out: "", err: "" });
	expect(install(dir)).toEqual({ code: 0, out: "", err: "" });
});

test("with core.hooksPath set it writes nothing and says so in one line", () => {
	const dir = repo();
	git(dir, "config", "core.hooksPath", ".husky");
	const r = install(dir);
	expect(r.code).toBe(0);
	expect(r.out).toBe("");
	expect(r.err.trim().split("\n")).toHaveLength(1);
	expect(r.err).toContain("core.hooksPath is set (.husky)");
	expect(existsSync(join(dir, ".husky"))).toBe(false);
	expect(existsSync(hook(dir, "pre-commit"))).toBe(false);
});
