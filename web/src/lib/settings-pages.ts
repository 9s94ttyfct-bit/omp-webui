/**
 * Settings in five pages (v0.11.18 §10): the groups of cards it had been one long column of. Each page is its own place
 * (`#/settings/<page>`), with only its cards shown and its own scroll; `#/settings` alone opens the page last shown.
 * Every page's cards stay in the document (hidden but the current one), so that the search finds a setting on any page
 * and a link to a card (`showSettingsCard`) finds it: what decides the page of a card is the page wrapper it is in.
 */
export const SETTINGS_PAGES = ["look", "chats", "models", "safety", "app"] as const;
export type SettingsPageId = (typeof SETTINGS_PAGES)[number];

export const isSettingsPage = (v: unknown): v is SettingsPageId =>
	typeof v === "string" && (SETTINGS_PAGES as readonly string[]).includes(v);

/** The attribute of the element that holds one page's cards. */
export const PAGE_ATTR = "data-settings-page";

const LAST_KEY = "ompw.settingsPage";

/** The page `#/settings` opens: the one last shown on this device, else the first. */
export function lastSettingsPage(): SettingsPageId {
	try {
		const v = localStorage.getItem(LAST_KEY);
		return isSettingsPage(v) ? v : "look";
	} catch {
		return "look";
	}
}

export function rememberSettingsPage(page: SettingsPageId): void {
	try {
		localStorage.setItem(LAST_KEY, page);
	} catch {
		// Storage refused (private mode): `#/settings` opens the first page.
	}
}

/** The page an element of Settings is on: the page wrapper it is in, or null outside the pages. */
export function pageOfElement(el: Element): SettingsPageId | null {
	const v = el.closest(`[${PAGE_ATTR}]`)?.getAttribute(PAGE_ATTR);
	return isSettingsPage(v) ? v : null;
}
