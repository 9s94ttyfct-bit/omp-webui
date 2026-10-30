import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { showLang } from "../../web/src/i18n/index.ts";
import { fmtDuration } from "../../web/src/lib/format.ts";

describe("English", () => {
	beforeAll(() => showLang("en"));

	test("durations read naturally at every scale", () => {
		expect(fmtDuration(450)).toBe("450ms");
		expect(fmtDuration(12_300)).toBe("12.3s");
		expect(fmtDuration(5 * 60_000 + 7_000)).toBe("5m 7s");
		expect(fmtDuration(2 * 3_600_000 + 13 * 60_000 + 59_000)).toBe("2h 13m");
		// The epsilon fixture's turn: was "409676m 11s".
		expect(fmtDuration(409_676 * 60_000 + 11_000)).toBe("284d 11h");
		expect(fmtDuration(-5)).toBe("0ms");
	});

	test("changes unit at each boundary", () => {
		expect(fmtDuration(0)).toBe("0ms");
		expect(fmtDuration(999)).toBe("999ms");
		expect(fmtDuration(1000)).toBe("1.0s");
		expect(fmtDuration(59_000)).toBe("59.0s");
		expect(fmtDuration(59_999)).toBe("60.0s");
		expect(fmtDuration(60_000)).toBe("1m 0s");
		expect(fmtDuration(3_599_999)).toBe("59m 59s");
		expect(fmtDuration(3_600_000)).toBe("1h 0m");
		expect(fmtDuration(23 * 3_600_000 + 59 * 60_000 + 59_999)).toBe("23h 59m");
		expect(fmtDuration(86_400_000)).toBe("1d 0h");
		expect(fmtDuration(3 * 86_400_000)).toBe("3d 0h");
	});
});

describe("中文", () => {
	beforeAll(() => showLang("zh-CN"));
	afterAll(() => showLang("en"));

	test("durations use Chinese units with no spaces", () => {
		expect(fmtDuration(450)).toBe("450毫秒");
		expect(fmtDuration(12_300)).toBe("12.3秒");
		expect(fmtDuration(5 * 60_000 + 7_000)).toBe("5分7秒");
		expect(fmtDuration(2 * 3_600_000 + 13 * 60_000 + 59_000)).toBe("2小时13分");
		expect(fmtDuration(409_676 * 60_000 + 11_000)).toBe("284天11小时");
		expect(fmtDuration(-5)).toBe("0毫秒");
	});

	test("changes unit at each boundary", () => {
		expect(fmtDuration(0)).toBe("0毫秒");
		expect(fmtDuration(999)).toBe("999毫秒");
		expect(fmtDuration(1000)).toBe("1.0秒");
		expect(fmtDuration(59_999)).toBe("60.0秒");
		expect(fmtDuration(60_000)).toBe("1分0秒");
		expect(fmtDuration(12 * 60_000 + 34_000)).toBe("12分34秒");
		expect(fmtDuration(3_599_999)).toBe("59分59秒");
		expect(fmtDuration(3_600_000)).toBe("1小时0分");
		expect(fmtDuration(23 * 3_600_000 + 59 * 60_000 + 59_999)).toBe("23小时59分");
		expect(fmtDuration(86_400_000)).toBe("1天0小时");
		expect(fmtDuration(3 * 86_400_000)).toBe("3天0小时");
	});
});
