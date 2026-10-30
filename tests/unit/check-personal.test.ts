import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanBytes, wordPattern } from "../../scripts/check-personal.ts";
import { ZipWriter } from "../../server/migrate/zip.ts";

/**
 * scripts/check-personal.ts: the patterns that need no private list (each catches a real-looking value and lets the
 * placeholders through), binary files and zip members, this machine's words, and the staged, range and tree modes in a
 * throwaway repository. Every value below is made up.
 */

const ROOT = join(import.meta.dir, "..", "..");
const SCRIPT = join(ROOT, "scripts", "check-personal.ts");
const NOREPLY = "273716724+9s94ttyfct-bit@users.noreply.github.com";

const scan = (text: string) => scanBytes(Buffer.from(text), "f", null);
/**
 * A sample of personal-looking data, written with a `§` the checker's patterns stop at, so that this file passes the check
 * it tests; the `§` is taken out before the sample is used.
 */
const u = (s: string) => s.replaceAll("§", "");

test("a macOS temporary folder is caught, in a path or in omp's session folder name; a made-up one says `example`", async () => {
	for (const text of [
		u("/var/folders/k3/§x8q2mvbn5c1zr9t7wl0p4hd60000gp/T/ompw-1"),
		u("--var-folders-k3-§x8q2mvbn5c1zr9t7wl0p4hd60000gp-T-proj--"),
	]) {
		expect((await scan(text)).join(), text).toContain("temporary folder");
	}
	for (const text of [
		"/var/folders/q7/zz00example00tmpdir000000000gn/T",
		"/var/folders/xx/AppTranslocation/x",
		"/tmp/ompw-1",
	]) {
		expect(await scan(text), text).toEqual([]);
	}
});

test("a home folder is caught unless its user is a placeholder", async () => {
	for (const text of [
		u("/Users/§mpetrova/proj"),
		u("/home/§kwanjiru/.omp"),
		u("C:\\Users\\§Rafael\\x"),
		u("--Users-§mpetrova-proj--"),
	]) {
		expect((await scan(text)).join(), text).toContain("home folder");
	}
	for (const text of [
		"/Users/jdoe/proj",
		"/Users/jdoe2/x",
		"/home/me/x",
		"/Users/Shared/x",
		"/Users/alice.",
		"/home/.omp",
		"--Users-jdoe-legacy--",
		"/Users/$USER/x",
	]) {
		expect(await scan(text), text).toEqual([]);
	}
});

test("an e-mail address is caught outside the reserved and placeholder domains; file names are not addresses", async () => {
	for (const text of [u("mail mpetrova@§gmail.com"), u("k.wanjiru@§uni.ac.ke"), u("someone@§outlook.com")]) {
		expect((await scan(text)).join(), text).toContain("e-mail address");
	}
	for (const text of [
		"jdoe@example.com",
		"a@b.example",
		"x@db.example.test",
		"y@host.invalid",
		NOREPLY,
		"https://ghp_x@github.com/o/r",
		"icon@2x.png",
		"n@a.ts",
		"@biomejs/biome",
	]) {
		expect(await scan(text), text).toEqual([]);
	}
});

test("a private network address is caught outside the placeholder ones; public and documentation addresses are not", async () => {
	for (const text of [u("10.99.§17.40"), u("http://172.18.§4.9/"), u("192.168.§7.23"), u("100.71.§3.9")]) {
		expect((await scan(text)).join(), text).toContain("private network address");
	}
	for (const text of [
		"10.0.0.5",
		"192.168.1.20",
		"172.16.0.1",
		"10.255.255.255",
		"203.0.113.9",
		"8.8.8.8",
		"v1.2.3.4.5",
		"1.10.99.1.9",
	]) {
		expect(await scan(text), text).toEqual([]);
	}
});

test("a finding names the place and the rule, never the text it matched", async () => {
	const found = await scanBytes(
		Buffer.from(u("ok\nmail mpetrova@§gmail.com\n")),
		"docs/x.md",
		wordPattern(["Zorblat"]),
	);
	expect(found).toEqual(["docs/x.md:2: e-mail address (use an address at example.com, .test or .invalid)"]);
	expect((await scanBytes(Buffer.from("by zorblat"), "y", wordPattern(["Zorblat"])))[0]).not.toContain("orblat");
});

test("a binary file is read as bytes, without the e-mail rule that random bytes could match", async () => {
	const bytes = Buffer.concat([
		Buffer.from([0, 1, 2, 0xff]),
		Buffer.from(u("/Users/§mpetrova/x mpetrova@§gmail.com Zorblat")),
	]);
	const found = (await scanBytes(bytes, "img.bin", wordPattern(["Zorblat"]))).join("\n");
	expect(found).toContain("img.bin (binary): home folder");
	expect(found).toContain("img.bin (binary): this machine's personal words");
	expect(found).not.toContain("e-mail");
});

let base: string;
beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "ompw-personal-test-"));
});
afterEach(() => rmSync(base, { recursive: true, force: true }));

test("a zip is opened: its members' content and names are read, compressed or not", async () => {
	const file = join(base, "a.ompw");
	const zip = await ZipWriter.create(file);
	await zip.add("ok.txt", Buffer.from("nothing here"));
	const session = u("agent/sessions/--var-folders-k3-§x8q2mvbn5c1zr9t7wl0p4hd60000gp-T-p--/s.jsonl");
	await zip.add(session, Buffer.from("{}"));
	await zip.add("data.db", Buffer.concat([Buffer.from([0, 0]), Buffer.from(u("/home/§kwanjiru/x"))]), {
		compress: true,
	});
	await zip.add("cfg.json", Buffer.from(u('{\n"ip": "10.99.§17.40"\n}')), { compress: false });
	await zip.finish();
	const found = await scanBytes(await Bun.file(file).bytes(), "a.ompw", null);
	expect(found).toEqual([
		`a.ompw:${session} (member name): temporary folder (use a made-up /var/folders/<xx>/<id> with \`example\` in the id, or /tmp)`,
		"a.ompw:data.db (binary): home folder (use a placeholder user: jdoe, me, alice, dev, someone)",
		"a.ompw:cfg.json:2: private network address (use 10.0.0.x, 192.168.1.x, or a documentation range (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24))",
	]);
});

