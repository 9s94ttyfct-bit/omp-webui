/**
 * Keep something that is shown fresh (the Issues tab, #695): `refresh` runs every `intervalMs` while the page is visible,
 * and when the page comes back (it becomes visible again, or its window gets the focus). While the page is hidden nothing
 * runs and no timer is kept: whatever `refresh` asks is not asked of a page nobody looks at.
 */

/** What the page says about itself: injected so that a test needs no browser. */
export interface PageEnv {
	/** Whether the page is on screen (not a background tab, a minimized or covered window). */
	visible(): boolean;
	/** `listener` runs when `visible()` may have changed. Returns the way to stop listening. */
	onVisibility(listener: () => void): () => void;
	/** `listener` runs when the window gets the focus. Returns the way to stop listening. */
	onFocus(listener: () => void): () => void;
}

/** How often the Issues tab asks again while it is shown: modest, as the server keeps an answer for 30 s (`server/gh-issues.ts`). */
export const AUTO_REFRESH_MS = 60_000;

/** The page as the browser tells it (also the CI tab's, `lib/ci-watch.ts`). */
export const browserPage: PageEnv = {
	visible: () => document.visibilityState !== "hidden",
	onVisibility: (listener) => {
		document.addEventListener("visibilitychange", listener);
		return () => document.removeEventListener("visibilitychange", listener);
	},
	onFocus: (listener) => {
		window.addEventListener("focus", listener);
		return () => window.removeEventListener("focus", listener);
	},
};

/** Start refreshing; returns the way to stop. The first run is the caller's own (it loads when it is shown). */
export function autoRefresh(refresh: () => void, intervalMs = AUTO_REFRESH_MS, env: PageEnv = browserPage): () => void {
	let timer: ReturnType<typeof setInterval> | undefined;
	const halt = () => {
		clearInterval(timer);
		timer = undefined;
	};
	const arm = () => {
		halt();
		if (env.visible()) timer = setInterval(refresh, intervalMs);
	};
	// Back on screen: look now, and count the interval from here.
	const back = () => {
		if (!env.visible()) {
			halt();
			return;
		}
		refresh();
		arm();
	};
	arm();
	const stopVisibility = env.onVisibility(back);
	const stopFocus = env.onFocus(back);
	return () => {
		halt();
		stopVisibility();
		stopFocus();
	};
}
