import "./browser-globals.ts";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	DEFAULT_PANES,
	DEFAULT_ROWS,
	PANEL_TABS,
	PANES,
	type PaneLayout,
	type PanelTab,
	type PaneRows,
	parsePanes,
	SPLIT_BOUNDS,
	serializePanes,
} from "../../shared/panes.ts";
import { isValidPref, PREF } from "../../shared/prefs.ts";
import {
	chooseSheetTab,
	isShown,
	MIN_BODY,
	moveAcross,
	moveBy,
	pick,
	place,
	ROW_HEIGHT,
	shareBounds,
	sheetTabOf,
	toggleFold,
} from "../../web/src/lib/panel-panes.ts";
import { installGlobals, restoreGlobals } from "./browser-globals.ts";

beforeAll(installGlobals);
afterAll(restoreGlobals);

const layout = (over: Partial<PaneLayout> = {}): PaneLayout => ({ ...DEFAULT_PANES, ...over });
const rowsOf = (top: PanelTab[], bottom: PanelTab[]): PaneRows => ({ top, bottom });

/** Every tab of the panel is in one row, once; a pane shows a tab of its own row (none when it has none); no closed pane is folded. */
function whole(l: PaneLayout, why = ""): void {
	expect([...l.rows.top, ...l.rows.bottom].sort(), why).toEqual([...PANEL_TABS].sort());
	for (const pane of PANES) {
		const row = l.rows[pane];
		if (row.length === 0) expect(l.shown[pane], why).toBeNull();
		else expect(row, why).toContain(l.shown[pane] as PanelTab);
	}
	if (l.rows.top.length === 0 || l.rows.bottom.length === 0) expect(l.collapsed, why).toBeNull();
}

/** A layout with every tab in one pane: the other is closed. */
const allIn = (pane: "top" | "bottom"): PaneLayout =>
	pane === "top"
		? { ...DEFAULT_PANES, rows: rowsOf([...PANEL_TABS], []), shown: { top: "agents", bottom: null } }
		: { ...DEFAULT_PANES, rows: rowsOf([], [...PANEL_TABS]), shown: { top: null, bottom: "agents" } };

const LAYOUTS: [string, PaneLayout][] = [
	["the default", layout()],
	["a pane folded", layout({ collapsed: "top" })],
	[
		"rows moved about",
		layout({
			rows: rowsOf(
				["info", "files", "agents", "guidance"],
				["btw", "todos", "jobs", "tree", "issues", "ci", "host", "terminal", "questions", "worktrees"],
			),
			shown: { top: "files", bottom: "tree" },
		}),
	],
	[
		"a row of one tab",
		layout({
			rows: rowsOf(
				["agents"],
				PANEL_TABS.filter((t) => t !== "agents"),
			),
			shown: { top: "agents", bottom: "todos" },
			collapsed: "bottom",
		}),
	],
	["the top pane closed", allIn("bottom")],
	["the bottom pane closed", allIn("top")],
];

describe("every tab is in one row", () => {
	test("the default rows list every tab of the panel exactly once, and each pane shows a tab of its row", () => {
		// A tab added to PANEL_TABS and not to DEFAULT_ROWS would be listed in no row of a layout nobody has changed.
		whole(DEFAULT_PANES);
		expect([...DEFAULT_ROWS.top, ...DEFAULT_ROWS.bottom].sort()).toEqual([...PANEL_TABS].sort());
		expect(DEFAULT_PANES.shown).toEqual({ top: "agents", bottom: "files" });
	});

	test("the default is agents, todos, jobs, tree, info, guidance and questions above, and files, issues, CI, ask, host and terminal below", () => {
		expect(DEFAULT_ROWS.top).toEqual(["agents", "todos", "jobs", "tree", "info", "guidance", "questions"]);
		expect(DEFAULT_ROWS.bottom).toEqual(["files", "issues", "ci", "btw", "host", "terminal", "worktrees"]);
	});

	test("no move leaves a tab listed twice or in no row", () => {
		for (const [name, l] of LAYOUTS) {
			whole(l, name);
			for (const tab of PANEL_TABS) {
				whole(pick(l, tab), `${name}: pick ${tab}`);
				whole(moveBy(l, tab, -1), `${name}: ${tab} left`);
				whole(moveBy(l, tab, 1), `${name}: ${tab} right`);
				whole(moveAcross(l, tab), `${name}: ${tab} across`);
				for (const pane of PANES) {
					for (let slot = -1; slot <= PANEL_TABS.length + 1; slot++) {
						const next = place(l, tab, pane, slot);
						whole(next, `${name}: ${tab} to ${pane} at ${slot}`);
						expect(next.rows[pane]).toContain(tab);
					}
				}
			}
		}
	});
});

