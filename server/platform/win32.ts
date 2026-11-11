import { statfsSync, statSync } from "node:fs";
import { arch, freemem, release, totalmem } from "node:os";
import { delimiter, extname, join, win32 as windowsPath } from "node:path";
import type { DiskMount, PsRow } from "../host-parse.ts";
import { capabilitiesFor } from "./capabilities.ts";
import { probe, treesOf } from "./system.ts";
import type { CommandOps, LoginItemOps, Platform, ProcessEntry, ProcessOps, ShellOps, SystemDeps } from "./types.ts";

/**
 * Windows, as far as it can go without native calls: processes are listed with PowerShell's CIM
 * (`Get-CimInstance Win32_Process`), a tree is ended with `taskkill /T`, programs are found with `PATHEXT`. What needs
 * more (freezing a process, relays over named pipes, keeping awake, the lease, opening files safely) is off in
 * `capabilities` until it is built (docs: the Windows feasibility study, phase 1).
 */

const POWERSHELL = ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"];
/** A CIM query starts PowerShell: about a second, more on a busy machine. */
const CIM_MS = 15_000;
/** omp's README installer for Windows, as its own header gives the standalone-binary form. */
const PS_INSTALLER = "& ([scriptblock]::Create((irm https://omp.sh/install.ps1))) -Binary";
/** The key whose values Windows starts at this user's login. */
const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const RUN_VALUE = "omp-webui";

/**
 * What the `Run` value starts: the launcher with `--background`, its console window minimized (`start /min`), so that it is in
 * the taskbar and closing it stops the server, as with a double-click.
 */
export function runCommand(systemRoot: string, program: string): string {
	if (program.includes('"')) throw new Error(`${program} cannot be named in a Run value`);
	return `"${windowsPath.join(systemRoot, "System32", "cmd.exe")}" /d /c start "" /min "${program}" --background`;
}

/** The `Run` value, read and written with the system's own `reg.exe`. */
function runKey(deps: SystemDeps): LoginItemOps {
	const root = deps.env.SystemRoot || "C:\\Windows";
	const reg = windowsPath.join(root, "System32", "reg.exe");
	const query = async () =>
		(await deps.run([reg, "query", RUN_KEY, "/v", RUN_VALUE], { timeoutMs: 10_000 })).code === 0;
	return {
		read: query,
		async write(_home, program) {
			const argv =
				program === null
					? [reg, "delete", RUN_KEY, "/v", RUN_VALUE, "/f"]
					: [reg, "add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", runCommand(root, program), "/f"];
			const r = await deps.run(argv, { timeoutMs: 10_000 });
			// Deleting a value that is not there fails, and leaves what was asked for.
			if (r.code !== 0 && (program !== null || (await query())))
				throw new Error(r.stderr.trim() || `reg.exe exit ${r.code}`);
		},
	};
}

/** One process as CIM describes it. */
interface CimProcess extends ProcessEntry {
	/** When it started, UTC, ISO 8601; empty for the system's own processes, which have no creation date. */
	created: string;
	command: string;
	/** Seconds of CPU in all, and the working set in bytes. */
	cpu: number;
	rss: number;
}

/**
 * The PowerShell that prints every process `filter` selects (a WQL condition on numbers only, never text from outside),
 * one line each: pid, parent, creation (UTC, round-trip format), CPU (100 ns units), working set, command line, by tabs.
 */
function cimScript(filter: string | null): string {
	const where = filter ? ` -Filter "${filter}"` : "";
	return (
		`Get-CimInstance Win32_Process${where} | ForEach-Object { ` +
		`$c = if ($_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { '' }; ` +
		`"{0}\`t{1}\`t{2}\`t{3}\`t{4}\`t{5}" -f $_.ProcessId, $_.ParentProcessId, $c, ` +
		`($_.KernelModeTime + $_.UserModeTime), $_.WorkingSetSize, $_.CommandLine }`
	);
}

function parseCim(text: string): CimProcess[] {
	const out: CimProcess[] = [];
	for (const line of text.split(/\r?\n/)) {
		const [pid, ppid, created, cpu, rss, ...command] = line.split("\t");
		const p = Number(pid);
		if (!Number.isInteger(p) || p <= 0 || command.length === 0) continue;
		out.push({
			pid: p,
			ppid: Number(ppid) || 0,
			created: created ?? "",
			cpu: (Number(cpu) || 0) / 1e7,
			rss: Number(rss) || 0,
			command: command.join("\t").trim(),
		});
	}
	return out;
}

