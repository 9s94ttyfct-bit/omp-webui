import { lazyStrings } from "../i18n/index.ts";
import { en } from "../i18n/macs.ts";

// Imported only by the machine switcher's lazy chunk (#628): the English strings go in with it, the Chinese ones when they are
// needed. None of it is in the first chunk.

/** True once these strings exist in the page's language (see `lazyStrings`). */
export const useMacsStrings = lazyStrings("macs", en, {
	"zh-CN": () => import("../i18n/zh-CN/macs.ts").then((m) => m.zh),
});
