import { existsSync } from "node:fs";
import { readdir, readFile, readlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { compareVersions, parseVersion } from "../../shared/omp-install.ts";
import { QUICK_MS, run } from "../omp/run.ts";

/**
 * omp gives a session one writer: the first omp process that writes to a session holds an operating-system lease on it,
 * keyed by its session id, for as long as it lives (omp's session.md, "Durability operations"). Another process that
 * writes the session moves to a fresh sibling file instead and leaves the owner's file alone, and a `/session delete`
 * from another process removes the owner's file under it. The server's own processes are known to it; a terminal's omp
 * is told only by the lease.
 *
 * omp 18.14.1 answers whether a lease is held (`omp session lease --json -- <id>`), without taking it: that is what is
 * asked. It does not say which process holds it (this one included), so where the server has a process of its own on the
 * conversation (which holds the lease only once it has written to it), and for an older omp, the holders are looked up
 * on the system, where omp keeps the lease:
 * - its directory is `<home>/<PI_CONFIG_DIR, else .omp>/run/session-owners`, or `$XDG_STATE_HOME/omp/run/session-owners`
 *   on Linux and macOS when `$XDG_STATE_HOME/omp` exists (pi-utils' `getSessionOwnersDir`, the same since omp 18.12.3);
 * - the lock is `<that directory>/<session id>.lock` (an id that is not a plain token is named by its hash);
 * - on macOS (and other Unix systems but Linux) it is a `flock` on that file, held by the processes that have it open; on
 *   Linux no file is made: it is an abstract Unix socket named from that path (omp's native `FileLock`), held by the
 *   process that has it bound.
 */

/** The first omp with `omp session lease` (and RPC `get_session_lease`). */
export const SESSION_LEASE_SINCE = "18.14.1";

/** How long asking the system who has the lock may take: `lsof` answers in a fraction of a second. */
const PROBE_MS = 10_000;

/** The omp the server runs. `version`: what it reports, anything else when it could not report one. */
export interface LeaseOmp {
	bin: string;
	version: string | null;
}

/** Where omp's lease is looked for: the server's environment and system (a test's own in tests). */
export interface LeaseSystem {
	/** The environment omp runs with (the server's: its omp processes inherit it). */
	env: Record<string, string | undefined>;
	home: string;
	platform: string;
	/** Linux's `/proc`. */
	proc: string;
}

export const hostSystem = (): LeaseSystem => ({
	env: process.env,
	home: homedir(),
	platform: process.platform,
	proc: "/proc",
});

/**
 * Whether a process other than `ours` (the server's own process on the conversation, or null) holds the write lease of
 * session `id`: null when none does, or when it cannot be told (a system without `lsof`, or a Linux without `/proc`,
 * leaves the lease unseen); else the holders' process ids where they were looked up (none where omp said it is held).
 */
export async function leaseHeldElsewhere(
	id: string,
	ours: number | null,
	omp: LeaseOmp,
	system: LeaseSystem = hostSystem(),
): Promise<{ pids: number[] } | null> {
	const held = await ompSaysHeld(id, omp, system);
	if (held === false) return null;
	if (held && ours === null) return { pids: [] };
	const others = (await leaseHolders(id, system)).filter((pid) => pid !== ours);
	return others.length ? { pids: others } : null;
}

/**
 * omp's answer to whether the lease of `id` is held: null when this omp is not known to have `omp session lease` (older,
 * or no version), or it could not tell (it failed, or reported the lease `unknown`).
 */
async function ompSaysHeld(id: string, omp: LeaseOmp, system: LeaseSystem): Promise<boolean | null> {
	if (!omp.version || !parseVersion(omp.version) || compareVersions(omp.version, SESSION_LEASE_SINCE) < 0) return null;
	try {
		// `--`: an id that starts with `-` is not an option.
		const { code, stdout } = await run([omp.bin, "session", "lease", "--json", "--", id], {
			timeoutMs: QUICK_MS,
			base: system.env,
		});
		if (code !== 0) return null;
		const report = JSON.parse(stdout) as { held?: unknown; unknown?: unknown };
		if (!Array.isArray(report.held) || !Array.isArray(report.unknown)) return null;
		if (report.held.includes(id)) return true;
		return report.unknown.includes(id) ? null : false;
	} catch {
		// It hung, or printed no JSON.
		return null;
	}
}

/** The directory of omp's session leases (see above). */
export function sessionOwnersDir(system: Pick<LeaseSystem, "env" | "home" | "platform">): string {
	const xdg = system.env.XDG_STATE_HOME;
	if (xdg && (system.platform === "linux" || system.platform === "darwin") && existsSync(join(xdg, "omp")))
		return join(xdg, "omp", "run", "session-owners");
	return join(system.home, system.env.PI_CONFIG_DIR || ".omp", "run", "session-owners");
}

/** The lock of session `id`'s lease: an id read from a file names no path outside the directory. */
export function leaseLockPath(id: string, system: Pick<LeaseSystem, "env" | "home" | "platform">): string {
	const name = /^[A-Za-z0-9_-]{1,128}$/.test(id) ? id : `h-${Bun.hash.wyhash(id).toString(16).padStart(16, "0")}`;
	return `${resolve(sessionOwnersDir(system), name)}.lock`;
}

/** The process ids of the omp processes that hold the write lease of session `id`, as the system tells them. */
export async function leaseHolders(id: string, system: LeaseSystem): Promise<number[]> {
	const lock = leaseLockPath(id, system);
	if (system.platform === "linux") return socketHolders(`@${abstractLockName(lock)}`, system.proc);
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
