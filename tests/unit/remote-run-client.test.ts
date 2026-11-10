// needs: posixShell
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	RemoteNotSignedIn,
	type RemoteRunOptions,
	RemoteUnsupported,
	runRemote,
} from "../../server/remote-run/client.ts";
import { RemoteSignInError, RemoteSignIns } from "../../server/remote-run/sign-ins.ts";
import { REMOTE_RUN_OUTPUT_TAIL } from "../../shared/remote-run.ts";
import { pollUntil } from "../support/poll.ts";

/**
 * The remote client against a stand-in for the remote computer: a local server that checks what the remote one checks
 * (the Access cookie on every request, its own cookie on the API and the socket, the page's Origin), sets its cookie on `GET /`,
 * and serves `/ws` with the Terminal tab's frames over a real `bash` in a real pseudo-terminal. So the line typed, the shell's
 * echo, its prompt and its escapes are what a remote computer's would be.
 */

const scratch = mkdtempSync(join(tmpdir(), "ompw-remote-run-client-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const b64url = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** A token of Access's shape, lapsing at `exp` (seconds); its signature is not one: nothing here checks it. */
const jwtOf = (exp: number) =>
	`${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({ exp, email: "me@example.com" })}.c2ln`;
const JWT = jwtOf(Math.floor(Date.now() / 1000) + 3600);

interface Fake {
	origin: string;
	/** What the stand-in was sent on its socket, in order. */
	frames: Record<string, unknown>[];
	/** The shells it started, and whether each has ended. */
	shells: { proc: Bun.Subprocess; ended: boolean }[];
	/** Its own cookie: changed to make the one a client holds stale. */
	token: string;
	/** What its terminals printed, together. */
	printed: string;
	stop(): void;
}

const fakes: Fake[] = [];
afterEach(() => {
	for (const f of fakes.splice(0)) f.stop();
});

const cookiesOf = (req: Request): Record<string, string> =>
	Object.fromEntries(
		(req.headers.get("cookie") ?? "")
			.split(";")
			.map((c) => c.trim().split("="))
			.filter((kv) => kv.length === 2),
	);

function fakeRemote(o: { jwt?: string; os?: string; shell?: string[]; env?: Record<string, string> } = {}): Fake {
	const jwt = o.jwt ?? JWT;
	const fake: Fake = { origin: "", frames: [], shells: [], token: "tok-1", printed: "", stop: () => {} };
	type Data = { terminals: Map<string, { terminal: Bun.Terminal; proc: Bun.Subprocess }> };
	const server = Bun.serve<Data>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req, srv) {
			const url = new URL(req.url);
			const cookies = cookiesOf(req);
			// Access: no token, no way in, whatever the path.
			if (cookies.CF_Authorization !== jwt)
				return new Response(null, {
					status: 302,
					headers: { location: "https://team.cloudflareaccess.com/cdn-cgi/access/login" },
				});
			if (url.pathname === "/")
				return new Response("<!doctype html>", {
					headers: { "set-cookie": `ompw_token=${fake.token}; Path=/; HttpOnly; Secure; SameSite=Strict` },
				});
			const origin = req.headers.get("origin");
			if (origin !== null && origin !== fake.origin) return new Response("Forbidden", { status: 403 });
			if (cookies.ompw_token !== fake.token) return new Response("Unauthorized", { status: 401 });
			if (url.pathname === "/api/diagnostics") return Response.json({ os: o.os ?? "linux 6.1.0 (x64)", mode: "full" });
			if (url.pathname === "/ws") {
				if (origin !== fake.origin) return new Response("Forbidden", { status: 403 });
				if (srv.upgrade(req, { data: { terminals: new Map() } })) return undefined;
			}
			return new Response("Not found", { status: 404 });
		},
		websocket: {
			open(ws) {
				ws.send(JSON.stringify({ t: "hello", ompVersion: "x", serverVersion: "y", time: Date.now() }));
			},
			message(ws, text) {
				const msg = JSON.parse(String(text));
				fake.frames.push(msg);
				if (msg.t === "pty_open") {
					if (msg.shell !== true || !Array.isArray(msg.args)) {
						ws.send(JSON.stringify({ t: "reply", req: msg.req, ok: false, error: "args must be a list of strings" }));
						return;
					}
					const ptyId = `P${fake.shells.length + 1}`;
					const terminal = new Bun.Terminal({
						cols: msg.cols,
						rows: msg.rows,
						data: (_t, data) => {
							const text = new TextDecoder().decode(data);
							fake.printed += text;
							ws.send(JSON.stringify({ t: "pty_data", ptyId, data: text }));
						},
					});
					const proc = Bun.spawn(o.shell ?? ["/bin/bash", "--noprofile", "--norc", "-i"], {
						cwd: scratch,
						terminal,
						// A session of its own, as the remote server's shells are: an interactive shell that is hung up passes the
						// hangup on to its jobs' group, which without this can be this test process's own (it then dies of SIGHUP).
						detached: true,
						env: {
							PATH: process.env.PATH ?? "/usr/bin:/bin",
							HOME: scratch,
							TERM: "xterm-256color",
							PS1: "\\[\\e[1m\\]$ \\[\\e[0m\\]",
							...o.env,
						},
					});
					const shell = { proc, ended: false };
					fake.shells.push(shell);
					void proc.exited.then((code) => {
						shell.ended = true;
						ws.send(JSON.stringify({ t: "pty_exit", ptyId, code }));
					});
					ws.data.terminals.set(ptyId, { terminal, proc });
					ws.send(JSON.stringify({ t: "reply", req: msg.req, ok: true, data: { ptyId } }));
				} else if (msg.t === "pty_input") ws.data.terminals.get(msg.ptyId)?.terminal.write(msg.data);
				else if (msg.t === "pty_kill") ws.data.terminals.get(msg.ptyId)?.proc.kill("SIGHUP");
			},
			close(ws) {
				// A page that leaves takes its terminals with it, as the remote server's do.
				for (const { proc } of ws.data.terminals.values()) proc.kill("SIGHUP");
			},
		},
	});
	fake.origin = `http://127.0.0.1:${server.port}`;
	fake.stop = () => {
		for (const s of fake.shells) s.proc.kill("SIGKILL");
		server.stop(true);
	};
	fakes.push(fake);
	return fake;
}