describe("picking a tab", () => {
	test("shows it in the pane that lists it and leaves the other pane alone", () => {
		expect(pick(layout(), "info")).toEqual(layout({ shown: { top: "info", bottom: "files" } }));
		expect(pick(layout(), "btw")).toEqual(layout({ shown: { top: "agents", bottom: "btw" } }));
	});

	test("changes nothing when the tab is already shown, so no write follows", () => {
		const before = layout({ shown: { top: "info", bottom: "files" } });
		expect(pick(before, "info")).toBe(before);
	});

	test("opens a folded pane, and leaves the fold of the other pane", () => {
		expect(pick(layout({ collapsed: "top" }), "info").collapsed).toBeNull();
		expect(pick(layout({ collapsed: "top" }), "agents").collapsed).toBeNull();
		expect(pick(layout({ collapsed: "top" }), "btw").collapsed).toBe("top");
	});

	test("never moves a tab to the other pane's row: a tab is shown only where it is listed", () => {
		for (const tab of PANEL_TABS) {
			const next = pick(layout(), tab);
			expect(next.rows).toEqual(layout().rows);
		}
	});
});

describe("moving a tab along its row", () => {
	test("a tab goes to the left or the right, and a tab at the end of the row stays", () => {
		expect(moveBy(layout(), "todos", -1).rows.top).toEqual([
			"todos",
			"agents",
			"jobs",
			"tree",
			"info",
			"guidance",
			"questions",
		]);
		expect(moveBy(layout(), "todos", 1).rows.top).toEqual([
			"agents",
			"jobs",
			"todos",
			"tree",
			"info",
			"guidance",
			"questions",
		]);
		const edge = layout();
		expect(moveBy(edge, "agents", -1)).toBe(edge);
		expect(moveBy(edge, "worktrees", 1)).toBe(edge);
	});

	test("what each pane shows and the fold stay as they were, whichever tab moves", () => {
		const before = layout({ shown: { top: "jobs", bottom: "btw" }, collapsed: "bottom", split: 0.3 });
		const after = place(before, "agents", "top", 7);
		expect(after.rows.top).toEqual(["todos", "jobs", "tree", "info", "guidance", "questions", "agents"]);
		expect({ ...after, rows: before.rows }).toEqual(before);
	});

	test("a slot beside the tab itself leaves the layout as it is (the same object, so no write follows)", () => {
		const before = layout();
		expect(place(before, "jobs", "top", 2)).toBe(before);
		expect(place(before, "jobs", "top", 3)).toBe(before);
		expect(place(before, "jobs", "top", 0).rows.top).toEqual([
			"jobs",
			"agents",
			"todos",
			"tree",
			"info",
			"guidance",
			"questions",
		]);
		expect(place(before, "jobs", "top", 7).rows.top).toEqual([
			"agents",
			"todos",
			"tree",
			"info",
			"guidance",
			"questions",
			"jobs",
		]);
	});
});

