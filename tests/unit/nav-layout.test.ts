import "./browser-globals.ts";
import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import {
	defaultNavLayout,
	NAV_GROUPS,
	NAV_ITEM_IDS,
	NAV_ITEMS,
	NAV_LAYOUT_KEY,
	NAV_SURFACES,
	type NavLayout,
	navItemsIn,
	navLayout,
	parseNavLayout,
	reloadNavLayout,
	serializeNavLayout,
	setNavLayout,
} from "../../web/src/lib/nav-layout.ts";
import {
	findNavItem,
	moveNavItem,
	nudgeNavItem,
	resetNavLayout,
	withNavItemMoved,
} from "../../web/src/lib/nav-layout-edit.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

beforeAll(installGlobals);
afterAll(restoreGlobals);
beforeEach(() => {
	localStorage.setItem(NAV_LAYOUT_KEY, "");
	reloadNavLayout();
});

/** Every item of every surface is in exactly one group, once. */
function expectWhole(layout: NavLayout) {
	for (const surface of NAV_SURFACES) {
		const all = NAV_GROUPS.flatMap((g) => layout[surface][g]);
		expect([...all].sort()).toEqual([...NAV_ITEM_IDS].sort());
	}
}

test("the model is one list: every id has an item, in the order the palette shows", () => {
	expect(NAV_ITEMS.map((i) => i.id)).toEqual([...NAV_ITEM_IDS]);
	expect(NAV_ITEMS.find((i) => i.id === "guard")?.remoteHidden).toBe(true);
	expect(NAV_ITEMS.filter((i) => i.remoteHidden).map((i) => i.id)).toEqual(["guard"]);
});

test("the defaults offer every page once per bar, with no page in two groups, and the guard is among them", () => {
	const layout = defaultNavLayout();
	expectWhole(layout);
	for (const surface of NAV_SURFACES) {
		const { top, bottom, hidden } = layout[surface];
		expect(top.filter((id) => bottom.includes(id))).toEqual([]);
		expect(hidden).toEqual([]);
		expect(bottom).toContain("guard");
	}
	// The shipped order of the pages is kept, the agent graph (#719) first and the guard last.
	expect(layout.sidebar.bottom).toEqual(["agents", "usage", "plugins", "settings", "guard"]);
	// A default is a copy: changing it does not change the next one.
	layout.sidebar.top.push("usage");
	expect(defaultNavLayout().sidebar.top).toEqual([]);
});

test("nothing stored is the defaults; an unreadable copy is too", () => {
	expect(parseNavLayout(null)).toEqual(defaultNavLayout());
	expect(parseNavLayout("")).toEqual(defaultNavLayout());
	expect(parseNavLayout("{not json")).toEqual(defaultNavLayout());
	expect(parseNavLayout("[]")).toEqual(defaultNavLayout());
	expect(parseNavLayout('"text"')).toEqual(defaultNavLayout());
	expect(parseNavLayout("null")).toEqual(defaultNavLayout());
});

test("a stored layout round-trips", () => {
	const layout = withNavItemMoved(defaultNavLayout(), "rail", "settings", { group: "top", index: 0 });
	expect(parseNavLayout(serializeNavLayout(layout))).toEqual(layout);
});

test("an item this version does not know (removed, or from a newer one) is dropped, the rest keep their place", () => {
	const raw = JSON.stringify({
		v: 99,
		sidebar: { top: ["settings", "weather", 3, null], bottom: ["usage", "memory"], hidden: ["cli", "nonsense"] },
		rail: { top: [], bottom: ["guard", "cli"], hidden: [] },
	});
	const layout = parseNavLayout(raw);
	expect(layout.sidebar.top).toEqual(["settings"]);
	// `cli` (Commands & terminal, now a page of Settings) is read as the Plugins page that took its place.
	expect(layout.sidebar.hidden).toEqual(["plugins"]);
	// `memory` (Memory, now a page of Settings) is dropped wherever it was.
	expect(layout.sidebar.bottom.slice(0, 1)).toEqual(["usage"]);
	expect(layout.sidebar.bottom).not.toContain("memory");
	expect(layout.rail.bottom.slice(0, 2)).toEqual(["guard", "plugins"]);
	expectWhole(layout);
});

