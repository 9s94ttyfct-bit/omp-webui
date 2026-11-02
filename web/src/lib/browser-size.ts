import { DESKTOP_SIZE, parseBrowserSize, type Size } from "@shared/browser-protocol.ts";
import { PREF } from "@shared/prefs.ts";

/** The desktop size of Settings › Browser (`ompw.browserSize`) a page is laid out at, 1280×800 without one. */
export function storedBrowserSize(): Size {
	return parseBrowserSize(localStorage.getItem(PREF.browserSize)) ?? DESKTOP_SIZE;
}
