import { useLayoutEffect, useState } from "react";
import { setClearance } from "./toast-clearance.ts";

/**
 * The keyboard leaves less than this much of the window above it; a smaller difference between the layout viewport and
 * the visual one is a toolbar, not a keyboard.
 */
const KEYBOARD_MIN = 150;
/**
 * A window this short (a phone on its side, a tablet with the keyboard up) cannot hold a request's choices and the
 * message box with everything else the block carries: while a request waits, the block keeps the two and puts the rest
 * away (`data-short`, see index.css).
 */
const SHORT = 520;

/** What of the window a person sees: the page's height, less what the keyboard covers when it does not resize the page. */
function visibleHeight(): { height: number; keyboard: boolean } {
	const vv = window.visualViewport;
	// A pinch-zoomed page has a smaller visual viewport too; that is not a keyboard.
	if (!vv || vv.scale > 1.01) return { height: window.innerHeight, keyboard: false };
	return {
		height: Math.min(window.innerHeight, vv.height),
		keyboard: window.innerHeight - vv.height > KEYBOARD_MIN,
	};
}

/**
 * Where the conversation leaves room for the toast stack (`toast-clearance.ts`): above the block, under the top of the
 * transcript. The transcript's top is under the header and whatever banner sits over the conversation; the stack must not
 * reach either, and the block holds the composer and the choices of a request.
 */
function clearanceOf(block: HTMLElement) {
	const transcript = block.parentElement?.querySelector('[data-testid="transcript"]');
	if (!transcript) return null;
	return {
		top: Math.round(transcript.getBoundingClientRect().top),
		bottom: Math.round(window.innerHeight - block.getBoundingClientRect().top),
	};
}

/**
 * The chat's bottom block (what is above the composer, and the composer) is anchored to the bottom of the window, and
 * the toasts stand over the conversation. This keeps the two from taking the screen from each other:
 *
 * - The toasts end above the block, and start under the transcript's top (`clearanceOf`): a tool approval is as tall as
 *   its choices, and a stack of toasts over them would take the taps meant for them; the composer's Send button is not
 *   to be covered either.
 * - iOS Safari does not resize the page for its on-screen keyboard: the layout viewport (`innerHeight`, `100dvh`) keeps
 *   its size, the keyboard covers its lower part, and only the visual viewport shrinks. The block is then taller than
 *   what shows. `--vvh` (on the block) is what the keyboard leaves while it is up, and `data-keyboard` says it is. A
 *   browser that resizes the page for the keyboard needs nothing: the layout follows by itself.
 * - `data-short` (on the block) says the window is too short for everything in it (`SHORT`).
 *
 * Returns the ref callback for the block, whose first child is the column its rows are in.
 */
export function useChatBottom(): (el: HTMLElement | null) => void {
	const [el, setEl] = useState<HTMLElement | null>(null);
	// Before paint, so that a window already short does not show the block whole for a frame.
	useLayoutEffect(() => {
		if (!el) return;
		const update = () => {
			const { height, keyboard } = visibleHeight();
			el.toggleAttribute("data-short", height < SHORT);
			el.toggleAttribute("data-keyboard", keyboard);
			if (keyboard) el.style.setProperty("--vvh", `${Math.round(height)}px`);
			else el.style.removeProperty("--vvh");
			setClearance(clearanceOf(el));
		};
		update();
		// The block grows and shrinks with what is in it, and with the column it is in (a panel, the sidebar).
		const observer = new ResizeObserver(update);
		// The transcript's top moves when a banner comes or goes, with no change in the block.
		const transcript = el.parentElement?.querySelector('[data-testid="transcript"]');
		observer.observe(el);
		if (transcript) observer.observe(transcript);
		window.addEventListener("resize", update);
		window.visualViewport?.addEventListener("resize", update);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", update);
			window.visualViewport?.removeEventListener("resize", update);
			setClearance(null);
		};
	}, [el]);
	return setEl;
}
