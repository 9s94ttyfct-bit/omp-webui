import { describe, expect, test } from "bun:test";
import { BUILTIN_GUIDANCE } from "../../shared/model-guidance.ts";
import type { MessageKey } from "../../web/src/i18n/index.ts";
import { zh } from "../../web/src/i18n/zh-CN/guidance.ts";
import { templateName, templateSummary } from "../../web/src/lib/guidance-names.ts";

/**
 * A shipped guidance template is shown in the page's language only while it is as shipped: the name and the text are the
 * person's to change, and what they wrote is what they see (S13 of the 0.11.20 audit).
 */
const inChinese = (key: MessageKey) => (zh as Record<string, string>)[key.replace(/^guidance\./, "")] ?? key;
const shipped = BUILTIN_GUIDANCE[0];

describe("a shipped template in Chinese", () => {
	test("as shipped: its name and summary are the Chinese ones", () => {
		expect(templateName(shipped, inChinese)).toBe(zh.builtinOneOfEachName);
		expect(templateSummary(shipped, inChinese)).toBe(zh.builtinOneOfEachSummary);
	});

	test("renamed: the person's name; its untouched text keeps the Chinese summary", () => {
		const renamed = { ...shipped, name: "My limits" };
		expect(templateName(renamed, inChinese)).toBe("My limits");
		expect(templateSummary(renamed, inChinese)).toBe(zh.builtinOneOfEachSummary);
	});

	test("rewritten: the summary is the first line of what the person wrote", () => {
		const rewritten = { ...shipped, text: "## Model guidance\nUse Haiku for everything." };
		expect(templateSummary(rewritten, inChinese)).toBe("Use Haiku for everything.");
		expect(templateName(rewritten, inChinese)).toBe(zh.builtinOneOfEachName);
	});

	test("a template the person made is shown as written", () => {
		const own = { id: "t1", name: "One of each kind at a time", text: shipped.text };
		expect(templateName(own, inChinese)).toBe(own.name);
	});
});
