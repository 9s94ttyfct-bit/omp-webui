import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void): () => void {
	document.addEventListener("visibilitychange", onChange);
	return () => document.removeEventListener("visibilitychange", onChange);
}

/**
 * Whether the page is on screen: false for a background tab and a window that is minimized or covered.
 * Not what the window's focus says: a visible window that is not in front may still be watched.
 */
export function usePageVisible(): boolean {
	return useSyncExternalStore(
		subscribe,
		() => document.visibilityState !== "hidden",
		() => true,
	);
}
