import { readFileSync } from "node:fs";
import { run } from "../omp/run.ts";
import type { ProcessEntry, SystemDeps } from "./types.ts";

/** The system itself: what every adapter runs on unless a test hands it another (`platformFor(id, deps)`). */
export const systemDeps: SystemDeps = {
	run: (argv, opts) => run(argv, opts),
	runSync(argv) {
		try {
			const r = Bun.spawnSync(argv, { stdout: "pipe", stderr: "ignore" });
			return { code: r.exitCode, stdout: r.stdout.toString() };
		} catch {
			return { code: -1, stdout: "" };
		}
	},
	readFile(path) {
		try {
			return readFileSync(path, "utf8");
		} catch {
			return null;
		}
	},
	kill: (pid, signal) => {
		process.kill(pid, signal);
	},
	env: process.env,
};

/** Whether a process exists: one that is not ours refuses the probe (EPERM), and is there. */
export function probe(deps: SystemDeps, pid: number): boolean {
	try {
		deps.kill(pid, 0);
		return true;
	} catch (e) {
		return (e as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * For each of `roots`: the process itself and every process below it in `listing`, each once. Parent ids can loop: Windows
 * keeps the id of a parent that has ended, and reuses ids, so a process can name one below it as its parent.
 */
export function treesOf(listing: readonly ProcessEntry[], roots: readonly number[]): Map<number, number[]> {
	const children = new Map<number, number[]>();
	for (const { pid, ppid } of listing) {
		const list = children.get(ppid) ?? [];
		list.push(pid);
		children.set(ppid, list);
	}
	const trees = new Map<number, number[]>();
	for (const root of roots) {
		const out: number[] = [];
		const seen = new Set<number>();
		const stack = [root];
		for (let p = stack.pop(); p !== undefined; p = stack.pop()) {
			if (seen.has(p)) continue;
			seen.add(p);
			out.push(p);
			// Pushed last to first: the first child is walked first, as a listing reads.
			stack.push(...(children.get(p) ?? []).toReversed());
		}
		trees.set(root, out);
	}
	return trees;
}

/** `pid ppid` lines (what `ps -o pid=,ppid=` prints) as entries; lines that are not two numbers are left out. */
export function parsePidPairs(text: string): ProcessEntry[] {
	const out: ProcessEntry[] = [];
	for (const line of text.split("\n")) {
		const [pid, ppid] = line.trim().split(/\s+/).map(Number);
		if (pid && ppid) out.push({ pid, ppid });
	}
	return out;
}
