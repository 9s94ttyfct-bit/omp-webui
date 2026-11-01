// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the snippets are source text, template literals included
import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ALLOWLIST, checkSource, checkTree, scopeFiles } from "../../scripts/check-platform.ts";

/**
 * scripts/check-platform.ts (in `bun run lint`): outside server/platform/ nothing asks the operating system itself. Each
 * snippet is one file's text; what it flags is named by line.
 */

const root = join(import.meta.dir, "..", "..");
const lines = (src: string) => checkSource(src, "f.ts").map((p) => Number(p.at.split(":")[1]));
const flagged = (src: string) => expect(lines(src).length, src).toBeGreaterThan(0);
const clean = (src: string) => expect(checkSource(src, "f.ts"), src).toEqual([]);

test("process.platform, getuid and node:os's platform are flagged", () => {
	flagged('if (process.platform === "win32") {}');
	flagged("const p = process.platform;");
	flagged("const uid = process.getuid?.();");
	flagged('import { arch, platform } from "node:os";');
	flagged('import { platform as osPlatform } from "os";');
	// Another module's `platform`, and a name that only looks like it, are not the system's.
	clean('import { platform } from "./platform/index.ts";\nconst id = platform.id;');
	clean('import { arch } from "node:os";\nconst x = { platform: "darwin" };');
	clean("const p = processes.platform;");
});

test("signals Windows has not, and a process group, are flagged; the portable ones are not", () => {
	flagged('process.kill(pid, "SIGSTOP");');
	flagged('process.kill(pid, "SIGUSR1");');
	flagged('child.kill("SIGHUP");');
	flagged('process.kill(-pid, "SIGTERM");');
	clean('process.kill(pid, "SIGTERM");');
	clean('process.kill(pid, "SIGKILL");');
	clean("process.kill(pid, 0);");
	clean('child.kill("SIGINT");');
	// A signal that is not a literal is the adapter's business to have chosen.
	clean("process.kill(pid, signal);");
});

test("macOS and POSIX commands run by name, shells given a string, POSIX paths and /tmp are flagged", () => {
	flagged('Bun.spawn(["ps", "-A", "-o", "pid="]);');
	flagged('await run(["lsof", "-t", "--", lock], { timeoutMs: 1 });');
	flagged('const argv = ["open", abs];');
	flagged('execFileSync("sw_vers", ["-productVersion"]);');
	flagged('spawn("caffeinate", ["-i"]);');
	flagged('Bun.spawnSync(["launchctl", "managername"]);');
	flagged("await $`osascript -e ${script}`;");
	flagged('spawn(["sh", "-c", command]);');
	flagged('const argv = ["bash", "-lc", line, x];');
	flagged('const bin = "/usr/bin/caffeinate";');
	flagged('run(["/bin/sh", "x"]);');
	flagged('const dir = "/tmp";');
	flagged("const sock = `/tmp/ompw-${id}.sock`;");
	// Words in a list, a command in a comment or a sentence, and a path that only contains /tmp are not.
	clean('const states = ["open", "closed", "all"];');
	clean('for (const t of ["open", "message", "error", "close"] as const) {}');
	clean('// run `ps -A` here\nconst a = 1; /* "/usr/bin/open" */');
	clean('const hint = "Open the folder with open";');
	clean('const p = join(tmpdir(), "x/tmp/y");');
	clean('Bun.spawn(["git", "status"]);');
	clean('const argv = ["sh", script];');
});

test("template literals and regular expressions are read as the compiler reads them", () => {
	// Code inside a substitution is code; text after it is still the template's.
	flagged("const s = `a ${process.platform} b`;");
	clean("const s = `${a} /usr/bin/open ${b}`;");
	clean("const r = /\\/tmp\\//; const t = `${x}`;");
	clean('const r = /"ps"/.test(a);');
	expect(lines("const a = `${b}\n${c}`;\nprocess.getuid?.();")).toEqual([3]);
});

test("an allow comment with a reason allows its own line, or the next when it is alone on its line", () => {
	clean('const dir = "/tmp"; // platform-allow: a path the classifier compares with');
	clean('// platform-allow: a recorded transcript\'s path, text the page shows\nconst p = "/tmp/a.ts";');
	// It allows that line only.
	expect(lines('// platform-allow: a recorded path\nconst p = "/tmp/a.ts";\nconst q = "/tmp/b.ts";')).toEqual([3]);
	// Without a reason it allows nothing, and says so.
	const bare = checkSource('// platform-allow\nconst p = "/tmp/a.ts";', "f.ts");
	expect(bare.map((p) => p.what)).toEqual([
		expect.stringContaining("needs a reason"),
		expect.stringContaining("hardcoded /tmp"),
	]);
	// One that allows nothing is an error: it would outlive what it was for.
	expect(checkSource("// platform-allow: once needed\nconst a = 1;", "f.ts")).toEqual([
		{ at: "f.ts:1", what: "this platform-allow allows nothing: remove it" },
	]);
});

test("a file on the allowlist is left alone, and an entry that covers nothing the rules find is an error", () => {
	const files: Record<string, string> = {
		"server/platform/darwin.ts": 'run(["ps", "-A"]);',
		"server/update/service.ts": "const a = 1;",
		"server/x.ts": 'run(["ps", "-A"]);',
	};
	const problems = checkTree(Object.keys(files), (f) => files[f]);
	expect(problems.some((p) => p.at.startsWith("server/platform/"))).toBe(false);
	expect(problems.find((p) => p.at === "server/x.ts:1")).toBeDefined();
	expect(problems.find((p) => p.at === "server/update/")?.what).toContain("take it off");
});

test("every allowlist entry is there and says why; the tree passes", () => {
	for (const [entry, why] of Object.entries(ALLOWLIST)) {
		expect(existsSync(join(root, entry)), entry).toBe(true);
		expect(why.length, entry).toBeGreaterThan(10);
	}
	expect(checkTree(scopeFiles(root), (file) => readFileSync(join(root, file), "utf8"))).toEqual([]);
});

test("`bun run lint` runs the check", () => {
	const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> };
	expect(pkg.scripts.lint).toContain("scripts/check-platform.ts");
});
