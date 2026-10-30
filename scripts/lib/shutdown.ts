/**
 * What a script cleans up when it is stopped by a signal, not only when it ends. Neither Bun nor Node runs `finally`
 * blocks or 'exit' hooks when SIGINT, SIGTERM or SIGHUP end the process (exit code 130/143/129, nothing run), so a
 * script that started servers, mounted an image or made a temporary tree leaves them behind unless it registers here.
 *
 *   const cleanup = onShutdown(async () => { await server.stop(); rmSync(dir, { recursive: true, force: true }); });
 *   try { ...the script... } finally { await cleanup(); }
 *
 * The same function serves both ends: it runs once, whichever comes first (a signal in the middle of the script, or
 * the script's own `finally`), and a caller that arrives while it runs waits for it. After a signal every registered
 * cleanup runs, the last one registered first (the order of acquiring, reversed), and then the process exits with
 * 128 + the signal number. A second signal while they run ends the process at once.
 *
 * Runs under Bun and Node (type stripping only: no enums, no parameter properties).
 */
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

type Cleanup = () => void | Promise<void>;

const SIGNALS = [
	["SIGHUP", 129],
	["SIGINT", 130],
	["SIGTERM", 143],
] as const;

const registered = new Set<() => Promise<void>>();
let installed = false;
let stopping = false;

/** True once a signal has begun the shutdown: the script's own error handling can stay quiet about what it caused. */
export function isShuttingDown(): boolean {
	return stopping;
}

async function shutdown(signal: string, code: number): Promise<void> {
	if (stopping) {
		process.exit(code);
	}
	stopping = true;
	console.error(`\n${signal}: stopping, cleaning up`);
	for (const run of [...registered].reverse()) await run();
	console.error(`${signal}: cleaned up`);
	process.exit(code);
}

/** Register `cleanup` for a signal; the returned function runs it (once) and is what the script calls when it ends. */
export function onShutdown(cleanup: Cleanup): () => Promise<void> {
	if (!installed) {
		installed = true;
		for (const [signal, code] of SIGNALS) process.on(signal, () => void shutdown(signal, code));
	}
	let running: Promise<void> | null = null;
	const run = (): Promise<void> => {
		running ??= (async () => {
			try {
				await cleanup();
			} catch (error) {
				console.error(`cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
			} finally {
				registered.delete(run);
			}
		})();
		return running;
	};
	registered.add(run);
	return run;
}

/** The processes below `pid` (children, their children, ...), the deepest first. */
export function descendants(pid: number): number[] {
	const table = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
	const children = new Map<number, number[]>();
	for (const line of table.split("\n")) {
		const [child, parent] = line.trim().split(/\s+/).map(Number);
		if (!child || parent === undefined || Number.isNaN(parent)) continue;
		children.set(parent, [...(children.get(parent) ?? []), child]);
	}
	const found: number[] = [];
	const walk = (of: number) => {
		for (const child of children.get(of) ?? []) {
			walk(child);
			found.push(child);
		}
	};
	walk(pid);
	return found;
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		// EPERM: it exists, and is not ours to signal.
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

function send(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch {}
}

/**
 * Stop `pid` and everything below it: SIGCONT first (a stopped process leaves SIGTERM pending and never acts on it),
 * SIGTERM, then SIGKILL for what is still there after `graceMs`. Returns when none of them is left.
 */
export async function killTree(pid: number, graceMs = 10_000): Promise<void> {
	const tree = [pid, ...descendants(pid)];
	for (const p of tree) send(p, "SIGCONT");
	for (const p of tree) send(p, "SIGTERM");
	const deadline = Date.now() + graceMs;
	while (tree.some(alive) && Date.now() < deadline) await sleep(50);
	for (const p of tree) if (alive(p)) send(p, "SIGKILL");
	const final = Date.now() + 2000;
	while (tree.some(alive) && Date.now() < final) await sleep(20);
}