describe("moving a tab to the other pane", () => {
	test("it goes in at the slot and is shown there", () => {
		const next = place(layout(), "info", "bottom", 1);
		expect(next.rows).toEqual(
			rowsOf(
				["agents", "todos", "jobs", "tree", "guidance", "questions"],
				["files", "info", "issues", "ci", "btw", "host", "terminal", "worktrees"],
			),
		);
		expect(next.shown.bottom).toBe("info");
		// The pane it left showed Agents: that stays.
		expect(next.shown.top).toBe("agents");
	});

	test("the pane it left shows the tab that took its place, the one before it when it was last", () => {
		const shownTodos = layout({ shown: { top: "todos", bottom: "files" } });
		expect(moveAcross(shownTodos, "todos").shown.top).toBe("jobs");
		const last = layout({ shown: { top: "questions", bottom: "files" } });
		expect(moveAcross(last, "questions").shown.top).toBe("guidance");
	});

	test("moveAcross puts the tab at the end of the other row", () => {
		expect(moveAcross(layout(), "agents").rows.bottom).toEqual([
			"files",
			"issues",
			"ci",
			"btw",
			"host",
			"terminal",
			"worktrees",
			"agents",
		]);
		expect(moveAcross(layout(), "host").rows.top).toEqual([
			"agents",
			"todos",
			"jobs",
			"tree",
			"info",
			"guidance",
			"questions",
			"host",
		]);
	});

	test("a folded pane it goes to is opened, and one it leaves stays folded", () => {
		expect(moveAcross(layout({ collapsed: "bottom" }), "agents").collapsed).toBeNull();
		expect(moveAcross(layout({ collapsed: "top" }), "agents").collapsed).toBe("top");
	});

	test("a pane left with no tab is closed, and is not folded", () => {
		let l = layout({
			rows: rowsOf(
				["agents"],
				PANEL_TABS.filter((t) => t !== "agents"),
			),
			shown: { top: "agents", bottom: "files" },
		});
		l = moveAcross({ ...l, collapsed: "top" }, "agents");
		expect(l.rows.top).toEqual([]);
		expect(l.shown.top).toBeNull();
		expect(l.collapsed).toBeNull();
		expect(l.shown.bottom).toBe("agents");
	});

	test("a closed pane is opened by a tab put in it", () => {
		const closed = allIn("top");
		const opened = place(closed, "files", "bottom", 0);
		expect(opened.rows.bottom).toEqual(["files"]);
		expect(opened.shown.bottom).toBe("files");
		expect(opened.collapsed).toBeNull();
		expect(opened.rows.top).not.toContain("files");
	});
});

describe("folding", () => {
	test("a pane folds and opens again", () => {
		expect(toggleFold(layout(), "bottom").collapsed).toBe("bottom");
		expect(toggleFold(layout({ collapsed: "bottom" }), "bottom").collapsed).toBeNull();
	});

	test("at most one pane is folded: folding the other opens this one", () => {
		expect(toggleFold(layout({ collapsed: "bottom" }), "top").collapsed).toBe("top");
	});

	test("a pane that is the whole panel does not fold", () => {
		const alone = allIn("top");
		expect(toggleFold(alone, "top")).toBe(alone);
		const other = allIn("bottom");
		expect(toggleFold(other, "bottom")).toBe(other);
	});
});

describe("on show", () => {
	test("a tab is on show when its pane shows it and is not folded", () => {
		expect(isShown(layout(), "agents")).toBe(true);
		expect(isShown(layout(), "files")).toBe(true);
		expect(isShown(layout(), "todos")).toBe(false);
		expect(isShown(layout({ collapsed: "bottom" }), "files")).toBe(false);
		expect(isShown(layout({ collapsed: "bottom" }), "agents")).toBe(true);
	});
});

