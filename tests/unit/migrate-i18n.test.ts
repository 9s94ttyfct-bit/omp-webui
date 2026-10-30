import { expect, test } from "bun:test";
import { en } from "../../web/src/i18n/migrate.ts";
import { zh } from "../../web/src/i18n/zh-CN/migrate.ts";

/**
 * The card of Settings › Move to another computer keeps its strings outside the namespaces of `i18n/index.ts` (it is a lazy
 * chunk), so the guards that read those (`i18n-terms.test.ts`) do not see them: these are the same guards for this pack.
 */

const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("every string of the card is in both languages, with the same parameters", () => {
	expect(Object.keys(zh).sort()).toEqual(Object.keys(en).sort());
	for (const key of Object.keys(en) as (keyof typeof en)[]) {
		expect(zh[key].trim(), key).not.toBe("");
		expect(placeholders(zh[key]), key).toEqual(placeholders(en[key]));
	}
});

test("the Chinese pack of the card says 对话 for a conversation, never 会话, and 账号 never 账户", () => {
	const offenders = Object.entries(zh)
		.filter(([, text]) => text.includes("会话") || text.includes("账户"))
		.map(([key]) => key);
	expect(offenders).toEqual([]);
});

test("the strings about the password say that the file cannot be opened without it and that it is kept nowhere", () => {
	expect(en.madeNote).toMatch(/cannot be opened without it/);
	expect(en.madeNote).toMatch(/not stored anywhere/);
	expect(zh.madeNote).toContain("没有它就打不开");
	expect(zh.madeNote).toContain("不会保存在任何地方");
	expect(en.exportDoneEncrypted).toMatch(/not stored anywhere/);
	expect(zh.exportDoneEncrypted).toContain("不会保存在任何地方");
});
