import { en } from "../i18n/guard.ts";
import { lazyStrings } from "../i18n/index.ts";

// Imported only by the lazy chunks of the guard (Settings › Safety, a card's verdict, the notice): the English strings go
// in with the first of them, the Chinese ones when they are needed. None of it is in the first chunk.

/** True once these strings exist in the page's language (see `lazyStrings`). */
export const useGuardStrings = lazyStrings("guard", en, {
	"zh-CN": () => import("../i18n/zh-CN/guard.ts").then((m) => m.zh),
});