/** The WQL condition for exactly these pids (integers only). */
const pidFilter = (pids: readonly number[]): string =>
	pids
		.filter((p) => Number.isInteger(p) && p > 0)
		.map((p) => `ProcessId=${p}`)
		.join(" OR ");

const identityOf = (p: CimProcess): string => `win32:${p.created} ${p.command}`;

/** A signal Windows cannot deliver (it only terminates). */
function unsupported(signal: NodeJS.Signals): Error {
	return Object.assign(new Error(`${signal} is not available on Windows`), { code: "ENOSYS" });
}

/** Signals Windows has an answer for: each ends the process (TerminateProcess). */
const ENDS: Partial<Record<NodeJS.Signals, true>> = { SIGTERM: true, SIGKILL: true, SIGINT: true };

function processes(deps: SystemDeps): ProcessOps {
	const query = async (filter: string | null, timeoutMs = CIM_MS): Promise<CimProcess[]> => {
		const r = await deps.run([...POWERSHELL, cimScript(filter)], { timeoutMs });
		if (r.code !== 0) throw new Error(r.stderr.trim() || `powershell exit ${r.code}`);
		return parseCim(r.stdout);
	};
	const one = async (pid: number, timeoutMs?: number): Promise<CimProcess | null> => {
		if (!Number.isInteger(pid) || pid <= 0) return null;
		return (await query(pidFilter([pid]), timeoutMs)).find((p) => p.pid === pid) ?? null;
	};
	const list: ProcessOps["list"] = async () => (await query(null)).map(({ pid, ppid }) => ({ pid, ppid }));
	/** `taskkill` on the tree `leader` heads: `/F` for a kill, without it a request to close (what Windows has for a SIGTERM). */
	const taskkill = (leader: number, signal: NodeJS.Signals): void => {
		if (signal !== "SIGTERM" && signal !== "SIGKILL") throw unsupported(signal);
		const r = deps.runSync(["taskkill", "/PID", String(leader), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])]);
		if (r.code !== 0) throw Object.assign(new Error(`taskkill could not end process ${leader}`), { code: "ESRCH" });
	};
	const signal = (pid: number, sig: NodeJS.Signals): void => {
		if (!ENDS[sig]) throw unsupported(sig);
		deps.kill(pid, sig);
	};
	return {
		exists: (pid) => probe(deps, pid),
		// No process groups: a group never outlives its leader here.
		groupExists: () => false,
		signal,
		signalGroup: taskkill,
		signalTrees(pids, sig) {
			if (!ENDS[sig]) return;
			for (const p of pids) {
				try {
					taskkill(p, sig === "SIGINT" ? "SIGTERM" : sig);
				} catch {
					try {
						signal(p, sig);
					} catch {
						// already gone
					}
				}
			}
		},
		signalChild(child, sig) {
			try {
				taskkill(child.pid, sig);
			} catch {
				try {
					child.kill(sig);
				} catch {
					// already gone
				}
			}
		},
		list,
		trees: async (roots) => treesOf(await list(), roots),
		tree: async (pid) => treesOf(await list(), [pid]).get(pid) as number[],
		async identity(pid) {
			try {
				const p = await one(pid);
				return p ? identityOf(p) : null;
			} catch {
				return null;
			}
		},
		async identities(pids) {
			const found = new Map<number, string>();
			const filter = pidFilter(pids);
			if (!filter) return found;
			try {
				for (const p of await query(filter)) found.set(p.pid, identityOf(p));
			} catch {
				// no listing: none is known to run
			}
			return found;
		},
		startTime: async (pid) => (await one(pid))?.created || null,
		commandLine: async (pid, timeoutMs) => (await one(pid, timeoutMs))?.command || null,
		commandLineSync(pid) {
			if (!Number.isInteger(pid) || pid <= 0) return null;
			const r = deps.runSync([...POWERSHELL, cimScript(pidFilter([pid]))]);
			if (r.code !== 0) return null;
			return parseCim(r.stdout).find((p) => p.pid === pid)?.command || null;
		},
		async commandLines() {
			try {
				return (await query(null)).map((p) => p.command);
			} catch {
				return null;
			}
		},
		// `detached` gives the child a console of its own; hidden, so that no window flashes up.
		groupSpawn: { detached: true, windowsHide: true },
		uid: () => undefined,
	};
}

