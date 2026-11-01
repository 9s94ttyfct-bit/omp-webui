import { existsSync } from "node:fs";
import { arch, release, totalmem } from "node:os";
import { join } from "node:path";
import { MAC_SYSCTL, memoryUsedMac, parseSysctl, pressureOf } from "../host-parse.ts";
import { capabilitiesFor } from "./capabilities.ts";
import { HOST_READ_MS, posixCommands, posixHostProcesses, posixProcesses, posixShell, psIdentity } from "./posix.ts";
import type { DesktopOps, LockOps, Platform, SystemDeps } from "./types.ts";

/** How long `open`, and the question to LaunchServices, may take. */
const OPEN_MS = 15_000;
/** How long asking who has a lock open may take: `lsof` answers in a fraction of a second. */
const LSOF_MS = 10_000;

/** The system's own `open`, by its full name: the page's `PATH` does not decide what runs. */
const OPEN = "/usr/bin/open";

const PACKAGE_JXA =
	'function run(a){ObjC.import("AppKit");return $.NSWorkspace.sharedWorkspace.isFilePackageAtPath(a[0])}';

function desktop(deps: SystemDeps): DesktopOps {
	return {
		openArgv: (abs) => [OPEN, abs],
		revealArgv: (abs) => [OPEN, "-R", abs],
		/**
		 * LaunchServices' own answer (`NSWorkspace.isFilePackageAtPath`), asked through `osascript` with the path as an
		 * argument (never in the script). Anything but a plain `false`, or a failure to ask, counts as a package.
		 */
		async isPackage(abs) {
			try {
				const r = await deps.run(["/usr/bin/osascript", "-l", "JavaScript", "-e", PACKAGE_JXA, abs], {
					timeoutMs: OPEN_MS,
				});
				return r.code !== 0 || r.stdout.trim() !== "false";
			} catch {
				return true;
			}
		},
	};
}

/**
 * omp's lease on macOS is a `flock` on the lock file, held by the processes that have it open: `lsof` names them. A
 * launch from the macOS app has a short `PATH`, and `lsof` lives in /usr/sbin there.
 */
function locks(deps: SystemDeps): LockOps {
	return {
		async holders(lock) {
			// A session nobody has written to has no lock file.
			if (!existsSync(lock)) return [];
			for (const lsof of ["lsof", "/usr/sbin/lsof"]) {
				try {
					// `-t`: process ids only; none, and a failing exit, when nothing has the file open.
					const { stdout } = await deps.run([lsof, "-t", "--", lock], { timeoutMs: LSOF_MS });
					return stdout
						.split("\n")
						.map((line) => Number(line))
						.filter((pid) => Number.isInteger(pid) && pid > 0);
				} catch {
					// not there (or it hung): the next place
				}
			}
			return [];
		},
	};
}

export function createDarwin(deps: SystemDeps): Platform {
	let version: Promise<string | null> | undefined;
	/** `sw_vers -productVersion`, asked once. */
	const macosVersion = (): Promise<string | null> => {
		version ??= (async () => {
			try {
				const r = await deps.run(["sw_vers", "-productVersion"], { timeoutMs: 10_000 });
				const out = r.stdout.trim();
				return r.code === 0 && /^\d+(\.\d+)*$/.test(out) ? out : null;
			} catch {
				return null;
			}
		})();
		return version;
	};
	return {
		id: "darwin",
		capabilities: capabilitiesFor("darwin"),
		proc: posixProcesses(deps, psIdentity(deps)),
		shell: posixShell(deps),
		commands: posixCommands,
		desktop: desktop(deps),
		power: {
			keepAwakeBin: (env) => env.OMP_WEBUI_CAFFEINATE || "/usr/bin/caffeinate",
			keepAwakeArgv: (bin, pid) => [bin, "-i", "-w", String(pid)],
		},
		host: {
			processes: posixHostProcesses(deps),
			memorySource: "sysctl",
			async memory() {
				// `sysctl` exits 1 when one of its names is unknown but still prints the others: its output is what is wanted.
				const out = await deps.run(["/usr/sbin/sysctl", ...MAC_SYSCTL], { timeoutMs: HOST_READ_MS });
				if (out.code !== 0 && out.stdout === "") throw new Error(out.stderr.trim() || `exit ${out.code}`);
				const values = parseSysctl(out.stdout);
				return { used: memoryUsedMac(values), total: totalmem(), pressure: pressureOf(values) };
			},
		},
		locks: locks(deps),
		socketTemp: "/tmp",
		// `~/Library` holds caches and app data by the hundred thousand; none of it is a project file.
		skipPaths: (home) => [join(home, "Library")],
		async describe() {
			const mac = await macosVersion();
			return mac ? `macOS ${mac} (${arch()})` : `darwin ${release()} (${arch()})`;
		},
	};
}