test("the Questions page an older copy names is left out wherever it was: it is a tab of the right panel now (#693)", () => {
	const raw = JSON.stringify({
		sidebar: { top: ["questions"], bottom: ["usage", "memory", "cli", "settings", "guard"], hidden: [] },
		rail: { top: [], bottom: ["usage", "memory", "questions", "cli", "settings", "guard"], hidden: [] },
	});
	const layout = parseNavLayout(raw);
	expect(layout.sidebar.top).toEqual([]);
	// The agent graph, which the copy does not name, comes in after what is there.
	expect(layout.rail.bottom).toEqual(["usage", "plugins", "settings", "guard", "agents"]);
	expectWhole(layout);
});

test("Commands & terminal an older copy names becomes Plugins in its place, never twice", () => {
	const raw = JSON.stringify({
		v: 1,
		sidebar: { top: ["cli"], bottom: ["agents", "usage", "memory", "settings", "guard"], hidden: [] },
		rail: { top: [], bottom: ["agents", "usage"], hidden: ["memory", "cli", "settings"] },
	});
	const layout = parseNavLayout(raw);
	expect(layout.sidebar.top).toEqual(["plugins"]);
	expect(layout.sidebar.bottom).toEqual(["agents", "usage", "settings", "guard"]);
	expect(layout.rail.hidden).toEqual(["plugins", "settings"]);
	expectWhole(layout);
	// A copy that names both (written by this version after an older one): the first place wins, there is one item.
	const both = parseNavLayout(
		JSON.stringify({ sidebar: { top: ["plugins"], bottom: ["cli", "usage"], hidden: ["cli"] }, rail: {} }),
	);
	expect(both.sidebar.top).toEqual(["plugins"]);
	expect(both.sidebar.bottom).not.toContain("plugins");
	expect(both.sidebar.hidden).toEqual([]);
	expectWhole(both);
	// What is written again names `plugins`, and the version that does.
	const written = JSON.parse(serializeNavLayout(layout));
	expect(written.v).toBe(3);
	expect(JSON.stringify(written)).not.toContain('"cli"');
});

test("an item the stored copy does not name (a page added since) comes in at its default group, after what is there", () => {
	// A copy written before the guard and the agent graph existed: the person had moved Settings to the top of the sidebar.
	const raw = JSON.stringify({
		sidebar: { top: ["settings"], bottom: ["usage", "memory", "cli"], hidden: [] },
		rail: { top: [], bottom: ["usage", "memory", "cli", "settings"], hidden: [] },
	});
	const layout = parseNavLayout(raw);
	expect(layout.sidebar.top).toEqual(["settings"]);
	expect(layout.sidebar.bottom).toEqual(["usage", "plugins", "agents", "guard"]);
	expect(layout.rail.bottom).toEqual(["usage", "plugins", "settings", "agents", "guard"]);
	expectWhole(layout);
});

test("an item named twice is kept where it first appears, in group order", () => {
	const layout = parseNavLayout(
		JSON.stringify({
			sidebar: { top: ["usage", "usage"], bottom: ["usage", "plugins"], hidden: ["plugins"] },
			rail: {},
		}),
	);
	expect(layout.sidebar.top).toEqual(["usage"]);
	expect(layout.sidebar.bottom).not.toContain("usage");
	expect(layout.sidebar.bottom).toContain("plugins");
	expect(layout.sidebar.hidden).not.toContain("plugins");
	expectWhole(layout);
});

test("a surface or a group of the wrong shape falls back to its default", () => {
	const layout = parseNavLayout(JSON.stringify({ sidebar: "x", rail: { top: "usage", bottom: { 0: "cli" } } }));
	expect(layout).toEqual(defaultNavLayout());
});

