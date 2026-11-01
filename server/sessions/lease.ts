import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { compareVersions, parseVersion } from "../../shared/omp-install.ts";
import type { PlatformId } from "../../shared/platform.ts";
import { QUICK_MS, run } from "../omp/run.ts";
import { platform, platformFor } from "../platform/index.ts";

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
	platform: PlatformId;
	/** Linux's `/proc`. */
	proc: string;
}

export const hostSystem = (): LeaseSystem => ({
	env: process.env,
	home: homedir(),
	platform: platform.id,
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

/** The process ids of the omp processes that hold the write lease of session `id`, as the system tells them (`Platform.locks`). */
export async function leaseHolders(id: string, system: LeaseSystem): Promise<number[]> {
	return (await platformFor(system.platform).locks?.holders(leaseLockPath(id, system), system.proc)) ?? [];
}
