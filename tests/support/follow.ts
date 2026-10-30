import { expect, type Locator, type Page } from "@playwright/test";

/** A transcript that follows its end: the view that scrolls, and the arrow that brings a reader who left back to it. */
export interface View {
	testId: string;
	/** The arrow's name: its `aria-label`, or the text on it. */
	arrow: string;
}

/** The conversation. */
export const CHAT: View = { testId: "transcript", arrow: "Scroll to bottom" };
/** One subagent's live view. */
export const AGENT: View = { testId: "subagent-scroll", arrow: "Jump to latest" };

/** Where the end of a transcript is, as a reader sees it. */
export interface End {
	/** Pixels of transcript below the visible part: 0 when its end is in view. */
	gap: number;
	/** How far the bottom of the last thing drawn is below the bottom of the visible part (0 or less: it is in view). */
	hidden: number;
	/** How far its top is above the top of the visible part: a line taller than the view is cut at its top, not its end. */
	above: number;
	/** What is drawn over the newest line, where it is on screen (the composer): null when nothing is. A toast, which stands above the composer for the seconds it lives, is not counted. */
	coveredBy: string | null;
	/** Whether the transcript says it follows the end (`data-following`). */
	following: boolean;
	/** Whether the arrow to the end is up. */
	button: boolean;
	/** The scroll position, for a reader who must not be moved. */
	top: number;
}

/** The end of a transcript (the conversation's, unless `view` says otherwise). Synchronous in the page: nothing moves between the measurements. */
export const endOf = (page: Page, view: View = CHAT): Promise<End> =>
	page.getByTestId(view.testId).evaluate((el, arrow) => {
		const box = el.getBoundingClientRect();
		// The last thing drawn: down the last child of each, to the deepest box that has a size.
		let last: Element = el;
		for (;;) {
			const next = [...last.children].reverse().find((c) => c.getBoundingClientRect().height > 0);
			if (!next) break;
			last = next;
		}
		const at = last.getBoundingClientRect();
		// The middle of the part of the line that is on screen; a line below the screen is `hidden`'s to report.
		const y = Math.min(at.bottom, box.bottom) - Math.min(4, at.height / 2);
		const hit = document.elementFromPoint(at.left + at.width / 2, y);
		return {
			gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight),
			hidden: Math.round(at.bottom - box.bottom),
			above: Math.round(box.top - at.top),
			coveredBy:
				hit && !el.contains(hit) && !hit.closest("[data-toast-region]")
					? (hit.getAttribute("data-testid") ?? hit.tagName)
					: null,
			following: el.getAttribute("data-following") === "true",
			button: [...document.querySelectorAll("button")].some(
				(b) => b.getAttribute("aria-label") === arrow || b.textContent?.trim() === arrow,
			),
			top: Math.round(el.scrollTop),
		};
	}, view.arrow);

/** After `n` frames of the page have been drawn: what a state change, a resize observer and a scroll event schedule has happened. */
export const frames = (page: Page, n = 3): Promise<void> =>
	page.evaluate((count) => {
		const { promise, resolve } = Promise.withResolvers<void>();
		let left = count;
		const tick = () => (--left > 0 ? requestAnimationFrame(tick) : resolve());
		requestAnimationFrame(tick);
		return promise;
	}, n);

/** What the page must show before a step is measured: a text of the transcript, an element, or whatever the function waits for. */
export type Shows = string | Locator | (() => Promise<unknown>);

async function waitFor(page: Page, shows: Shows, view: View): Promise<void> {
	if (typeof shows === "string") await expect(page.getByTestId(view.testId)).toContainText(shows);
	else if (typeof shows === "function") await shows();
	else await expect(shows.first()).toBeAttached();
	await frames(page);
}

/** What a reader at the end may be short of it by: nothing but a pixel of rounding. */
export const ROUNDING = 2;

/** After the step has been drawn: the reader is at the end and the newest line is in view, with nothing over it. */
export async function expectFollowing(page: Page, label: string, shows: Shows, view: View = CHAT): Promise<End> {
	await waitFor(page, shows, view);
	const end = await endOf(page, view);
	expect(end.gap, `${label}: pixels of the conversation below the screen`).toBeLessThanOrEqual(ROUNDING);
	expect(end.hidden, `${label}: how far the newest line is below the screen`).toBeLessThanOrEqual(ROUNDING);
	expect(end.coveredBy, `${label}: what is over the newest line`).toBeNull();
	expect(end.button, `${label}: the arrow to the end is up`).toBe(false);
	expect(end.following, `${label}: the transcript follows the end`).toBe(true);
	return end;
}

/** After the step has been drawn: the reader is where they were, and the page says they are not at the end. */
export async function expectStaying(
	page: Page,
	label: string,
	shows: Shows,
	top: number,
	view: View = CHAT,
): Promise<void> {
	await waitFor(page, shows, view);
	const end = await endOf(page, view);
	expect(end.top, `${label}: the reader's place`).toBe(top);
	expect(end.button, `${label}: the arrow to the end is up`).toBe(true);
	expect(end.following, `${label}: the transcript follows the end`).toBe(false);
}

/** The reader scrolls up by `by`; where they are now. */
export const scrollUp = async (page: Page, by: number, view: View = CHAT): Promise<number> => {
	const top = await page.getByTestId(view.testId).evaluate((el, delta) => {
		el.scrollTop -= delta;
		return Math.round(el.scrollTop);
	}, by);
	await frames(page);
	return top;
};
