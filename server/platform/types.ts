import type { Pressure } from "../../shared/host.ts";
import type { Capabilities, PlatformId } from "../../shared/platform.ts";
import type { DiskMount, NetCounters, PsRow } from "../host-parse.ts";
import type { Ran, RunOptions } from "../omp/run.ts";

/**
 * The one interface the server asks the operating system through (see `index.ts`): processes, signals, shells, the
 * desktop, power, the host's figures and omp's locks. A module outside `server/platform/` never runs `ps`, `kill`,
 * `open`, `/bin/sh` or the like itself, never sends a signal with `process.kill` and never branches on
 * `process.platform` (scripts/check-platform.ts fails the lint when one does).
 */

type Env = Record<string, string | undefined>;

/** What an adapter asks of the system: the real one unless a test hands its own (`platformFor(id, deps)`). */
export interface SystemDeps {
	/** Run a command with a deadline (`server/omp/run.ts`). */
	run(argv: string[], opts: RunOptions): Promise<Ran>;
	/** Run a command and wait for it; `code` is -1 when it could not be started. */
	runSync(argv: string[]): { code: number; stdout: string };
	/** A file's text; null when it cannot be read. */
	readFile(path: string): string | null;
	/** `process.kill`. */
	kill(pid: number, signal: NodeJS.Signals | 0): void;
	/** The environment programs are looked up in. */
	env: Env;
}

/** One process in a listing. */
export interface ProcessEntry {
	pid: number;
	ppid: number;
}

export interface ProcessOps {
	/** Whether a process exists (one that is not ours, which refuses a signal, does). */
	exists(pid: number): boolean;
	/** Whether any process is left in the process group `leader` led (false where there are no process groups). */
	groupExists(leader: number): boolean;
	/** Send `signal` to the process; throws as `process.kill` does (gone, refused, or a signal this system has not). */
	signal(pid: number, signal: NodeJS.Signals): void;
	/** Send `signal` to the process group `leader` leads, or (Windows) to its tree; throws when there is none. */
	signalGroup(leader: number, signal: NodeJS.Signals): void;
	/** Signal each of `pids` and what it leads: omp and what it started, tools in sessions of their own included. Never throws. */
	signalTrees(pids: readonly number[], signal: NodeJS.Signals): void;
	/**
	 * Signal the group a child this server started with `groupSpawn` leads, else (no such group) the child itself. Never
	 * throws: a child that is gone is ended already.
	 */
	signalChild(child: { readonly pid: number; kill(signal?: NodeJS.Signals): void }, signal: NodeJS.Signals): void;
	/** Every process on the computer, from one listing; rejects when the system cannot give one in time. */
	list(): Promise<ProcessEntry[]>;
	/** For each of `roots`: the process itself and every process below it, from one listing (rejects as `list`). */
	trees(roots: readonly number[]): Promise<Map<number, number[]>>;
	/** `pid` and every process below it. */
	tree(pid: number): Promise<number[]>;
	/**
	 * What identifies the process beyond its number, which the system reuses: when it started and its full command line.
	 * Stable across server restarts and changes of the clock. Null when there is no such process.
	 */
	identity(pid: number): Promise<string | null>;
	/** `identity` for each of `pids` that is running, from one listing where the system gives one. */
	identities(pids: readonly number[]): Promise<Map<number, string>>;
	/** When the process started, as the system says it; null when there is none. Rejects when it cannot be asked in time. */
	startTime(pid: number): Promise<string | null>;
	/** The command line of a process; null when there is no such process. Rejects when the system could not say. */
	commandLine(pid: number, timeoutMs?: number): Promise<string | null>;
	/** `commandLine`, waited for; null when there is no such process or it cannot be told. */
	commandLineSync(pid: number): string | null;
	/** The command line of every process, from one listing; null when the system cannot give one. */
	commandLines(): Promise<string[] | null>;
	/** Spawn options that give a child a process group (and session) of its own, and no console window on Windows. */
	readonly groupSpawn: { detached: true; windowsHide?: boolean };
	/** This user's id; undefined where the system has no such thing. */
	uid(): number | undefined;
}

export interface ShellOps {
	/** The Terminal tab's interactive shell, as an argument list: the person's login shell, as a login shell (POSIX). */
	interactive(): string[];
	/** What a terminal's interactive shell is ended with (hung up, as closing a window does); undefined: the default. */
	readonly hangup: NodeJS.Signals | undefined;
	/**
	 * The argument list that asks `shell`, as an interactive login shell (so `.zshrc` runs too), to print `marker` and then
	 * its environment, `NAME=value` NUL-terminated; null where a server needs no login shell's environment.
	 */
	loginEnvArgv(shell: string, marker: string): string[] | null;
	/** `command` run so that the files it (and what it starts) writes are this user's alone (`umask 077`). */
	privateArgv(command: string[]): string[];
	/** `command` run so that its exit status is written to `statusFile` when it is over; null where the server must write it. */
	jobArgv(statusFile: string, command: string[]): string[] | null;
	/**
	 * omp's installer as the server runs it (download, then run), what the first-run screen shows for it (omp's README
	 * one-liner for this system) and the program it needs.
	 */
	installer(): { argv: string[]; command: string; needs: string };
	/** The signals that ask the server to stop. */
	readonly shutdownSignals: readonly NodeJS.Signals[];
	/** Signals a relay ignores: a terminal going away must not end the conversations it holds. */
	readonly relayIgnored: readonly NodeJS.Signals[];
}

