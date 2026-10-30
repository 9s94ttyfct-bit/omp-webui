import { expect, test } from "bun:test";
import {
	afterScroll,
	atEndOf,
	followAfterScroll,
	glideToEnd,
	type Place,
	settledPlace,
} from "../../web/src/lib/follow-end.ts";

/**
 * Whether a view follows its end after a scroll event (#586). The event is delivered a frame after what moved the view,
 * so how far the end is below it says nothing about who scrolled: the content may have grown again, or the view shrunk.
 */

const at = (top: number, height: number, client: number, ratio = 1): Place => ({ top, height, client, ratio });

test("the event of the page's own pin is not the reader leaving, however much the content has grown since", () => {
	// Pinned to the end of 2914 px in a 692 px view (position 2222); a tool card of 586 px opened before the event came.
	expect(followAfterScroll(true, at(2222, 2914, 692), at(2222, 3500, 692))).toBe(true);
	// The same for a window that shrank under the pin (a taller approval card in the bottom block).
	expect(followAfterScroll(true, at(2222, 2914, 692), at(2222, 2914, 380))).toBe(true);
});

test("the browser cutting the position back while the view was taller for a moment is not the reader leaving", () => {
	// A text box was measured by shrinking it and growing it again: the view was taller, the position was cut back to
	// the end of that, and the view is shorter again by the time the event comes.
	expect(followAfterScroll(true, at(2594, 3120, 526), at(2386, 3120, 462))).toBe(true);
});

test("a cut back the layout has come back from before the event is the reader leaving, unless the page noted the view in it", () => {
	// A phone, a message sent: pinned to the end of 704 px in a 433 px view (position 271). The line under the message box
	// is one line instead of two for the length of the send, the view is 449 px tall, and the browser cuts the position back
	// to 255, the end of that. The line is two again when the event comes: 16 px short of the end of a layout like the one
	// the page pinned in.
	const pinned = at(271, 704, 433);
	const event = at(255, 704, 433);
	expect(followAfterScroll(true, pinned, event)).toBe(false);
	// The page looked while the view was that tall: the position was the end of it, and that is where it had the view.
	const noted = settledPlace(pinned, at(255, 704, 449));
	expect(noted).toEqual(at(255, 704, 449));
	const next = afterScroll(true, noted, event);
	expect(next.following).toBe(true);
	// Put back at the end now, not when the content next happens to change.
	expect(next.pin).toBe(true);
});

test("noting the view after a render leaves a reader who has scrolled up since the page last had it seen to have", () => {
	const pinned = at(271, 704, 433);
	// 71 px up and not at the end: not where the page has the view, the place stays the one it had.
	expect(settledPlace(pinned, at(200, 704, 433))).toBe(pinned);
	expect(followAfterScroll(true, settledPlace(pinned, at(200, 704, 433)), at(200, 704, 433))).toBe(false);
	// The end of a layout that grew is the end too: the place moves with it and nothing is taken for a reader.
	expect(settledPlace(pinned, at(500, 933, 433))).toEqual(at(500, 933, 433));
});

test("a reader who scrolls up leaves the end, by however little, whether or not the content grows meanwhile", () => {
	expect(followAfterScroll(true, at(2222, 2914, 692), at(2192, 2914, 692))).toBe(false);
	expect(followAfterScroll(true, at(2222, 2914, 692), at(2192, 2989, 692))).toBe(false);
	// Two pixels is a move.
	expect(followAfterScroll(true, at(2200, 2914, 692), at(2198, 2914, 692))).toBe(false);
	// A scroll the reader did not make with a hand (find in page, a link to an earlier message) is theirs too.
	expect(followAfterScroll(true, at(2222, 2914, 692), at(300, 2914, 692))).toBe(false);
});

test("the rounding of a fractional pixel ratio is not a move", () => {
	expect(followAfterScroll(true, at(2200, 2914, 692), at(2199.7, 2914, 692))).toBe(true);
});

test("the end is the end however the view got there: a bounce back, a clamp, a scroll to it", () => {
	// Overscroll bouncing back is up, and at the end.
	expect(followAfterScroll(true, at(2240, 2914, 692), at(2222, 2914, 692))).toBe(true);
	// A shorter content cuts the position back to its end.
	expect(followAfterScroll(true, at(2222, 2914, 692), at(1900, 2592, 692))).toBe(true);
	// A reader who had left comes to it.
	expect(followAfterScroll(false, at(1000, 2914, 692), at(2222, 2914, 692))).toBe(true);
	// The rounding of a fractional pixel ratio is not short of it.
	expect(followAfterScroll(false, at(1000, 2914, 692), at(2221.67, 2914, 692))).toBe(true);
});