const run = (fake: Fake, over: Partial<RemoteRunOptions> & { command: string }) =>
	runRemote({
		host: "omp.example.com",
		jwt: JWT,
		cwd: null,
		timeoutMs: 15_000,
		signal: new AbortController().signal,
		origin: fake.origin,
		...over,
	});

/** The remote shell was told to end (`pty_kill`): it reaches the stand-in just after the call has resolved. */
const killSent = (fake: Fake) =>
	pollUntil(() => fake.frames.filter((f) => f.t === "pty_kill").length === 1, "the shell to be killed", 5000);

const shellsEnded = (fake: Fake) =>
	pollUntil(() => fake.shells.every((s) => s.ended), "the remote shells to end", 5000);

describe("runRemote", () => {
	test("runs a command in a login shell over the page's socket and gives its output and exit code", async () => {
		const fake = fakeRemote();
		const r = await run(fake, { command: "echo hello; echo there" });
		expect(r).toMatchObject({ exitCode: 0, output: "hello\nthere\n", cut: false, timedOut: false, cancelled: false });
		expect(fake.frames.find((f) => f.t === "pty_open")).toMatchObject({ shell: true, args: [], cols: 200, rows: 50 });
		// The shell is killed when the command is done: one shell per call.
		await killSent(fake);
		await shellsEnded(fake);
	});

	test("a command that fails gives its exit code and what it printed to stderr", async () => {
		const fake = fakeRemote();
		const r = await run(fake, { command: "echo bad >&2; exit 4" });
		expect(r).toMatchObject({ exitCode: 4, output: "bad\n", timedOut: false });
	});

	test("a multi-line command with quotes, $, a heredoc and non-ASCII text runs exactly as given", async () => {
		const fake = fakeRemote();
		const command = `x='it'"'"'s'\necho "$x \\$HOME" '$HOME'\ncat <<'EOF'\n你好 \`not run\` $(not run)\nEOF\necho 'ü'`;
		const r = await run(fake, { command });
		expect(r).toMatchObject({ exitCode: 0, output: "it's $HOME $HOME\n你好 `not run` $(not run)\nü\n" });
	});

	test("runs in cwd; one that does not exist fails with the shell's error, never in the home folder", async () => {
		const fake = fakeRemote();
		const here = await run(fake, { command: "pwd", cwd: tmpdir() });
		expect(here.exitCode).toBe(0);
		const missing = await run(fake, { command: "pwd; echo ran", cwd: "/no/such/folder" });
		expect(missing.exitCode).not.toBe(0);
		expect(missing.exitCode).not.toBeNull();
		expect(missing.output).toContain("/no/such/folder");
		expect(missing.output).not.toContain("ran");
		expect(missing.output).not.toContain(scratch);
	});

	// The line typed carries the command (in base64): a shell that keeps a history file must not keep it. Both shells write
	// each line as it is entered here (bash's `history -a` before every prompt, zsh's INC_APPEND_HISTORY), which is the
	// hardest case: nothing waits for the shell's exit, where the kill would also have kept it out.
	for (const [name, shell, env] of [
		["bash", ["/bin/bash", "--noprofile", "--norc", "-i"], { PROMPT_COMMAND: "history -a" }],
		["zsh", ["/bin/zsh", "-f", "-i", "-o", "incappendhistory"], { SAVEHIST: "100", HISTSIZE: "100", PS1: "$ " }],
	] as const) {
		test.skipIf(!existsSync(shell[0]))(`the command never reaches the ${name} history file`, async () => {
			const history = join(scratch, `${name}-history`);
			writeFileSync(history, "");
			const fake = fakeRemote({ shell: [...shell], env: { ...env, HISTFILE: history } });
			const r = await run(fake, { command: "echo secret-word-4711" });
			expect(r).toMatchObject({ exitCode: 0, output: "secret-word-4711\n" });
			await killSent(fake);
			await shellsEnded(fake);
			const kept = readFileSync(history, "utf8");
			expect(kept).not.toContain("secret-word-4711");
			expect(kept).not.toContain(btoa("echo secret-word-4711"));
			expect(kept).not.toContain("base64 -d");
		});
	}

	test("a command that never ends returns at its time limit with what it printed, and the remote shell is killed", async () => {
		const fake = fakeRemote();
		const started = Date.now();
		const r = await run(fake, { command: "echo started; sleep 9999", timeoutMs: 2500 });
		expect(Date.now() - started).toBeLessThan(5000);
		expect(r).toMatchObject({ exitCode: null, timedOut: true, cancelled: false });
		expect(r.output).toContain("started");
		await killSent(fake);
		await shellsEnded(fake);
	});

	test("a call that is given up mid-command ends promptly and kills the remote shell", async () => {
		const fake = fakeRemote();
		const abort = new AbortController();
		const call = run(fake, { command: "echo started; sleep 9999", signal: abort.signal });
		// Mid-command: it has begun to print (the typed line is base64, so its echo never holds the word).
		await pollUntil(() => fake.printed.includes("started"), "the command to start", 5000);
		const at = Date.now();
		abort.abort();
		const r = await call;
		expect(Date.now() - at).toBeLessThan(500);
		expect(r).toMatchObject({ exitCode: null, cancelled: true, timedOut: false });
		await killSent(fake);
		await shellsEnded(fake);
	});

	test("a call given up before it starts runs nothing", async () => {
		const fake = fakeRemote();
		const abort = new AbortController();
		abort.abort();
		const r = await run(fake, { command: "echo x", signal: abort.signal });
		expect(r).toMatchObject({ cancelled: true, exitCode: null });
		expect(fake.frames).toEqual([]);
	});

	test("output past the limit is cut to its last part, and says so", async () => {
		const fake = fakeRemote();
		const r = await run(fake, { command: "head -c 100000 /dev/zero | tr '\\0' a; echo; echo end" });
		expect(r.exitCode).toBe(0);
		expect(r.cut).toBe(true);
		expect(r.output.length).toBe(REMOTE_RUN_OUTPUT_TAIL);
		expect(r.output.endsWith("a\nend\n")).toBe(true);
	});

	test("a sign-in Access does not take (a redirect) is RemoteNotSignedIn, and no shell is opened", async () => {
		const fake = fakeRemote({ jwt: jwtOf(Math.floor(Date.now() / 1000) + 60) });
		await expect(run(fake, { command: "echo x" })).rejects.toBeInstanceOf(RemoteNotSignedIn);
		expect(fake.frames).toEqual([]);
	});

	test("a Windows computer is refused before any shell is opened", async () => {
		const fake = fakeRemote({ os: "win32 10.0.22631 (x64)" });
		await expect(run(fake, { command: "dir" })).rejects.toBeInstanceOf(RemoteUnsupported);
		expect(fake.frames).toEqual([]);
	});

	test("the remote server's cookie is asked for again when the one held is refused", async () => {
		const fake = fakeRemote();
		expect((await run(fake, { command: "echo one" })).output).toBe("one\n");
		fake.token = "tok-2";
		expect((await run(fake, { command: "echo two" })).output).toBe("two\n");
	});
});

