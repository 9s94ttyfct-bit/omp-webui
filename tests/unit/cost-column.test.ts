import { expect, test } from "bun:test";
import { costColumn } from "../../web/src/lib/format.ts";

/**
 * A column of costs is written with one number of decimals, so the points line up: `$0.06`, `$0.04` and `$0.0040` in
 * one list did not. Two decimals, four when any figure of the column is under a cent.
 */

test("a column of cents has two decimals", () => {
	const money = costColumn([0.0581, 0.0438, 0.0155, 0.02]);
	expect(money(0.0581)).toBe("$0.06");
	expect(money(0.0155)).toBe("$0.02");
	expect(money(0)).toBe("$0.00");
});

test("one figure under a cent gives the whole column four decimals", () => {
	const values = [0.0581, 0.0438, 0.0155, 0.004];
	const money = costColumn(values);
	expect(values.map(money)).toEqual(["$0.0581", "$0.0438", "$0.0155", "$0.0040"]);
	expect(money(0)).toBe("$0.0000");
	// Every figure ends its decimals in the same place.
	expect(new Set(values.map((v) => money(v).split(".")[1].length)).size).toBe(1);
});

test("big figures keep their thousands separators and the column's decimals", () => {
	expect(costColumn([1234.5, 0.5])(1234.5)).toBe("$1,234.50");
	expect(costColumn([1234.5, 0.004])(1234.5)).toBe("$1,234.5000");
});

test("an empty column writes like a column of cents", () => {
	expect(costColumn([])(2.5)).toBe("$2.50");
});
