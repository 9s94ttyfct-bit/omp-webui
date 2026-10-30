/**
 * The app is the window: the page, `body`, `#root` and `.app-shell` hold it and nothing in them is meant to scroll
 * (index.css clips them). A browser still scrolls a clipped box for a script or a focus that wants something in it
 * seen, and such a box has no scroll bar to bring it back: the chat's header and the top of the sidebar stay off the
 * screen until the window is resized. This puts all of them back at the top left.
 */
export function resetShellScroll(): void {
	const frame = [
		document.scrollingElement,
		document.documentElement,
		document.body,
		document.getElementById("root"),
		document.querySelector(".app-shell"),
	];
	for (const el of frame) {
		if (el && (el.scrollTop !== 0 || el.scrollLeft !== 0)) el.scrollTo({ top: 0, left: 0, behavior: "instant" });
	}
}
