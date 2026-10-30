import { expect, test } from "bun:test";
import * as zh from "../../web/src/i18n/zh-CN/index.ts";

/** The Simplified Chinese pack had 对话 and 会话 side by side for the same thing (#110). */
test("the Simplified Chinese pack says 对话 for a conversation, never 会话", () => {
	const offenders = Object.entries(zh).flatMap(([namespace, pack]) =>
		Object.entries(pack.zh)
			.filter(([, text]) => text.includes("会话"))
			.map(([key]) => `${namespace}.${key}`),
	);
	expect(offenders).toEqual([]);
});

/**
 * It also said 账户 in the Settings section (its title, the Manage / Add buttons) and 账号 everywhere else, and one string
 * quoted “账号” for a section titled 账户 (#301). 账号 is the one the rest of the pack and the release notes use.
 */
test("the Simplified Chinese pack says 账号 for an account, never 账户", () => {
	const offenders = Object.entries(zh).flatMap(([namespace, pack]) =>
		Object.entries(pack.zh)
			.filter(([, text]) => text.includes("账户"))
			.map(([key]) => `${namespace}.${key}`),
	);
	expect(offenders).toEqual([]);
});

test("the note that points at the Accounts section quotes the section's own title", () => {
	expect(zh.pages.zh.settingsAccountsHelperStatus).toContain(`“${zh.pages.zh.accTitle}”`);
});
