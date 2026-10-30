/** Input omp withdrew from its queue when stopping (to put back into the composer). */
export interface Withdrawn {
	text: string;
	images?: { type: "image"; data: string; mimeType: string }[];
}

export interface StopResult {
	steering?: Withdrawn[];
	followUp?: Withdrawn[];
	truncated?: boolean;
	/** omp's process ended for Stop (`stopped`: it did not end the turn in time) or while Stop waited (`exited`): the queue it held went with it. */
	ended?: "stopped" | "exited";
	/** The press joined a Stop that another press (another page) ran: that one has the queue. */
	joined?: true;
}

type Rpc = (command: Record<string, unknown>) => Promise<unknown>;

/**
 * Stop the running turn like the TUI's Esc: `abort_and_restore_queue` withdraws queued
 * input. Runtimes without it reject the command as unknown; fall back to plain `abort`
 * (the queue then stays with omp). Resolves to the withdrawn input, if any.
 */
export async function stopTurn(rpc: Rpc): Promise<StopResult | null> {
	try {
		return ((await rpc({ type: "abort_and_restore_queue" })) as StopResult | undefined) ?? null;
	} catch (e) {
		if (!/unknown command/i.test(String((e as Error)?.message ?? e))) throw e;
		await rpc({ type: "abort" });
		return null;
	}
}
