import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run } from "../omp/run.ts";

/**
 * omp gives a session one writer: the first omp process that writes to a session holds an operating-system lock on
 * `<home>/.omp/run/session-owners/<session id>.lock` for as long as it lives (omp's session.md, "Durability operations").
 * Another process that writes the session moves to a fresh sibling file instead and leaves the owner's file alone, and a
 * `/session delete` from another process removes the owner's file under it. The server's own processes are known to it;
 * a terminal's omp is told only by the lock, which is held by an open file: the processes that have it open hold it.
 */

/** How long asking the system who has the lock may take: `lsof` answers in a fraction of a second. */
const PROBE_MS = 10_000;

/**
 * The process ids of the omp processes that hold the write lease of session `id` (none when nobody does, and when it
 * cannot be told: a system without `lsof` leaves the lease unseen, which is how it was before it was looked at).
 */
export async function leaseHolders(id: string, home = homedir()): Promise<number[]> {
	const lock = join(home, ".omp", "run", "session-owners", `${id}.lock`);
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
