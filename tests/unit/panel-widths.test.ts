import "./browser-globals.ts";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { CHAT_MIN, computeLayout, LIMITS } from "../../web/src/lib/panel-widths.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

beforeAll(installGlobals);
afterAll(restoreGlobals);

const both = { sidebar: true, panel: true };
const none = { sidebar: null, panel: null };

test("at the narrowest window that shows both columns the panel gives way first, then the sidebar, and the conversation keeps its minimum", () => {
	// 1024 - 480 leaves 544 for the two: the panel falls to its own minimum (280) and the sidebar takes the rest.
	const { width } = computeLayout(1024, both, none);
	expect(width).toEqual({ sidebar: 264, panel: LIMITS.panel.min });
	expect(1024 - width.sidebar - width.panel).toBe(CHAT_MIN);
	// A window with room for both defaults and the conversation draws the defaults.
	const room = LIMITS.sidebar.def + LIMITS.panel.def + CHAT_MIN;
	expect(computeLayout(room, both, none).width).toEqual({ sidebar: LIMITS.sidebar.def, panel: LIMITS.panel.def });
});

test("remembered widths are kept inside each column's own bounds", () => {
	const { width } = computeLayout(2400, both, { sidebar: 5000, panel: 10 });
	expect(width).toEqual({ sidebar: LIMITS.sidebar.max, panel: LIMITS.panel.min });
});

test("a narrower window takes the room from the panel first, then the sidebar, and widening gives it back", () => {
	const wide = { sidebar: 300, panel: 600 };
	expect(computeLayout(1400, both, wide).width).toEqual(wide);
	const narrow = computeLayout(1100, both, wide).width;
	expect(narrow.sidebar).toBe(300);
	expect(narrow.panel).toBe(1100 - CHAT_MIN - 300);
	const tiny = computeLayout(1000, both, wide).width;
	expect(tiny.sidebar + tiny.panel).toBeLessThanOrEqual(1000 - CHAT_MIN);
	expect(computeLayout(1400, both, wide).width).toEqual(wide);
});

test("the most a column can take leaves the conversation its minimum beside the other column", () => {
	const layout = computeLayout(1200, both, { sidebar: 300, panel: 400 });
	expect(layout.max.sidebar).toBe(1200 - CHAT_MIN - 400);
	expect(layout.max.panel).toBe(1200 - CHAT_MIN - 300);
	// A column that is not beside the conversation takes no room.
	expect(computeLayout(1200, { sidebar: true, panel: false }, { sidebar: 300, panel: 400 }).max.sidebar).toBe(
		LIMITS.sidebar.max,
	);
});
