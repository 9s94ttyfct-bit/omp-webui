import { expect, test } from "bun:test";

/**
 * A count that can be one reads in the singular in English ("1 match", not "1 matches"), as `paletteMoreOne` and
 * `advisorNoteOne` do (#409): the strings below take a number from a list or a search that has one entry quite often, so
 * each has a `…One` sibling in both languages and its caller picks by the number.
 */

const WITH_ONE: [namespace: string, file: string, keys: string[]][] = [
	["shell", "shell.ts", ["sidebarSearchCount"]],
	["pages", "pages-later.ts", ["settingsSearchCount"]],
	["guard", "guard.ts", ["decCount", "decCountFiltered", "benchHeld", "benchSlipped"]],
	["panel", "panel-later.ts", ["branchEntries"]],
	["mode", "mode-later.ts", ["modelsServed"]],
];

for (const [namespace, file, keys] of WITH_ONE) {
	test(`${namespace}: ${keys.join(", ")} have a singular form in English and Chinese`, async () => {
		const { en } = (await import(`../../web/src/i18n/${file}`)) as { en: Record<string, string> };
		const zhFile = file.replace(/-later(?=\.ts$)/, "");
		const { zh } = (await import(`../../web/src/i18n/zh-CN/${zhFile}`)) as { zh: Record<string, string> };
		for (const key of keys) {
			const one = en[`${key}One`];
			expect(one, `${namespace}.${key}One`).toBeDefined();
			// The English singular names the one ("1 match"), it does not take a count placeholder.
			expect(one, one).toMatch(/\b1\b|\{(?:matched|total)\}/);
			expect(zh[`${key}One`], `zh ${namespace}.${key}One`).toBeDefined();
		}
	});
}

test("the import refusal puts no plural noun after the number of working conversations", async () => {
	const { en } = await import("../../web/src/i18n/errors.ts");
	expect(en.migrateWorking).not.toMatch(/\{count\} conversations/);
});
