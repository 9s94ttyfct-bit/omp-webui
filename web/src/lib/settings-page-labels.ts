import "../i18n/later.ts";
import type { MessageKey } from "../i18n/index.ts";
import type { SettingsPageId } from "./settings-pages.ts";

/**
 * What each of Settings' pages is called: in the list beside the cards, in its heading and in the search's results. Not in
 * `settings-pages.ts`: the address (`#/settings/<page>`) is read on the first load, these strings are Settings' own.
 */
export const SETTINGS_PAGE_LABEL: Record<SettingsPageId, MessageKey> = {
	look: "pages.settingsGroupLook",
	chats: "pages.settingsGroupChats",
	models: "pages.settingsGroupModels",
	safety: "pages.settingsGroupSafety",
	app: "pages.settingsGroupApp",
};