export interface CommandOps {
	/** The first `name` in `dirs` this process may run (Windows: with `PATHEXT`'s extensions). */
	which(name: string, dirs: readonly string[]): string | null;
	/** A file this process may run. */
	isExecutable(path: string): boolean;
	/** Where Homebrew and omp's installers put programs that an app started from Finder has no `PATH` for. */
	readonly installDirs: readonly string[];
	/** Where Homebrew is on Linux, searched for `brew` only. */
	readonly brewDirs: readonly string[];
	/** `PATH` when the environment has none at all. */
	readonly fallbackPath: readonly string[];
	/** Where omp's own installer puts omp when `PI_INSTALL_DIR` does not say (`home`: the user's home folder). */
	ompInstallDir(home: string): string;
}

/** Hand a file or folder to the desktop: what runs is the system's own `open`, from an argument list. */
export interface DesktopOps {
	/** Open a file in the app the system has for it. */
	openArgv(abs: string): string[];
	/** Show a file or folder in the file manager. */
	revealArgv(abs: string): string[];
	/** Whether the system treats the folder at this real path as one package (it would start it or hand it to an app). */
	isPackage(abs: string): Promise<boolean>;
}

export interface PowerOps {
	/** The program that holds idle sleep off: the system's own, unless `OMP_WEBUI_CAFFEINATE` names another. */
	keepAwakeBin(env: Env): string;
	/** The command line that holds idle sleep off for as long as `pid` lives. */
	keepAwakeArgv(bin: string, pid: number): string[];
}

/** Memory as the host indicator shows it. `used`/`pressure` null: this system does not say. */
export interface HostMemory {
	used: number | null;
	total: number;
	pressure: Pressure | null;
}

export interface HostOps {
	/** Every process with its CPU time and memory (the host indicator's per-conversation share); rejects when it cannot. */
	processes(): Promise<PsRow[]>;
	/** Memory; rejects when the system's figure could not be read this time. */
	memory(): Promise<HostMemory>;
	/** What failed in `memory`, for the log ("sysctl", "meminfo"). */
	readonly memorySource: string;
	/**
	 * Bytes received and sent so far by each physical network interface (macOS: `sysctl` through libSystem, no process;
	 * Linux: `/proc/net/dev`, the interfaces with a device); rejects when they could not be read this time. Null where the
	 * system has no figure (Windows).
	 */
	readonly netBytes: (() => Promise<NetCounters>) | null;
	/**
	 * The mounted volumes a person has, in mount order (macOS: `/` and /Volumes' local ones, from `mount`; Linux: the block
	 * devices of `/proc/mounts`; Windows: the drive letters that answer); rejects when they could not be listed. Asked at most
	 * once a minute (`host-read.ts`); their free space is `statfs`'s.
	 */
	disks(): Promise<DiskMount[]>;
}

export interface LockOps {
	/** The processes that hold omp's write lease at `lockPath` (`proc`: Linux's `/proc`, a test's own in tests). */
	holders(lockPath: string, proc: string): Promise<number[]>;
}

/** Starting the launcher in the background at login, for this user. */
export interface LoginItemOps {
	/** Whether this user's login starts omp-webui now (the entry this server writes; `home`: the user's home folder). */
	read(home: string): Promise<boolean>;
	/** Start `program` with `--background` at login, or (`program` null) stop doing so. Throws what failed. */
	write(home: string, program: string | null): Promise<void>;
}

/** A process's working folder, as the system tells it (links resolved). */
export interface WorkingFolder {
	pid: number;
	/** Its program's name (`node`, `zsh`). */
	name: string;
	cwd: string;
}

/** Moving what a deleted conversation left to the Trash (docs/superpowers/specs/2026-11-11-delete-session-folder-design.md). */
export interface TrashOps {
	/**
	 * The program that moves the paths it is given to the Trash, keeping Put Back (macOS's `/usr/bin/trash`); null where
	 * there is none. `OMP_WEBUI_TRASH_COMMAND` names another (tests).
	 */
	command(): string | null;
	/** The working folders of this user's processes; null when they could not be listed. */
	workingFolders(): Promise<WorkingFolder[] | null>;
}

export interface Platform {
	readonly id: PlatformId;
	readonly capabilities: Capabilities;
	readonly proc: ProcessOps;
	readonly shell: ShellOps;
	readonly commands: CommandOps;
	/** Null where `capabilities.openFiles` is false. */
	readonly desktop: DesktopOps | null;
	/**
	 * The command that opens an `http(s)` address in the person's default browser (the Windows launcher's page). Only
	 * ever given an address the server made; unlike `desktop`, nothing a page names is opened with it.
	 */
	openUrlArgv(url: string): string[];
	/** Null where `capabilities.keepAwake` is false. */
	readonly power: PowerOps | null;
	readonly host: HostOps;
	/** Null where `capabilities.leaseHolders` is false. */
	readonly locks: LockOps | null;
	/** Where unix sockets with short paths go (a relay's, when its data dir is too deep for one). */
	readonly socketTemp: string;
	/** Folders of the home directory that hold no project files, left out of a file search (macOS's `~/Library`). */
	skipPaths(home: string): string[];
	/** The machine as a bug report names it: `macOS 15.1 (arm64)`, `linux 6.8.0 (x64)`. */
	describe(): Promise<string>;
	/**
	 * Starting the launcher at login, in the background (Settings › App & system › Start at login): an XDG autostart entry on
	 * Linux, the user's `Run` key on Windows. Null on macOS, where the app registers itself (`SMAppService`).
	 */
	readonly loginItem: LoginItemOps | null;
	/** Null where nothing is ever moved to a Trash (Windows). */
	readonly trash: TrashOps | null;
}
