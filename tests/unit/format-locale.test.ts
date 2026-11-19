import { afterEach, expect, test } from "bun:test";
import { useLang } from "../../web/src/i18n/index.ts";
import { fmtInt, fmtWeekdayTime } from "../../web/src/lib/format.ts";

/**
 * Numbers and times are written in the language chosen in Settings, not the browser's (#410): a German browser with the page
 * in English would otherwise read `1.234.567` and `18.11.2026` among English words. The browser's own language cannot be
 * changed from a test, so what is held is the locale each formatter is made with.
 */

const was = useLang.getState().lang;
afterEach(() => useLang.setState({ lang: was }));

/** The locales `Intl[name]` is constructed with while `run` goes. */
function localesOf(name: "NumberFormat" | "DateTimeFormat", run: () => void): unknown[] {
	const seen: unknown[] = [];
	const Real = Intl[name] as unknown as new (l?: unknown, o?: unknown) => object;
	const Spy = class extends Real {
		constructor(l?: unknown, o?: unknown) {
			seen.push(l);
			super(l, o);
		}
	};
	(Intl as unknown as Record<string, unknown>)[name] = Spy;
	try {
		run();
	} finally {
		(Intl as unknown as Record<string, unknown>)[name] = Real;
	}
	return seen;
}

test("a whole number is written for the page's language, whatever the browser's is", () => {
	useLang.setState({ lang: "zh-CN" });
	expect(localesOf("NumberFormat", () => fmtInt(1_234_567))).toEqual(["zh-CN"]);
	expect(fmtInt(1_234_567)).toBe("1,234,567");
});

test("a reset time with its weekday is written for the page's language", () => {
	useLang.setState({ lang: "zh-CN" });
	expect(localesOf("DateTimeFormat", () => fmtWeekdayTime(Date.UTC(2026, 10, 18, 12)))).toEqual(["zh-CN"]);
});