test("a hidden item is not drawn, and a page that is not this computer's gets no guard", () => {
	const layout = withNavItemMoved(defaultNavLayout(), "sidebar", "usage", { group: "hidden" });
	const drawn = navItemsIn(layout, "sidebar", "bottom", { remote: false }).map((i) => i.id);
	expect(drawn).toEqual(["agents", "plugins", "settings", "guard"]);
	expect(navItemsIn(layout, "sidebar", "hidden", { remote: false }).map((i) => i.id)).toEqual(["usage"]);
	expect(navItemsIn(layout, "sidebar", "bottom", { remote: true }).map((i) => i.id)).toEqual([
		"agents",
		"plugins",
		"settings",
	]);
	// The other bar is not touched by it.
	expect(navItemsIn(layout, "rail", "bottom", { remote: false }).map((i) => i.id)).toContain("usage");
});

test("moving an item puts it in the group at the place, without repeating it, and leaves the other bar alone", () => {
	const start = defaultNavLayout();
	const up = withNavItemMoved(start, "sidebar", "settings", { group: "top", index: 0 });
	expect(up.sidebar.top).toEqual(["settings"]);
	expect(up.sidebar.bottom).toEqual(["agents", "usage", "plugins", "guard"]);
	expect(up.rail).toBe(start.rail);
	expectWhole(up);

	// Within a group the place is counted without the item itself.
	const within = withNavItemMoved(start, "sidebar", "usage", { group: "bottom", index: 2 });
	expect(within.sidebar.bottom).toEqual(["agents", "plugins", "usage", "settings", "guard"]);

	// No place, or one past the end: last. One before the start: first.
	expect(withNavItemMoved(start, "rail", "usage", { group: "hidden" }).rail.hidden).toEqual(["usage"]);
	expect(withNavItemMoved(start, "rail", "usage", { group: "bottom", index: 99 }).rail.bottom.at(-1)).toBe("usage");
	expect(withNavItemMoved(start, "rail", "guard", { group: "bottom", index: -4 }).rail.bottom[0]).toBe("guard");
	// The input is not changed.
	expect(start).toEqual(defaultNavLayout());
});

test("findNavItem says where an item is", () => {
	const layout = withNavItemMoved(defaultNavLayout(), "sidebar", "plugins", { group: "top" });
	expect(findNavItem(layout, "sidebar", "plugins")).toEqual({ group: "top", index: 0 });
	expect(findNavItem(layout, "sidebar", "guard")).toEqual({ group: "bottom", index: 3 });
	expect(findNavItem(layout, "rail", "plugins")).toEqual({ group: "bottom", index: 2 });
});

test("the layout in force is remembered on this device, read again by the next page, and each bar apart", () => {
	moveNavItem("rail", "plugins", { group: "top", index: 0 });
	moveNavItem("sidebar", "usage", { group: "hidden" });
	const stored = localStorage.getItem(NAV_LAYOUT_KEY);
	expect(stored).not.toBeNull();
	expect(parseNavLayout(stored)).toEqual(navLayout());
	expect(navLayout().rail.top).toEqual(["plugins"]);
	expect(navLayout().sidebar.top).toEqual([]);
	expect(navLayout().sidebar.hidden).toEqual(["usage"]);
	// A page loaded later reads the same.
	setNavLayout(parseNavLayout(stored));
	reloadNavLayout();
	expect(navLayout().rail.top).toEqual(["plugins"]);
});

test("one step up or down stays in its group, and does nothing at the edge", () => {
	nudgeNavItem("sidebar", "usage", -1);
	expect(navLayout().sidebar.bottom.slice(0, 2)).toEqual(["usage", "agents"]);
	nudgeNavItem("sidebar", "usage", -1);
	expect(navLayout().sidebar.bottom.slice(0, 2)).toEqual(["usage", "agents"]);
	nudgeNavItem("sidebar", "guard", 1);
	expect(navLayout().sidebar.bottom.at(-1)).toBe("guard");
	nudgeNavItem("sidebar", "settings", 1);
	expect(navLayout().sidebar.bottom.slice(-2)).toEqual(["guard", "settings"]);
});

test("Reset to default restores both bars, and what was stored", () => {
	moveNavItem("sidebar", "usage", { group: "top" });
	moveNavItem("rail", "plugins", { group: "hidden" });
	resetNavLayout();
	expect(navLayout()).toEqual(defaultNavLayout());
	expect(parseNavLayout(localStorage.getItem(NAV_LAYOUT_KEY))).toEqual(defaultNavLayout());
});
