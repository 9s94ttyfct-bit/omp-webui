import type { Locator, Page } from "@playwright/test";

export interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** Where an element is on screen. Playwright answers null for one that is not rendered; asking means expecting it. */
export async function boxOf(el: Locator): Promise<Box> {
	const box = await el.boundingBox();
	if (!box) throw new Error(`${el} is not rendered`);
	return box;
}

/** Whether two boxes share any area. */
export function overlap(a: Box, b: Box): boolean {
	return a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
}

/** The window's size (Playwright reports none only when the viewport is switched off, which no spec does). */
export function viewportOf(page: Page): { width: number; height: number } {
	const size = page.viewportSize();
	if (!size) throw new Error("the page has no viewport");
	return size;
}
