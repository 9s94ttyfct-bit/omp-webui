import { expect, test } from "bun:test";
import type { PromptImage } from "../../web/src/lib/messages.ts";
import { noteQueuedCompactEnd } from "../../web/src/lib/queued-compact.ts";

/** What the page does when a queued compact ended (`web/src/lib/queued-compact.ts`). */

const PICTURE = { type: "image" as const, data: "iVBORw0KGgo=", mimeType: "image/png" };

test("messages that could not be sent after the compact come back in the message box with their pictures", () => {
	const toasts: string[] = [];
	const back: { text: string; images: PromptImage[] }[] = [];
	noteQueuedCompactEnd(
		{ at: 1, ok: true, returned: [{ message: "b", images: [PICTURE] }, { message: "c" }] },
		(level) => toasts.push(level),
		(text, images) => back.push({ text, images }),
	);
	expect(back).toEqual([{ text: "b\n\nc", images: [PICTURE] }]);
	expect(toasts).toEqual(["warning"]);
});

test("nothing handed back: the message box is left alone", () => {
	const back: unknown[] = [];
	noteQueuedCompactEnd(
		{ at: 1, ok: true },
		() => {},
		(text) => back.push(text),
	);
	expect(back).toEqual([]);
});
