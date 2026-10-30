import "./browser-globals.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DEFAULT_PANES } from "../../shared/panes.ts";
import { type Box, dropTargetAt, type RowGeometry, slotAt, type ZoneGeometry } from "../../web/src/lib/pane-drag.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

beforeAll(installGlobals);
afterAll(restoreGlobals);

/** A row of `n` tabs, 60 px wide with 2 px between, from x = 4: the box of a row whose tabs are `top`…`bottom`. */
function row(pane: "top" | "bottom", n: number, y: number, height: number): RowGeometry {
	const tabs: Box[] = Array.from({ length: n }, (_, i) => ({
		left: 4 + i * 62,
		right: 64 + i * 62,
		top: y + (height - 24) / 2,
		bottom: y + (height + 24) / 2,
	}));
	return { pane, box: { left: 0, top: y, right: 400, bottom: y + height }, tabs };
}

// The default layout: five tabs above, four below.
const TOP = row("top", 5, 0, 52);
const BOTTOM = row("bottom", 4, 300, 40);

describe("the slot a pointer is over", () => {
	test("is the number of tabs whose centre is left of the pointer", () => {
		const centres = [34, 96, 158];
		expect(slotAt(centres, -5)).toBe(0);
		expect(slotAt(centres, 34)).toBe(0);
		expect(slotAt(centres, 40)).toBe(1);
		expect(slotAt(centres, 100)).toBe(2);
		expect(slotAt(centres, 900)).toBe(3);
		expect(slotAt([], 10)).toBe(0);
	});
});

describe("where a drop would put the tab", () => {
	const at = (tab: Parameters<typeof dropTargetAt>[1], x: number, y: number, zones: ZoneGeometry[] = []) =>
		dropTargetAt(DEFAULT_PANES, tab, x, y, [TOP, BOTTOM], zones);

	test("along its own row, between the tabs on either side of the pointer", () => {
		const target = at("jobs", 10, 26);
		expect(target).toMatchObject({ pane: "top", slot: 0 });
		// Before the first tab: a line just left of it, as tall as a tab.
		expect(target?.marker).toEqual({ x: 3, top: TOP.tabs[0]?.top ?? 0, bottom: TOP.tabs[0]?.bottom ?? 0 });
		expect(at("jobs", 395, 26)).toMatchObject({ pane: "top", slot: 5, marker: { x: (TOP.tabs[4]?.right ?? 0) + 1 } });
	});

	test("nothing where the tab would stay put: the slots at and after it", () => {
		// Jobs is the third tab: its own centre and the gap after it leave it where it is.
		expect(at("jobs", 150, 26)).toBeNull();
		expect(at("jobs", 160, 26)).toBeNull();
		expect(at("jobs", 200, 26)).toBeNull();
		expect(at("jobs", 70, 26)).not.toBeNull();
	});

	test("onto the other pane's row, at the gap the pointer is in", () => {
		const target = at("agents", 100, 320);
		expect(target).toMatchObject({ pane: "bottom", slot: 2 });
		// Between the second and third tab of the lower row.
		expect(target?.marker?.x).toBe(((BOTTOM.tabs[1]?.right ?? 0) + (BOTTOM.tabs[2]?.left ?? 0)) / 2);
		expect(at("files", 10, 20)).toMatchObject({ pane: "top", slot: 0 });
	});

	test("nothing off the rows", () => {
		expect(at("agents", 100, 150)).toBeNull();
		expect(at("agents", 500, 320)).toBeNull();
		expect(at("agents", 100, 345)).toBeNull();
	});

	test("the edge of a closed pane takes the tab, and is its own mark", () => {
		const top: ZoneGeometry = { pane: "top", box: { left: 4, top: 0, right: 396, bottom: 14 } };
		const lower = row("bottom", 9, 0, 52);
		// Above the tabs, even off the top of the window.
		expect(dropTargetAt(DEFAULT_PANES, "files", 100, 6, [lower], [top])).toEqual({
			pane: "top",
			slot: 0,
			marker: null,
		});
		expect(dropTargetAt(DEFAULT_PANES, "files", 100, -40, [lower], [top])).toEqual({
			pane: "top",
			slot: 0,
			marker: null,
		});
		// Among the tabs, a row is a row: reordering the lone pane is not taken over by the zone.
		expect(dropTargetAt(DEFAULT_PANES, "info", 10, 26, [lower], [top])).toMatchObject({ pane: "bottom", slot: 0 });

		const bottom: ZoneGeometry = { pane: "bottom", box: { left: 4, top: 700, right: 396, bottom: 740 } };
		expect(dropTargetAt(DEFAULT_PANES, "agents", 100, 720, [TOP], [bottom])).toEqual({
			pane: "bottom",
			slot: 0,
			marker: null,
		});
		expect(dropTargetAt(DEFAULT_PANES, "agents", 100, 900, [TOP], [bottom])).toEqual({
			pane: "bottom",
			slot: 0,
			marker: null,
		});
		expect(dropTargetAt(DEFAULT_PANES, "agents", 100, 600, [TOP], [bottom])).toBeNull();
		// Outside the panel's width it is not the zone.
		expect(dropTargetAt(DEFAULT_PANES, "agents", 500, 720, [TOP], [bottom])).toBeNull();
	});
});
