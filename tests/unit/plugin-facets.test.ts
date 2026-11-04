import { expect, test } from "bun:test";
import { facets } from "../../web/src/components/plugins/parts.tsx";

const items = [
	{ name: "a", market: "m1", cat: "dev", on: true },
	{ name: "b", market: "m1", cat: "design", on: false },
	{ name: "c", market: "m2", cat: "dev", on: true },
	{ name: "d", market: "m2", cat: null, on: true },
];
const by = (market: string, cat: string) => ({
	market: { value: market, of: (i: (typeof items)[number]) => i.market },
	cat: { value: cat, of: (i: (typeof items)[number]) => i.cat },
});

test("each facet counts what choosing a value would show, given the other facets and the text", () => {
	const { kept, choices } = facets(items, by("m2", ""), (i) => i.on);
	expect(kept.map((i) => i.name)).toEqual(["c", "d"]);
	// The marketplace counts ignore the marketplace chosen but keep the text filter (b is off).
	expect(choices.market.options).toEqual([
		{ value: "m2", label: "m2", count: 2 },
		{ value: "m1", label: "m1", count: 1 },
	]);
	// The category counts follow the marketplace chosen; an item without a category is not a choice.
	expect(choices.cat.options).toEqual([{ value: "dev", label: "dev", count: 1 }]);
	expect(choices.cat.useful).toBe(true);
});

test("a chosen value nothing has any more stays a choice with 0; a facet with one value is not useful", () => {
	const { kept, choices } = facets(items, by("m1", "dev"), (i) => i.name !== "a");
	expect(kept).toEqual([]);
	expect(choices.cat.options).toContainEqual({ value: "dev", label: "dev", count: 0 });
	const one = facets([items[0], items[1]], by("", ""), () => true);
	expect(one.choices.market.useful).toBe(false);
});
