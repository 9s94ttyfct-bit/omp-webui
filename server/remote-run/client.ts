import { randomBytes } from "node:crypto";
import { isRecord } from "../../shared/guards.ts";
import { parseRemoteRun, REMOTE_RUN_HISTORY_OFF, remoteRunLine, tailOutput } from "../../shared/remote-run.ts";

/**
 * Run one command on a remote computer through its own page (see `shared/remote-run.ts`): what this server does for a call of
 * `remote_run`, as the remote computer's page signed in through Cloudflare Access would. Nothing on the remote computer is new
 * for it: it serves this exactly as it serves its Terminal tab to the person's own page (v0.22.5 and later).
 *
 *   1. `GET https://<host>/` with the Access token alone: the remote server answers its page and sets its own cookie,
 *      `ompw_token` (kept in this process's memory per computer, and asked for again when the remote refuses it).
 *   2. `GET /api/diagnostics` with both: whether the sign-in holds, and what system the computer runs (Windows is refused:
 *      its Terminal is PowerShell or cmd, which the line typed here is not written for).
 *   3. The page's WebSocket (`/ws`) with both cookies and the page's own `Origin`, a login shell (`pty_open` with `shell`), the
 *      line of `remoteRunLine` typed into it, what it prints read until the end marker, and the shell killed (`pty_kill`)
 *      whatever happened: done, out of time, cancelled.
 *
 * One fresh shell per call: nothing carries over, and a call that hangs leaves nothing behind for the next. The credentials
 * are only ever in the request headers sent to that computer; nothing here logs them or puts them in a result.
 */

/** What a call came to. */
export interface RemoteRunResult {
	/** The command's exit status; null when it did not finish (out of time, cancelled, the shell or the connection ended). */
	exitCode: number | null;
	/** What it printed (the last `REMOTE_RUN_OUTPUT_TAIL` characters), escapes and carriage returns taken out. */
	output: string;
	/** More was printed than `output` holds. */
	cut: boolean;
	/** Stopped at its time limit. */
	timedOut: boolean;
	/** Stopped because the call was given up (the turn was stopped, the conversation ended). */
	cancelled: boolean;
	/** How long the call took, from its start to its end, in ms. */
	ms: number;
}

/** The computer did not let this server in with the sign-in it holds: an Access redirect, or a refusal. */
export class RemoteNotSignedIn extends Error {}

/** The computer runs a system the command line typed here is not written for (Windows). */
export class RemoteUnsupported extends Error {}

/** What `runRemote` needs. */
export interface RemoteRunOptions {
	/** The computer's host, as the Macs list holds it (`omp.example.com`). */
	host: string;
	/** Its Access token (`CF_Authorization`). */
	jwt: string;
	command: string;
	cwd: string | null;
	timeoutMs: number;
	signal: AbortSignal;
	/** Where the computer's page is, when it is not `https://<host>` (tests: a local stand-in, `http://127.0.0.1:<port>`). */
	origin?: string;
}

/** How long the HTTP steps before the shell may take: the tunnel answers at once or not at all. */
const HTTP_TIMEOUT_MS = 20_000;
/** How long to wait for the shell's first output (its prompt) before typing anyway. */
const PROMPT_WAIT_MS = 1500;
/** What is held of the terminal's text at most; past it, only the last `RAW_KEEP` characters are (the result is marked cut). */
const RAW_MAX = 4 * 1024 * 1024;
const RAW_KEEP = 1024 * 1024;
/** The `req` of the one request this connection makes. */
const OPEN_REQ = "remote-run";

/** The remote server's own cookie, by its origin: asked for again when it is refused. In memory only. */
const appTokens = new Map<string, string>();

/** A request the computer refused for its credentials (as opposed to one that could not be made). */
const REFUSED = Symbol("refused");

function httpSignal(signal: AbortSignal): AbortSignal {
	return AbortSignal.any([signal, AbortSignal.timeout(HTTP_TIMEOUT_MS)]);
}

/** The remote server's cookie for the page signed in with `jwt`: the one held, or a new one (`fresh`). */
async function appToken(origin: string, jwt: string, fresh: boolean, signal: AbortSignal): Promise<string> {
	const held = appTokens.get(origin);
	if (held !== undefined && !fresh) return held;
	const res = await fetch(`${origin}/`, {
		headers: { cookie: `CF_Authorization=${jwt}` },
		redirect: "manual",
		signal: httpSignal(signal),
	});
	await res.body?.cancel();
	const token =
		res.status === 200
			? res.headers
					.getSetCookie()
					.map((c) => /^ompw_token=([^;]*)/.exec(c)?.[1])
					.find((v) => v !== undefined && v !== "")
			: undefined;
	if (token === undefined) {
		appTokens.delete(origin);
		throw new RemoteNotSignedIn(`${origin} answered ${res.status} without letting this server in`);
	}
	appTokens.set(origin, token);
	return token;
}

/** What `/api/diagnostics` says the computer runs (`os`), or `REFUSED` when the credentials were not taken. */
async function systemOf(origin: string, cookie: string, signal: AbortSignal): Promise<string | typeof REFUSED> {
	const res = await fetch(`${origin}/api/diagnostics`, {
		headers: { cookie, origin, accept: "application/json" },
		redirect: "manual",
		signal: httpSignal(signal),
	});
	if (res.status !== 200) {
		await res.body?.cancel();
		if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400)) return REFUSED;
		throw new Error(`${origin}/api/diagnostics answered ${res.status}`);
	}
	const body: unknown = await res.json().catch(() => null);
	return isRecord(body) && typeof body.os === "string" ? body.os : "";
}

const cookieOf = (jwt: string, token: string) => `CF_Authorization=${jwt}; ompw_token=${token}`;

