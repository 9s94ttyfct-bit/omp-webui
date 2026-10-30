import type { Page } from "@playwright/test";

/** A file to put in a drag: its bytes are text, or given as byte values (a binary file). */
export interface DragFile {
	name: string;
	type?: string;
	text?: string;
	bytes?: number[];
}

/**
 * Drop files on the composer's box, the way the browser does for a drag from the Finder: a `drop` event with a
 * `DataTransfer` that holds them. Nothing is sent anywhere; what the page does with them is what the spec looks at.
 */
export async function dropOnComposer(page: Page, files: DragFile[]): Promise<void> {
	await page.evaluate((list) => {
		const card = document.querySelector('[data-testid="composer"]')?.closest(".rounded-2xl");
		if (!card) throw new Error("no composer card");
		const data = new DataTransfer();
		for (const f of list) {
			const content = f.bytes ? new Uint8Array(f.bytes) : (f.text ?? "");
			data.items.add(new File([content], f.name, { type: f.type ?? "" }));
		}
		card.dispatchEvent(new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: data }));
	}, files);
}

/** The bytes of a 1×1 PNG, for a picture to drop. */
export const PIXEL_PNG: number[] = [
	...Uint8Array.from(
		atob("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="),
		(c) => c.charCodeAt(0),
	),
];

/** A file as `setInputFiles` takes it. */
export interface PickedFile {
	name: string;
	mimeType: string;
	buffer: Buffer;
}

/**
 * Choose files with the Attach button and answer the choice that follows with "Attach": what the picture specs did when
 * the button took pictures and nothing else (see `components/DropChoice.tsx`).
 */
export async function attachPicked(page: Page, files: PickedFile | PickedFile[]): Promise<void> {
	await page.locator('input[type="file"]').setInputFiles(files);
	await page.getByTestId("drop-attach").click();
}

/** Paste files into the composer's field, as a ⌘V of a copied picture or file does (a `paste` event with the clipboard's files). */
export async function pasteIntoComposer(page: Page, files: DragFile[]): Promise<void> {
	await page.evaluate((list) => {
		const field = document.querySelector('[data-testid="composer"]');
		if (!field) throw new Error("no composer");
		const data = new DataTransfer();
		for (const f of list) {
			const content = f.bytes ? new Uint8Array(f.bytes) : (f.text ?? "");
			data.items.add(new File([content], f.name, { type: f.type ?? "" }));
		}
		field.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }));
	}, files);
}
