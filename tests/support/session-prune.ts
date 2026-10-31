import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

/**
 * The conversations of a worker-scoped e2e server, kept to what the server started with plus what the current spec file
 * writes (#7, A-025). Every spec adds conversations to its worker's agent folder, and a worker that runs many files (one
 * or two workers, a change in sharding) would list hundreds: past `WINDOW_FROM` (`web/src/components/SessionList.tsx`)
 * the sidebar draws only the rows near its scroll position, and the fixture rows, the oldest, are then not in the page
 * for the specs that click them.
 *
 * `entries` is what the folder holds when the server has started (its fixtures); `prune` takes away everything else, once
 * a file's processes have ended. A spec never reads what another file wrote: files run in any order, on any worker.
 */
export function sessionEntries(agentDir: string): Set<string> {
	const sessions = join(agentDir, "sessions");
	const out = new Set<string>();
	if (!existsSync(sessions)) return out;
	for (const entry of readdirSync(sessions, { recursive: true, encoding: "utf8" })) out.add(entry);
	return out;
}

/** Remove what is under `<agentDir>/sessions` and not in `keep`; returns how many entries went. */
export function pruneSessions(agentDir: string, keep: ReadonlySet<string>): number {
	const sessions = join(agentDir, "sessions");
	let removed = 0;
	for (const entry of sessionEntries(agentDir)) {
		if (keep.has(entry)) continue;
		// A folder the server did not start with goes whole; what was in it is then gone, and found no more.
		const path = join(sessions, entry);
		if (!existsSync(path)) continue;
		rmSync(path, { recursive: true, force: true });
		removed++;
	}
	return removed;
}
