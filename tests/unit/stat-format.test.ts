import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { showLang } from "../../web/src/i18n/index.ts";
import { fmtElapsed, fmtFinished, fmtRate, fmtWindow } from "../../web/src/lib/stat-format.ts";

/** The small readouts of the turn stats line and the status line: how they are written. */

describe("elapsed time", () => {
	test("counts whole seconds while it is under a minute, so a ticking clock does not shimmer", () => {
		expect(fmtElapsed(0)).toBe("0s");
		expect(fmtElapsed(999)).toBe("0s");
		expect(fmtElapsed(12_300)).toBe("12s");
		expect(fmtElapsed(59_999)).toBe("59s");
	});

	test("goes on in minutes, hours and days like every other duration in the app", () => {
		expect(fmtElapsed(5 * 60_000 + 6_000)).toBe("5m 6s");
		expect(fmtElapsed(13 * 3_600_000 + 7 * 60_000 + 40_000)).toBe("13h 7m");
		expect(fmtElapsed(2 * 86_400_000 + 5 * 3_600_000)).toBe("2d 5h");
	});

	test("never goes below zero", () => {
		expect(fmtElapsed(-4000)).toBe("0s");
	});
});

describe("elapsed time in Chinese", () => {
	beforeAll(() => showLang("zh-CN"));
	afterAll(() => showLang("en"));

	test("counts whole seconds under a minute", () => {
		expect(fmtElapsed(0)).toBe("0秒");
		expect(fmtElapsed(999)).toBe("0秒");
		expect(fmtElapsed(59_999)).toBe("59秒");
	});

	test("goes on in minutes, hours and days with Chinese units", () => {
		expect(fmtElapsed(60_000)).toBe("1分0秒");
		expect(fmtElapsed(5 * 60_000 + 6_000)).toBe("5分6秒");
		expect(fmtElapsed(3_599_999)).toBe("59分59秒");
		expect(fmtElapsed(3_600_000)).toBe("1小时0分");
		expect(fmtElapsed(23 * 3_600_000 + 59 * 60_000)).toBe("23小时59分");
		expect(fmtElapsed(86_400_000)).toBe("1天0小时");
		expect(fmtElapsed(3 * 86_400_000)).toBe("3天0小时");
	});
});

describe("output speed", () => {
	test("keeps a decimal under 10 tokens a second and none above", () => {
		expect(fmtRate(2.46)).toBe("2.5");
		expect(fmtRate(9.96)).toBe("10");
		expect(fmtRate(102.04)).toBe("102");
		expect(fmtRate(1234.5)).toBe("1,235");
	});
});

describe("a context window or a token budget", () => {
	test("is written the way the TUI writes it, with no needless zeros", () => {
		expect(fmtWindow(1_000_000)).toBe("1M");
		expect(fmtWindow(1_500_000)).toBe("1.5M");
		expect(fmtWindow(200_000)).toBe("200k");
		expect(fmtWindow(128_000)).toBe("128k");
		expect(fmtWindow(32_768)).toBe("33k");
		expect(fmtWindow(8_192)).toBe("8.2k");
		expect(fmtWindow(950)).toBe("950");
		expect(fmtWindow(0)).toBe("0");
		expect(fmtWindow(10_000_000)).toBe("10M");
	});

	test("rounds up to the next unit instead of printing 1000k", () => {
		expect(fmtWindow(999_700)).toBe("1M");
		expect(fmtWindow(999_400)).toBe("999k");
	});
});

describe("when a turn finished", () => {
	const at = (y: number, mo: number, d: number, h: number, mi: number, s: number) =>
		new Date(y, mo - 1, d, h, mi, s).getTime();

	test("today it is the time of day, with seconds, on a 24-hour clock", () => {
		const now = at(2026, 10, 17, 18, 0, 0);
		expect(fmtFinished(at(2026, 10, 17, 10, 49, 50), now, "en")).toBe("10:49:50");
		expect(fmtFinished(at(2026, 10, 17, 0, 5, 9), now, "en")).toBe("00:05:09");
		expect(fmtFinished(at(2026, 10, 17, 15, 3, 2), now, "zh-CN")).toBe("15:03:02");
	});

	test("another day names the day too; another year names the year", () => {
		const now = at(2026, 10, 17, 18, 0, 0);
		expect(fmtFinished(at(2026, 10, 16, 10, 49, 50), now, "en")).toMatch(/Oct\D*16\D+10:49:50/);
		expect(fmtFinished(at(2025, 12, 31, 23, 59, 58), now, "en")).toMatch(/2025.*23:59:58/);
		expect(fmtFinished(at(2026, 10, 16, 10, 49, 50), now, "zh-CN")).toMatch(/10月16日.*10:49:50/);
	});
});
