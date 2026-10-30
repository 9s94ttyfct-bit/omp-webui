import { PREF, type PrefKey } from "@shared/prefs.ts";
import { type Lang, showLang } from "../i18n/index.ts";
import { useApp } from "../store/app.ts";
import { reloadStoredWidths } from "./panel-widths.ts";
import { onPrefsChanged, receiveSnapshot, refreshPrefs } from "./prefs.ts";
import { paintPalette, paintTheme, storedPalette, storedTheme } from "./theme.ts";
import { socket } from "./ws.ts";

/**
 * Preferences chosen somewhere else (another tab, the macOS window, another browser on the same server) show here as
 * they are chosen, without a reload: `lib/prefs.ts` takes the new values into localStorage and says which keys changed;
 * this repaints what shows them. Only what is on screen all the time needs it; the rest is read when it is next used.
 */
function show(keys: PrefKey[]): void {
	if (keys.includes(PREF.theme)) {
		const theme = storedTheme();
		useApp.setState({ theme });
		paintTheme(theme);
	}
	if (keys.includes(PREF.palette)) {
		const colorPalette = storedPalette();
		useApp.setState({ colorPalette });
		paintPalette(colorPalette);
	}
	if (keys.includes(PREF.lang)) {
		const lang = localStorage.getItem(PREF.lang);
		if (lang === "en" || lang === "zh-CN") void showLang(lang as Lang);
	}
	if (keys.includes(PREF.sidebarWidth) || keys.includes(PREF.panelWidth)) reloadStoredWidths();
	if (keys.includes(PREF.keepThinking)) {
		useApp.setState({ keepThinkingOpen: localStorage.getItem(PREF.keepThinking) === "on" });
	}
}

let started = false;

/** Once per page. */
export function startLivePrefs(): void {
	if (started) return;
	started = true;
	onPrefsChanged(show);
	socket.on((msg) => {
		if (msg.t === "prefs") receiveSnapshot(msg.snapshot);
	});
	// Changes made while there was no connection or no one looking (another server on the same data dir included) are
	// not announced: ask when the page can have missed one.
	socket.onStatus((connected) => {
		if (connected) void refreshPrefs();
	});
	addEventListener("focus", () => void refreshPrefs());
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "visible") void refreshPrefs();
	});
}