describe("the sheet", () => {
	test("shows the top pane's tab until one is chosen in it, and a choice leaves the layout as it is", () => {
		const before = layout({ shown: { top: "jobs", bottom: "host" } });
		expect(sheetTabOf(before)).toBe("jobs");
		expect(sheetTabOf({ ...before, shown: { top: null, bottom: "host" } })).toBe("host");
		// A tab of the bottom row, which the top pane could never show.
		chooseSheetTab("btw");
		expect(sheetTabOf(before)).toBe("btw");
		expect(before.rows).toEqual(DEFAULT_PANES.rows);
	});
});

describe("the divider's reach", () => {
	test("each pane keeps its row and room for a few rows of its tab", () => {
		const { min, max } = shareBounds(900);
		expect(min * 900).toBeGreaterThanOrEqual(ROW_HEIGHT.top + MIN_BODY - 1e-6);
		expect((1 - max) * 900).toBeGreaterThanOrEqual(ROW_HEIGHT.bottom + MIN_BODY - 1e-6);
	});

	test("a tall panel is held by the bounds of the share, a short one by the panes' own room", () => {
		expect(shareBounds(3000)).toEqual({ min: SPLIT_BOUNDS.min, max: SPLIT_BOUNDS.max });
		const short = shareBounds(400);
		expect(short.min).toBeGreaterThan(SPLIT_BOUNDS.min);
		expect(short.max).toBeLessThan(SPLIT_BOUNDS.max);
	});

	test("a panel too short for both splits at the middle, and one not measured yet keeps the bounds", () => {
		expect(shareBounds(200)).toEqual({ min: 0.5, max: 0.5 });
		expect(shareBounds(0)).toEqual({ min: SPLIT_BOUNDS.min, max: SPLIT_BOUNDS.max });
	});
});

describe("what is kept", () => {
	test("the default layout is kept as nothing, and anything else whole, with its version and rows", () => {
		expect(serializePanes(DEFAULT_PANES)).toBeNull();
		expect(JSON.parse(serializePanes(layout({ shown: { top: "agents", bottom: "info" } })) ?? "null")).toEqual({
			version: 2,
			rows: DEFAULT_ROWS,
			top: "agents",
			bottom: "info",
		});
		expect(JSON.parse(serializePanes(layout({ collapsed: "top", split: 0.35 })) ?? "null")).toEqual({
			version: 2,
			rows: DEFAULT_ROWS,
			top: "agents",
			bottom: "files",
			collapsed: "top",
			split: 0.35,
		});
	});

	test("a pane with no tab is kept without a tab to show, as the first version's pages would not read it", () => {
		const kept = JSON.parse(serializePanes(allIn("top")) ?? "null");
		expect(kept.rows).toEqual({ top: [...PANEL_TABS], bottom: [] });
		expect(kept.top).toBe("agents");
		expect("bottom" in kept).toBe(false);
	});

	test("what is written is read back as it was", () => {
		for (const [name, l] of LAYOUTS) {
			if (name === "the default") continue;
			expect(parsePanes(serializePanes(l)), name).toEqual(l);
		}
		for (const l of [
			layout({ split: 0.9 }),
			layout({ split: 0.1, collapsed: "top", shown: { top: "info", bottom: "btw" } }),
		]) {
			expect(parsePanes(serializePanes(l))).toEqual(l);
		}
		expect(parsePanes(null)).toBeNull();
	});

	test("the first version's pages read the tabs a pane shows from a value of this version", () => {
		const kept = serializePanes(layout({ shown: { top: "info", bottom: "btw" } })) ?? "";
		const { top, bottom } = JSON.parse(kept);
		expect({ top, bottom }).toEqual({ top: "info", bottom: "btw" });
	});

	test("anything the page does not write is not a layout", () => {
		const rows = '"rows":{"top":["agents"],"bottom":["files"]}';
		const bad = [
			"",
			"nope",
			"[]",
			"null",
			"3",
			'{"top":"agents"}',
			'{"top":"agents","bottom":"agents"}',
			'{"top":"agents","bottom":"settings"}',
			'{"top":1,"bottom":"todos"}',
			'{"top":"agents","bottom":"todos","collapsed":"left"}',
			'{"top":"agents","bottom":"todos","collapsed":true}',
			'{"top":"agents","bottom":"todos","split":"half"}',
			'{"top":"agents","bottom":"todos","split":0}',
			'{"top":"agents","bottom":"todos","split":0.95}',
			'{"top":"agents","bottom":"todos","split":null}',
			// Version 2: a version the page does not know, rows that are not rows, values that are not valid.
			`{"version":1,"top":"agents","bottom":"todos"}`,
			`{"version":3,${rows}}`,
			`{"version":"2",${rows}}`,
			'{"version":2}',
			'{"version":2,"rows":[]}',
			'{"version":2,"rows":"agents"}',
			'{"version":2,"rows":{"top":["agents"]}}',
			'{"version":2,"rows":{"top":"agents","bottom":[]}}',
			`{"version":2,${rows},"collapsed":"left"}`,
			`{"version":2,${rows},"split":0.95}`,
			`{"version":2,${rows},"top":5}`,
		];
		for (const value of bad) expect(parsePanes(value), value).toBeNull();
	});

	test("the server takes a layout the page writes (either version) and refuses the rest", () => {
		expect(isValidPref(PREF.panelPanes, '{"top":"info","bottom":"jobs","collapsed":"bottom","split":0.4}')).toBe(true);
		expect(isValidPref(PREF.panelPanes, serializePanes(allIn("bottom")) ?? "")).toBe(true);
		expect(isValidPref(PREF.panelPanes, '{"top":"info","bottom":"info"}')).toBe(false);
		expect(isValidPref(PREF.panelPanes, '{"version":2,"rows":"all"}')).toBe(false);
		expect(isValidPref(PREF.panelPanes, "wide")).toBe(false);
	});
});

