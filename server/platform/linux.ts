import { readdir, readFile, readlink } from "node:fs/promises";
import { arch, release, totalmem } from "node:os";
import { join } from "node:path";
import { parseMeminfo } from "../host-parse.ts";
import { capabilitiesFor } from "./capabilities.ts";
import { posixCommands, posixHostProcesses, posixProcesses, posixShell } from "./posix.ts";
import type { LockOps, Platform, ProcessOps, SystemDeps } from "./types.ts";

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

export function createLinux(deps: SystemDeps): Platform {
	return {
		id: "linux",
		capabilities: capabilitiesFor("linux"),
		proc: posixProcesses(deps, procIdentity(deps)),
		shell: posixShell(deps),
		commands: posixCommands,
		desktop: null,
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
		},
		locks,
		socketTemp: "/tmp",
		skipPaths: () => [],
		describe: async () => `linux ${release()} (${arch()})`,
	};
}
