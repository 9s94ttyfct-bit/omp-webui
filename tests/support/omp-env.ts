import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { tmpBase } from "./tmp.ts";

/**
 * Environment for an omp process that must not touch the user's ~/.omp.
 *
 * omp keeps some state at the config root (`~/.omp/stats.db`, run leases,
 * logs) regardless of PI_CODING_AGENT_DIR, so the process gets its own HOME.
 * The current Anthropic access token is passed via ANTHROPIC_OAUTH_TOKEN
 * (never written to disk), so the isolated process cannot rotate the user's
 * stored refresh token. Native addons are reused read-only from the real
 * install to avoid re-extracting them per run. Runs under Bun and Node.
 */
export const OFFLINE_PLACEHOLDER_KEY = "ompw-offline-placeholder";

/**
 * The environment a test passes on to a server it starts, without any `OMP_WEBUI_*` setting of its own: a shell
 * opened from the macOS app carries the app's (`OMP_WEBUI_DIST` would serve the installed app's build, not this
 * checkout's; `OMP_WEBUI_PARENT_PID` would tie the test server's life to the app). Tests set what they need.
 */
export function hostEnv(): Record<string, string | undefined> {
	return Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("OMP_WEBUI_")));
}

export async function isolatedEnv(root: string, opts: { login?: boolean } = {}): Promise<Record<string, string>> {
	const home = join(root, "home");
	const agentDir = join(home, ".omp", "agent");
	mkdirSync(agentDir, { recursive: true });
	const env: Record<string, string> = { HOME: home, PI_CODING_AGENT_DIR: agentDir, PI_NO_TITLE: "1" };
	// The server keeps the overlay files of its conversations in the temp dir it is given, and it sweeps the overlay
	// directories of the servers that are gone out of it. Two servers that share one temp dir can take each other's
	// overlays away — a paused conversation loses the mode its overlay held (#461) — so the servers of a test get
	// their temp dirs from here: one per data dir (see `serverTmp`).
	env.TMPDIR = tmpBase(root);
	const natives = join(homedir(), ".omp", "natives");
	if (existsSync(natives)) env.PI_NATIVES_DIR = natives;
	// `login: false` (the screenshots): no stored login is read and none is handed on; omp boots on the placeholder key.
	const token = opts.login === false ? null : anthropicToken();
	// A token of the caller's shell must not reach the process either (the server inherits the shell's environment).
	if (opts.login === false) env.ANTHROPIC_OAUTH_TOKEN = "";
	// omp refuses to start without any usable model. Offline runs (CI) never prompt,
	// so a placeholder key is enough to boot it; live-model tests skip without a token.
	if (token) env.ANTHROPIC_OAUTH_TOKEN = token;
	else env.ANTHROPIC_API_KEY = OFFLINE_PLACEHOLDER_KEY;
	return env;
}

/** How long `omp token anthropic` may take: it refreshes an expired OAuth token over the network. */
const LOOKUP_MS = 60_000;

/** What this process has learned about the login (the lookup spawns omp: once per process, not per server). */
let looked: { token: string | null } | undefined;

/**
 * The Anthropic access token for a run that calls models: the caller's `ANTHROPIC_OAUTH_TOKEN`, else the one omp holds.
 * null when there is no login to hand on (omp is not installed, or not logged in to Anthropic): live-model tests skip and
 * servers boot on the placeholder key. A lookup that fails any other way (omp crashed, timed out, refused to refresh)
 * throws: falling back to the placeholder would let one worker of a run skip or fail a live spec that another passes.
 * `exportModelLogin` does the lookup once for a whole run; `OMPW_E2E_OFFLINE=1` is the way to run without a login.
 */
function anthropicToken(): string | null {
	const fromEnv = process.env.ANTHROPIC_OAUTH_TOKEN;
	if (fromEnv !== undefined) return fromEnv || null;
	// An offline run asks omp nothing, wherever it builds an environment (the spec that starts omp itself, not through
	// the server fixture, included): omp boots on the placeholder key, and the lookup is a process that can refresh a
	// login over the network and time out under load.
	if (process.env.OMPW_E2E_OFFLINE) return null;
	looked ??= { token: lookupAnthropicToken() };
	return looked.token;
}

function lookupAnthropicToken(): string | null {
	const r = spawnSync("omp", ["token", "anthropic"], { encoding: "utf8", timeout: LOOKUP_MS });
	const said = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
	if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") return null;
	if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
	if (r.status === 1 && /no active credential/i.test(said)) return null;
	const how = r.error ? r.error.message : `exit ${r.status}${said ? `: ${said}` : ""}`;
	throw new Error(
		`\`omp token anthropic\` failed (${how}). A run that calls models needs the login; set OMPW_E2E_OFFLINE=1 to run without it.`,
	);
}

/**
 * Look the login up once and put it in this process's environment, where every process started below (test workers,
 * servers) inherits it instead of asking omp again. Nothing is looked up when the run is offline. Returns the token.
 */
export function exportModelLogin(): string | null {
	if (process.env.OMPW_E2E_OFFLINE) return null;
	const token = anthropicToken();
	if (token) process.env.ANTHROPIC_OAUTH_TOKEN = token;
	return token;
}

/** Whether a real model can be called: contract tests that need one skip themselves without (CI) or when offline is forced. */
export function canCallModel(): boolean {
	return !process.env.OMPW_E2E_OFFLINE && Boolean(anthropicToken());
}