describe("a layout stored before the rows (version 1)", () => {
	const v1 = (stored: Record<string, unknown>) => parsePanes(JSON.stringify(stored));

	test("keeps the tab each pane showed in that pane's row, and the rest follow the default rows", () => {
		// The pair the panel opened with: Todos was the lower pane's, and is the lower row's now.
		const first = v1({ top: "agents", bottom: "todos" });
		expect(first?.rows).toEqual(
			rowsOf(
				["agents", "jobs", "tree", "info", "guidance", "questions"],
				["files", "issues", "ci", "btw", "host", "terminal", "worktrees", "todos"],
			),
		);
		expect(first?.shown).toEqual({ top: "agents", bottom: "todos" });
		// A tab from the other default row is put at the end of the row of the pane that showed it.
		const second = v1({ top: "info", bottom: "jobs", collapsed: "bottom", split: 0.4 });
		expect(second?.rows).toEqual(
			rowsOf(
				["agents", "todos", "tree", "info", "guidance", "questions"],
				["files", "issues", "ci", "btw", "host", "terminal", "worktrees", "jobs"],
			),
		);
		expect(second).toMatchObject({ shown: { top: "info", bottom: "jobs" }, collapsed: "bottom", split: 0.4 });
	});

	test("a tab that is already in its pane's default row keeps its place there", () => {
		const l = v1({ top: "tree", bottom: "btw" });
		expect(l?.rows).toEqual(DEFAULT_ROWS);
		expect(l?.shown).toEqual({ top: "tree", bottom: "btw" });
	});

	test("two tabs that swap sides both move", () => {
		const l = v1({ top: "files", bottom: "agents" });
		expect(l?.rows).toEqual(
			rowsOf(
				["todos", "jobs", "tree", "info", "guidance", "questions", "files"],
				["issues", "ci", "btw", "host", "terminal", "worktrees", "agents"],
			),
		);
		expect(l?.shown).toEqual({ top: "files", bottom: "agents" });
	});

	test("lists every tab once, whichever pair was kept", () => {
		for (const top of PANEL_TABS) {
			for (const bottom of PANEL_TABS) {
				if (top === bottom) continue;
				const l = v1({ top, bottom });
				expect(l).not.toBeNull();
				if (l) {
					whole(l, `${top}/${bottom}`);
					expect(l.rows.top).toContain(top);
					expect(l.rows.bottom).toContain(bottom);
				}
			}
		}
	});

	test("keeps the fold and the divider, and is written as version 2 once the layout changes", () => {
		const l = v1({ top: "info", bottom: "todos", collapsed: "top", split: 0.25 });
		expect(l).toMatchObject({ collapsed: "top", split: 0.25 });
		expect(JSON.parse(serializePanes(l as PaneLayout) ?? "null")).toMatchObject({
			version: 2,
			collapsed: "top",
			split: 0.25,
		});
	});
});

