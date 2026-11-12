import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readdir, readFile, readlink, stat } from "node:fs/promises";
import { arch, release, totalmem } from "node:os";
import { dirname, join } from "node:path";
import { type NetCounters, parseMeminfo, parseProcMounts, parseProcNetDev } from "../host-parse.ts";
import { capabilitiesFor } from "./capabilities.ts";
import { posixCommands, posixHostProcesses, posixProcesses, posixShell } from "./posix.ts";
import type { LockOps, LoginItemOps, Platform, ProcessOps, SystemDeps, TrashOps, WorkingFolder } from "./types.ts";

/**
 * The XDG autostart entry that starts the launcher at login (Settings › Start at login): `Exec` runs it with `--background`,
 * with no terminal. A path the entry cannot quote plainly (a quote, a backtick, `$`, `\`, `%`, a line break: what the
 * package's install.sh refuses too) is refused.
 */
export function autostartEntry(program: string): string {
	if (/["`$\\%\n\r]/.test(program)) throw new Error(`${program} cannot be named in an autostart entry`);
	return [
		"[Desktop Entry]",
		"Type=Application",
		"Name=omp-webui",
		"Comment=Starts omp-webui in the background",
		`Exec="${program}" --background`,
		"Terminal=false",
		"NoDisplay=true",
		"X-GNOME-Autostart-enabled=true",
		"",
	].join("\n");
}

/** `~/.config/autostart/omp-webui.desktop` (`XDG_CONFIG_HOME`'s): on while it is there and not turned off in it. */
function autostart(deps: SystemDeps): LoginItemOps {
	const file = (home: string) =>
		join(deps.env.XDG_CONFIG_HOME || join(home, ".config"), "autostart", "omp-webui.desktop");
	return {
		async read(home) {
			const text = deps.readFile(file(home));
			// A desktop's own switch for the entry writes one of these into it.
			return text !== null && !/^(Hidden\s*=\s*true|X-GNOME-Autostart-enabled\s*=\s*false)\s*$/im.test(text);
		},
		async write(home, program) {
			const path = file(home);
			if (program === null) return rmSync(path, { force: true });
			const text = autostartEntry(program);
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(`${path}.tmp`, text);
			renameSync(`${path}.tmp`, path);
		},
	};
}

/**
 * Linux: when the process started in the kernel's ticks since boot (`/proc/<pid>/stat`, field 22) and which boot, and
 * its command line. Not `ps -o lstart`, which is the boot time plus those ticks: a suspend or a clock step moves the
 * boot time, and a conversation that is still the recorded one would no longer be recognised.
 */
function linuxIdentity(pid: number, deps: SystemDeps): string | null {
	const stat = deps.readFile(`/proc/${pid}/stat`);
	if (!stat) return null;
	// `pid (command) state …`: the command may hold spaces and parentheses, so the fields count from the last one.
	const close = stat.lastIndexOf(")");
	const started = stat
		.slice(close + 2)
		.trim()
		.split(" ")[19];
	if (close < 0 || !started || !/^\d+$/.test(started)) return null;
	const boot = deps.readFile("/proc/sys/kernel/random/boot_id")?.trim() ?? "";
	const command = (deps.readFile(`/proc/${pid}/cmdline`) ?? "").split("\0").join(" ").trim();
	// A process without a command line (a kernel thread, one that is ending) is named by its own name.
	return `linux:${boot}:${started} ${command || `[${stat.slice(stat.indexOf("(") + 1, close)}]`}`;
}

function procIdentity(deps: SystemDeps): Pick<ProcessOps, "identity" | "identities"> {
	return {
		identity: async (pid) => linuxIdentity(pid, deps),
		async identities(pids) {
			const found = new Map<number, string>();
			for (const pid of pids) {
				const identity = linuxIdentity(pid, deps);
				if (identity) found.set(pid, identity);
			}
			return found;
		},
	};
}

/**
 * The abstract socket name omp's native lock binds on Linux for the lock path `path`: two 64-bit xxHashes of the path's
 * UTF-8 bytes under omp's two fixed seeds (`memory_lock_name` in pi-natives' `file_lock`).
 */
export function abstractLockName(path: string): string {
	const bytes = Buffer.from(path, "utf8");
	const high = Bun.hash.xxHash64(bytes, 0x4f4d_502d_4c4f_434bn);
	const low = Bun.hash.xxHash64(bytes, 0x5049_2d46_494c_454cn);
	return `omp-file-lock-${high.toString(16).padStart(16, "0")}${low.toString(16).padStart(16, "0")}`;
}

/**
 * The processes that have the Unix socket bound at `address` (`@name` for an abstract one) open: its inodes from
 * `<proc>/net/unix`, then every process whose open files include one of them. Processes this user cannot look into are
 * skipped (a terminal's omp is the same user's).
 */
async function socketHolders(address: string, proc: string): Promise<number[]> {
	let table: string;
	try {
		table = await readFile(join(proc, "net", "unix"), "utf8");
	} catch {
		return [];
	}
	// `Num RefCount Protocol Flags Type St Inode Path`: the path is the eighth column, absent for an unbound socket.
	const sockets = new Set<string>();
	for (const line of table.split("\n").slice(1)) {
		const cols = line.trim().split(/\s+/);
		if (cols[7] === address && cols[6]) sockets.add(`socket:[${cols[6]}]`);
	}
	if (sockets.size === 0) return [];
	const holders: number[] = [];
	for (const entry of await readdir(proc).catch(() => [] as string[])) {
		const pid = Number(entry);
		if (!Number.isInteger(pid) || pid <= 0) continue;
		const fdDir = join(proc, entry, "fd");
		for (const fd of await readdir(fdDir).catch(() => [] as string[])) {
			const target = await readlink(join(fdDir, fd)).catch(() => null);
			if (target !== null && sockets.has(target)) {
				holders.push(pid);
				break;
			}
		}
	}
	return holders;
}

/** omp's lease on Linux: no file is made, it is an abstract Unix socket named from the lock's path, held by the process that has it bound. */
const locks: LockOps = {
	holders: (lock, proc) => socketHolders(`@${abstractLockName(lock)}`, proc),
};

/**
 * Linux has no Trash command of its own here (no freedesktop Trash is written): nothing is offered unless
 * `OMP_WEBUI_TRASH_COMMAND` names one (tests). Working folders are `<proc>/<pid>/cwd` of this user's processes.
 */
export function linuxTrash(deps: SystemDeps, uid: () => number | undefined, proc = "/proc"): TrashOps {
	return {
		command: () => deps.env.OMP_WEBUI_TRASH_COMMAND || null,
		async workingFolders() {
			const me = uid();
			const entries = await readdir(proc).catch(() => null);
			if (me === undefined || entries === null) return null;
			const out: WorkingFolder[] = [];
			for (const entry of entries) {
				const pid = Number(entry);
				if (!Number.isInteger(pid) || pid <= 0) continue;
				const owner = await stat(join(proc, entry))
					.then((s) => s.uid)
					.catch(() => null);
				if (owner !== me) continue;
				const cwd = await readlink(join(proc, entry, "cwd")).catch(() => null);
				if (cwd === null || !cwd.startsWith("/")) continue;
				const name = (deps.readFile(join(proc, entry, "comm")) ?? "").trim();
				// `<pid> (<comm>) <state> <ppid> …`: the name may hold spaces and parentheses, so read after its last `)`.
				const status = deps.readFile(join(proc, entry, "stat")) ?? "";
				const ppid =
					Number(
						status
							.slice(status.lastIndexOf(")") + 1)
							.trim()
							.split(" ")[1],
					) || 0;
				out.push({ pid, ppid, name, cwd });
			}
			return out;
		},
	};
}

/** How long which interfaces are a device is kept: they come and go seldom, and a new name is asked about at once. */
const PHYSICAL_MS = 60_000;

/**
 * Linux's network counters: `/proc/net/dev`, of the interfaces that are a device (`<sys>/<name>/device` is there: Ethernet,
 * Wi-Fi; not the loopback, a bridge, a VPN's `tun`, a container's `veth`, whose traffic is a device's already). Which ones
 * are is asked again after a minute. `sys` and `now` are a test's own.
 */
export function linuxNetBytes(
	deps: SystemDeps,
	sys = "/sys/class/net",
	now: () => number = Date.now,
): () => Promise<NetCounters> {
	let physical = new Map<string, boolean>();
	let since = Number.NEGATIVE_INFINITY;
	return async () => {
		const text = deps.readFile("/proc/net/dev");
		if (text === null) throw new Error("/proc/net/dev could not be read");
		if (now() - since > PHYSICAL_MS) {
			physical = new Map();
			since = now();
		}
		const out = new Map<string, { rx: number; tx: number }>();
		for (const [name, counters] of parseProcNetDev(text)) {
			let device = physical.get(name);
			if (device === undefined) {
				device = existsSync(join(sys, name, "device"));
				physical.set(name, device);
			}
			if (device) out.set(name, counters);
		}
		return out;
	};
}

export function createLinux(deps: SystemDeps): Platform {
	const proc = posixProcesses(deps, procIdentity(deps));
	return {
		id: "linux",
		capabilities: capabilitiesFor("linux"),
		proc,
		shell: posixShell(deps),
		commands: posixCommands,
		desktop: null,
		openUrlArgv: (url) => ["xdg-open", url],
		power: null,
		host: {
			processes: posixHostProcesses(deps),
			memorySource: "meminfo",
			async memory() {
				const text = deps.readFile("/proc/meminfo");
				if (text === null) throw new Error("/proc/meminfo could not be read");
				const meminfo = parseMeminfo(text);
				return { used: meminfo?.used ?? null, total: meminfo?.total ?? totalmem(), pressure: null };
			},
			netBytes: linuxNetBytes(deps),
			async disks() {
				const text = deps.readFile("/proc/mounts");
				if (text === null) throw new Error("/proc/mounts could not be read");
				return parseProcMounts(text);
			},
		},
		locks,
		socketTemp: "/tmp",
		skipPaths: () => [],
		describe: async () => `linux ${release()} (${arch()})`,
		loginItem: autostart(deps),
		trash: linuxTrash(deps, () => proc.uid()),
	};
}
