import { useCallback, useRef, useState } from "react";

/**
 * Whether a scrolled view follows its end: a transcript that is at the end stays there as it grows, and one the reader
 * has scrolled up in is left where they put it (#586).
 *
 * A scroll event is the browser's report, a frame later, of a position that something moved to: the reader, or the
 * page's own pin to the end. By the time it is delivered the content may have grown again, so how far the end is below
 * says nothing about who scrolled: reading "far from the end" as "the reader went up" took a tool card that opened
 * between a pin and its event for a reader leaving, and the view stopped following for good. What says the reader left
 * is the position having gone up from where the page last had it. The browser moves a position up by itself too, when
 * the view gets taller or its content shorter (it cuts it back to the end of what is there), and reports that a frame
 * later like any other: `settledPlace` is how the page keeps hold of where the view was while the layout was that.
 */

/**
 * Where a scrolled view is, and how big it and its content are: `scrollTop`, `scrollHeight`, `clientHeight`; and how many
 * device pixels a CSS pixel is, which says how small a step of the reader's finger can be.
 */
export interface Place {
	top: number;
	height: number;
	client: number;
	ratio: number;
}

function placeOf(view: HTMLElement): Place {
	const ratio = view.ownerDocument.defaultView?.devicePixelRatio || 1;
	return { top: view.scrollTop, height: view.scrollHeight, client: view.clientHeight, ratio };
}

/** How far a place is above the end of its content (negative: an overscroll past it). */
const behindEnd = (place: Place): number => place.height - place.top - place.client;

/** Within this of the end is at it: the rounding of a fractional pixel ratio, an overscroll that bounces back. */
const AT_END = 1;

/**
 * A position that is this much higher than it was has moved: less is the rounding of a fractional pixel ratio. A step of
 * the reader's finger is a device pixel at least, and at a pixel ratio of 2 or 3 (a retina screen, a phone) that is half
 * a CSS pixel or a third: so the line is half a CSS pixel where a device pixel is bigger than that, and three quarters of
 * a device pixel where it is smaller. A line fixed at half a CSS pixel took such steps for rounding, each on its own: a
 * slow drag was never a move, and the page put the view back at the end after every step of it.
 */
const moved = (place: Place): number => Math.min(0.5, 0.75 / place.ratio);

/**
 * Whether the view follows its end after a scroll event.
 * @param following whether it did until now
 * @param before where the view was when the page last put it at the end, or last heard from it
 * @param now where it is
 */
export function followAfterScroll(following: boolean, before: Place, now: Place): boolean {
	// At the end, however it got there: a pin, a bounce back from an overscroll, the end coming up to a view that was
	// shortened, the reader's scroll to it.
	if (behindEnd(now) <= AT_END) return true;
	if (now.top < before.top - moved(now)) {
		// Up, and not to the end: the reader left it. Unless the view itself changed size meanwhile: then the browser cut
		// the position back to keep it valid while the view was taller for a moment, and the page puts it at the end again
		// (see `afterScroll`) rather than take that for the reader.
		return before.client === now.client ? false : following;
	}
	// Down, or where it was, and short of the end: nothing changes. A reader who left follows again only at the end (or
	// with the arrow): short of it the page does not take a step down for a return, which would snap the view to the end
	// from under a reader who is reading the last lines, or from a scroll that the page itself made (an anchor put back,
	// a gliding arrow). And far from it says nothing either way: the content may have grown since the page pinned the
	// view, and the event of a pin is such a scroll.
	return following;
}

/** Whether a view is at the end of its content: the measure by which a reader who left follows again, and a finished turn lets go of their place. */
export function atEndOf(view: HTMLElement): boolean {
	return behindEnd(placeOf(view)) <= AT_END;
}

/**
 * Go to the end of a view with a glide, or at once where the reader asked for less motion (`prefers-reduced-motion`). The
 * glide aims at where the end is when it starts: for a view whose content is growing, pin it instead (`useFollowEnd`).
 */
