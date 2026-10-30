/**
 * How a part of the page that is no child of the message box puts text into it (the Files tab's "Insert as @mention").
 * The message box on screen offers itself while it is mounted; there is at most one, and the latest to mount is it.
 */

export type InsertText = (text: string, focus: boolean) => void;

let target: InsertText | null = null;

/** Offer `insert` as the message box; the returned function withdraws it (only if it is still the one offered). */
export function offerComposer(insert: InsertText): () => void {
	target = insert;
	return () => {
		if (target === insert) target = null;
	};
}

/** Put `text` at the end of the message box on screen, after a space when it does not end in one. False when there is none. */
export function insertIntoComposer(text: string, focus: boolean): boolean {
	if (!target) return false;
	target(text, focus);
	return true;
}

/** `piece` added to the end of `current`, set off from what is there by a space, with a space after it to go on typing. */
export function appendPiece(current: string, piece: string): string {
	const gap = current === "" || /\s$/.test(current) ? "" : " ";
	return `${current}${gap}${piece} `;
}
