import type { Pressure } from "@shared/host.ts";
import { en } from "../i18n/host.ts";
import { lazyStrings, type MessageKey } from "../i18n/index.ts";

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

/** True once these strings exist in the page's language (see `lazyStrings`). */
export const useHostStrings = lazyStrings("host", en, {
	"zh-CN": () => import("../i18n/zh-CN/host.ts").then((m) => m.zh),
});
