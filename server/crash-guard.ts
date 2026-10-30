/**
 * Bun ends the process on a promise rejection nobody handles and on an exception thrown from a timer or an event
 * callback: `bun -e "Promise.reject(new Error('x')); setTimeout(() => console.log('alive'), 500)"` never prints
 * `alive`. A server that holds sockets, file watchers, git probes and every conversation's omp is one stray error from
 * ending all of it, and in the macOS app the window with it (#373).
 *
 * The error is logged, with its stack, and the server keeps running: a failed git probe or a socket that closed under
 * a send must not end a conversation that is in the middle of a turn. When errors keep coming — `limit` of them within
 * `windowMs` — whatever is failing is not a one-off, and the server stops (`onStorm`, the same shutdown as a signal)
 * so that the app starts a clean one in its place.
 */
export function guardAgainstStrayErrors(options: { onStorm: () => void; limit?: number; windowMs?: number }): void {
	const { onStorm, limit = 10, windowMs = 60_000 } = options;
	const times: number[] = [];
	let stormed = false;
	const stray = (what: string) => (error: unknown) => {
		console.error(`omp-webui: ${what}; the server keeps running:`, error);
		const now = Date.now();
		times.push(now);
		while (times[0] < now - windowMs) times.shift();
		if (times.length < limit || stormed) return;
		stormed = true;
		console.error(`omp-webui: ${times.length} stray errors within ${windowMs / 1000} s; stopping the server`);
		onStorm();
	};
	process.on("unhandledRejection", stray("unhandled promise rejection"));
	process.on("uncaughtException", stray("uncaught exception"));
}