/** The extensions Windows runs a program by (`PATHEXT`), lower case. */
function pathExtensions(deps: SystemDeps): string[] {
	return (deps.env.PATHEXT || ".COM;.EXE;.BAT;.CMD")
		.split(";")
		.filter(Boolean)
		.map((e) => e.toLowerCase());
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

function commands(deps: SystemDeps): CommandOps {
	return {
		which(name, dirs) {
			const exts = pathExtensions(deps);
			const names = exts.includes(extname(name).toLowerCase()) ? [name] : exts.map((e) => `${name}${e}`);
			for (const dir of dirs) {
				for (const n of names) {
					const candidate = join(dir, n);
					if (isFile(candidate)) return candidate;
				}
			}
			return null;
		},
		// No execute bit: a file that is there may be run.
		isExecutable: isFile,
		installDirs: [],
		brewDirs: [],
		fallbackPath: [],
		// omp's `install.ps1`: `%LOCALAPPDATA%\omp\omp.exe`.
		ompInstallDir: (home) => join(deps.env.LOCALAPPDATA || join(home, "AppData", "Local"), "omp"),
	};
}

function shell(deps: SystemDeps, find: CommandOps): ShellOps {
	return {
		// PowerShell 7, else Windows PowerShell, else `cmd`.
		interactive() {
			const dirs = (deps.env.PATH ?? deps.env.Path ?? "").split(delimiter).filter(Boolean);
			return [find.which("pwsh", dirs) ?? find.which("powershell", dirs) ?? deps.env.ComSpec ?? "cmd.exe"];
		},
		// A console program has no hangup: it is terminated.
		hangup: undefined,
		// A Windows app inherits the user's environment from the registry: there is no login shell to ask.
		loginEnvArgv: () => null,
		// Files under the user's profile inherit an ACL that is the user's own: there is no umask to set.
		privateArgv: (command) => command,
		// No `/bin/sh` to write the status: the server writes it when the job ends (and a job does not outlive it).
		jobArgv: () => null,
		// omp's PowerShell installer, its standalone binary (`-Binary`: its default installs through bun when bun is there,
		// which is the Bun option's job). A failed download is an error PowerShell ends with, so the job reports it.
		installer: () => ({
			argv: [...POWERSHELL, `$ErrorActionPreference = 'Stop'; ${PS_INSTALLER}`],
			command: PS_INSTALLER,
			needs: "powershell",
		}),
		shutdownSignals: ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"],
		relayIgnored: [],
	};
}

export function createWin32(deps: SystemDeps): Platform {
	const find = commands(deps);
	return {
		id: "win32",
		capabilities: capabilitiesFor("win32"),
		proc: processes(deps),
		shell: shell(deps, find),
		commands: find,
		desktop: null,
		// The system's own `rundll32` (not one a `PATH` names first) hands the address to the default browser; unlike
		// `cmd /c start`, nothing in it is read by a shell.
		openUrlArgv: (url) => [
			join(deps.env.SystemRoot || "C:\\Windows", "System32", "rundll32.exe"),
			"url.dll,FileProtocolHandler",
			url,
		],
		power: null,
		host: {
			async processes(): Promise<PsRow[]> {
				const r = await deps.run([...POWERSHELL, cimScript(null)], { timeoutMs: CIM_MS });
				if (r.code !== 0) throw new Error(r.stderr.trim() || `powershell exit ${r.code}`);
				return parseCim(r.stdout).map(({ pid, ppid, cpu, rss }) => ({ pid, ppid, cpu, rss }));
			},
			memorySource: "os",
			memory: async () => ({ used: totalmem() - freemem(), total: totalmem(), pressure: null }),
			// No network figure yet: the interfaces' counters are a native call (GetIfTable2) or a PowerShell a look away.
			netBytes: null,
			// The drive letters `statfs` answers for: a letter with no drive, or an empty card reader, does not.
			disks: async () => {
				const out: DiskMount[] = [];
				for (let c = 65; c <= 90; c++) {
					const drive = `${String.fromCharCode(c)}:`;
					try {
						statfsSync(`${drive}\\`);
						out.push({ mount: `${drive}\\`, name: drive });
					} catch {
						// Not a drive now.
					}
				}
				return out;
			},
		},
		locks: null,
		socketTemp: deps.env.TEMP ?? deps.env.TMP ?? ".",
		skipPaths: (home) => [join(home, "AppData")],
		describe: async () => `win32 ${release()} (${arch()})`,
		loginItem: runKey(deps),
		trash: null,
	};
}
