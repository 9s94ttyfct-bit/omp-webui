/**
 * A trigger for events that come in bursts (a file watcher's: every write to a conversation is one). `fire` runs once `quietMs`
 * have passed without another event, or `maxWaitMs` after the first event of the burst however many came since: a debounce that
 * only restarts on every event never fires while they keep coming closer than its delay, which is what several conversations or
 * subagents writing at once do. Returns the function to call for each event.
 */
export function burst(fire: () => void, quietMs: number, maxWaitMs: number): () => void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	/** When the first event of the burst that is waiting arrived. */
	let since = 0;
	return () => {
		const now = Date.now();
		if (timer === undefined) since = now;
		clearTimeout(timer);
		timer = setTimeout(
			() => {
				timer = undefined;
				fire();
			},
			Math.max(0, Math.min(quietMs, since + maxWaitMs - now)),
		);
	};
}
