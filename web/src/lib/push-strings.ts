import { lazyStrings } from "../i18n/index.ts";
import { en } from "../i18n/push.ts";

// Imported only by the lazy chunk of the push card (Settings › Notifications when this page is closed): the English strings go
// in with it, the Chinese ones when they are needed. None of it is in the first chunk.

/** True once these strings exist in the page's language (see `lazyStrings`). */
export const usePushStrings = lazyStrings("push", en, {
	"zh-CN": () => import("../i18n/zh-CN/push.ts").then((m) => m.zh),
});
