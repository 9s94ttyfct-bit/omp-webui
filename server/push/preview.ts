import { isRecord } from "../../shared/guards.ts";
import { PUSH_PREVIEW_MAX } from "../../shared/push.ts";

/**
 * The one line of a notification that a device opted in to (`PushDevice.preview`): what the dialog that waits asks, or how the
 * last reply of the turn ends. Taken from the frames the server holds anyway (`Live`), never from the transcript, and cut
 * to `PUSH_PREVIEW_MAX` characters. A device that did not opt in is sent none of it.
 */

/** `text` on one line, at most `PUSH_PREVIEW_MAX` characters (counted as characters a person sees, not UTF-16 units). */
export function oneLine(text: string): string {
	const flat = text.replace(/\s+/g, " ").trim();
	const chars = Array.from(flat);
	return chars.length <= PUSH_PREVIEW_MAX
		? flat
		: `${chars
				.slice(0, PUSH_PREVIEW_MAX - 1)
				.join("")
				.trimEnd()}…`;
}

/** The text of an assistant message omp finished (`message_end`), null for any other frame or a message with no text. */
export function replyLine(frame: Record<string, unknown>): string | null {
	if (frame.type !== "message_end" || !isRecord(frame.message) || frame.message.role !== "assistant") return null;
	const content = frame.message.content;
	if (!Array.isArray(content)) return null;
	const text = content
		.map((block) => (isRecord(block) && block.type === "text" && typeof block.text === "string" ? block.text : ""))
		.join(" ");
	const line = oneLine(text);
	return line === "" ? null : line;
}

/** What a dialog asks, as one line: its title (the first line of it), else its message; null when it says neither. */
export function dialogLine(frame: Record<string, unknown>): string | null {
	for (const field of [frame.title, frame.message]) {
		if (typeof field !== "string") continue;
		const first = field.split("\n").find((l) => l.trim() !== "");
		if (first !== undefined) return oneLine(first);
	}
	return null;
}
