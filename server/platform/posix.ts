import { accessSync, constants, existsSync, statSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { parsePs } from "../host-parse.ts";
import { PS_MS } from "../omp/run.ts";
import { parsePidPairs, probe, treesOf } from "./system.ts";
import type { CommandOps, HostOps, ProcessOps, ShellOps, SystemDeps } from "./types.ts";

/**
 * What macOS and Linux share: process groups and signals, `ps`, `/bin/sh`, a login shell. `darwin.ts` and `linux.ts`
 * add what differs (how a process is identified, the desktop, power, memory, omp's lease).
 */

/** The process group `leader` leads, signalled; throws as `process.kill` does when there is none. */
function signalGroup(deps: SystemDeps, leader: number, signal: NodeJS.Signals): void {
	deps.kill(-leader, signal);
}

/** `ps` with the locale and zone pinned: a later server may run in another one, and must read the same text. */
const PINNED = { LC_ALL: "C", TZ: "UTC" };

/** The process operations, but `identity`/`identities` (how a process is told from another differs: see darwin/linux). */
export function posixProcesses(deps: SystemDeps, identify: Pick<ProcessOps, "identity" | "identities">): ProcessOps {
	const list: ProcessOps["list"] = async () =>
		parsePidPairs((await deps.run(["ps", "-A", "-o", "pid=,ppid="], { timeoutMs: PS_MS })).stdout);
	const ops: ProcessOps = {
		exists: (pid) => probe(deps, pid),
		groupExists: (leader) => probe(deps, -leader),
		signal: (pid, signal) => deps.kill(pid, signal),
		signalGroup: (leader, signal) => signalGroup(deps, leader, signal),
		signalTrees(pids, signal) {
			for (const p of pids) {
				for (const target of [p, -p]) {
					try {
						deps.kill(target, signal);
					} catch {
						// already gone
					}
				}
			}
		},
		signalChild(child, signal) {
			try {
				signalGroup(deps, child.pid, signal);
			} catch {
				try {
					child.kill(signal);
				} catch {
					// already gone
				}
			}
		},
		list,
		trees: async (roots) => treesOf(await list(), roots),
		tree: async (pid) => treesOf(await list(), [pid]).get(pid) as number[],
		...identify,
		async startTime(pid) {
			const r = await deps.run(["ps", "-o", "lstart=", "-p", String(pid)], { timeoutMs: PS_MS, env: PINNED });
			return r.code === 0 ? r.stdout.trim() || null : null;
		},
		async commandLine(pid, timeoutMs = PS_MS) {
			const r = await deps.run(["ps", "-o", "command=", "-p", String(pid)], { timeoutMs, env: PINNED });
			const command = r.stdout.trim();
			if (r.code === 0 && command) return command;
			// `ps -p` exits 1 and prints nothing for an id no process has; any other failure is a `ps` that could not say.
			if (r.code === 1 && !command) return null;
			throw new Error(`ps gave no answer for process ${pid}: exit ${r.code}`);
		},
		commandLineSync(pid) {
			const r = deps.runSync(["ps", "-o", "command=", "-p", String(pid)]);
			if (r.code !== 0) return null;
			return r.stdout.trim() || null;
		},
		async commandLines() {
			try {
				const ran = await deps.run(["ps", "-A", "-ww", "-o", "command="], { timeoutMs: PS_MS });
				return ran.code === 0 ? ran.stdout.split("\n") : null;
			} catch {
				return null;
			}
		},
		groupSpawn: { detached: true },
		uid: () => process.getuid?.(),
	};
	return ops;
}

/** What `ps` prints as the identity of a process: `lstart` and `command`, as one line. */
const PS_IDENTITY = "lstart=,command=";

/** `ps` for `args` with the locale and zone pinned; null when it cannot run or does not answer. */
async function pinnedPs(deps: SystemDeps, args: string[]): Promise<string | null> {
	try {
		return (await deps.run(["ps", ...args], { timeoutMs: PS_MS, env: PINNED })).stdout;
	} catch {
		return null;
	}
}

/** A process's identity from `ps`: its start (`lstart`) and command line. */
export function psIdentity(deps: SystemDeps): Pick<ProcessOps, "identity" | "identities"> {
	return {
		identity: async (pid) => (await pinnedPs(deps, ["-o", PS_IDENTITY, "-p", String(pid)]))?.trim() || null,
		async identities(pids) {
			const found = new Map<number, string>();
			if (pids.length === 0) return found;
			const listing = (await pinnedPs(deps, ["-o", `pid=,${PS_IDENTITY}`, "-p", pids.join(",")])) ?? "";
			for (const line of listing.split("\n")) {
				const m = /^\s*(\d+)\s+(.*\S)\s*$/.exec(line);
				if (m) found.set(Number(m[1]), m[2]);
			}
			return found;
		},
	};
}

/**
 * What every job runs as, with its command as the arguments after the status file's path: the command, then its exit
 * status written to that file, so that a server that did not start the job — or was not there when it ended — can
 * tell how it ended. The status is written after the command is over and before this shell is.
 */
const JOB_WRAPPER = 'status=$1; shift; "$@"; code=$?; printf %s "$code" > "$status"; exit "$code"';

/**
 * omp's installer as two steps. In `curl … | sh` the pipeline's status is `sh`'s, so a failed download ran an empty
 * script, "succeeded", and the job's error was "omp was not found afterwards" while curl's own message (could not
 * resolve host, HTTP 404…) was only in the log. Downloaded to a file first, the job ends with curl's status and
 * the last lines of its output are curl's message. The file goes away however the job ends, cancelling included.
 */
const INSTALLER_SCRIPT = [
	"set -e",
	`tmp=$(mktemp "\${TMPDIR:-/tmp}/omp-install.XXXXXX")`,
	`trap 'rm -f "$tmp"' EXIT`,
	"trap 'exit 143' TERM",
	"trap 'exit 130' INT HUP",
	'curl -fsSL -o "$tmp" https://omp.sh/install',
	'sh "$tmp" --binary',
].join("\n");

/**
 * The person's login shell: what the system has for the account, else `$SHELL`, else zsh (macOS's own). Only an absolute
 * path to a program that is there counts: Bun answers `"unknown"` for the account's shell where it cannot read it.
 */
function loginShell(deps: SystemDeps): string {
	let account: string | undefined;
	try {
		account = userInfo().shell ?? undefined;
	} catch {
		// No account entry (a container's user): the environment's.
	}
	for (const shell of [account, deps.env.SHELL]) if (shell?.startsWith("/") && existsSync(shell)) return shell;
	return "/bin/zsh";
}

export function posixShell(deps: SystemDeps): ShellOps {
	return {
		interactive: () => [loginShell(deps), "-l"],
		// An interactive shell ignores SIGTERM (zsh, bash): it is hung up, as closing a terminal window does.
		hangup: "SIGHUP",
		// The marker first: the start-up files may print what they like before it.
		loginEnvArgv: (shell, marker) => [shell, "-ilc", `printf %s ${marker}; /usr/bin/env -0`],
		privateArgv: (command) => ["/bin/sh", "-c", 'umask 077; exec "$@"', "omp-webui", ...command],
		jobArgv: (statusFile, command) => ["/bin/sh", "-c", JOB_WRAPPER, "sh", statusFile, ...command],
		installerArgv: () => ["/bin/sh", "-c", INSTALLER_SCRIPT],
		shutdownSignals: ["SIGINT", "SIGTERM", "SIGHUP"],
		// No terminal: a stray hangup or interrupt is not for the relay.
		relayIgnored: ["SIGHUP", "SIGINT"],
	};
}

/** A file this process may run. */
function isExecutable(path: string): boolean {
	try {
		if (!statSync(path).isFile()) return false;
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export const posixCommands: CommandOps = {
	which(name, dirs) {
		for (const dir of dirs) {
			const candidate = join(dir, name);
			if (isExecutable(candidate)) return candidate;
		}
		return null;
	},
	isExecutable,
	installDirs: ["/opt/homebrew/bin", "/usr/local/bin"],
	brewDirs: ["/home/linuxbrew/.linuxbrew/bin"],
	fallbackPath: ["/usr/bin", "/bin", "/usr/sbin", "/sbin"],
};

/** None of the host's commands takes longer than a few milliseconds; one that has not answered in this time is stuck. */
export const HOST_READ_MS = 5_000;

/** Every process with its CPU time and memory, from the system's own `ps` (a `PATH` from a shell may name another first). */
export function posixHostProcesses(deps: SystemDeps): HostOps["processes"] {
	return async () => {
		const out = await deps.run(["/bin/ps", "-A", "-o", "pid=,ppid=,time=,rss="], { timeoutMs: HOST_READ_MS });
		if (out.code !== 0) throw new Error(out.stderr.trim() || `ps exit ${out.code}`);
		return parsePs(out.stdout);
	};
}
