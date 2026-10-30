import { expect, test } from "bun:test";
import { fmtTokens } from "../../web/src/lib/format.ts";
import { parseTokenAmount } from "../../web/src/lib/token-amount.ts";

/** The goal's token budget field: what the page itself prints (`200k`, `1.5M`) must read back as the amount it stands for. */

test("plain digits, with or without thousands separators, are the amount typed", () => {
	expect(parseTokenAmount("200000")).toBe(200_000);
	expect(parseTokenAmount("  12345 ")).toBe(12_345);
	expect(parseTokenAmount("1,500,000")).toBe(1_500_000);
	expect(parseTokenAmount("1 500 000")).toBe(1_500_000);
	expect(parseTokenAmount("1_500_000")).toBe(1_500_000);
});

test("k, M and B scale the amount, as the page writes budgets (200k, 1.5M)", () => {
	expect(parseTokenAmount("200k")).toBe(200_000);
	expect(parseTokenAmount("200K")).toBe(200_000);
	expect(parseTokenAmount("1.5M")).toBe(1_500_000);
	expect(parseTokenAmount("1.5m")).toBe(1_500_000);
	expect(parseTokenAmount("2B")).toBe(2_000_000_000);
	expect(parseTokenAmount(".5k")).toBe(500);
	expect(parseTokenAmount("1.15k")).toBe(1150);
});

test("what the page prints for a token count reads back as that count", () => {
	for (const n of [850, 12_000, 200_000, 1_500_000, 25_000_000, 2_000_000_000]) {
		expect(parseTokenAmount(fmtTokens(n))).toBe(n);
	}
});

test("an empty field is no amount; text that is not an amount is refused, never read as part of it", () => {
	expect(parseTokenAmount("")).toBeUndefined();
	expect(parseTokenAmount("   ")).toBeUndefined();
	for (const bad of [
		"1e6",
		"2,5M",
		"12,34",
		"1.5",
		"abc",
		"k",
		"-5",
		"0",
		"0k",
		"200 k",
		"1.5.5M",
		"200kk",
		"99999999999999999999",
	]) {
		expect(parseTokenAmount(bad), bad).toBeNull();
	}
});