describe("RemoteSignIns", () => {
	test("keeps a token until its expiry, per computer, without case in the id", () => {
		let now = Date.parse("2026-11-10T12:00:00Z");
		const signIns = new RemoteSignIns(() => now);
		const exp = Math.floor(now / 1000) + 3600;
		expect(signIns.set("ABCDEF00-0000-4000-8000-000000000001", jwtOf(exp))).toEqual({
			expires: new Date(exp * 1000).toISOString(),
		});
		expect(signIns.get("abcdef00-0000-4000-8000-000000000001")?.jwt).toBe(jwtOf(exp));
		expect(signIns.signedInUntil("abcdef00-0000-4000-8000-000000000001")).toBe("2026-11-10T13:00:00.000Z");
		expect(signIns.signedInUntil("abcdef00-0000-4000-8000-000000000002")).toBeNull();
		now += 3600 * 1000;
		expect(signIns.get("abcdef00-0000-4000-8000-000000000001")).toBeNull();
		expect(signIns.signedInUntil("abcdef00-0000-4000-8000-000000000001")).toBeNull();
	});

	test("clear forgets it", () => {
		const signIns = new RemoteSignIns();
		signIns.set("m1", JWT);
		signIns.clear("M1");
		expect(signIns.get("m1")).toBeNull();
	});

	test("a token that is not a JWT, has no expiry or has lapsed is refused with 400, and nothing is kept", () => {
		const signIns = new RemoteSignIns();
		const refused = (jwt: string) => {
			try {
				signIns.set("m1", jwt);
			} catch (e) {
				expect(e instanceof RemoteSignInError ? e.status : null).toBe(400);
				return true;
			}
			return false;
		};
		expect(refused("not a token")).toBe(true);
		expect(refused("a.b")).toBe(true);
		expect(refused(`${b64url({})}.${Buffer.from("{nope").toString("base64url")}.c2ln`)).toBe(true);
		expect(refused(`${b64url({})}.${b64url({ email: "x" })}.c2ln`)).toBe(true);
		expect(refused(jwtOf(Math.floor(Date.now() / 1000) - 10))).toBe(true);
		expect(refused(`${b64url({})}.${b64url({ exp: Math.floor(Date.now() / 1000) + 60 })}.c2ln; ompw_token=x`)).toBe(
			true,
		);
		expect(signIns.get("m1")).toBeNull();
		// One that was kept stays when a bad one comes after it.
		signIns.set("m1", JWT);
		expect(refused("garbage")).toBe(true);
		expect(signIns.get("m1")?.jwt).toBe(JWT);
	});
});
