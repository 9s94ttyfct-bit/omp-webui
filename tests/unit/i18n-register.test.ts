import { expect, test } from "bun:test";
import { en as chatLater } from "../../web/src/i18n/chat-later.ts";
import { en as files } from "../../web/src/i18n/files.ts";
import { en as guard } from "../../web/src/i18n/guard.ts";
import { addStrings, registerLater, registerStrings, t } from "../../web/src/i18n/index.ts";

/**
 * Lazy chunks bring their own English strings, some through `addStrings("en", …)` (guard, migrate) and some through
 * `registerStrings` (files, projects…). In v0.11.11 `addStrings` replaced the English dictionary, so a namespace
 * registered afterwards went to the old one and the Files tab showed its keys (`files.mentionInserted`) whenever the
 * guard's strings had loaded first.
 */
test("a namespace registered after another was added is translated", () => {
	addStrings("en", "guard", guard as unknown as Record<string, string>);
	registerStrings("files", files);
	expect(t("files.mentionInserted", { mention: "@a.ts" })).toBe("Added @a.ts to the message");
	expect(t("guard.guardTitle")).toBe("Guard dangerous commands");
});

test("a namespace added after another was registered is translated, and neither loses the other", () => {
	registerStrings("files", files);
	addStrings("en", "guard", guard as unknown as Record<string, string>);
	expect(t("files.previewFailedTitle")).toBe(files.previewFailedTitle);
	expect(t("guard.guardTitle")).toBe("Guard dangerous commands");
});

/** The `-later` halves go into the same dictionary as the strings of the lazy namespaces, in either order. */
test("the later halves and the lazy namespaces keep each other's strings", () => {
	const [key, text] = Object.entries(chatLater)[0] as [keyof typeof chatLater, string];
	registerLater({ chat: chatLater } as Parameters<typeof registerLater>[0]);
	addStrings("en", "guard", guard as unknown as Record<string, string>);
	expect(t(`chat.${key}`)).toBe(text);
	expect(t("guard.guardTitle")).toBe("Guard dangerous commands");
	registerStrings("files", files);
	registerLater({ chat: chatLater } as Parameters<typeof registerLater>[0]);
	expect(t("files.previewFailedTitle")).toBe(files.previewFailedTitle);
	expect(t("guard.guardTitle")).toBe("Guard dangerous commands");
});
