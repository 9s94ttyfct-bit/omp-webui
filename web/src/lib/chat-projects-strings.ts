import { en } from "../i18n/chat-projects.ts";
import { lazyStrings } from "../i18n/index.ts";

// Imported only by the lazy chunks of the sidebar's projects (a project's menu, its dialogs, "Move to project", its page): the
// English strings go in with them, the Chinese ones when they are needed. None of it is in the first chunk.

/** True once these strings exist in the page's language (see `lazyStrings`). */
export const useChatProjectsStrings = lazyStrings("chatProjects", en, {
	"zh-CN": () => import("../i18n/zh-CN/chat-projects.ts").then((m) => m.zh),
});
