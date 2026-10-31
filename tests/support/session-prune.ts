import { existsSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * The conversations of a worker-scoped e2e server, kept to what the server started with plus what the current spec file
 * writes (#7, A-025). Every spec adds conversations to its worker's agent folder, and a worker that runs many files (one
 * or two workers, a change in sharding) would list hundreds: past `WINDOW_FROM` (`web/src/components/SessionList.tsx`)
 * the sidebar draws only the rows near its scroll position, and the fixture rows, the oldest, are then not in the page
 * for the specs that click them.
 *
 * `entries` is what the folder holds: when the server has started (its fixtures), and when a test has ended (what its file
 * has written so far). `prune` takes away what the earlier file left, once its processes have ended, and nothing the
 * next file wrote before its first test (a `beforeAll`). A spec never reads what another file wrote: files run in any
 * order, on any worker.
 */
export function sessionEntries(agentDir: string): Set<string> {
	const sessions = join(agentDir, "sessions");
	const out = new Set<string>();
	if (!existsSync(sessions)) return out;
	for (const entry of readdirSync(sessions, { recursive: true, encoding: "utf8" })) out.add(entry);
	return out;
}

/**
 * Remove what is under `<agentDir>/sessions`, among `left` (what the earlier file had left when its last test ended) and
 * not in `keep` (the fixtures). Files go first, then the folders they leave empty: a folder an earlier file made, which
 * the next file has written to as well, keeps what the next file wrote. Returns how many entries went.
 */
export function pruneSessions(agentDir: string, keep: ReadonlySet<string>, left: ReadonlySet<string>): number {
	const sessions = join(agentDir, "sessions");
	let removed = 0;
	const folders: string[] = [];
	for (const entry of left) {
		if (keep.has(entry)) continue;
		const path = join(sessions, entry);
		const stat = statSync(path, { throwIfNoEntry: false });
		if (!stat) continue;
		if (stat.isDirectory()) folders.push(entry);
		else {
			rmSync(path, { force: true });
			removed++;
		}
	}
	// Deepest first: a folder's own folders are emptied before it is looked at.
	for (const entry of folders.sort((a, b) => b.length - a.length)) {
		const path = join(sessions, entry);
		if (readdirSync(path).length) continue;
		rmSync(path, { recursive: true, force: true });
		removed++;
	}
	return removed;
}