// ------------------------------------------------------------------ the modes, in a throwaway repository

function git(cwd: string, ...args: string[]): string {
	const r = Bun.spawnSync(["git", ...args], {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "n",
			GIT_AUTHOR_EMAIL: NOREPLY,
			GIT_COMMITTER_NAME: "n",
			GIT_COMMITTER_EMAIL: NOREPLY,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
	return r.stdout.toString().trim();
}

/** The script run in `cwd`, outside any GitHub Actions event. */
function check(cwd: string, args: string[] = []) {
	const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("GITHUB_")));
	const r = Bun.spawnSync([process.execPath, SCRIPT, ...args], { cwd, env, stdout: "pipe", stderr: "pipe" });
	return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

function repo(): string {
	const dir = join(base, "repo");
	mkdirSync(dir);
	git(dir, "init", "-q", "-b", "main");
	writeFileSync(join(dir, "a.md"), "/Users/jdoe/x\n");
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "first");
	return dir;
}

test("the tree mode reads every tracked file, and this machine's words from .personal-words, never printing them", () => {
	const dir = repo();
	expect(check(dir).code).toBe(0);
	writeFileSync(join(dir, ".personal-words"), "Zorblat Quux\n");
	writeFileSync(join(dir, "b.md"), "written by zorblat quux\n");
	git(dir, "add", "b.md");
	const r = check(dir);
	expect(r.code).toBe(1);
	expect(r.out).toContain("b.md:1: this machine's personal words");
	expect(r.out.toLowerCase()).not.toContain("zorblat");
});

test("the staged mode reads what is staged, not what is only in the working tree", () => {
	const dir = repo();
	writeFileSync(join(dir, "a.md"), u("/Users/§mpetrova/x\n"));
	expect(check(dir, ["--staged"]).code).toBe(0);
	git(dir, "add", "a.md");
	const r = check(dir, ["--staged"]);
	expect(r.code).toBe(1);
	expect(r.out).toContain("a.md:1: home folder");
});

test("the range mode reads the files each commit adds or changes, and the commits' messages", () => {
	const dir = repo();
	const first = git(dir, "rev-parse", "HEAD");
	writeFileSync(join(dir, "c.md"), u("at 10.99.§17.40\n"));
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", "second");
	// Removed again: still published by the commit that added it.
	rmSync(join(dir, "c.md"));
	git(dir, "add", "-A");
	git(dir, "commit", "-q", "-m", u("from mpetrova@§gmail.com"));
	const r = check(dir, ["--range", `${first}..HEAD`]);
	expect(r.code).toBe(1);
	expect(r.out).toContain("c.md:1: private network address");
	expect(r.out).toMatch(/commit [0-9a-f]{12} \(names and message\):\d+: e-mail address/);
	expect(check(dir, ["--range", "HEAD~1", "--not", first]).code).toBe(1);
	expect(check(dir, ["--range", `${first}`]).code).toBe(0);
});

test("the tree of this repository passes", () => {
	const r = check(ROOT);
	expect(r.out).toContain("No personal data in");
	expect(r.code).toBe(0);
});

test("the hooks `bun run hooks` installs refuse a commit and a push with personal data or another author", () => {
	const dir = repo();
	symlinkSync(join(ROOT, "scripts"), join(dir, "scripts"));
	writeFileSync(join(dir, ".git", "info", "exclude"), "scripts\n");
	Bun.spawnSync(["git", "init", "--bare", "-q", join(base, "origin.git")]);
	git(dir, "remote", "add", "origin", join(base, "origin.git"));
	const env = { ...process.env, PATH: `${join(process.execPath, "..")}:${process.env.PATH}` };
	const run = (cmd: string[], extra: Record<string, string> = {}) =>
		Bun.spawnSync(cmd, { cwd: dir, env: { ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
	expect(run([process.execPath, join(ROOT, "scripts", "install-hooks.ts")]).exitCode).toBe(0);
	const id = { GIT_AUTHOR_NAME: "n", GIT_AUTHOR_EMAIL: NOREPLY, GIT_COMMITTER_NAME: "n", GIT_COMMITTER_EMAIL: NOREPLY };
	expect(run(["git", "push", "-q", "origin", "main"], id).exitCode).toBe(0);

	writeFileSync(join(dir, "d.md"), u("/home/§kwanjiru/x\n"));
	run(["git", "add", "d.md"]);
	const refused = run(["git", "commit", "-q", "-m", "d"], id);
	expect(refused.exitCode).not.toBe(0);
	expect(refused.stderr.toString()).toContain("d.md:1: home folder");

	writeFileSync(join(dir, "d.md"), "/home/jdoe/x\n");
	run(["git", "add", "d.md"]);
	const other = { ...id, GIT_AUTHOR_EMAIL: "mpetrova@example.com" };
	expect(run(["git", "commit", "-q", "-m", "d"], other).exitCode).toBe(0);
	const push = run(["git", "push", "-q", "origin", "main"], id);
	expect(push.exitCode).not.toBe(0);
	expect(push.stderr.toString()).toContain("author mpetrova@example.com");
});
