import { en } from "../i18n/guidance.ts";
import { lazyStrings } from "../i18n/index.ts";

// Imported only by the lazy chunks of the model guidance (New chat's picker, Settings › Model guidance, a conversation's
// Info tab): the English strings go in with the first of them, the Chinese ones when they are needed. None of it is in the
// first chunk.

/** True once these strings exist in the page's language (see `lazyStrings`). */
export const useGuidanceStrings = lazyStrings("guidance", en, {
	"zh-CN": () => import("../i18n/zh-CN/guidance.ts").then((m) => m.zh),
});
