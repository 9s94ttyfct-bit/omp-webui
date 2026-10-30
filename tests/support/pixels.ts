import type { Page } from "@playwright/test";
import type { Rgb } from "./style.ts";

/**
 * Reads pixels out of a screenshot, in the browser's own PNG decoder (no image library): the screenshot is drawn on a
 * canvas of a blank tab of the same browser. `points` are CSS pixels of the screenshot, which Playwright takes at
 * device scale 1 here. Used to check what a palette actually paints, apart from what the stylesheet says: flat areas
 * (a page background, a card, a bubble) come out the same on every OS and browser build, text and borders do not.
 */
export async function pixelsAt(page: Page, png: Buffer, points: { x: number; y: number }[]): Promise<Rgb[]> {
	const scratch = await page.context().newPage();
	try {
		await scratch.goto("about:blank");
		return await scratch.evaluate(
			async ({ base64, at }) => {
				const bitmap = await createImageBitmap(await (await fetch(`data:image/png;base64,${base64}`)).blob());
				const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
				const ctx = canvas.getContext("2d", { willReadFrequently: true });
				if (!ctx) throw new Error("no 2d canvas");
				ctx.drawImage(bitmap, 0, 0);
				return at.map(({ x, y }) => {
					const [r, g, b] = ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data;
					return { r, g, b };
				});
			},
			{ base64: png.toString("base64"), at: points },
		);
	} finally {
		await scratch.close();
	}
}

/** The largest per-channel difference of two colours (0–255). */
export const distance = (a: Rgb, b: Rgb) => Math.max(Math.abs(a.r - b.r), Math.abs(a.g - b.g), Math.abs(a.b - b.b));
