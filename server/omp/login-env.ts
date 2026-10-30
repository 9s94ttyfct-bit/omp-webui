import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { childEnv } from "../env.ts";
import { isExecutableFile, searchDirs, which } from "./install.ts";

/**
 * The environment of the user's terminal, for a server that was not started from one. An app started from Finder
 * gets the environment of a launch, not of a shell: `PATH` is `/usr/bin:/bin:…`, and whatever `.zshrc` or `.zprofile`
 * exports — nvm's node, Python's framework, provider keys, `HTTPS_PROXY` — is missing, for omp and for every tool it
 * runs. The macOS app names the user's login shell (`OMP_WEBUI_LOGIN_SHELL`); the server asks that shell for its
 * environment, once at start and again when the first-run screen's "Look again" is pressed.
 */

type Env = Record<string, string | undefined>;

const MARKER = "__OMPW_LOGIN_ENV__";
/** A shell whose start-up files take longer than this does not get to hold the app up. */
export const LOGIN_SHELL_TIMEOUT_MS = 5000;

/**
 * What the shell sets for itself or for its own session, and so not what the user's terminal environment is: they
 * would be wrong in the server (another directory, another terminal, another nesting level).
 */
const SESSION_VARIABLES = new Set([
	"_",
	"SHLVL",
	"PWD",
	"OLDPWD",
	"COLUMNS",
	"LINES",
	"TERM",
	"TERM_PROGRAM",
	"TERM_PROGRAM_VERSION",
	"TERM_SESSION_ID",
	"SHELL_SESSION_ID",
	"SHELL_SESSION_DIR",
	"SHELL_SESSION_FILE",
	"SHELL_SESSION_HISTORY",
	"SHELL_SESSION_DID_INIT",
	"SHELL_SESSION_DID_HISTORY",
]);

/** Where omp's installers put it, that a login shell's `PATH` may lack: tried only to find omp (see `importLoginEnv`). */
const OMP_HOMES = ["/opt/homebrew/bin", "/usr/local/bin"];

/** What a shell is asked to print: the marker (the start-up files may print what they like first), then `env` with NULs. */
const PRINT_ENVIRONMENT = `printf %s ${MARKER}; /usr/bin/env -0`;

/**
 * The variables in what `env -0` printed after the marker: `NAME=value`, NUL-terminated, so a value may hold
 * newlines. Null when the marker is missing (the shell did not get as far as printing). Entries that are not
 * variable names (an exported shell function, `BASH_FUNC_x%%`) are left out.
 */
export function parseLoginEnv(output: string): Map<string, string> | null {
	const at = output.lastIndexOf(MARKER);
	if (at < 0) return null;
	const vars = new Map<string, string>();
	for (const entry of output.slice(at + MARKER.length).split("\0")) {
		const eq = entry.indexOf("=");
		if (eq <= 0) continue;
		const name = entry.slice(0, eq);
		if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) vars.set(name, entry.slice(eq + 1));
	}
	return vars.size > 0 ? vars : null;
}

/**
 * Ask `shell` for its environment as a login shell that is interactive (so `.zshrc` runs too); null if it cannot say
 * within `timeoutMs`. The shell gets a process group of its own, which is all ended at the time: a start-up file that
 * starts something in the background would otherwise keep the pipe open, and this waiting for it.
 */
export async function readLoginEnv(
	shell: string,
	env: Env = process.env,
	timeoutMs = LOGIN_SHELL_TIMEOUT_MS,
): Promise<Map<string, string> | null> {
	let proc: Bun.Subprocess<"ignore", "pipe", "ignore">;
	try {
		proc = Bun.spawn([shell, "-ilc", PRINT_ENVIRONMENT], {
			// What the shell's own files see is the server's environment without the server's settings: never its token.
			env: childEnv({}, env),
			stdin: "ignore",
			stdout: "pipe",
			stderr: "ignore",
			detached: true,
		});
	} catch {
		return null;
	}
	const answer = (async () => {
		const [output, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		return code === 0 ? parseLoginEnv(output) : null;
	})().catch(() => null);
	let timer: NodeJS.Timeout | undefined;
	const late = new Promise<null>((resolve) => {
		timer = setTimeout(() => resolve(null), timeoutMs);
	});
	const login = await Promise.race([answer, late]);
	clearTimeout(timer);
	if (login === null) {
		try {
			process.kill(-proc.pid, "SIGKILL");
		} catch {
			proc.kill("SIGKILL");
		}
	}
	return login;
}

/**
 * Take the shell's variables into `env`, as the terminal has them — except the app's own settings (`OMP_WEBUI_*` are
 * the server's, whatever a shell file says) and a shell's session variables. `PATH` is the shell's as it is: no
 * directory is added in front of it or reordered, so `node` and `python3` are the ones the terminal runs.
 */
export function mergeLoginEnv(env: Env, login: Map<string, string>): void {
	for (const [name, value] of login) {
		if (name.startsWith("OMP_WEBUI_") || SESSION_VARIABLES.has(name)) continue;
		env[name] = value;
	}
}

export interface LoginEnvOptions {
	home?: string;
	timeoutMs?: number;
	/** Where omp's installers put it, tried when it is not where the lifecycle looks (`OMP_HOMES`). */
	ompHomes?: string[];
}

/**
 * Import the login shell's environment into `env` (the server's own, by default). If the shell cannot say within the
 * time, the environment stays what the server had, with the directories omp's installers use added behind `PATH`:
 * the tools a Finder launch lacks are mostly in those. Either way, an omp that is in none of the directories the
 * lifecycle searches but is in Homebrew's is made findable by adding that one directory to the end of `PATH`.
 * Returns whether the shell answered.
 */
export async function importLoginEnv(
	shell: string,
	env: Env = process.env,
	opts: LoginEnvOptions = {},
): Promise<boolean> {
	const home = opts.home ?? homedir();
	const ompHomes = opts.ompHomes ?? OMP_HOMES;
	const login = await readLoginEnv(shell, env, opts.timeoutMs);
	if (login) {
		mergeLoginEnv(env, login);
	} else {
		const had = (env.PATH ?? "").split(delimiter).filter(Boolean);
		const base = had.length > 0 ? had : ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
		const installers = [...ompHomes, join(home, ".local", "bin"), join(home, ".bun", "bin")];
		env.PATH = [...new Set([...base, ...installers])].join(delimiter);
	}
	if (!which("omp", searchDirs(env, home))) {
		const found = ompHomes.find((dir) => isExecutableFile(join(dir, "omp")));
		if (found) env.PATH = [...(env.PATH ?? "").split(delimiter).filter(Boolean), found].join(delimiter);
	}
	return login !== null;
}
