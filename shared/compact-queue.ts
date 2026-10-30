/**
 * A compact queued while the agent works (#651): the person asks for Compact in the middle of a turn, and the server
 * holds the request and sends omp's `compact` when that loses no work: when the turn has ended, or, where the person chose
 * it and the conversation allows it, between two steps of the turn (`CompactWhere`). Held by the server, not the page: it
 * survives a reload, a second page sees it, and it goes on through a change of the session file (a handoff).
 *
 * omp delivers a queued follow-up inside the run that is going on (the run ends only when its queues are empty), so the
 * turn would never end before the next message went out. What the queue holds back is therefore those follow-ups too:
 * they are taken out of omp's queue when the compact is queued, and a follow-up sent while it waits is kept here as
 * well. They go to omp after the compact, in the order they were sent, and, for a compact between two steps, after the rest
 * of the turn it was made in.
 */

import { isRecord } from "./guards.ts";

/** The longest note a queued compact keeps for the summary (the box in the panel is one line; this is generous). */
export const COMPACT_INSTRUCTIONS_MAX = 4000;

/**
 * Where a queued compact runs. `turn`: when the turn ends, before the next queued message is sent (the default, and always
 * possible). `step`: at the next point between two steps, after the tools of the step that runs have returned and before
 * the next model request, where no work is in flight; the rest of the turn goes on after it. A turn that ends before such a
 * point is compacted at its end.
 */
export type CompactWhere = "turn" | "step";
export const COMPACT_WHERES: readonly CompactWhere[] = ["turn", "step"];

/** The place a value names, or undefined: a value from another version, or none. */
export const compactWhereOf = (v: unknown): CompactWhere | undefined => COMPACT_WHERES.find((w) => w === v);

/**
 * Why a compact asked to run between steps waits for the end of the turn instead, said to the person: the conversation was
 * started with an extension of the person's own (omp does not take the server's beside it), the server's extension did not say
 * it started in this process, or omp is set not to go on with the turn after a compaction (`compaction.autoContinue`), which
 * a compact between steps needs: the turn would stop where it was cut.
 */
export type StepUnavailable = "trustedExtension" | "notLoaded" | "noContinue";

/**
 * `queued`: it waits for its place (the end of the turn, or a step boundary) and can be cancelled. `running`: omp compacts
 * now (the compact has been sent; what omp has started is not cancelled from here). `following`: the compact is done, the
 * turn it was made in goes on, and the messages held behind it wait for that turn's end; there is nothing to cancel.
 */
export type CompactPhase = "queued" | "running" | "following";

/** What every page is told of a queued compact (`LiveInfo.compactQueued`). */
export interface CompactQueued {
	/** When it was queued (the server's clock). */
	at: number;
	phase: CompactPhase;
	/** Where it runs: what was asked, unless `stepUnavailable` says it could not be given. */
	where: CompactWhere;
	/** Why `step` was asked and `turn` given. */
	stepUnavailable?: StepUnavailable;
	/** What the summary must keep, as the person wrote it; sent with the compact. */
	instructions?: string;
	/** The text of the follow-ups held back until the compact is over, in the order they go. */
	held: string[];
}

/**
 * How the last queued compact ended (`LiveInfo.compactEnded`): omp's answer to the compact, or that it was cancelled. `returned`:
 * held messages the server could not send, for the person to have back. Said once per end (`at` tells them apart); the page that
 * shows the conversation says it (a toast, the returned messages in its message box).
 */
export interface CompactEnded {
	at: number;
	ok: boolean;
	error?: string;
	cancelled?: boolean;
	/** A compact between two steps failed, and omp does not go on with a turn whose summary failed: the turn ended at the boundary. */
	stopped?: boolean;
	returned?: string[];
}

/** A message held back: what its `prompt` command carried, which is all that is needed to send it again. */
export interface HeldPrompt {
	message: string;
	/** The pictures it carried (omp's image content), as omp gave them back when the message was taken out of its queue. */
	images?: Record<string, unknown>[];
}

/**
 * What a paused conversation's record keeps of a compact that waits, or of the messages that wait for the turn a compact
 * between two steps left running (a running compact is not kept). No `where` is the end of the turn.
 */
export interface CompactQueueRecord {
	at: number;
	instructions?: string;
	held: HeldPrompt[];
	where?: CompactWhere;
	/** The compact is done: what is held waits for the turn to end, and nothing is compacted (`CompactPhase` `following`). */
	following?: true;
}

/** `v` as a list of held messages: an entry that is no message is left out. */
export function heldPromptsOf(v: unknown): HeldPrompt[] {
	if (!Array.isArray(v)) return [];
	const out: HeldPrompt[] = [];
	for (const item of v) {
		if (!isRecord(item) || typeof item.message !== "string") continue;
		const images = Array.isArray(item.images) ? item.images.filter(isRecord) : [];
		out.push(images.length > 0 ? { message: item.message, images } : { message: item.message });
	}
	return out;
}

/** `v` (a record from disk) as a queued compact, or undefined when it is not one: damage costs the queue, never the record. */
export function compactQueueRecordOf(v: unknown): CompactQueueRecord | undefined {
	if (!isRecord(v) || typeof v.at !== "number") return undefined;
	const instructions =
		typeof v.instructions === "string" && v.instructions.length <= COMPACT_INSTRUCTIONS_MAX
			? v.instructions
			: undefined;
	const where = compactWhereOf(v.where);
	return {
		at: v.at,
		...(instructions ? { instructions } : {}),
		held: heldPromptsOf(v.held),
		...(where === "step" ? { where } : {}),
		...(v.following === true ? { following: true as const } : {}),
	};
}

/** The instructions as they are kept: trimmed, none when empty. Throws for a note that is too long. */
export function instructionsOf(v: unknown): string | undefined {
	if (v === undefined || v === null) return undefined;
	if (typeof v !== "string") throw new Error("Bad instructions");
	const text = v.trim();
	if (text.length > COMPACT_INSTRUCTIONS_MAX) throw new Error("The instructions are too long");
	return text || undefined;
}
