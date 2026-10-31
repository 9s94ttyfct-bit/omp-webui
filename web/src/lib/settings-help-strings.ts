import { useEffect, useReducer } from "react";
import { addStrings, useLang } from "../i18n/index.ts";
import { en } from "../i18n/settings-help.ts";

// Imported only by the lazy chunks of Ask agent for help (Settings' card, the strip of the dedicated conversation): the
// English strings go in with the first of them, the Chinese ones when they are needed. None of it is in the first chunk.
addStrings("en", "settingsHelp", en);

/** Whether the Chinese strings are in the dictionary (they are fetched once, the first time they are read). */
let zhAdded = false;

/** True once the strings exist in the page's language: what draws them shows nothing until then rather than English for a moment. */
export function useSettingsHelpStrings(): boolean {
	const lang = useLang((s) => s.lang);
	const [, redraw] = useReducer((n: number) => n + 1, 0);
	useEffect(() => {
		if (lang === "en" || zhAdded) return;
		let live = true;
		// The pack is picked at run time by the interface language, so it cannot be a static import.
		void import("../i18n/zh-CN/settings-help.ts")
			.then((m) => addStrings(lang, "settingsHelp", m.zh))
			// A pack that does not arrive leaves English under the Chinese: better than a card that never shows.
			.catch(() => {})
			.finally(() => {
				zhAdded = true;
				if (live) redraw();
			});
		return () => {
			live = false;
		};
	}, [lang]);
	return lang === "en" || zhAdded;
}