/** Run `o.command` on the computer; throws `RemoteNotSignedIn`, `RemoteUnsupported`, or an error the connection met. */
export async function runRemote(o: RemoteRunOptions): Promise<RemoteRunResult> {
	const started = Date.now();
	const origin = o.origin ?? `https://${o.host}`;
	const cancelled = (): RemoteRunResult => ({
		exitCode: null,
		output: "",
		cut: false,
		timedOut: false,
		cancelled: true,
		ms: Date.now() - started,
	});
	if (o.signal.aborted) return cancelled();
	let token: string;
	let system: string | typeof REFUSED;
	try {
		token = await appToken(origin, o.jwt, false, o.signal);
		system = await systemOf(origin, cookieOf(o.jwt, token), o.signal);
		// The cookie held may be one the remote server no longer takes (it restarted with a new one): asked for again, once.
		if (system === REFUSED) {
			token = await appToken(origin, o.jwt, true, o.signal);
			system = await systemOf(origin, cookieOf(o.jwt, token), o.signal);
		}
	} catch (e) {
		if (o.signal.aborted) return cancelled();
		throw e;
	}
	if (system === REFUSED) throw new RemoteNotSignedIn(`${origin} refused the sign-in`);
	if (/^win32\b|windows/i.test(system)) throw new RemoteUnsupported(`${origin} runs ${system}`);
	return shell(o, origin, cookieOf(o.jwt, token), started);
}

/** The shell part of a call: one login shell, the line typed, the output read, the shell killed. */
function shell(o: RemoteRunOptions, origin: string, cookie: string, started: number): Promise<RemoteRunResult> {
	const nonce = randomBytes(12).toString("hex");
	const begin = `B${nonce}X`;
	// Bun's WebSocket takes request headers (`Bun.WebSocketOptions`); the DOM's constructor type, also in scope, does not.
	const options: Bun.WebSocketOptions = { headers: { cookie, origin } };
	const ws = new WebSocket(`${origin.replace(/^http/, "ws")}/ws`, options as unknown as string[]);
	const { promise, resolve, reject } = Promise.withResolvers<RemoteRunResult>();
	let ptyId: string | null = null;
	let typed = false;
	let raw = "";
	let trimmed = false;
	let settled = false;
	const timers: Timer[] = [];

	const end = (): void => {
		settled = true;
		for (const t of timers) clearTimeout(t);
		o.signal.removeEventListener("abort", onAbort);
		try {
			if (ptyId !== null && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "pty_kill", ptyId }));
			ws.close();
		} catch {
			// The connection is gone already: the remote server ends the shell of a page that left.
		}
	};
	const finish = (how: "done" | "ended" | "timeout" | "abort"): void => {
		if (settled) return;
		end();
		const parsed = parseRemoteRun(raw, nonce);
		const tail = tailOutput(parsed.output);
		resolve({
			exitCode: how === "done" || (how === "ended" && parsed.done) ? parsed.exitCode : null,
			output: tail.text,
			cut: tail.cut || trimmed,
			timedOut: how === "timeout",
			cancelled: how === "abort",
			ms: Date.now() - started,
		});
	};
	const fail = (error: Error): void => {
		if (settled) return;
		end();
		reject(error);
	};
	const type = (): void => {
		if (typed || settled || ptyId === null) return;
		typed = true;
		// History off first, then the command: the shell reads the second line only once the first has run.
		const data = REMOTE_RUN_HISTORY_OFF + remoteRunLine(o.command, o.cwd, nonce);
		ws.send(JSON.stringify({ t: "pty_input", ptyId, data }));
	};
	function onAbort(): void {
		finish("abort");
	}
	/** The connection ended or failed: before a shell was opened that is an error; after, the command did not finish. */
	const lost = (): void => {
		if (ptyId === null) fail(new Error(`Could not open a shell on ${o.host}: the connection was refused or lost`));
		else finish("ended");
	};

	o.signal.addEventListener("abort", onAbort, { once: true });
	timers.push(setTimeout(() => finish("timeout"), Math.max(0, o.timeoutMs)));
	ws.addEventListener("open", () => {
		ws.send(JSON.stringify({ t: "pty_open", req: OPEN_REQ, shell: true, args: [], cols: 200, rows: 50 }));
	});
	ws.addEventListener("message", (event) => {
		if (settled || typeof event.data !== "string") return;
		let msg: unknown;
		try {
			msg = JSON.parse(event.data);
		} catch {
			return;
		}
		if (!isRecord(msg)) return;
		if (msg.t === "reply" && msg.req === OPEN_REQ) {
			const id = isRecord(msg.data) ? msg.data.ptyId : undefined;
			if (msg.ok !== true || typeof id !== "string") {
				const why = typeof msg.error === "string" ? msg.error : "no reason given";
				fail(new Error(`${o.host} did not open a shell: ${why}`));
				return;
			}
			ptyId = id;
			// The prompt is the shell's sign that it reads; one that prints none is typed to all the same.
			timers.push(setTimeout(type, PROMPT_WAIT_MS));
			return;
		}
		if (ptyId === null || msg.ptyId !== ptyId) return;
		if (msg.t === "pty_data" && typeof msg.data === "string") {
			raw += msg.data;
			if (raw.length > RAW_MAX && raw.includes(begin)) {
				raw = `${begin}\n${raw.slice(-RAW_KEEP)}`;
				trimmed = true;
			}
			if (!typed) type();
			else if (parseRemoteRun(raw, nonce).done) finish("done");
			return;
		}
		if (msg.t === "pty_exit") finish("ended");
	});
	ws.addEventListener("close", lost);
	ws.addEventListener("error", lost);
	return promise;
}
