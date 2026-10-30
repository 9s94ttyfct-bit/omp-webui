import { existsSync } from "node:fs";
import { readdir, readFile, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "../omp/run.ts";

/**
 * omp gives a session one writer: the first omp process that writes to a session holds an operating-system lock named by
 * `<home>/.omp/run/session-owners/<session id>.lock` for as long as it lives (omp's session.md, "Durability operations").
 * Another process that writes the session moves to a fresh sibling file instead and leaves the owner's file alone, and a
 * `/session delete` from another process removes the owner's file under it. The server's own processes are known to it;
 * a terminal's omp is told only by the lock. On macOS (and other Unix systems but Linux) the lock is a `flock` on that file,
 * held by an open file: the processes that have it open hold it. On Linux no file is made: the lock is an abstract Unix
 * socket named from that path (omp's native `FileLock`), held by the process that has it bound.
 */

/** How long asking the system who has the lock may take: `lsof` answers in a fraction of a second. */
const PROBE_MS = 10_000;

/**
 * The process ids of the omp processes that hold the write lease of session `id` (none when nobody does, and when it
 * cannot be told: a system without `lsof`, or a Linux without `/proc`, leaves the lease unseen, which is how it was before
 * it was looked at).
 */
export async function leaseHolders(
	id: string,
	home = homedir(),
	platform: string = process.platform,
	proc = "/proc",
): Promise<number[]> {
	const lock = join(home, ".omp", "run", "session-owners", `${id}.lock`);
	if (platform === "linux") return socketHolders(`@${abstractLockName(lock)}`, proc);
	// A session nobody has written to has no lock file.
	if (!existsSync(lock)) return [];
	// A launch from the macOS app has a short PATH, and `lsof` lives in /usr/sbin there.
	for (const lsof of ["lsof", "/usr/sbin/lsof"]) {
		try {
			// `-t`: process ids only; none, and a failing exit, when nothing has the file open.
			const { stdout } = await run([lsof, "-t", "--", lock], { timeoutMs: PROBE_MS });
			return stdout
				.split("\n")
				.map((line) => Number(line))
				.filter((pid) => Number.isInteger(pid) && pid > 0);
		} catch {
			// not there (or it hung): the next place
		}
	}
	return [];
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
