import type { CompactQueued, CompactWhere } from "@shared/compact-queue.ts";
import type { LiveInfo } from "@shared/protocol.ts";
import { socket } from "./ws.ts";

/**
 * Compact when it loses no work (#651): when the turn that runs has ended, or between two of its steps. The server holds the
 * request (`LiveInfo.compactQueued`, which every page is told), so nothing is kept here: both resolve once the server has taken
 * them, and the page shows what it is told.
 */

/** Ask for a compact at `where`, with the note the summary must keep (none: omp's own). */
export function queueCompact(liveId: string, customInstructions: string, where: CompactWhere): Promise<LiveInfo> {
	return socket.request<LiveInfo>({
		t: "compact_queue",
		liveId,
		where,
		...(customInstructions ? { customInstructions } : {}),
	});
}

/** Take back a queued compact that has not started; what was held behind it goes to omp. */
export function cancelCompact(liveId: string): Promise<LiveInfo> {
	return socket.request<LiveInfo>({ t: "compact_cancel", liveId });
}

/** What the page knows of omp's queue (`LiveState.queue`). */
export interface Queue {
	steering: string[];
	followUp: string[];
	liveSteered?: number;
}

/**
 * What the message box shows as queued: omp's queue, and behind its follow-ups the ones the server holds until the
 * compact is over (they are sent after it, in this order).
 */
export function withHeldFollowUps(queue: Queue | undefined, queued: CompactQueued | undefined): Queue | undefined {
	if (!queued || queued.held.length === 0) return queue;
	const base: Queue = queue ?? { steering: [], followUp: [] };
	return { ...base, followUp: [...base.followUp, ...queued.held] };
}
