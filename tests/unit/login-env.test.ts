import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { importLoginEnv, mergeLoginEnv, parseLoginEnv, readLoginEnv } from "../../server/omp/login-env.ts";

/**
 * The environment of the user's login shell, as the macOS app's server imports it: parsed from what `env -0` prints,
 * merged without the app's own settings, with `PATH` as the shell has it and a fallback when the shell does not
 * answer. The shell is a script that prints what a test says, so nothing here runs the machine's own shell files.
 */

const root = mkdtempSync(join(tmpdir(), "ompw-login-env-"));
let n = 0;
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A directory of this test's own. */
function dir(name = "d"): string {
	const d = join(root, `${name}${++n}`);
	mkdirSync(d, { recursive: true });
	return d;
}

/** A "shell": a script run as `<shell> -ilc <command>`, which does what `body` says instead. */
function fakeShell(body: string): string {
	const path = join(dir("shell"), "zsh");
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

function executable(path: string): string {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, "#!/bin/sh\n");
	chmodSync(path, 0o755);
	return path;
}

/** What a shell prints for the server: the marker, then NUL-terminated variables. */
const prints = (vars: Record<string, string>): string =>
	`printf %s __OMPW_LOGIN_ENV__; printf '%s\\0' ${Object.entries(vars)
		.map(([k, v]) => `'${k}=${v}'`)
		.join(" ")}`;

test("what a shell printed is read as variables: after its start-up output, values may hold newlines", () => {
	const text =
		"Last login: Mon\nwelcome __OMPW_LOGIN_ENV__PATH=/a:/b\0MULTI=one\ntwo\0EMPTY=\0not a variable\0=orphan\0BASH_FUNC_x%%=() { :; }\0";
	expect([...(parseLoginEnv(text) ?? new Map())]).toEqual([
		["PATH", "/a:/b"],
		["MULTI", "one\ntwo"],
		["EMPTY", ""],
	]);
	// The shell never got as far as printing: nothing to import.
	expect(parseLoginEnv("PATH=/a\0")).toBeNull();
	expect(parseLoginEnv("__OMPW_LOGIN_ENV__")).toBeNull();
});

test("the shell's variables are imported, PATH exactly as it has it; the app's own settings and the shell's session stay out", () => {
	const env: Record<string, string | undefined> = {
		PATH: "/usr/bin:/bin",
		OMP_WEBUI_TOKEN: "app-token",
		OMP_WEBUI_PORT: "7878",
		HOME: "/Users/me",
		KEEP: "from the app",
	};
	const login = new Map([
		["PATH", "/Users/me/.nvm/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin"],
		["HTTPS_PROXY", "http://proxy.example:3128"],
		["ANTHROPIC_API_KEY", "k"],
		["OMP_WEBUI_TOKEN", "from a shell file"],
		["OMP_WEBUI_PORT", "1"],
		["PWD", "/"],
		["OLDPWD", "/tmp"],
		["SHLVL", "2"],
		["_", "/usr/bin/env"],
		["TERM", "dumb"],
		["TERM_SESSION_ID", "x"],
		["SHELL_SESSION_ID", "y"],
	]);
	mergeLoginEnv(env, login);
	// As the shell has it: order and repeats kept, nothing put in front.
	expect(env.PATH).toBe("/Users/me/.nvm/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin");
	expect(env.HTTPS_PROXY).toBe("http://proxy.example:3128");
	expect(env.ANTHROPIC_API_KEY).toBe("k");
	expect(env.OMP_WEBUI_TOKEN).toBe("app-token");
	expect(env.OMP_WEBUI_PORT).toBe("7878");
	expect(env.KEEP).toBe("from the app");
	for (const name of ["PWD", "OLDPWD", "SHLVL", "_", "TERM", "TERM_SESSION_ID", "SHELL_SESSION_ID"]) {
		expect(env[name]).toBeUndefined();
	}
});

