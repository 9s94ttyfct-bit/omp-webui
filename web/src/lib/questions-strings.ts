import { useEffect, useReducer } from "react";
import { addStrings, useLang } from "../i18n/index.ts";
import { en } from "../i18n/questions.ts";

// Imported only by the lazy chunks of unattended mode (the Questions page, the switch beside the message box, the card in
// Settings): the English strings go in with the first of them, the Chinese ones when they are needed. None of it is in the
// first chunk.
addStrings("en", "questions", en);

/** Whether the Chinese strings of unattended mode are in the dictionary (they are fetched once, the first time they are read). */
let zhAdded = false;

/**
 * True once the strings of unattended mode exist in the page's language. English is there as the chunk loads; Chinese is a
 * chunk of its own that only a person reading Chinese downloads. What draws them shows nothing until then rather than
 * English for a moment.
 */
export function useQuestionsStrings(): boolean {
	const lang = useLang((s) => s.lang);
	const [, redraw] = useReducer((n: number) => n + 1, 0);
	useEffect(() => {
		if (lang === "en" || zhAdded) return;
		let live = true;
		// The pack is picked at run time by the interface language, so it cannot be a static import.
		void import("../i18n/zh-CN/questions.ts")
			.then((m) => addStrings(lang, "questions", m.zh))
			// A pack that does not arrive leaves English under the Chinese: better than a page that never shows.
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
