import { lazyStrings } from "../i18n/index.ts";
import { en } from "../i18n/settings-help.ts";

// Imported only by the lazy chunks of Ask agent for help (Settings' card, the strip of the dedicated conversation): the
// English strings go in with the first of them, the Chinese ones when they are needed. None of it is in the first chunk.

/** True once these strings exist in the page's language (see `lazyStrings`). */
export const useSettingsHelpStrings = lazyStrings("settingsHelp", en, {
	"zh-CN": () => import("../i18n/zh-CN/settings-help.ts").then((m) => m.zh),
});
