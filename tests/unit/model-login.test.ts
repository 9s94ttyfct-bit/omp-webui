import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * How a run finds the Anthropic login (tests/support/omp-env.ts): omp is asked once, a machine without a login runs
 * offline, and a lookup that fails is an error and never a quiet switch to the placeholder key. Each case runs in its own
 * process (the lookup is remembered per process) with an `omp` on PATH that does what the case says and counts its calls.
 */

const ENV_MODULE = join(import.meta.dir, "..", "support", "omp-env.ts");
const PLACEHOLDER = "ompw-offline-placeholder";
const WRAPPER = join(import.meta.dir, "..", "..", "scripts", "with-model-login.ts");
let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "ompw-login-test-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** An `omp` that records each call and then runs `body` (sh). */
function fakeOmp(body: string): void {
	const bin = join(dir, "bin");
	Bun.spawnSync(["mkdir", "-p", bin]);
	writeFileSync(join(bin, "omp"), `#!/bin/sh\necho "$@" >> "${join(dir, "calls")}"\n${body}\n`);
	chmodSync(join(bin, "omp"), 0o755);
}

const calls = () => {
	try {
		return readFileSync(join(dir, "calls"), "utf8").trim().split("\n").length;
	} catch {
		return 0;
	}
};

/** Runs `source` (it can import omp-env) in a fresh process with fake omp first, and only, on PATH. */
function run(source: string, env: Record<string, string> = {}) {
	const file = join(dir, "case.ts");
	writeFileSync(file, `import * as login from ${JSON.stringify(ENV_MODULE)};\n${source}`);
	const clean = Object.fromEntries(
		Object.entries(process.env).filter(([k]) => !["ANTHROPIC_OAUTH_TOKEN", "OMPW_E2E_OFFLINE"].includes(k)),
	);
	const r = Bun.spawnSync([process.execPath, file], {
		env: { ...clean, PATH: `${join(dir, "bin")}:/usr/bin:/bin`, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	return { out: r.stdout.toString().trim(), err: r.stderr.toString(), code: r.exitCode };
}

const PROBE = `
const out: Record<string, unknown> = {};
for (let i = 0; i < 3; i++) {
	const env = await login.isolatedEnv(process.env.CASE_ROOT as string);
	out.token = env.ANTHROPIC_OAUTH_TOKEN ?? null;
	out.placeholder = env.ANTHROPIC_API_KEY ?? null;
}
out.can = login.canCallModel();
console.log(JSON.stringify(out));
`;

test("omp is asked once however many servers' environments and checks follow", () => {
	fakeOmp(`echo tok-1`);
	const r = run(PROBE, { CASE_ROOT: dir });
	expect(JSON.parse(r.out)).toEqual({ token: "tok-1", placeholder: null, can: true });
	expect(calls()).toBe(1);
});

test("a machine with no Anthropic login runs offline: placeholder key, no live model", () => {
	fakeOmp(`echo 'No active credential found for provider "anthropic".' >&2; exit 1`);
	const r = run(PROBE, { CASE_ROOT: dir });
	expect(JSON.parse(r.out)).toEqual({ token: null, placeholder: PLACEHOLDER, can: false });
	expect(calls()).toBe(1);
});

test("a machine without omp has no login either, and is not an error", () => {
	const r = run(PROBE, { CASE_ROOT: dir });
	expect(JSON.parse(r.out)).toEqual({ token: null, placeholder: PLACEHOLDER, can: false });
});

test("a lookup that fails any other way is an error that says why and how to run without a login", () => {
	fakeOmp(`echo "token refresh failed: network unreachable" >&2; exit 3`);
	const r = run(PROBE, { CASE_ROOT: dir });
	expect(r.code).not.toBe(0);
	expect(r.err).toContain("token refresh failed: network unreachable");
	expect(r.err).toContain("OMPW_E2E_OFFLINE=1");
	// canCallModel is no quieter: a spec file must not skip itself on a failed lookup.
	const can = run(`console.log(login.canCallModel())`);
	expect(can.code).not.toBe(0);
	expect(can.err).toContain("token refresh failed");
});

test("an omp that prints nothing and exits 0 is a failed lookup too", () => {
	fakeOmp(`exit 0`);
	const r = run(PROBE, { CASE_ROOT: dir });
	expect(r.code).not.toBe(0);
	expect(r.err).toContain("omp token anthropic");
});

test("the caller's token is used as it is, without asking omp", () => {
	fakeOmp(`echo from-omp`);
	const r = run(PROBE, { CASE_ROOT: dir, ANTHROPIC_OAUTH_TOKEN: "from-shell" });
	expect(JSON.parse(r.out).token).toBe("from-shell");
	expect(calls()).toBe(0);
});

test("a run without a login (login: false) or offline asks nothing", () => {
	fakeOmp(`echo from-omp`);
	const noLogin = run(
		`const env = await login.isolatedEnv(process.env.CASE_ROOT as string, { login: false });
console.log(JSON.stringify({ token: env.ANTHROPIC_OAUTH_TOKEN, key: env.ANTHROPIC_API_KEY }));`,
		{ CASE_ROOT: dir },
	);
	expect(JSON.parse(noLogin.out)).toEqual({ token: "", key: PLACEHOLDER });
	const offline = run(`console.log(login.canCallModel(), login.exportModelLogin())`, { OMPW_E2E_OFFLINE: "1" });
	expect(offline.out).toBe("false null");
	// An environment built in an offline run (a spec that starts omp itself) boots on the placeholder key, asking omp nothing.
	const offlineEnv = run(PROBE, { CASE_ROOT: dir, OMPW_E2E_OFFLINE: "1" });
	expect(JSON.parse(offlineEnv.out)).toEqual({ token: null, placeholder: PLACEHOLDER, can: false });
	expect(calls()).toBe(0);
});

test("the wrapper asks once and hands the token to every command of the run", () => {
	fakeOmp(`echo tok-run`);
	const r = Bun.spawnSync(
		[
			process.execPath,
			WRAPPER,
			"sh",
			"-c",
			'echo "a=$ANTHROPIC_OAUTH_TOKEN"; sh -c \'echo "b=$ANTHROPIC_OAUTH_TOKEN"\'; exit 7',
		],
		{
			env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, HOME: process.env.HOME as string },
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	expect(r.stdout.toString().trim().split("\n")).toEqual(["a=tok-run", "b=tok-run"]);
	expect(r.exitCode).toBe(7);
	expect(calls()).toBe(1);
});

test("the wrapper does not start the run when the login cannot be read, and says why", () => {
	fakeOmp(`echo "boom" >&2; exit 2`);
	const r = Bun.spawnSync([process.execPath, WRAPPER, "sh", "-c", `echo started > "${join(dir, "started")}"`], {
		env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, HOME: process.env.HOME as string },
		stdout: "pipe",
		stderr: "pipe",
	});
	expect(r.exitCode).toBe(1);
	expect(r.stderr.toString()).toContain("boom");
	expect(() => readFileSync(join(dir, "started"))).toThrow();
});

test("with --require-login the wrapper refuses a machine with no login, or an offline run, and starts nothing", () => {
	const started = join(dir, "started");
	const wrap = (env: Record<string, string> = {}) =>
		Bun.spawnSync(
			[process.execPath, WRAPPER, "--require-login", "sh", "-c", `echo "$ANTHROPIC_OAUTH_TOKEN" > "${started}"`],
			{
				env: { PATH: `${join(dir, "bin")}:/usr/bin:/bin`, HOME: process.env.HOME as string, ...env },
				stdout: "pipe",
				stderr: "pipe",
			},
		);
	fakeOmp(`echo 'No active credential found for provider "anthropic".' >&2; exit 1`);
	const none = wrap();
	expect(none.exitCode).toBe(1);
	expect(none.stderr.toString()).toContain("need this machine's Anthropic login");
	const offline = wrap({ OMPW_E2E_OFFLINE: "1" });
	expect(offline.exitCode).toBe(1);
	expect(offline.stderr.toString()).toContain("OMPW_E2E_OFFLINE is set");
	expect(() => readFileSync(started)).toThrow();
	rmSync(join(dir, "bin"), { recursive: true });
	fakeOmp(`echo tok-live`);
	expect(wrap().exitCode).toBe(0);
	expect(readFileSync(started, "utf8").trim()).toBe("tok-live");
});
