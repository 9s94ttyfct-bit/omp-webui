import { describe, expect, test } from "bun:test";
import { t } from "../../web/src/i18n/index.ts";
import "../../web/src/i18n/later.ts";
import type { MessageKey } from "../../web/src/i18n/index.ts";
import { zh as pagesZh } from "../../web/src/i18n/zh-CN/pages.ts";
import { flattenSettings, SETTINGS, searchSettings } from "../../web/src/lib/settings-search.ts";

/**
 * The search at the top of Settings: every setting is found by the name it is shown under, the sentence under it and the
 * names people use for it, in English and in Chinese; the results are grouped by the card they are on, the best card
 * first. The catalogue's targets are checked against the page itself (`tests/e2e/settings-search.spec.ts`), which is
 * where an entry that points at nothing would show.
 */

/** The app's own translation, every namespace registered (as a page that has the Settings chunk has it). */
const text = (key: MessageKey) => t(key);
/** The same, in Chinese, for the namespace the page's own cards are named in. */
const zhText = (key: MessageKey) => {
	const short = key.replace(/^pages\./, "");
	const zh = pagesZh as Record<string, string>;
	return key.startsWith("pages.") && short in zh ? (zh[short] as string) : t(key);
};

const ids = (query: string, look = text) => flattenSettings(searchSettings(query, look)).map((hit) => hit.entry.id);
const groups = (query: string, look = text) => searchSettings(query, look).map((group) => group.group);

describe("finding a setting", () => {
	test("by the name it is shown under", () => {
		expect(ids("automatically")).toContain("auto-title");
		expect(ids("theme")).toContain("theme");
	});

	test("by the sentence under it", () => {
		// "Drag the edge of the sidebar or the side panel to resize it" is the reset card's hint.
		expect(ids("drag the edge")).toContain("reset-layout");
	});

	test("by the names people use for it", () => {
		expect(ids("dark mode")).toContain("theme");
		expect(ids("yolo")).toContain("approval");
		expect(ids("api key")).toContain("accounts");
	});

	test("a fuzzy match, not a substring: the letters in order", () => {
		expect(ids("ntfctns")).toContain("notifications");
	});

	test("a sentence under a setting counts only when it has the word whole: its scattered letters, or a piece of a word, do not", () => {
		// "theme" spelled itself out of letters across dozens of hints, and then out of the letters of a few labels that are
		// whole sentences ("Keep the Mac awake while a conversation works"): 26, then 5 settings, 3 of them unrelated.
		expect(ids("theme")).toEqual(["theme", "palette"]);
		expect(ids("ntfctns")).not.toContain("remote-shell");
		// "After the first reply, omp generates a title …" is the automatic title's hint.
		expect(ids("reply")).toContain("auto-title");
		expect(ids("repl")).not.toContain("auto-title");
		expect(ids("generate")).not.toContain("auto-title");
		expect(ids("generates a title")).toContain("auto-title");
	});

	test("a label or an alias is matched by its letters in order only where they stay close", () => {
		expect(ids("ntfctns")).toContain("notifications");
		// The letters of "theme" are all in "Keep the Mac awake while a conversation works", seven characters apart.
		expect(ids("theme")).not.toContain("sleep");
		expect(ids("theme")).not.toContain("migrate");
	});

	test("a label outranks an alias, and an alias a sentence under a setting", () => {
		const found = (query: string) => flattenSettings(searchSettings(query, text));
		// "Theme" is the theme's name and the palette's nickname: the one it names comes first.
		expect(found("theme").map((hit) => hit.entry.id)).toEqual(["theme", "palette"]);
		expect(found("theme")[0]?.score).toBeGreaterThan(found("theme")[1]?.score ?? 0);
		// Both are a label and a sentence under another setting: "model" names the roles card, and is only said in the rest.
		const model = found("model");
		const labelled = model.findIndex((hit) => hit.entry.id === "model-roles");
		const prose = model.findIndex((hit) => hit.entry.id === "auto-title");
		expect(labelled).toBeGreaterThanOrEqual(0);
		expect(prose).toBeGreaterThan(labelled);
		expect(model[labelled]?.score).toBeGreaterThan(model[prose]?.score ?? 0);
	});

	test("an empty query finds nothing: the box is a search, not a list", () => {
		expect(searchSettings("", text)).toEqual([]);
		expect(searchSettings("   ", text)).toEqual([]);
	});

	test("a query nothing answers is nothing", () => {
		expect(searchSettings("zzzzzz", text)).toEqual([]);
	});
});

describe("the two languages", () => {
	test("a Chinese query finds a setting by its Chinese name", () => {
		expect(ids("主题", zhText)).toContain("theme");
		expect(ids("自动命名", zhText)).toContain("auto-title");
	});

	test("the theme settings are all found for 主题: the theme and the palette, in that order and nothing else", () => {
		expect(ids("主题", zhText)).toEqual(["theme", "palette"]);
		// And the palette by each of its Chinese names.
		for (const name of ["配色", "调色板", "配色方案"]) expect(ids(name, zhText), name).toContain("palette");
		expect(ids("theme", zhText)).toEqual(["theme", "palette"]);
	});

	test("a sentence under a Chinese setting counts when it has the whole term, not letters of it in order", () => {
		// "首次回复后，omp 会用其标题模型生成标题（一次小模型调用）" is the automatic title's hint.
		expect(ids("标题模型", zhText)).toContain("auto-title");
		expect(ids("标模调", zhText)).not.toContain("auto-title");
	});

	test("a Chinese alias finds an English-labelled setting, and the other way round", () => {
		// The theme's aliases carry both languages, so a reader of either finds the one card.
		expect(ids("深色", text)).toContain("theme");
		expect(ids("dark mode", zhText)).toContain("theme");
		expect(ids("配色", text)).toContain("palette");
	});

	test("the group is the card's name in the language searched", () => {
		expect(groups("theme")[0]).toBe("pages.settingsAppearance");
		expect(searchSettings("主题", zhText)[0]?.title).toBe("外观");
	});
});

describe("the order and the grouping", () => {
	test("the results are grouped by the card they are on", () => {
		const found = searchSettings("model", text);
		expect(found.map((g) => g.group)).toContain("presets.rolesTitle");
		expect(found.every((g) => g.hits.length > 0)).toBe(true);
	});

	test("the best match leads, and within a card the best setting", () => {
		const found = flattenSettings(searchSettings("palette", text));
		expect(found[0]?.entry.id).toBe("palette");
		const group = searchSettings("notification", text)[0];
		expect(group?.hits[0]?.entry.id).toBe("notifications");
	});

	test("every setting has an id of its own, a label to show and an element to go to", () => {
		expect(new Set(SETTINGS.map((e) => e.id)).size).toBe(SETTINGS.length);
		for (const entry of SETTINGS) {
			expect(entry.label, `${entry.id} has a label`).toMatch(/^[a-z][A-Za-z]*\.[A-Za-z]+$/);
			expect(entry.target, `${entry.id} has a target`).not.toBe("");
		}
	});

	test("a card the page does not show is left out", () => {
		const found = searchSettings("safety", text, { available: (entry) => entry.id !== "guard" });
		expect(found.map((g) => g.group)).not.toContain("guard.title");
	});
});
