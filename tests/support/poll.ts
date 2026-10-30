/**
 * Wait until `condition` holds, or fail after `ms` naming what was awaited. For effects in another process
 * (a server reacting to a closed socket, a process ending) that offer no event to await; the interval is the
 * only wall-clock time involved, and the deadline just bounds a failing run.
 */
export async function pollUntil(condition: () => boolean | Promise<boolean>, what: string, ms = 15_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!(await condition())) {
		if (Date.now() > deadline) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
		await Bun.sleep(25);
	}
}

/** Whether a process exists (one that exited but is not yet collected by its parent still does). */
export function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}
