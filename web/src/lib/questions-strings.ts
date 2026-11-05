import { lazyStrings } from "../i18n/index.ts";
import { en } from "../i18n/questions.ts";

// Imported only by the lazy chunks of unattended mode (the Questions page, the switch beside the message box, the card in
// Settings): the English strings go in with the first of them, the Chinese ones when they are needed. None of it is in the
// first chunk.

/** True once these strings exist in the page's language (see `lazyStrings`). */
export const useQuestionsStrings = lazyStrings("questions", en, {
	"zh-CN": () => import("../i18n/zh-CN/questions.ts").then((m) => m.zh),
});
