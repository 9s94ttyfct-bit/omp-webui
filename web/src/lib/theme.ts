import { PALETTES, PREF, THEMES } from "@shared/prefs.ts";
import { setPref } from "./prefs.ts";

/** Light, dark or whatever the OS is set to: the mode. Independent of the palette. */
export type Theme = (typeof THEMES)[number];
export const DEFAULT_THEME: Theme = "dark";

/**
 * The palettes (palettes.css has each one's colours, in light and in dark): a brand's look, chosen apart from the mode.
 * Claude is the app's original look and the default.
 */
export { PALETTES };
export type Palette = (typeof PALETTES)[number];
export const DEFAULT_PALETTE: Palette = "claude";

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function isTheme(value: unknown): value is Theme {
	return typeof value === "string" && (THEMES as readonly string[]).includes(value);
}

/** The theme chosen: dark when none is stored or the stored value is not a theme. */
export function storedTheme(): Theme {
	const value = localStorage.getItem(PREF.theme);
	return isTheme(value) ? value : DEFAULT_THEME;
}

export function isPalette(value: unknown): value is Palette {
	return typeof value === "string" && (PALETTES as readonly string[]).includes(value);
}

/** The palette chosen: the default when none is stored or the stored value is not a palette. */
export function storedPalette(): Palette {
	const value = localStorage.getItem(PREF.palette);
	return isPalette(value) ? value : DEFAULT_PALETTE;
}

/**
 * The colour of the browser's own chrome (the status bar of a phone, the title bar of an installed app): the page's
 * background in the palette and mode being shown. Read from the stylesheet, so it cannot drift from it.
 */
function paintChrome(): void {
	const bg = getComputedStyle(document.documentElement).getPropertyValue("--bg").trim();
	if (bg) document.querySelector('meta[name="theme-color"]')?.setAttribute("content", bg);
}

/** Show `theme` now: the `dark` class on <html> and the colour of the browser's own chrome. */
export function paintTheme(theme: Theme): void {
	const dark = theme === "dark" || (theme === "system" && matchMedia(DARK_QUERY).matches);
	document.documentElement.classList.toggle("dark", dark);
	paintChrome();
}

/** Show `palette` now: the `data-palette` attribute on <html> and the colour of the browser's own chrome. */
export function paintPalette(palette: Palette): void {
	document.documentElement.dataset.palette = palette;
	paintChrome();
}

/** Choose a theme: remembered for the next visit, on any port (index.html applies it before first paint), and shown now. */
export function applyTheme(theme: Theme): void {
	setPref(PREF.theme, theme);
	paintTheme(theme);
}

/** Choose a palette: remembered for the next visit, on any port (index.html applies it before first paint), and shown now. */
export function applyPalette(palette: Palette): void {
	setPref(PREF.palette, palette);
	paintPalette(palette);
}

/**
 * Repaint when the OS appearance changes while the chosen theme is "system"; an explicit light or dark
 * ignores it. `current` reads the choice at the time of the change. Returns the unsubscribe function.
 */
export function followSystemTheme(current: () => Theme): () => void {
	const query = matchMedia(DARK_QUERY);
	const onChange = () => {
		if (current() === "system") paintTheme("system");
	};
	query.addEventListener("change", onChange);
	return () => query.removeEventListener("change", onChange);
}
