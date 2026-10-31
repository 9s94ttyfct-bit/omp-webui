/**
 * The test servers this process runs (`startTestServer`), so that every test begins with them answering (#3). Bun's test
 * runner can end one in the middle of a file: when it decides a test is past its deadline (sometimes one that has already
 * finished, oven-sh/bun#46373) it prints `killed 1 dangling process` and sends SIGTERM to what the worker spawned, a file's
 * shared server included. The helper starts such a server again on its data dir and port; the preload's `beforeEach` waits
 * for that, so that only the test it happened in can see it gone.
 */

const running = new Set<() => Promise<void>>();

/** Count `alive` (it settles once the server answers) among this process's servers, until the returned function is called. */
export function trackServer(alive: () => Promise<void>): () => void {
	running.add(alive);
	return () => running.delete(alive);
}

/** Every server this process runs, answering: at once, or once the one that is being started again is up. */
export async function serversAlive(): Promise<void> {
	await Promise.all([...running].map((alive) => alive()));
}