export function glideToEnd(view: HTMLElement): void {
	const reduced = view.ownerDocument.defaultView?.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
	view.scrollTo({ top: view.scrollHeight, behavior: reduced ? "auto" : "smooth" });
}

/** What a scroll event of a view makes of what the page keeps. */
export interface Scrolled {
	/** Whether the view follows its end now. */
	following: boolean;
	/** Where the next event is compared from. */
	seen: Place;
	/** Whether the page puts the view at the end again at once. */
	pin: boolean;
}

/**
 * What a scroll event of the view comes to.
 * @param following whether the view followed its end until now
 * @param seen where the page last had the view
 * @param now where it is
 * @param reachable whether the end that is in reach is the end of what there is (a window around a search hit is not)
 */
export function afterScroll(following: boolean, seen: Place, now: Place, reachable = true): Scrolled {
	const follows = followAfterScroll(following, seen, now) && reachable;
	// A view that follows is at the end: where the browser cut the position back (see `followAfterScroll`) the page puts
	// it there again now, not when the content next happens to change.
	return { following: follows, seen: now, pin: follows && behindEnd(now) > AT_END };
}

/**
 * Where the next scroll event of a view that follows its end is compared from, once the page has changed the layout.
 *
 * The browser cuts a position back whenever the view is taller, or its content shorter, than when the position was taken,
 * and tells of it a frame later, at the layout of that frame. If the layout has come back by then, the position is short
 * of the end of the layout the page pinned in, and reads as a reader who went up. A message sent on a phone did that:
 * the line under the message box is two lines of disclaimer and, for the length of the send, one of "Working…"; the view
 * was 16 px taller meanwhile, the position was cut back by as much, and the line was two again when the event came.
 * Whether the conversation went on following then was a matter of how soon the frame came.
 *
 * A position that is the end of the layout it is read in is where the page has the view, however it got there: the
 * measure of `followAfterScroll`, taken while the layout is that. A position short of the end is left alone, so a
 * reader who scrolled up meanwhile is still seen to have.
 * @param seen where the page last had the view
 * @param now where the view is, in the layout the page has just made
 */
export function settledPlace(seen: Place, now: Place): Place {
	return behindEnd(now) <= AT_END ? now : seen;
}

/**
 * Whether a scrolled view follows its end, kept for a transcript that streams: the conversation, a subagent's live view.
 * The view is put at the end (`pin`) when its content grows or its box changes size and it follows; its `onScroll` hands
 * each scroll event to `scrolled`. `following` is `atEnd` a render sooner, for the callbacks and observers that cannot
 * wait for one.
 */
export function useFollowEnd() {
	const following = useRef(true);
	const [atEnd, setAtEndState] = useState(true);
	/** The view's scroll position, and its size, when the page last put it at the end or last heard from it. */
	const seen = useRef<Place>({ top: 0, height: 0, client: 0, ratio: 1 });
	const setAtEnd = useCallback((value: boolean) => {
		following.current = value;
		setAtEndState(value);
	}, []);
	/** Put the view at the end of its content. */
	const pin = useCallback((view: HTMLElement) => {
		view.scrollTop = view.scrollHeight;
		seen.current = placeOf(view);
	}, []);
	/**
	 * Note where the view is now that the page has changed its layout: call it after a render, before the browser has had
	 * a frame (see `settledPlace`). It moves nothing, and reads nothing of a view that does not follow.
	 */
	const settle = useCallback((view: HTMLElement) => {
		if (following.current) seen.current = settledPlace(seen.current, placeOf(view));
	}, []);
	/** A scroll event of the view; `reachable` as in `afterScroll`. */
	const scrolled = useCallback(
		(view: HTMLElement, reachable = true) => {
			const next = afterScroll(following.current, seen.current, placeOf(view), reachable);
			seen.current = next.seen;
			if (next.pin) pin(view);
			setAtEnd(next.following);
		},
		[pin, setAtEnd],
	);
	return { following, atEnd, setAtEnd, pin, scrolled, settle };
}