test("a reader who left follows again only at the end: short of it, however near, nothing changes", () => {
	// At the end: following (also the rounding of a fractional pixel ratio, see above).
	expect(followAfterScroll(false, at(1000, 2914, 692), at(2222, 2914, 692))).toBe(true);
	// A step down that stops 62 px short of it, or 10 px: the reader is reading the last lines, and the page does not
	// snap the view to the end from under them (nor from a scroll of its own: an anchor put back, a gliding arrow).
	expect(followAfterScroll(false, at(1000, 2914, 692), at(2160, 2914, 692))).toBe(false);
	expect(followAfterScroll(false, at(2100, 2914, 692), at(2212, 2914, 692))).toBe(false);
	// Where it was: the same.
	expect(followAfterScroll(false, at(2160, 2914, 692), at(2160, 2914, 692))).toBe(false);
	// A reader far from the end who is not following stays so as the content grows under a position that did not move.
	expect(followAfterScroll(false, at(1000, 2914, 692), at(1500, 2914, 692))).toBe(false);
	expect(followAfterScroll(false, at(1000, 2914, 692), at(1000, 3500, 692))).toBe(false);
});

test("a reader who left is not put back at the end by a scroll event short of it", () => {
	const next = afterScroll(false, at(2100, 2914, 692), at(2160, 2914, 692));
	expect(next.following).toBe(false);
	expect(next.pin).toBe(false);
});

test("a reader who is not following stays so when the view is cut back or the content grows", () => {
	expect(followAfterScroll(false, at(1500, 2914, 692), at(1200, 2914, 692))).toBe(false);
	expect(followAfterScroll(false, at(1500, 2914, 692), at(1500, 3500, 692))).toBe(false);
});

test("a step of a device pixel is a move at any pixel ratio, and less than half of one is rounding", () => {
	// Well above the end, so that only a move says the reader left.
	for (const ratio of [1, 1.25, 1.5, 2, 3, 4]) {
		const pixel = 1 / ratio;
		const before = at(2000, 2914, 692, ratio);
		expect(followAfterScroll(true, before, at(2000 - pixel, 2914, 692, ratio))).toBe(false);
		expect(followAfterScroll(true, before, at(2000 - 0.4 * pixel, 2914, 692, ratio))).toBe(true);
	}
});

/**
 * A reader drags a view that follows its end up by one device pixel per scroll event, at a pixel ratio of `ratio`: the
 * way a slow drag, or the tail of a flick, is reported on a phone or a tablet. Between the reader's step and its event
 * the content grows by `grows` (a token of a streaming reply), and the page puts a view that follows back at the end,
 * as its resize observer does when content grows and its scroll handler does when `afterScroll` says so.
 */
function drag(ratio: number, events: number, grows = 0) {
	const device = (px: number) => Math.round(px * ratio) / ratio;
	let seen = at(2222, 2914, 692, ratio);
	let place = seen;
	let following = true;
	let left = -1;
	for (let i = 0; i < events; i++) {
		const height = place.height + grows;
		const now = at(device(place.top - 1 / ratio), height, place.client, ratio);
		const next = afterScroll(following, seen, now);
		following = next.following;
		if (!following && left < 0) left = i;
		seen = next.seen;
		place = now;
		// A view that follows is at its end again, wherever the reader's step put it.
		if (next.pin || (following && grows > 0)) {
			place = at(height - place.client, height, place.client, ratio);
			seen = place;
		}
	}
	return { left, place, behind: place.height - place.top - place.client };
}

for (const ratio of [2, 3]) {
	test(`a reader who drags up one device pixel at a time at a pixel ratio of ${ratio} leaves the end`, () => {
		const { left, behind } = drag(ratio, 10);
		expect(left).toBeGreaterThanOrEqual(0);
		// And is not put back at it: the drag is theirs.
		expect(behind).toBeGreaterThan(2);
	});

	test(`the same at a pixel ratio of ${ratio} while the content grows between the steps`, () => {
		const { left, behind } = drag(ratio, 10, 20);
		expect(left).toBeGreaterThanOrEqual(0);
		expect(behind).toBeGreaterThan(2);
	});
}

/** A view as far as `atEndOf` and `glideToEnd` look at it. */
function view(geometry: { top: number; height: number; client: number }, reduced: boolean) {
	const glides: ScrollToOptions[] = [];
	const el = {
		scrollTop: geometry.top,
		scrollHeight: geometry.height,
		clientHeight: geometry.client,
		scrollTo: (options: ScrollToOptions) => glides.push(options),
		ownerDocument: { defaultView: { devicePixelRatio: 1, matchMedia: () => ({ matches: reduced }) } },
	};
	return { el: el as unknown as HTMLElement, glides };
}

test("a view is at its end where a reader who left would follow it again, not 80 px short of it", () => {
	expect(atEndOf(view({ top: 2222, height: 2914, client: 692 }, false).el)).toBe(true);
	expect(atEndOf(view({ top: 2221.5, height: 2914, client: 692 }, false).el)).toBe(true);
	expect(atEndOf(view({ top: 2200, height: 2914, client: 692 }, false).el)).toBe(false);
	expect(atEndOf(view({ top: 2160, height: 2914, client: 692 }, false).el)).toBe(false);
});

test("the arrow glides to the end, and goes there at once for a reader who asked for less motion", () => {
	const smooth = view({ top: 100, height: 2914, client: 692 }, false);
	glideToEnd(smooth.el);
	expect(smooth.glides).toEqual([{ top: 2914, behavior: "smooth" }]);
	const still = view({ top: 100, height: 2914, client: 692 }, true);
	glideToEnd(still.el);
	expect(still.glides).toEqual([{ top: 2914, behavior: "auto" }]);
});
