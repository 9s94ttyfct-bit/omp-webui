/**
 * `await expect(p).rejects.toThrow(…)` as `expect(await rejectionOf(p)).toThrow(…)`: the same assertion, with the promise
 * awaited plainly. On Windows, Bun loses the data event of a socket or pipe whose answer comes while a test waits through
 * `expect(…).rejects`, which runs the event loop from inside the callback that resumed the test (oven-sh/bun#44429,
 * oven-sh/bun#45473): a server's reply never arrives, or the WebSocket client reads the rest of the stream out of step and
 * fails with "RSV2 and RSV3 must be clear". Linux CI saw that error too, in the one test of a file that waited this way.
 * A test that waits on a socket, a pipe or a process uses this instead.
 *
 * Resolves to a function that throws what `p` rejected with, or does nothing when `p` resolved (and `toThrow` then fails).
 */
export async function rejectionOf(p: Promise<unknown>): Promise<() => void> {
	try {
		await p;
	} catch (error) {
		return () => {
			throw error;
		};
	}
	return () => {};
}
