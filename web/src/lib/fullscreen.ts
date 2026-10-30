import { useEffect, useState } from "react";

/**
 * Full screen for the window the page is in (not the in-window full screen of a subagent: that is a route, see
 * `showAgentFull`). In the macOS app the window is native and goes to its own Space: the page asks the shell through
 * the `ompwWindow` message handler (`{ type: "toggleFullScreen" }`, typed with the shell's other handler in
 * `shell-notify.ts`) and the shell says when it did, also when the green button did it, with a `ompw-fullscreen` event
 * on `window` that has the new state in `detail`. In a browser it is the Fullscreen API, which needs a user gesture.
 */

/** What the macOS shell tells the page when its window enters or leaves full screen. */
export const FULLSCREEN_EVENT = "ompw-fullscreen";

/** Whether full screen is on, whether it can be asked for here (an iPhone's browser cannot), and the way to flip it. */
export function useWindowFullScreen(onError: (message: string) => void): {
	available: boolean;
	active: boolean;
	toggle(): void;
} {
	const [active, setActive] = useState(() => document.fullscreenElement !== null);
	useEffect(() => {
		const sync = () => setActive(document.fullscreenElement !== null);
		const fromShell = (e: Event) => setActive((e as CustomEvent<boolean>).detail === true);
		document.addEventListener("fullscreenchange", sync);
		window.addEventListener(FULLSCREEN_EVENT, fromShell);
		return () => {
			document.removeEventListener("fullscreenchange", sync);
			window.removeEventListener(FULLSCREEN_EVENT, fromShell);
		};
	}, []);
	const shell = window.webkit?.messageHandlers?.ompwWindow;
	return {
		available: shell !== undefined || document.fullscreenEnabled === true,
		active,
		toggle() {
			if (shell) {
				void shell.postMessage({ type: "toggleFullScreen" });
				return;
			}
			const done = document.fullscreenElement
				? document.exitFullscreen()
				: document.documentElement.requestFullscreen();
			done.catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)));
		},
	};
}