test("the shell is asked as an interactive login shell, and never sees the server's settings, its token above all", async () => {
	const out = join(dir(), "asked");
	const shell = fakeShell(
		`printf '%s\\n' "$@" > "${out}"; echo "token=\${OMP_WEBUI_TOKEN:-none} keep=\${KEEP:-none}" >> "${out}"; ${prints({ PATH: "/x" })}`,
	);
	const login = await readLoginEnv(shell, { OMP_WEBUI_TOKEN: "secret", KEEP: "yes", PATH: "/usr/bin" });
	expect([...(login ?? [])]).toEqual([["PATH", "/x"]]);
	const asked = readFileSync(out, "utf8").split("\n");
	expect(asked[0]).toBe("-ilc");
	expect(asked[1]).toContain("/usr/bin/env -0");
	expect(asked.at(-2)).toBe("token=none keep=yes");
});

test("with the shell's answer, node and python3 are the ones the terminal runs", async () => {
	const nvm = dir("nvm");
	const brew = dir("brew");
	executable(join(nvm, "node"));
	executable(join(brew, "node"));
	// A terminal whose PATH has nvm before Homebrew; the app's own PATH is the Finder's.
	const shell = fakeShell(prints({ PATH: [nvm, brew, "/usr/bin"].join(delimiter) }));
	const env: Record<string, string | undefined> = { PATH: "/usr/bin:/bin" };
	const home = dir("home");
	expect(await importLoginEnv(shell, env, { home, ompHomes: [] })).toBe(true);
	expect(env.PATH).toBe([nvm, brew, "/usr/bin"].join(delimiter));
	// First `node` on that PATH.
	expect(env.PATH?.split(delimiter).find((d) => d === nvm || d === brew)).toBe(nvm);
});

test("a shell that does not answer in time leaves the server's environment, with omp's installer directories behind PATH", async () => {
	const home = dir("home");
	const brew = dir("brew");
	// It hangs for ten minutes: a limit that ended nothing fails this test by its own timeout. How long the limit takes
	// to end it is not asserted: that depends on what else the machine is running.
	const hang = fakeShell("sleep 600");
	const env: Record<string, string | undefined> = { PATH: "/usr/bin:/bin", KEEP: "yes" };
	expect(await importLoginEnv(hang, env, { home, timeoutMs: 300, ompHomes: [brew] })).toBe(false);
	expect(env.KEEP).toBe("yes");
	expect(env.PATH).toBe(
		["/usr/bin", "/bin", brew, join(home, ".local", "bin"), join(home, ".bun", "bin")].join(delimiter),
	);

	// A shell that fails, or says nothing, is the same.
	for (const body of ["exit 1", "echo no marker", `${prints({ PATH: "/x" })}; exit 3`]) {
		const e: Record<string, string | undefined> = { PATH: "/usr/bin" };
		expect(await importLoginEnv(fakeShell(body), e, { home, ompHomes: [] })).toBe(false);
		expect(e.PATH?.startsWith("/usr/bin:")).toBe(true);
	}
	// And a shell that is not there at all.
	const gone: Record<string, string | undefined> = { PATH: "/usr/bin" };
	expect(await importLoginEnv(join(root, "no-such-shell"), gone, { home, ompHomes: [] })).toBe(false);
});

test("an omp that only Homebrew's directory has is found by adding that one directory behind PATH, and only then", async () => {
	const home = dir("home");
	const brew = dir("brew");
	const other = dir("other");
	executable(join(brew, "omp"));
	const shell = fakeShell(prints({ PATH: "/usr/bin:/bin" }));
	const env: Record<string, string | undefined> = { PATH: "/usr/bin" };
	await importLoginEnv(shell, env, { home, ompHomes: [other, brew] });
	expect(env.PATH).toBe(["/usr/bin", "/bin", brew].join(delimiter));

	// On the shell's own PATH already: nothing is added.
	const found = fakeShell(prints({ PATH: `${brew}:/usr/bin` }));
	const again: Record<string, string | undefined> = { PATH: "/usr/bin" };
	await importLoginEnv(found, again, { home, ompHomes: [brew] });
	expect(again.PATH).toBe(`${brew}:/usr/bin`);

	// In ~/.local/bin, which the lifecycle searches itself: nothing is added.
	executable(join(home, ".local", "bin", "omp"));
	const local: Record<string, string | undefined> = { PATH: "/usr/bin" };
	await importLoginEnv(shell, local, { home, ompHomes: [brew] });
	expect(local.PATH).toBe("/usr/bin:/bin");
});
