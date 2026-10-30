import type { SessionEntry } from "@shared/protocol.ts";
import { type AgentMessage, messageOf } from "./messages.ts";

/**
 * A subagent's transcript, built the way the live view reads it: omp's `get_subagent_messages` returns the
 * records written since a byte offset, and the view asks again from where the last answer ended.
 */

/** What `get_subagent_messages` answers (omp docs: rpc.md, "Subagent subscriptions"). */
export interface TranscriptPage {
	sessionFile?: string;
	fromByte: number;
	/** Where the next read starts: only whole lines are consumed, so this can lag the file's size. */
	nextByte: number;
	/** The offset was past the end of the file, so reading started over from zero. */
	reset: boolean;
	entries: unknown[];
}

export interface Transcript {
	entries: SessionEntry[];
	nextByte: number;
}

export const EMPTY_TRANSCRIPT: Transcript = { entries: [], nextByte: 0 };

function isEntry(v: unknown): v is SessionEntry {
	return typeof v === "object" && v !== null && "id" in v && typeof v.id === "string";
}

/** Add a page to the transcript. Safe to apply twice, or out of order: entries are told apart by id. */
export function appendPage(t: Transcript, page: TranscriptPage): Transcript {
	const fresh = page.entries.filter(isEntry);
	if (page.reset) return { entries: fresh, nextByte: page.nextByte };
	const known = new Set(t.entries.map((e) => e.id));
	const added = fresh.filter((e) => !known.has(e.id));
	const nextByte = Math.max(t.nextByte, page.nextByte);
	if (!added.length) return nextByte === t.nextByte ? t : { entries: t.entries, nextByte };
	return { entries: [...t.entries, ...added], nextByte };
}

/**
 * What a failed `get_subagent_messages` means. omp refusing the subagent ("Unknown subagent …", or no subagent bus
 * at all) is final for this process: the transcript file is the only source left. Anything else (a dropped socket,
 * a busy or paused process) says nothing about the subagent, and asking omp again is right.
 */
export function readFailure(e: unknown): "fallback" | "retry" {
	const message = e instanceof Error ? e.message : String(e);
	return /^Unknown subagent|event bus is unavailable/i.test(message) ? "fallback" : "retry";
}

/**
 * The transcript with the entries of a read of the whole file, or the same object when the file has not moved on
 * (same length, same last entry), so a poll of an idle file renders nothing. The offset omp reads from is kept.
 */
export function replaceEntries(t: Transcript, entries: SessionEntry[]): Transcript {
	const last = t.entries.at(-1)?.id;
	if (entries.length === t.entries.length && entries.at(-1)?.id === last) return t;
	return { entries, nextByte: t.nextByte };
}

/**
 * The assistant message a subagent is writing (or has just written), if it is not in the transcript yet. The
 * transcript has it once an entry carries its timestamp; a message without one is shown only while it is open.
 */
export function pendingTail(
	streaming: AgentMessage | null | undefined,
	ended: boolean | undefined,
	entries: SessionEntry[],
): AgentMessage | null {
	if (!streaming) return null;
	const at = streaming.timestamp;
	if (at === undefined) return ended ? null : streaming;
	return entries.some((e) => messageOf(e)?.timestamp === at) ? null : streaming;
}

/** The text of a tool result's content blocks. */
function blockText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const b of content) {
		if (b && typeof b === "object" && "type" in b && b.type === "text" && "text" in b && typeof b.text === "string") {
			parts.push(b.text);
		}
	}
	return parts.join("\n");
}

/** The last `lines` lines a running tool has printed, from the partial result omp forwards. */
export function liveToolOutput(partial: unknown, lines: number): string {
	const text =
		typeof partial === "object" && partial !== null && "content" in partial
			? blockText(partial.content)
			: blockText(partial);
	return text.trimEnd().split("\n").slice(-lines).join("\n");
}
