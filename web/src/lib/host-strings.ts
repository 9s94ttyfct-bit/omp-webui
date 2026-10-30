import type { Pressure } from "@shared/host.ts";
import { useEffect, useReducer } from "react";
import { en } from "../i18n/host.ts";
import { addStrings, type MessageKey, useLang } from "../i18n/index.ts";

/** What the system's three levels of memory pressure are called. */
export const PRESSURE_KEY: Record<Pressure, MessageKey> = {
	0: "host.pressureNormal",
	1: "host.pressureWarning",
	2: "host.pressureCritical",
};

/** The colour of each level, as the app's own tones are (`Badge`). */
export const PRESSURE_TONE = { 0: "success", 1: "warning", 2: "danger" } as const satisfies Record<Pressure, string>;

/** The dot that says the level at a glance. A computer that tells no pressure (null) has a neutral one. */
export const PRESSURE_DOT: Record<Pressure | "none", string> = {
	none: "bg-faint",
	0: "bg-success",
	1: "bg-warning",
	2: "bg-danger",
};

// Imported only by the lazy chunks of the host's load (the sidebar's indicator, the pane of graphs): the English strings
// go in with the first of them, the Chinese ones when they are needed. None of it is in the first chunk.
addStrings("en", "host", en);

/** Whether the Chinese strings of the host's load are in the dictionary (they are fetched once, the first time they are read). */
let zhAdded = false;

/**
 * True once the host load's strings exist in the page's language. English is there as the chunk loads; Chinese is a chunk
 * of its own that only a person reading Chinese downloads. What draws them shows nothing until then rather than English
 * for a moment.
 */
export function useHostStrings(): boolean {
	const lang = useLang((s) => s.lang);
	const [, redraw] = useReducer((n: number) => n + 1, 0);
	useEffect(() => {
		if (lang === "en" || zhAdded) return;
		let live = true;
		// The pack is picked at run time by the interface language, so it cannot be a static import.
		void import("../i18n/zh-CN/host.ts")
			.then((m) => addStrings(lang, "host", m.zh))
			// A pack that does not arrive leaves English under the Chinese: better than a chip that never shows.
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
