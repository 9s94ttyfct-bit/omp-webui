import "./browser-globals.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { PREF } from "../../shared/prefs.ts";
import { showLang, t, useLang } from "../../web/src/i18n/index.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

/**
 * Switching the interface language (`setLang` in Settings, `showLang` for another page's choice): the language shown is
 * the one chosen last, whatever order the packs arrive in.
 */

beforeAll(installGlobals);
afterAll(async () => {
	await showLang("en");
	restoreGlobals();
});

test("a language chosen while the one chosen before it is still loading is the one shown, and the one kept", async () => {
	const { setLang } = useLang.getState();
	const first = setLang("zh-CN");
	const second = setLang("en");
	await Promise.all([first, second]);
	expect(useLang.getState().lang).toBe("en");
	expect(localStorage.getItem(PREF.lang)).toBe("en");
	expect(t("common.cancel")).toBe("Cancel");
});
