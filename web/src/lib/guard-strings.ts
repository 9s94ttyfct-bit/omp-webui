import { useEffect, useReducer } from "react";
import { en } from "../i18n/guard.ts";
import { addStrings, useLang } from "../i18n/index.ts";

// Imported only by the lazy chunks of the guard (Settings › Safety, a card's verdict, the notice): the English strings go
// in with the first of them, the Chinese ones when they are needed. None of it is in the first chunk.
addStrings("en", "guard", en);

/** Whether the Chinese strings of the guard are in the dictionary (they are fetched once, the first time they are read). */
let zhAdded = false;

/**
 * True once the guard's strings exist in the page's language. English is there as the chunk loads; Chinese is a chunk of
 * its own that only a person reading Chinese downloads. What draws them shows nothing until then rather than English for a moment.
 */
export function useGuardStrings(): boolean {
	const lang = useLang((s) => s.lang);
	const [, redraw] = useReducer((n: number) => n + 1, 0);
	useEffect(() => {
		if (lang === "en" || zhAdded) return;
		let live = true;
		// The pack is picked at run time by the interface language, so it cannot be a static import.
		void import("../i18n/zh-CN/guard.ts")
			.then((m) => addStrings(lang, "guard", m.zh))
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
