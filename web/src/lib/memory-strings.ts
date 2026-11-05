import { lazyStrings } from "../i18n/index.ts";
import { en } from "../i18n/memory.ts";

// Imported only by the lazy chunk of the Memory page: the English strings go in with it, the Chinese ones when they are
// needed. None of it is in the first chunk.

/** True once these strings exist in the page's language (see `lazyStrings`). */
export const useMemoryStrings = lazyStrings("memory", en, {
	"zh-CN": () => import("../i18n/zh-CN/memory.ts").then((m) => m.zh),
});
