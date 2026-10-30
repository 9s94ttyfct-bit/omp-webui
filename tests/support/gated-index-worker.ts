import "../../server/search-index-worker.ts";

/**
 * The real search index worker, with its indexing held after the first batch of a file until a moment after a search
 * has arrived.
 *
 * The worker lets the loop turn between two batches of a file (`yieldToLoop`, a `setImmediate` looked up at each call):
 * while the gate is shut those turns never come, so a file of more rows than one batch holds stays in the worker's
 * `pending` set by construction, however fast the machine is. The gate opens `RELEASE_MS` after a search is handed to
 * the worker. The worker's own wait for the file is a timer set while the search is handled, ahead of the one that opens
 * the gate; timers of one thread fire in the order of their moments, so a worker that waits for the file only as long as
 * `waitMs` (a millisecond in the test) has answered by the time the gate opens, however loaded the machine is, and one
 * that waits for the file itself has not.
 */

const RELEASE_MS = 50;

let shut = true;
const held: (() => void)[] = [];
const turn = globalThis.setImmediate;
globalThis.setImmediate = ((callback: (...args: unknown[]) => void, ...args: unknown[]) => {
	if (!shut) return turn(callback, ...args);
	held.push(() => callback(...args));
	return undefined;
}) as unknown as typeof setImmediate;

// Registered after the worker's own `onmessage`, so it runs after the search has been handled as far as its first wait.
self.addEventListener("message", (event: MessageEvent<{ t: string }>) => {
	if (event.data.t !== "search") return;
	setTimeout(() => {
		shut = false;
		for (const resume of held.splice(0)) turn(resume);
	}, RELEASE_MS);
});
