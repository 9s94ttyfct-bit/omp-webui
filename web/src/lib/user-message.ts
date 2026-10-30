import { type MessageFile, splitMessage } from "@shared/attachment.ts";

/**
 * A user message as the page shows and edits it: what the person typed, and the text files attached to it (#617), which
 * `joinMessage` wrote after the text. Only conversation chunks import this: the first page load must not carry the
 * message format (`tests/unit/entry-graph.test.ts`).
 */

const MARK = "<file name=";

/** Whether `text` may carry attached text files: the cheap test that keeps every other message at no cost. */
export const mayHaveFiles = (text: string): boolean => text.includes(MARK);

/** `text` split into what was typed and its attached files; a message without file blocks is its own typed part. */
export function userParts(text: string): { typed: string; files: MessageFile[] } {
	if (!mayHaveFiles(text)) return { typed: text, files: [] };
	const { text: typed, files } = splitMessage(text);
	return { typed, files };
}

/**
 * The message an edit makes: the new typed part, and the attached files' blocks as they stood (verbatim, so that editing
 * the words never changes, loses or shows what was attached).
 */
export function editedMessage(typed: string, files: readonly Pick<MessageFile, "raw">[]): string {
	if (!files.length) return typed;
	const blocks = files.map((f) => f.raw).join("\n");
	return typed ? `${typed}\n\n${blocks}` : blocks;
}

/**
 * What Up recalls for each sent message: a message with attached files is recalled without them (their text is not what
 * a person wants pasted back into the composer), and one that was nothing but files is skipped. The same array comes
 * back when no message has files.
 */
export function recallable(sent: string[]): string[] {
	if (!sent.some(mayHaveFiles)) return sent;
	const out: string[] = [];
	for (const message of sent) {
		const typed = mayHaveFiles(message) ? userParts(message).typed.trim() : message;
		if (typed && typed !== out.at(-1)) out.push(typed);
	}
	return out;
}
