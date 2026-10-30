import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { FIXTURE_CWD, type SeededFixtures, seedFixtures } from "./fixtures.ts";
import { hostEnv, isolatedEnv } from "./omp-env.ts";
import { removeRelayDir } from "./relay-dirs.ts";
import { serverTmp } from "./tmp.ts";

export interface TestServer {
	/** Everything the current server has printed so far (after a `restart`: since it). */
	output(): string;
	/**
	 * What the servers of this world wrote to stderr, every start of them (#774). Not shown as it comes: a test that means
	 * to hit an error (a port taken, a stray rejection) would look like a failure. The e2e fixture shows it for a test that
	 * failed; a server that exits on its own prints it; `OMPW_SERVER_STDERR=1` shows it as it comes.
	 */
	errors(): string;
	/** Where the server listens now: another one after `restart(port)`. */
	readonly url: string;
	root: string;
	home: string;
	agentDir: string;
	work: string;
	/** The temp dir of the server: where it keeps the overlay files of its conversations (see `tests/support/tmp.ts`). */
	readonly tmpDir: string;
	hasToken: boolean;
	/** omp-webui access token (cookie `ompw_token` / header `x-omp-webui-token`). */
	accessToken: string;
	fixtures: SeededFixtures;
	stop(): Promise<void>;
	/**
	 * Stop and start on the same data dir and token; omit `port` to reuse it, or pass 0 for a new free port. `signal`: how
	 * the server is stopped (SIGKILL is a crash: it gets no chance to say goodbye); `downMs`: how long nothing runs
	 * between the two, for what has to happen while no server is there.
	 */
	restart(port?: number, options?: { signal?: NodeJS.Signals; downMs?: number }): Promise<void>;
}

/**
 * omp-webui against a throwaway omp agent dir (isolated HOME) seeded with
 * fixture sessions; models default to Claude Haiku 5.5. Runs under Node and Bun.
 * `serverEnv` sets server settings for this test (e.g. `OMP_WEBUI_DIST`); the
 * shell's own `OMP_WEBUI_*` are never passed on (see `hostEnv`). `opts.login: false` starts it without the
 * Anthropic login (none is read from the machine or handed to omp): for runs that call no model.
 */
export async function startTestServer(
	port = 0,
	serverEnv: Record<string, string> = {},
	opts: { login?: boolean } = {},
): Promise<TestServer> {
	const root = mkdtempSync(join(tmpdir(), "ompw-e2e-"));
	try {
		return await boot(root, port, serverEnv, opts);
	} catch (error) {
		// No caller has a handle to a server that never came up: its directory (an isolated HOME, the fixtures) goes now.
		removeWorld(root);
		throw error;
	}
}

/**
 * The processes a test server started (its relays and omps carry its directory in their command line), killed. On every
 * stop, not only a forced one: an omp that outlived a polite stop would write its `home/.omp` again after the world was
 * removed (#768).
 */
