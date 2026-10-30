import { PS_MS, run } from "./run.ts";

/**
 * For each of `roots`: the process itself and every process below it, from one `ps` listing. The listing is awaited, not
 * waited for: the server's single thread serves everyone else meanwhile (it took 16–130 ms each, #355). Rejects when
 * `ps` cannot be run or does not answer in time.
 */
export async function processTrees(roots: number[]): Promise<Map<number, number[]>> {
	const listing = await run(["ps", "-A", "-o", "pid=,ppid="], { timeoutMs: PS_MS });
	const children = new Map<number, number[]>();
	for (const line of listing.stdout.split("\n")) {
		const [p, pp] = line.trim().split(/\s+/).map(Number);
		if (!p || !pp) continue;
		const list = children.get(pp) ?? [];
		list.push(p);
		children.set(pp, list);
	}
	const trees = new Map<number, number[]>();
	for (const root of roots) {
		const out: number[] = [];
		const walk = (p: number) => {
			out.push(p);
			for (const c of children.get(p) ?? []) walk(c);
		};
		walk(root);
		trees.set(root, out);
	}
	return trees;
}

/** `pid` and every process below it (ps snapshot). */
export async function processTree(pid: number): Promise<number[]> {
	return (await processTrees([pid])).get(pid) as number[];
}

/** Whether a process exists — or, for a negative `pid`, whether any process is left in that group. */
export function exists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Signal `pids` and the process groups they lead: omp and what it started, tools in sessions of their own included. */
export function signalAll(pids: number[], signal: NodeJS.Signals): void {
	for (const p of pids) {
		for (const target of [p, -p]) {
			try {
				process.kill(target, signal);
			} catch {
				// already gone
			}
		}
	}
}
