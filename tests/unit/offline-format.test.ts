import { expect, test } from "bun:test";
import type { ContextBreakdown } from "../../shared/offline.ts";
import { contextRows, formatTokens, parseList, savingPercent } from "../../web/src/lib/offline-format.ts";

/** What the Settings mode section makes of the measurements and of the skills field. */

const breakdown = (items: [string, number][]): ContextBreakdown => ({
	window: 65536,
	startTokens: 0,
	items: items.map(([label, tokens]) => ({ label, tokens })),
	incomplete: false,
});

test("token counts read like omp's own: whole numbers up to a thousand, then 1.2K", () => {
	expect([0, 23, 999, 1000, 2411, 16_100, 32_322].map(formatTokens)).toEqual([
		"0",
		"23",
		"999",
		"1.0K",
		"2.4K",
		"16.1K",
		"32.3K",
	]);
});

test("the saving is the whole percent Light starts below Full, or nothing when it does not", () => {
	expect(savingPercent(32_000, 16_000)).toBe(50);
	expect(savingPercent(28_700, 16_700)).toBe(42);
	expect(savingPercent(1000, 1000)).toBeNull();
	expect(savingPercent(1000, 1200)).toBeNull();
	expect(savingPercent(0, 0)).toBeNull();
});

test("rows follow omp's order, leave out the free space, and show a side that did not measure as nothing", () => {
	const full = breakdown([
		["System prompt", 16_100],
		["System tools", 8100],
		["System context", 6000],
		["Skills", 1700],
		["Auto-compact buf", 16_384],
		["Free", 17_100],
	]);
	const light = breakdown([
		["System prompt", 10_800],
		["System tools", 2400],
		["System context", 3500],
		["Free", 32_300],
	]);
	expect(contextRows(full, light)).toEqual([
		{ label: "System prompt", full: 16_100, light: 10_800 },
		{ label: "System tools", full: 8100, light: 2400 },
		{ label: "System context", full: 6000, light: 3500 },
		// Light has no skills row at all: none of it is in the window.
		{ label: "Skills", full: 1700, light: 0 },
	]);
	expect(contextRows(null, light).map((r) => r.full)).toEqual([null, null, null]);
	expect(contextRows(null, null)).toEqual([]);
});

test("a row only one side has (an MCP row, say) is listed once", () => {
	const rows = contextRows(breakdown([["MCP tools", 900]]), breakdown([["System prompt", 100]]));
	expect(rows).toEqual([
		{ label: "MCP tools", full: 900, light: 0 },
		{ label: "System prompt", full: 0, light: 100 },
	]);
});

test("skills are typed as names or patterns separated by commas", () => {
	expect(parseList("reverse-engineer-anything, git-*,docker , ,git-*")).toEqual([
		"reverse-engineer-anything",
		"git-*",
		"docker",
	]);
	expect(parseList("")).toEqual([]);
	expect(parseList(" , ")).toEqual([]);
});