function killStrays(root: string): void {
	const table = execFileSync("ps", ["-A", "-o", "pid=,command="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
	for (const line of table.split("\n")) {
		const [pid] = line.trim().split(/\s+/, 1);
		if (!line.includes(root) || Number(pid) === process.pid) continue;
		try {
			process.kill(Number(pid), "SIGKILL");
		} catch {}
	}
}

/** Remove a test server's directory (and its relay directory), unless the run keeps it for inspection. */
function removeWorld(root: string): void {
	if (process.env.OMPW_KEEP_E2E) return;
	removeRelayDir(join(root, "data"));
	rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

async function boot(
	root: string,
	port: number,
	serverEnv: Record<string, string>,
	opts: { login?: boolean },
): Promise<TestServer> {
	const env = await isolatedEnv(root, { ...opts, ...(process.env.OMPW_E2E_OFFLINE ? { login: false } : {}) });
	const agentDir = env.PI_CODING_AGENT_DIR;
	// Every role omp may use (titles use tiny/commit) points at Haiku, so nothing falls back to a local model.
	// Word completion is pinned to the n-gram predictor: `auto` would also download and run SmolLM locally.
	writeFileSync(
		join(agentDir, "config.yml"),
		[
			"modelRoles:",
			"  default: anthropic/claude-haiku-5-5:low",
			"  smol: anthropic/claude-haiku-5-5",
			"  slow: anthropic/claude-haiku-5-5",
			"  tiny: anthropic/claude-haiku-5-5:low",
			"  commit: anthropic/claude-haiku-5-5",
			"spelling:",
			"  autocomplete: ngram",
			"",
		].join("\n"),
	);
	// omp's session titles create history.db without the TUI's `history` table, after which every
	// `predict_word` fails with "no such table: history" (omp 18.11). A TUI user always has it; seed it.
	const history = new DatabaseSync(join(agentDir, "history.db"));
	history.exec(
		"CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)), cwd TEXT, session_id TEXT, use_count INTEGER NOT NULL DEFAULT 1)",
	);
	history.close();
	const fixtures = seedFixtures(agentDir);
	mkdirSync(FIXTURE_CWD, { recursive: true });
	const work = join(root, "work");
	mkdirSync(work, { recursive: true });
	const accessToken = randomBytes(18).toString("base64url");
	let listening = port;
	const origin = () => `http://127.0.0.1:${listening}`;
	const dataDir = join(root, "data");
	// "Guard dangerous commands" (#609) is on in a fresh install, and every risky call then waits for a reviewer: a spec that
	// is about something else must not. The guard's settings are in a file of the test's own, off unless it says otherwise
	// (a spec of the guard sets it through the API, or writes `<root>/guard.json` before it starts the server).
	const guardFile = join(root, "guard.json");
	if (!existsSync(guardFile)) writeFileSync(guardFile, JSON.stringify({ mode: "off" }));
	// The temp dir of the server: one of its own, so that the server of another data dir (another test file running
	// in parallel) never sweeps the overlay directories of this one's dead servers (#461). The same one for every
	// server of this data dir, as in production, where they take each other's conversations over.
	const tmpDir = serverTmp(env.TMPDIR ?? join(root, "tmp"), dataDir);
	/** What the current server has printed so far (its startup banner, say). */
	let printed = "";
	/** What every server of this world wrote to stderr (see `errors`). */
	let errors = "";
	/** Set while this helper stops the server itself: an exit then is no news. */
	let stopping = false;
	const launch = async (): Promise<ChildProcess> => {
		const child = spawn("bun", [join(import.meta.dirname, "../../server/main.ts")], {
			env: {
				...hostEnv(),
				...env,
				TMPDIR: tmpDir,
				OMP_WEBUI_DATA_DIR: dataDir,
				OMP_WEBUI_PORT: String(listening),
				OMP_WEBUI_TOKEN: accessToken,
				// The real npm registry is none of a test's business, and a newer omp than the one installed would put a
				// notice on every page: a spec about updates points the server at its own registry instead.
				OMP_WEBUI_UPDATE_CHECK: "off",
				OMP_WEBUI_GUARD_CONFIG: guardFile,
				// The server asks omp for a title after a conversation's first exchange (a model call of its own): a spec that is
				// about something else must not have it, so it is off unless the spec says (`OMP_WEBUI_AUTO_TITLE: "on"`).
				OMP_WEBUI_AUTO_TITLE: "off",
				// Playwright forces color in workers; omp config output is parsed as plain values, not ANSI.
				FORCE_COLOR: "0",
				NO_COLOR: "1",
				// A test process that dies (a Playwright worker torn down, a killed `bun test`) takes its server with it: the
				// server checks every second that this pid is still there (#767).
				OMP_WEBUI_PARENT_PID: String(process.pid),
				// The page this run built (`scripts/e2e.ts` builds into a folder of its own, #769); else the checkout's `dist/web`.
				...(process.env.OMPW_E2E_DIST ? { OMP_WEBUI_DIST: process.env.OMPW_E2E_DIST } : {}),
				...serverEnv,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		/** Where this start's stderr begins in `errors`, and whether it got as far as listening. */
		const since = errors.length;
		let up = false;
		const stderrOfStart = () => (errors.length > since ? `\nstderr:\n${errors.slice(since)}` : "");
		child.stderr?.on("data", (chunk: Buffer) => {
			const text = chunk.toString();
			errors += text;
			if (process.env.OMPW_SERVER_STDERR) process.stderr.write(text);
		});
		child.once("exit", (code, signal) => {
			// A server that ends while nobody stopped it is a crash the test may not even look at: say why, here. One that never
			// got going says so in the error `launch` throws.
			if (!up || stopping || errors.length === since) return;
			process.stderr.write(
				`omp-webui test server exited by itself (${code ?? signal}); its stderr:\n${errors.slice(since)}\n`,
			);
		});
		// Port 0 must be chosen by the listening socket, not a probe that another worker can race to claim.
		printed = "";
		const ready = Promise.withResolvers<void>();
		const timeout = setTimeout(
			() => ready.reject(new Error(`omp-webui did not start: ${printed}${stderrOfStart()}`)),
			30_000,
		);
		const fail = (error: Error) => {
			clearTimeout(timeout);
			ready.reject(error);
		};
		child.once("error", fail);
		child.once("exit", (code, signal) =>
			fail(new Error(`omp-webui exited before ready (${code ?? signal}): ${printed}${stderrOfStart()}`)),
		);
		child.stdout?.on("data", (chunk: Buffer) => {
			printed += chunk.toString();
			const address = /omp-webui listening on http:\/\/[^:\s]+:(\d+)/.exec(printed);
			if (!address) return;
			listening = Number(address[1]);
			clearTimeout(timeout);
			up = true;
			ready.resolve();
		});
		try {
			await ready.promise;
			return child;
		} catch (error) {
			child.kill("SIGKILL");
			killStrays(root);
			throw error;
		}
	};
	/** `signal` (SIGTERM), then SIGKILL after five seconds: a server wedged in its event loop or ignoring SIGTERM must still end. */
	const kill = async (child: ChildProcess, signal: NodeJS.Signals = "SIGTERM") => {
		stopping = true;
		try {
			if (child.exitCode !== null || child.signalCode !== null) return;
			const exited = Promise.withResolvers<void>();
			child.once("exit", () => exited.resolve());
			child.kill(signal);
			const grace = new AbortController();
			const ended = await Promise.race([
				exited.promise.then(() => {
					grace.abort();
					return true;
				}),
				sleep(5000, undefined, { signal: grace.signal }).then(
					() => false,
					() => true,
				),
			]);
			if (ended) return;
			child.kill("SIGKILL");
			await exited.promise;
			killStrays(root);
		} finally {
			stopping = false;
		}
	};
	let server = await launch();
	return {
		get url() {
			return origin();
		},
		output: () => printed,
		errors: () => errors,
		root,
		home: env.HOME,
		agentDir,
		work,
		tmpDir,
		hasToken: Boolean(env.ANTHROPIC_OAUTH_TOKEN),
		accessToken,
		fixtures,
		async stop() {
			// A paused conversation stays frozen, and one waiting out a usage limit goes on waiting, in the background when a server
			// ends: end them, or they outlive the run.
			// A server that no longer answers must not hold the teardown: the request has two seconds.
			await fetch(`${origin()}/api/lives/end-kept`, {
				method: "POST",
				headers: { "x-omp-webui-token": accessToken, "x-omp-webui": "1" },
				signal: AbortSignal.timeout(2000),
			}).catch(() => {});
			await kill(server);
			killStrays(root);
			removeWorld(root);
		},
		async restart(onPort, options = {}) {
			if (onPort !== undefined) listening = onPort;
			await kill(server, options.signal);
			if (options.downMs) await sleep(options.downMs);
			server = await launch();
		},
	};
}