describe("a layout of version 2 that does not match the tabs of this page", () => {
	const v2 = (stored: Record<string, unknown>) => parsePanes(JSON.stringify({ version: 2, ...stored }));

	test("a tab it does not list (one a later version added) goes at the end of its default pane's row", () => {
		const l = v2({ rows: { top: ["info", "agents"], bottom: ["files"] } });
		expect(l?.rows).toEqual(
			rowsOf(
				["info", "agents", "todos", "jobs", "tree", "guidance", "questions"],
				["files", "issues", "ci", "btw", "host", "terminal", "worktrees"],
			),
		);
		if (l) whole(l);
		// Only the tabs it lists are the user's to place: a pane the user emptied gets nothing back that it has listed elsewhere.
		const emptied = v2({ rows: { top: [], bottom: [...PANEL_TABS] } });
		expect(emptied?.rows).toEqual(rowsOf([], [...PANEL_TABS]));
		expect(emptied?.shown).toEqual({ top: null, bottom: "agents" });
	});

	test("a layout stored before the Guidance, Questions, Worktrees and CI tabs (#704, #693, #698) gets each at the end of its default row, where the rest stay as they were", () => {
		const l = v2({
			rows: {
				top: ["jobs", "agents", "todos", "tree", "info"],
				bottom: ["files", "issues", "btw", "host", "terminal"],
			},
			top: "info",
			bottom: "files",
		});
		expect(l?.rows).toEqual(
			rowsOf(
				["jobs", "agents", "todos", "tree", "info", "guidance", "questions"],
				["files", "issues", "btw", "host", "terminal", "ci", "worktrees"],
			),
		);
		expect(l?.shown).toEqual({ top: "info", bottom: "files" });
		if (l) whole(l);
	});

	test("ids it does not know are dropped, and a tab listed twice keeps its first place", () => {
		const l = v2({
			rows: {
				top: ["agents", "nope", 7, null, "info", "agents"],
				bottom: ["info", "files", "todos", "jobs", "issues", "btw", "host", "tree"],
			},
		});
		expect(l?.rows).toEqual(
			rowsOf(
				["agents", "info", "guidance", "questions"],
				["files", "todos", "jobs", "issues", "btw", "host", "tree", "ci", "terminal", "worktrees"],
			),
		);
		if (l) whole(l);
	});

	test("the tab a pane shows is one of its own row, else the first of it", () => {
		const rows = { top: ["info", "agents", "todos", "jobs", "tree"], bottom: ["files", "issues", "btw", "host"] };
		expect(v2({ rows, top: "todos", bottom: "host" })?.shown).toEqual({ top: "todos", bottom: "host" });
		// Files is the bottom row's, and a stale or unknown name has no place in the top one.
		expect(v2({ rows, top: "files", bottom: "nope" })?.shown).toEqual({ top: "info", bottom: "files" });
		expect(v2({ rows })?.shown).toEqual({ top: "info", bottom: "files" });
	});

	test("no pane is folded while the other is closed", () => {
		const l = v2({ rows: { top: [], bottom: [...PANEL_TABS] }, collapsed: "bottom" });
		expect(l?.collapsed).toBeNull();
	});
});
