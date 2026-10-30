import AxeBuilder from "@axe-core/playwright";
import { DEFAULT_ROWS, type PanelTab } from "../../shared/panes.ts";
import { PREF, type PrefsSnapshot } from "../../shared/prefs.ts";
import { FIXTURE } from "../support/fixtures.ts";
import { boxOf } from "../support/geometry.ts";
import { openSidebar, sessionRow, startLive } from "../support/live.ts";
import { COUNT_RENDERS, countRendersOf, painted, rendersCounted, settled } from "../support/render-count.ts";
import { rpcState } from "../support/rpc-state.ts";
import { type Msg, tapSocket } from "../support/socket-tap.ts";
import { sessionWithSubagents } from "../support/subagent-fixtures.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * The side panel is two panes (no model call): a divider that moves with the pointer and the keyboard, a tab row for each
 * pane that lists its own tabs and no other pane's (a tab is in one row only), tabs that are moved by dragging them or from
 * their context menu, a pane with no tab that closes and is opened again by a drop on its edge, a pane that folds to its row,
 * and the task strip and the jobs list that leave the composer's area while a pane shows them. What is chosen is remembered
 * across reloads, and a layout that the first version stored is migrated. A phone keeps the one pane.
 */

const pane = (page: Page, which: "top" | "bottom") => page.getByTestId(`panel-pane-${which}`);
const tabOf = (page: Page, which: "top" | "bottom", name: RegExp | string) =>
	pane(page, which).getByRole("tab", { name });
const divider = (page: Page) => page.getByTestId("resize-panes");
const ariaValue = async (el: Locator, name = "aria-valuenow") => Number(await el.getAttribute(name));
const heightOf = async (el: Locator) => (await boxOf(el)).height;

async function openChat(page: Page) {
	await page.goto("/");
	await openSidebar(page);
	await sessionRow(page, FIXTURE.gammaTitle).click();
	await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.gammaTitle);
	await page.getByTestId("toggle-panel").click();
	await expect(page.getByTestId("right-panel")).toBeVisible();
}

/** Open the panel again after a reload: the panel itself starts closed; what its panes hold is what was left. */
async function reopen(page: Page) {
	await page.reload();
	await openSidebar(page);
	await page.getByTestId("toggle-panel").click();
	await expect(page.getByTestId("right-panel")).toBeVisible();
}

/** Press on the divider, move the pointer down by `dy`, release. */
async function drag(page: Page, el: Locator, dy: number) {
	const box = await boxOf(el);
	const x = box.x + box.width / 2;
	const y = box.y + box.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x, y + dy / 2, { steps: 4 });
	await page.mouse.move(x, y + dy, { steps: 4 });
	await page.mouse.up();
}

const stored = (page: Page): Promise<PrefsSnapshot> => page.evaluate(() => fetch("/api/prefs").then((r) => r.json()));

/** The tabs a pane's row lists, left to right. */
const idsIn = (page: Page, which: "top" | "bottom") =>
	pane(page, which)
		.locator("[data-pane-tab]")
		.evaluateAll((els) => els.map((el) => el.getAttribute("data-pane-tab")));

const ALL: PanelTab[] = [...DEFAULT_ROWS.top, ...DEFAULT_ROWS.bottom];

/** A layout as the page keeps it (version 2). */
const keptLayout = (
	rows: { top: PanelTab[]; bottom: PanelTab[] },
	shown: { top?: PanelTab; bottom?: PanelTab },
	more: object = {},
) => JSON.stringify({ version: 2, rows, ...shown, ...more });

/** Start the page with `layout` as what the browser kept. */
const startWith = (page: Page, layout: string) =>
	page.addInitScript((kept) => {
		localStorage.setItem("ompw.panelPanes", kept);
		localStorage.setItem("ompw.autoTitle", "off");
	}, layout);

interface StoredPanes {
	version: number;
	rows: { top: string[]; bottom: string[] };
	top?: string;
	bottom?: string;
	collapsed?: string;
	split?: number;
}
const storedLayout = (page: Page): Promise<StoredPanes | null> =>
	stored(page).then((s) => JSON.parse(s.values[PREF.panelPanes] ?? "null"));

/**
 * Press on a tab and carry it to the point `to` gives, the button held (`page.mouse.up()` drops it). Pressing a tab picks it,
 * which can fit the row's labels again: the point is asked for once that has happened.
 */
async function carry(page: Page, tab: Locator, to: () => Promise<{ x: number; y: number }>) {
	const box = await boxOf(tab);
	await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
	await page.mouse.down();
	await expect(tab).toHaveAttribute("aria-selected", "true");
	const end = await to();
	await page.mouse.move(end.x, end.y, { steps: 12 });
}

/** A point on `tab`'s row just inside its left edge: a tab dropped there goes before it. */
const beforeTab = async (tab: Locator) => {
	const box = await boxOf(tab);
	return { x: box.x + 2, y: box.y + box.height / 2 };
};

test.describe("beside the conversation (1400 px)", () => {
	test.use({ viewport: { width: 1400, height: 900 } });

	test("the panel opens as two panes, Agents above and Files below, each with a row of its own tabs", async ({
		page,
	}) => {
		await openChat(page);
		await expect(pane(page, "top")).toHaveAttribute("data-tab", "agents");
		await expect(pane(page, "bottom")).toHaveAttribute("data-tab", "files");
		await expect(pane(page, "top").getByRole("tablist")).toBeVisible();
		await expect(pane(page, "bottom").getByRole("tablist")).toBeVisible();
		// A tab is in one row: seven above and six below, and none is listed twice.
		expect(await idsIn(page, "top")).toEqual(["agents", "todos", "jobs", "tree", "info", "guidance", "questions"]);
		expect(await idsIn(page, "bottom")).toEqual(["files", "issues", "btw", "host", "terminal", "worktrees"]);
		for (const id of ALL) await expect(page.getByTestId(`pane-tab-${id}`)).toHaveCount(1);
		await expect(tabOf(page, "top", /^Agents/)).toHaveAttribute("aria-selected", "true");
		await expect(tabOf(page, "bottom", /^Files/)).toHaveAttribute("aria-selected", "true");
		await expect(page.getByTestId("pane-body-top")).toBeVisible();
		await expect(page.getByTestId("pane-body-bottom")).toBeVisible();
		// Both are on screen at once, one above the other, and the divider is between them.
		const top = await boxOf(pane(page, "top"));
		const bottom = await boxOf(pane(page, "bottom"));
		const sep = await boxOf(divider(page));
		expect(top.y + top.height).toBeLessThanOrEqual(bottom.y + 1);
		expect(sep.y).toBeGreaterThan(top.y + top.height - sep.height);
		expect(sep.y + sep.height).toBeLessThan(bottom.y + 20);
		expect(Math.abs(top.height - bottom.height), "the default split is even").toBeLessThan(20);
	});

	test("each pane shows a tab of its own: picking one in the lower pane leaves the upper pane as it was", async ({
		page,
	}) => {
		await openChat(page);
		await tabOf(page, "bottom", "Ask").click();
		await expect(pane(page, "bottom")).toHaveAttribute("data-tab", "btw");
		await expect(pane(page, "bottom").getByTestId("btw-input")).toBeVisible();
		await expect(pane(page, "top")).toHaveAttribute("data-tab", "agents");
		await tabOf(page, "top", "Info").click();
		await expect(pane(page, "top").getByTestId("session-info")).toBeVisible();
		await expect(pane(page, "bottom").getByTestId("btw-input")).toBeVisible();
		await tabOf(page, "top", "Branches").click();
		await expect(pane(page, "top")).toContainText("No branches yet");
		await expect(pane(page, "bottom").getByTestId("btw-input")).toBeVisible();
	});

	test("a tab is shown in the pane that lists it: picking one never moves it, and the arrow keys pick along the row", async ({
		page,
	}) => {
		await openChat(page);
		await tabOf(page, "top", /^Todos/).click();
		await expect(pane(page, "top")).toHaveAttribute("data-tab", "todos");
		await expect(pane(page, "bottom")).toHaveAttribute("data-tab", "files");
		expect(await idsIn(page, "top")).toEqual(["agents", "todos", "jobs", "tree", "info", "guidance", "questions"]);
		expect(await idsIn(page, "bottom")).toEqual(["files", "issues", "btw", "host", "terminal", "worktrees"]);
		await tabOf(page, "bottom", "Ask").click();
		await expect(pane(page, "bottom")).toHaveAttribute("data-tab", "btw");
		await expect(pane(page, "top")).toHaveAttribute("data-tab", "todos");
		// Arrow keys on a tab row pick like a click does, and stay in the row: the last wraps to the first.
		await tabOf(page, "top", /^Todos/).focus();
		await page.keyboard.press("ArrowRight");
		await expect(pane(page, "top")).toHaveAttribute("data-tab", "jobs");
		await tabOf(page, "top", /^Questions/).focus();
		await page.keyboard.press("ArrowRight");
		await expect(pane(page, "top")).toHaveAttribute("data-tab", "agents");
	});

	test("the divider is a separator with a value: a drag moves it, and it is where it was left after a reload", async ({
		page,
	}) => {
		await openChat(page);
		const grip = divider(page);
		await expect(grip).toHaveAttribute("role", "separator");
		await expect(grip).toHaveAttribute("aria-orientation", "horizontal");
		await expect(grip).toHaveAttribute("aria-label", "Resize the panes");
		await expect(grip).toHaveAttribute("tabindex", "0");
		expect(await ariaValue(grip)).toBe(50);
		const top = pane(page, "top");
		const before = await heightOf(top);

		await drag(page, grip, 120);
		expect(await heightOf(top)).toBeCloseTo(before + 120, -0.5);
		expect(await ariaValue(grip)).toBeGreaterThan(50);
		const moved = await heightOf(top);
		const value = await ariaValue(grip);

		await reopen(page);
		expect(await heightOf(top)).toBeCloseTo(moved, -0.5);
		expect(await ariaValue(divider(page))).toBe(value);
		// Up again: the other way.
		await drag(page, divider(page), -200);
		expect(await heightOf(top)).toBeCloseTo(moved - 200, -0.5);
	});

	test("arrow keys, Home, End and Enter move the divider; double-click puts it back; all of it is kept", async ({
		page,
	}) => {
		await openChat(page);
		const grip = divider(page);
		const top = pane(page, "top");
		const start = await heightOf(top);
		await grip.focus();
		await page.keyboard.press("ArrowDown");
		expect(await heightOf(top)).toBeCloseTo(start + 16, -0.5);
		await page.keyboard.press("Shift+ArrowDown");
		expect(await heightOf(top)).toBeCloseTo(start + 16 + 64, -0.5);
		await page.keyboard.press("ArrowUp");
		expect(await heightOf(top)).toBeCloseTo(start + 64, -0.5);

		const min = await ariaValue(grip, "aria-valuemin");
		const max = await ariaValue(grip, "aria-valuemax");
		expect(min).toBeGreaterThanOrEqual(10);
		expect(max).toBeLessThanOrEqual(90);
		await page.keyboard.press("Home");
		expect(await ariaValue(grip)).toBe(min);
		await page.keyboard.press("End");
		expect(await ariaValue(grip)).toBe(max);
		// Each pane keeps room for a few rows, at either end.
		expect(await heightOf(pane(page, "bottom"))).toBeGreaterThanOrEqual(120);
		await page.keyboard.press("Home");
		expect(await heightOf(top)).toBeGreaterThanOrEqual(120);

		await page.keyboard.press("Home");
		await reopen(page);
		expect(await ariaValue(divider(page))).toBe(min);

		await divider(page).focus();
		await page.keyboard.press("Enter");
		expect(await ariaValue(divider(page))).toBe(50);
		await page.keyboard.press("ArrowDown");
		expect(await ariaValue(divider(page))).toBeGreaterThan(50);
		await divider(page).dblclick();
		expect(await ariaValue(divider(page))).toBe(50);
		expect(await heightOf(pane(page, "top"))).toBeCloseTo(start, -0.5);
		// Back at the default it is not kept as a position at all.
		await expect
			.poll(async () => JSON.parse((await stored(page)).values[PREF.panelPanes] ?? "{}").split)
			.toBeUndefined();
	});

	test("a drag cannot take the room a pane needs, and does not move the panel's width", async ({ page }) => {
		await openChat(page);
		const width = (await boxOf(page.getByTestId("right-panel"))).width;
		await drag(page, divider(page), 2000);
		expect(await heightOf(pane(page, "bottom"))).toBeGreaterThanOrEqual(120);
		await drag(page, divider(page), -3000);
		expect(await heightOf(pane(page, "top"))).toBeGreaterThanOrEqual(120);
		expect((await boxOf(page.getByTestId("right-panel"))).width).toBe(width);
	});

	test("a pane folds to its tab row and the other takes the height; both are remembered", async ({ page }) => {
		await openChat(page);
		const panel = await boxOf(page.getByTestId("right-panel"));
		const fold = page.getByTestId("pane-fold-bottom");
		await expect(fold).toHaveAttribute("aria-expanded", "true");
		await fold.click();
		await expect(fold).toHaveAttribute("aria-expanded", "false");
		await expect(fold).toHaveAccessibleName("Expand the bottom pane");
		await expect(pane(page, "bottom")).toHaveAttribute("data-collapsed", "true");
		await expect(page.getByTestId("pane-body-bottom")).toHaveCount(0);
		await expect(pane(page, "bottom").getByRole("tablist")).toBeVisible();
		await expect(divider(page)).toHaveCount(0);
		// The upper pane has all but the lower one's row.
		const rest = await boxOf(pane(page, "bottom"));
		expect(rest.height).toBeLessThan(50);
		expect(await heightOf(pane(page, "top"))).toBeGreaterThan(panel.height - 60 - 52 + 40);

		await reopen(page);
		await expect(pane(page, "bottom")).toHaveAttribute("data-collapsed", "true");
		await expect(page.getByTestId("pane-body-bottom")).toHaveCount(0);

		// Opened again, it has the room it had.
		await page.getByTestId("pane-fold-bottom").click();
		await expect(page.getByTestId("pane-body-bottom")).toBeVisible();
		await expect(divider(page)).toBeVisible();
		await expect(page.getByTestId("pane-fold-bottom")).toHaveAttribute("aria-expanded", "true");
	});

	test("folding one pane while the other is folded opens the other; picking a tab in a folded pane opens it", async ({
		page,
	}) => {
		await openChat(page);
		await page.getByTestId("pane-fold-bottom").click();
		await expect(pane(page, "bottom")).toHaveAttribute("data-collapsed", "true");
		// At most one is folded: the upper one folds, the lower one opens.
		await page.getByTestId("pane-fold-top").click();
		await expect(pane(page, "top")).toHaveAttribute("data-collapsed", "true");
		await expect(pane(page, "bottom")).toHaveAttribute("data-collapsed", "false");
		await expect(page.getByTestId("pane-body-bottom")).toBeVisible();
		await expect(page.getByTestId("pane-body-top")).toHaveCount(0);

		// A tab picked in the folded pane shows it.
		await tabOf(page, "top", "Info").click();
		await expect(pane(page, "top")).toHaveAttribute("data-collapsed", "false");
		await expect(pane(page, "top").getByTestId("session-info")).toBeVisible();
		// And so does the tab it already shows, picked again.
		await page.getByTestId("pane-fold-top").click();
		await expect(pane(page, "top")).toHaveAttribute("data-collapsed", "true");
		await tabOf(page, "top", "Info").click();
		await expect(pane(page, "top")).toHaveAttribute("data-collapsed", "false");
	});

	test("the layout is kept by the server, like the panel's width, and is not stored when it is the default", async ({
		page,
	}) => {
		await openChat(page);
		await expect.poll(async () => (await stored(page)).values[PREF.panelPanes]).toBeNull();
		await tabOf(page, "bottom", "Ask").click();
		await page.getByTestId("pane-fold-top").click();
		await expect
			.poll(() => storedLayout(page))
			.toMatchObject({ version: 2, rows: DEFAULT_ROWS, top: "agents", bottom: "btw", collapsed: "top" });
		// What is not at its default is kept whole, with its version and rows.
		expect(Object.keys((await storedLayout(page)) ?? {}).sort()).toEqual([
			"bottom",
			"collapsed",
			"rows",
			"top",
			"version",
		]);

		await page.getByTestId("pane-fold-top").click();
		await expect
			.poll(() => storedLayout(page))
			.toEqual({ version: 2, rows: DEFAULT_ROWS, top: "agents", bottom: "btw" });
		// A reload shows the pair, and each row still lists its own tabs.
		await reopen(page);
		await expect(pane(page, "bottom")).toHaveAttribute("data-tab", "btw");
		await expect(pane(page, "top")).toHaveAttribute("data-tab", "agents");
		expect(await idsIn(page, "top")).toEqual(["agents", "todos", "jobs", "tree", "info", "guidance", "questions"]);
		expect(await idsIn(page, "bottom")).toEqual(["files", "issues", "btw", "host", "terminal", "worktrees"]);
	});

	test("a layout that the page cannot read is the default", async ({ page }) => {
		await page.addInitScript(() => {
			localStorage.setItem("ompw.panelPanes", JSON.stringify({ top: "info", bottom: "info" }));
			localStorage.setItem("ompw.autoTitle", "off");
		});
		await openChat(page);
		await expect(pane(page, "top")).toHaveAttribute("data-tab", "agents");
		await expect(pane(page, "bottom")).toHaveAttribute("data-tab", "files");
		expect(await idsIn(page, "top")).toEqual(["agents", "todos", "jobs", "tree", "info", "guidance", "questions"]);
	});

	test("a layout that the first version stored is migrated: each pane keeps its tab, in the row of its pane", async ({
		page,
	}) => {
		await page.addInitScript(() => {
			localStorage.setItem(
				"ompw.panelPanes",
				JSON.stringify({ top: "info", bottom: "jobs", collapsed: "bottom", split: 0.4 }),
			);
			localStorage.setItem("ompw.autoTitle", "off");
		});
		await openChat(page);
		await expect(pane(page, "top")).toHaveAttribute("data-tab", "info");
		await expect(pane(page, "bottom")).toHaveAttribute("data-tab", "jobs");
		await expect(pane(page, "bottom")).toHaveAttribute("data-collapsed", "true");
		// Jobs was the lower pane's tab: it is listed in the lower row now, after the default five.
		expect(await idsIn(page, "top")).toEqual(["agents", "todos", "tree", "info", "guidance", "questions"]);
		expect(await idsIn(page, "bottom")).toEqual(["files", "issues", "btw", "host", "terminal", "worktrees", "jobs"]);
		for (const id of ALL) await expect(page.getByTestId(`pane-tab-${id}`)).toHaveCount(1);
		// It is written as version 2 when the layout next changes, with the fold and the divider kept.
		await page.getByTestId("pane-fold-bottom").click();
		await expect
			.poll(() => storedLayout(page))
			.toMatchObject({
				version: 2,
				rows: {
					top: ["agents", "todos", "tree", "info", "guidance", "questions"],
					bottom: ["files", "issues", "btw", "host", "terminal", "worktrees", "jobs"],
				},
				top: "info",
				bottom: "jobs",
				split: 0.4,
			});
	});

	test("a tab dragged along its row is dropped where the marker was, and a click on a tab is still a click", async ({
		page,
	}) => {
		await openChat(page);
		const jobs = tabOf(page, "top", /^Jobs/);
		await carry(page, jobs, () => beforeTab(tabOf(page, "top", /^Agents/)));
		// While it is carried: its name beside the pointer, and a line where it would go.
		await expect(page.getByTestId("pane-drag-ghost")).toContainText("Jobs");
		await expect(page.getByTestId("pane-drop-marker")).toBeVisible();
		expect(await idsIn(page, "top"), "nothing moves until it is dropped").toEqual([
			"agents",
			"todos",
			"jobs",
			"tree",
			"info",
			"guidance",
			"questions",
		]);
		await page.mouse.up();
		await expect(page.getByTestId("pane-drop-marker")).toHaveCount(0);
		await expect(page.getByTestId("pane-drag-ghost")).toHaveCount(0);
		expect(await idsIn(page, "top")).toEqual(["jobs", "agents", "todos", "tree", "info", "guidance", "questions"]);
		// The lower pane's row is as it was, and the drop was not taken for a click on the tab it ended over.
		expect(await idsIn(page, "bottom")).toEqual(["files", "issues", "btw", "host", "terminal", "worktrees"]);
		await expect(pane(page, "top")).toHaveAttribute("data-tab", "jobs");
		await expect(pane(page, "bottom")).toHaveAttribute("data-tab", "files");
		await expect
			.poll(() => storedLayout(page))
			.toMatchObject({ rows: { top: ["jobs", "agents", "todos", "tree", "info", "guidance", "questions"] } });

		// A press that does not travel is a click: the tab is picked, and nothing moves.
		await tabOf(page, "top", /^Info/).click();
		await expect(pane(page, "top")).toHaveAttribute("data-tab", "info");
		expect(await idsIn(page, "top")).toEqual(["jobs", "agents", "todos", "tree", "info", "guidance", "questions"]);

		// A tab dropped at the end of its row goes last.
		await carry(page, tabOf(page, "top", /^Jobs/), async () => {
			const last = await boxOf(tabOf(page, "top", /^Questions/));
			return { x: last.x + last.width + 4, y: last.y + last.height / 2 };
		});
		await page.mouse.up();
		expect(await idsIn(page, "top")).toEqual(["agents", "todos", "tree", "info", "guidance", "questions", "jobs"]);
	});

	test("a tab dragged onto the other pane's row moves there and is shown there; Escape drops nothing", async ({
		page,
	}) => {
		await openChat(page);
		const toIssues = () => beforeTab(tabOf(page, "bottom", /^Issues/));
		// Escape while it is carried: it stays where it was.
		await carry(page, tabOf(page, "top", /^Todos/), toIssues);
		await expect(page.getByTestId("pane-drop-marker")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("pane-drop-marker")).toHaveCount(0);
		await expect(page.getByTestId("pane-drag-ghost")).toHaveCount(0);
		await page.mouse.up();
		expect(await idsIn(page, "top")).toEqual(["agents", "todos", "jobs", "tree", "info", "guidance", "questions"]);
		expect(await idsIn(page, "bottom")).toEqual(["files", "issues", "btw", "host", "terminal", "worktrees"]);

		// Dropped on the lower row, between Files and Issues.
		await carry(page, tabOf(page, "top", /^Todos/), toIssues);
		await page.mouse.up();
		expect(await idsIn(page, "bottom")).toEqual(["files", "todos", "issues", "btw", "host", "terminal", "worktrees"]);
		expect(await idsIn(page, "top")).toEqual(["agents", "jobs", "tree", "info", "guidance", "questions"]);
		for (const id of ALL) await expect(page.getByTestId(`pane-tab-${id}`)).toHaveCount(1);
		await expect(pane(page, "bottom")).toHaveAttribute("data-tab", "todos");
		// The upper pane showed Todos when it was pressed: it shows the tab that took its place.
		await expect(pane(page, "top")).toHaveAttribute("data-tab", "jobs");
		await expect
			.poll(() => storedLayout(page))
			.toMatchObject({
				rows: {
					top: ["agents", "jobs", "tree", "info", "guidance", "questions"],
					bottom: ["files", "todos", "issues", "btw", "host", "terminal", "worktrees"],
				},
				top: "jobs",
				bottom: "todos",
			});
	});

	test("a pane left with no tab closes and the other takes the panel; a tab dropped on its edge opens it again", async ({
		page,
	}) => {
		await startWith(page, keptLayout({ top: [], bottom: ALL }, { bottom: "files" }));
		await openChat(page);
		await expect(pane(page, "top")).toHaveCount(0);
		await expect(divider(page)).toHaveCount(0);
		await expect(page.getByTestId("pane-fold-bottom")).toHaveCount(0);
		await expect(pane(page, "bottom").getByRole("tab")).toHaveCount(ALL.length);
		// The pane that is left is the top of the panel: its row is the header's height and has the Close button.
		await expect(pane(page, "bottom").getByTestId("right-panel-close")).toBeVisible();
		const panel = await boxOf(page.getByTestId("right-panel"));
		expect((await boxOf(pane(page, "bottom"))).height).toBeGreaterThan(panel.height - 4);

		// While a tab is carried the closed pane's edge is a place to drop it, along the top of the panel.
		const zone = page.getByTestId("pane-drop-zone-top");
		await expect(zone).toHaveCount(0);
		await carry(page, tabOf(page, "bottom", /^Info/), async () => ({ x: panel.x + panel.width / 2, y: panel.y + 4 }));
		await expect(zone).toBeVisible();
		await expect(zone).toHaveAttribute("data-over", "true");
		await page.mouse.up();
		await expect(zone).toHaveCount(0);
		await expect(pane(page, "top")).toHaveAttribute("data-tab", "info");
		expect(await idsIn(page, "top")).toEqual(["info"]);
		await expect(divider(page)).toBeVisible();
		await expect(page.getByTestId("pane-fold-top")).toBeVisible();
		await expect(pane(page, "bottom").getByTestId("right-panel-close")).toHaveCount(0);
		await expect(pane(page, "top").getByTestId("right-panel-close")).toBeVisible();
		await expect(pane(page, "bottom").getByRole("tab")).toHaveCount(ALL.length - 1);
	});

	test("the lower pane closes and opens the same way, from the bottom edge", async ({ page }) => {
		await startWith(page, keptLayout({ top: ALL, bottom: [] }, { top: "agents" }));
		await openChat(page);
		await expect(pane(page, "bottom")).toHaveCount(0);
		await expect(divider(page)).toHaveCount(0);
		const zone = page.getByTestId("pane-drop-zone-bottom");
		await carry(page, tabOf(page, "top", /^Host/), async () => {
			const panel = await boxOf(page.getByTestId("right-panel"));
			return { x: panel.x + panel.width / 2, y: panel.y + panel.height - 20 };
		});
		await expect(zone).toHaveAttribute("data-over", "true");
		await page.mouse.up();
		await expect(pane(page, "bottom")).toHaveAttribute("data-tab", "host");
		expect(await idsIn(page, "bottom")).toEqual(["host"]);
		await expect(divider(page)).toBeVisible();
		await expect(pane(page, "top").getByRole("tab")).toHaveCount(ALL.length - 1);
	});

	test("every tab has a menu (right-click, the menu key or Shift+F10): move left, right, and to the other pane", async ({
		page,
	}) => {
		await openChat(page);
		const menu = page.getByTestId("pane-tab-menu");
		const item = (name: string) => page.getByRole("menuitem", { name });
		// The first tab of a row cannot go left.
		await tabOf(page, "top", /^Agents/).click({ button: "right" });
		await expect(menu).toBeVisible();
		await expect(menu).toHaveAccessibleName("Move the Agents tab");
		await expect(item("Move left")).toHaveAttribute("aria-disabled", "true");
		await expect(item("Move right")).not.toHaveAttribute("aria-disabled", "true");
		await expect(item("Move to bottom pane")).not.toHaveAttribute("aria-disabled", "true");
		await page.keyboard.press("Escape");
		await expect(menu).toHaveCount(0);
		// The last one cannot go right, and the other pane is the upper one.
		await tabOf(page, "bottom", /^Worktrees/).click({ button: "right" });
		await expect(item("Move right")).toHaveAttribute("aria-disabled", "true");
		await expect(item("Move left")).not.toHaveAttribute("aria-disabled", "true");
		await expect(item("Move to top pane")).toBeVisible();
		await page.keyboard.press("Escape");

		await tabOf(page, "top", /^Todos/).click({ button: "right" });
		await item("Move left").click();
		expect(await idsIn(page, "top")).toEqual(["todos", "agents", "jobs", "tree", "info", "guidance", "questions"]);
		await expect(tabOf(page, "top", /^Todos/)).toBeFocused();
		await tabOf(page, "top", /^Agents/).click({ button: "right" });
		await item("Move right").click();
		expect(await idsIn(page, "top")).toEqual(["todos", "jobs", "agents", "tree", "info", "guidance", "questions"]);
		// To the other pane: at the end of its row, shown there, and the tab still has the focus. The pane it left shows what it
		// showed (Agents: giving a tab the focus picks it, so Agents is the one that was last moved).
		await tabOf(page, "top", /^Todos/).click({ button: "right" });
		await item("Move to bottom pane").click();
		expect(await idsIn(page, "bottom")).toEqual(["files", "issues", "btw", "host", "terminal", "worktrees", "todos"]);
		expect(await idsIn(page, "top")).toEqual(["jobs", "agents", "tree", "info", "guidance", "questions"]);
		await expect(pane(page, "bottom")).toHaveAttribute("data-tab", "todos");
		await expect(tabOf(page, "bottom", /^Todos/)).toBeFocused();
		await expect(pane(page, "top")).toHaveAttribute("data-tab", "agents");
		await expect
			.poll(() => storedLayout(page))
			.toMatchObject({
				rows: {
					top: ["jobs", "agents", "tree", "info", "guidance", "questions"],
					bottom: ["files", "issues", "btw", "host", "terminal", "worktrees", "todos"],
				},
			});
	});

	test("the keyboard moves a tab: the menu key or Shift+F10 opens its menu, and the focus stays on the tab", async ({
		page,
	}) => {
		await openChat(page);
		const menu = page.getByTestId("pane-tab-menu");
		const item = (name: string) => page.getByRole("menuitem", { name });
		const info = tabOf(page, "top", /^Info/);
		await info.focus();
		await page.keyboard.press("Shift+F10");
		await expect(menu).toBeVisible();
		// A menu the keyboard opened has the focus on its first item that can be chosen (Info is not the first of its row, so
		// Move left).
		await expect(item("Move left")).toBeFocused();
		// Closed without choosing: the focus goes back to the tab.
		await page.keyboard.press("Escape");
		await expect(menu).toHaveCount(0);
		await expect(info).toBeFocused();

		await page.keyboard.press("ContextMenu");
		await expect(item("Move left")).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(menu).toHaveCount(0);
		expect(await idsIn(page, "top")).toEqual(["agents", "todos", "jobs", "info", "tree", "guidance", "questions"]);
		await expect(tabOf(page, "top", /^Info/)).toBeFocused();

		// Across: the arrow keys go down the items, which can all be chosen now.
		await page.keyboard.press("Shift+F10");
		await expect(item("Move left")).toBeFocused();
		await page.keyboard.press("ArrowDown");
		await expect(item("Move right")).toBeFocused();
		await page.keyboard.press("ArrowDown");
		await expect(item("Move to bottom pane")).toBeFocused();
		await page.keyboard.press("Enter");
		expect(await idsIn(page, "bottom")).toEqual(["files", "issues", "btw", "host", "terminal", "worktrees", "info"]);
		await expect(pane(page, "bottom")).toHaveAttribute("data-tab", "info");
		await expect(tabOf(page, "bottom", /^Info/)).toBeFocused();
	});

	test("moving the last tab of a pane to the other pane closes it", async ({ page }) => {
		await startWith(
			page,
			keptLayout({ top: ALL.filter((id) => id !== "host"), bottom: ["host"] }, { top: "agents", bottom: "host" }),
		);
		await openChat(page);
		await expect(pane(page, "bottom")).toHaveAttribute("data-tab", "host");
		await tabOf(page, "bottom", /^Host/).click({ button: "right" });
		// Alone in its row: nowhere to go but the other pane.
		await expect(page.getByRole("menuitem", { name: "Move left" })).toHaveAttribute("aria-disabled", "true");
		await expect(page.getByRole("menuitem", { name: "Move right" })).toHaveAttribute("aria-disabled", "true");
		await page.getByRole("menuitem", { name: "Move to top pane" }).click();
		await expect(pane(page, "bottom")).toHaveCount(0);
		await expect(divider(page)).toHaveCount(0);
		await expect(pane(page, "top")).toHaveAttribute("data-tab", "host");
		expect((await idsIn(page, "top")).at(-1)).toBe("host");
		await expect(tabOf(page, "top", /^Host/)).toBeFocused();
	});

	test("a folded pane leaves no tab pointing at a panel that is not there (axe)", async ({ page }) => {
		await openChat(page);
		const rules = ["aria-valid-attr-value", "aria-valid-attr", "aria-allowed-attr", "aria-required-attr"];
		const scan = async () =>
			(await new AxeBuilder({ page }).include('[data-testid="right-panel"]').withRules(rules).analyze()).violations.map(
				(v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
			);
		expect(await scan(), "both panes open").toEqual([]);
		await page.getByTestId("pane-fold-bottom").click();
		await expect(pane(page, "bottom")).toHaveAttribute("data-collapsed", "true");
		expect(await scan(), "the lower pane folded").toEqual([]);
		// Folding the upper one opens the lower one again.
		await page.getByTestId("pane-fold-top").click();
		await expect(pane(page, "top")).toHaveAttribute("data-collapsed", "true");
		expect(await scan(), "the upper pane folded").toEqual([]);
		// The tab each pane has selected names a panel that is on the page, folded or not.
		const dangling = await page
			.getByTestId("right-panel")
			.locator('[role="tab"][aria-selected="true"][aria-controls]')
			.evaluateAll(
				(els) => els.filter((el) => !document.getElementById(el.getAttribute("aria-controls") ?? "")).length,
			);
		expect(dangling).toBe(0);
	});
});

// ------------------------------------------------------------------ the strip and the jobs list

type Frame = Record<string, unknown>;

const lifecycle = (id: string, status: string, extra: Frame = {}): Frame => ({
	type: "subagent_lifecycle",
	payload: { id, agent: "explore", agentSource: "bundled", index: 0, status, ...extra },
});
const progress = (id: string, p: Frame, extra: Frame = {}): Frame => ({
	type: "subagent_progress",
	payload: {
		index: 0,
		agent: "explore",
		agentSource: "bundled",
		task: id,
		progress: { id, status: "running", ...p },
		...extra,
	},
});

const PLAN = [
	{
		name: "Build",
		tasks: [
			{ content: "Write the parser", status: "in_progress" },
			{ content: "Wire the strip", status: "pending" },
			{ content: "Deploy", status: "pending" },
		],
	},
];

/** A conversation of the spec's own with its process running, and its todo list and jobs under the spec's control. */
async function openLive(page: Page, n: number, title: string) {
	sessionWithSubagents(n, title, {});
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	await openSidebar(page);
	const liveId = await startLive(page, tap, title, `split-probe-${n}`);
	const frame = (f: Frame) => tap.push({ t: "frame", liveId, frame: f } as Msg);
	return {
		frame,
		setTodos(phases: unknown[]) {
			tap.answer("get_state", () => ({ ok: true, data: rpcState({ todoPhases: phases }) }));
			frame({ type: "tool_execution_end", toolCallId: `todo-${Math.random()}`, toolName: "todo", result: {} });
		},
		startJobs(count: number) {
			for (let i = 1; i <= count; i++) {
				const named = { index: i, parentToolCallId: "call_split" };
				frame(lifecycle(`Job${i}`, "started", { ...named, description: `Description ${i}` }));
				frame(progress(`Job${i}`, { durationMs: i * 10_000, completionPercent: i * 10 }, named));
			}
		},
	};
}

test.describe("the task strip and the jobs list, beside the conversation", () => {
	test.use({ viewport: { width: 1400, height: 900 } });

	test("the strip leaves the composer's area while a pane shows the Todos tab, and is back when the panel closes", async ({
		page,
	}) => {
		const { setTodos } = await openLive(page, 0x61, "Split strip probe");
		setTodos(PLAN);
		const strip = page.getByTestId("todo-strip");
		await expect(strip).toBeVisible();
		await expect(strip.getByTestId("todo-current")).toHaveText("Write the parser");

		// Open, no pane shows Todos (the upper pane lists it, and shows Agents): the strip is still above the composer.
		await page.getByTestId("toggle-panel").click();
		await expect(pane(page, "top")).toHaveAttribute("data-tab", "agents");
		await expect(strip).toBeVisible();
		await expect(tabOf(page, "top", "Todos 0/3")).toBeVisible();

		// The pane that shows it has the list, and the strip is not drawn above the composer any more.
		await tabOf(page, "top", /^Todos/).click();
		await expect(strip).toHaveCount(0);
		await expect(pane(page, "top").getByTestId("todo-progress")).toHaveCount(0);
		await expect(pane(page, "top")).toContainText("Write the parser");
		await expect(pane(page, "top")).toContainText("Wire the strip");

		// A pane folded away is not showing it.
		await page.getByTestId("pane-fold-top").click();
		await expect(strip).toBeVisible();
		await page.getByTestId("pane-fold-top").click();
		await expect(strip).toHaveCount(0);
		// Nor is a pane that shows something else.
		await tabOf(page, "top", "Info").click();
		await expect(strip).toBeVisible();
		await tabOf(page, "top", /^Todos/).click();
		await expect(strip).toHaveCount(0);
		// Moved to the lower pane, the tab is shown there just as well.
		await tabOf(page, "top", /^Todos/).click({ button: "right" });
		await page.getByRole("menuitem", { name: "Move to bottom pane" }).click();
		await expect(pane(page, "bottom")).toHaveAttribute("data-tab", "todos");
		await expect(strip).toHaveCount(0);
		await expect(pane(page, "bottom")).toContainText("Write the parser");
		await tabOf(page, "bottom", /^Files/).click();
		await expect(strip).toBeVisible();
		await tabOf(page, "bottom", /^Todos/).click();
		await expect(strip).toHaveCount(0);

		// With the panel closed the strip is above the composer as before.
		await page.getByTestId("right-panel-close").click();
		await expect(page.getByTestId("right-panel")).toHaveCount(0);
		await expect(strip).toBeVisible();
		await expect(strip.getByTestId("todo-progress")).toHaveText("0/3");
		// Its button shows the Todos tab where a pane can show it: the panel opens on it and the strip steps aside.
		await page.getByTestId("todo-open-panel").click();
		await expect(page.getByTestId("right-panel")).toBeVisible();
		await expect(strip).toHaveCount(0);
		await expect(pane(page, "bottom")).toHaveAttribute("data-tab", "todos");
	});

	test("the strip's button brings the Todos tab into a pane that is not showing it", async ({ page }) => {
		const { setTodos } = await openLive(page, 0x62, "Split strip button probe");
		setTodos(PLAN);
		await page.getByTestId("toggle-panel").click();
		await tabOf(page, "top", "Info").click();
		const strip = page.getByTestId("todo-strip");
		await expect(strip).toBeVisible();
		await page.getByTestId("todo-open-panel").click();
		await expect(strip).toHaveCount(0);
		await expect(pane(page, "top")).toHaveAttribute("data-tab", "todos");
		await expect(pane(page, "bottom")).toHaveAttribute("data-tab", "files");
	});

	test("omp's reminder to finish the list shows at the top of the Todos tab while the strip is not drawn", async ({
		page,
	}) => {
		const { frame, setTodos } = await openLive(page, 0x63, "Split reminder probe");
		setTodos(PLAN);
		await page.getByTestId("toggle-panel").click();
		await tabOf(page, "top", /^Todos/).click();
		await expect(page.getByTestId("todo-strip")).toHaveCount(0);
		frame({ type: "agent_start" });
		frame({
			type: "todo_reminder",
			todos: [
				{ content: "Write the parser", status: "in_progress" },
				{ content: "Wire the strip", status: "pending" },
			],
			attempt: 1,
			maxAttempts: 3,
		});
		const reminder = pane(page, "top").getByTestId("todo-reminder");
		await expect(reminder).toHaveText("2 incomplete todos - reminder 1/3");
		await expect(page.getByTestId("todo-reminder")).toHaveCount(1);
		// The stop that was reminded is not the end; the turn it asked for runs, and the reminder goes when that turn ends.
		frame({ type: "agent_end", isTerminal: false });
		frame({ type: "agent_start" });
		await expect(reminder).toBeVisible();
		frame({ type: "agent_end", isTerminal: true });
		await expect(reminder).toHaveCount(0);
	});

	test("the jobs list is a tab; while a pane shows it the list is not drawn above the composer", async ({ page }) => {
		const { startJobs, frame } = await openLive(page, 0x64, "Split jobs probe");
		startJobs(4);
		const block = page.getByTestId("jobs-block");
		await expect(block).toContainText("Waiting on 4 jobs");

		// Open, no pane has Jobs: the list is where it was.
		await page.getByTestId("toggle-panel").click();
		await expect(block).toBeVisible();
		await expect(tabOf(page, "top", "Jobs 4/4")).toBeVisible();

		await tabOf(page, "top", /^Jobs/).click();
		await expect(block).toHaveCount(0);
		const list = pane(page, "top").getByTestId("jobs-list");
		await expect(list).toContainText("Waiting on 4 jobs");
		// All of them, not three and "1 more": the pane scrolls.
		await expect(list.getByTestId("job-row")).toHaveCount(4);
		await expect(list.getByTestId("jobs-more")).toHaveCount(0);
		await expect(list.getByTestId("job-row").first()).toContainText("Description 1");
		await expect(list.getByTestId("job-row").first()).toContainText("10%");
		// It follows the jobs.
		frame(lifecycle("Job4", "completed", { index: 4, parentToolCallId: "call_split" }));
		await expect(list).toContainText("Waiting on 3 of 4 jobs");
		await expect(tabOf(page, "top", "Jobs 3/4")).toBeVisible();

		// A row opens that subagent in the Agents tab: the same pane lists it, so the pane shows it and the list is not shown.
		await list.getByTestId("job-row").nth(1).click();
		await expect(page.getByTestId("subagent-detail")).toContainText("Job2");
		await expect(pane(page, "top")).toHaveAttribute("data-tab", "agents");
		await expect(block).toBeVisible();

		// Shown again it steps aside; folded away, or with the panel closed, the list is above the composer again.
		await tabOf(page, "top", /^Jobs/).click();
		await expect(block).toHaveCount(0);
		await page.getByTestId("pane-fold-top").click();
		await expect(block).toBeVisible();
		await page.getByTestId("pane-fold-top").click();
		await expect(block).toHaveCount(0);
		await page.getByTestId("right-panel-close").click();
		await expect(block).toBeVisible();
		await expect(block).toContainText("Waiting on 3 of 4 jobs");
		for (let i = 1; i <= 3; i++) frame(lifecycle(`Job${i}`, "completed", { index: i, parentToolCallId: "call_split" }));
		await expect(block).toHaveCount(0);
	});

	test("the Jobs tab says so when nothing runs", async ({ page }) => {
		await openLive(page, 0x65, "Split no jobs probe");
		await page.getByTestId("toggle-panel").click();
		await tabOf(page, "top", "Jobs").click();
		await expect(pane(page, "top")).toContainText("No jobs running");
	});

	test("the Agents tab shows the subagents at work as a badge, whichever tab the pane is on, and none when nothing runs", async ({
		page,
	}) => {
		const { frame, startJobs } = await openLive(page, 0x68, "Split badge probe");
		startJobs(2);
		await page.getByTestId("toggle-panel").click();
		// The pane is on another tab (the panel keeps the one last looked at, it does not follow the work): the badge on the
		// Agents tab is what says that two subagents are at work.
		await tabOf(page, "top", /^Todos/).click();
		const tab = page.getByTestId("pane-tab-agents");
		await expect(tab).toHaveAccessibleName("Agents 2/2");
		const background = (text: string) =>
			tab.getByText(text, { exact: true }).evaluate((el) => getComputedStyle(el).backgroundColor);
		expect(await background("2/2")).not.toBe("rgba(0, 0, 0, 0)");
		for (let i = 1; i <= 2; i++) frame(lifecycle(`Job${i}`, "completed", { index: i, parentToolCallId: "call_split" }));
		await expect(tab).toHaveAccessibleName("Agents 2");
		expect(await background("2")).toBe("rgba(0, 0, 0, 0)");
	});

	test("the layout is drawn in Chinese too, with the tabs and the buttons named", async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem("ompw.lang", "zh-CN"));
		await openChat(page);
		await expect(tabOf(page, "top", "子代理")).toBeVisible();
		await expect(tabOf(page, "top", /^待办/)).toBeVisible();
		await expect(tabOf(page, "top", "任务")).toBeVisible();
		await expect(tabOf(page, "bottom", /^文件/)).toBeVisible();
		await expect(tabOf(page, "bottom", "提问")).toBeVisible();
		await expect(divider(page)).toHaveAttribute("aria-label", "调整上下面板大小");
		await expect(page.getByTestId("pane-fold-bottom")).toHaveAccessibleName("收起下方面板");
		// The tab's menu is in Chinese too.
		await tabOf(page, "top", /^待办/).click({ button: "right" });
		await expect(page.getByTestId("pane-tab-menu")).toHaveAccessibleName("移动“待办”标签页");
		await expect(page.getByRole("menuitem", { name: "向左移动" })).toBeVisible();
		await expect(page.getByRole("menuitem", { name: "向右移动" })).toBeVisible();
		await expect(page.getByRole("menuitem", { name: "移到下方面板" })).toBeVisible();
	});
});

// ------------------------------------------------------------------ one pane on a phone

test.describe("on a phone", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("the panel is the sheet with one pane: no lower pane, no divider, and the strip stays above the composer", async ({
		page,
	}) => {
		const { setTodos, startJobs } = await openLive(page, 0x66, "Split phone probe");
		setTodos(PLAN);
		startJobs(2);
		await page.getByTestId("toggle-panel").click();
		await expect(page.getByTestId("right-panel")).toBeVisible();
		await expect(pane(page, "top")).toBeVisible();
		await expect(pane(page, "bottom")).toHaveCount(0);
		await expect(divider(page)).toHaveCount(0);
		await expect(page.getByTestId("pane-fold-top")).toHaveCount(0);
		await expect(page.getByTestId("right-panel-close")).toBeVisible();
		await expect(pane(page, "top").getByRole("tab")).toHaveCount(ALL.length);

		// The sheet covers the conversation, which is still the thing being read: the strip and the list stay in it.
		await tabOf(page, "top", /^Todos/).click();
		await expect(pane(page, "top")).toHaveAttribute("data-tab", "todos");
		await expect(page.getByTestId("todo-strip")).toHaveCount(1);
		await tabOf(page, "top", /^Jobs/).click();
		await expect(pane(page, "top").getByTestId("jobs-list")).toBeVisible();
		await expect(page.getByTestId("jobs-block")).toHaveCount(1);
		// Every tab of the panel is in its one row, the bottom row's too, and a tab is not moved here: no drag, no menu.
		await tabOf(page, "top", /^Ask/).click();
		await expect(pane(page, "top")).toHaveAttribute("data-tab", "btw");
		await tabOf(page, "top", /^Ask/).click({ button: "right" });
		await expect(page.getByTestId("pane-tab-menu")).toHaveCount(0);
		await expect(pane(page, "top").locator("[data-pane-row]")).toHaveCount(0);
		// The pane takes the whole sheet.
		const sheet = await boxOf(page.getByTestId("right-panel"));
		const one = await boxOf(pane(page, "top"));
		expect(one.height).toBeGreaterThan(sheet.height - 4);
	});

	test("a tab picked on the phone is the sheet's own choice: the layout that the desktop draws is not changed", async ({
		page,
	}) => {
		await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
		await page.goto("/");
		await openSidebar(page);
		await sessionRow(page, FIXTURE.gammaTitle).click();
		await page.getByTestId("toggle-panel").click();
		await tabOf(page, "top", /^Todos/).click();
		await expect(pane(page, "top")).toHaveAttribute("data-tab", "todos");
		await page.getByTestId("right-panel-close").click();
		expect(await page.evaluate(() => localStorage.getItem("ompw.panelPanes"))).toBeNull();
	});

	test("a layout stored by another page is read in the sheet as one row of every tab, and is left as it was", async ({
		page,
	}) => {
		const kept = JSON.stringify({ top: "agents", bottom: "todos", collapsed: "top" });
		await page.addInitScript((layout) => {
			localStorage.setItem("ompw.autoTitle", "off");
			localStorage.setItem("ompw.panelPanes", layout);
		}, kept);
		await page.goto("/");
		await openSidebar(page);
		await sessionRow(page, FIXTURE.gammaTitle).click();
		await page.getByTestId("toggle-panel").click();
		// The fold is the desktop layout's: the sheet has no fold. The top row's tabs come first, then the bottom row's.
		await expect(pane(page, "top")).toHaveAttribute("data-collapsed", "false");
		await expect(pane(page, "top")).toHaveAttribute("data-tab", "agents");
		expect(await idsIn(page, "top")).toEqual([
			"agents",
			"jobs",
			"tree",
			"info",
			"guidance",
			"questions",
			"files",
			"issues",
			"btw",
			"host",
			"terminal",
			"worktrees",
			"todos",
		]);
		await tabOf(page, "top", /^Todos/).click();
		await expect(pane(page, "top")).toHaveAttribute("data-tab", "todos");
		await page.getByTestId("right-panel-close").click();
		expect(await page.evaluate(() => localStorage.getItem("ompw.panelPanes"))).toBe(kept);
	});

	for (const [lang, locale] of [
		["English", "en"],
		["Chinese", "zh-CN"],
	] as const) {
		test(`every tab of the sheet is named on screen, none is cut, and the row scrolls to the ones past its edge (${lang})`, async ({
			page,
		}) => {
			await page.addInitScript((l) => localStorage.setItem("ompw.lang", l), locale);
			await openLive(page, 0x69, `Split phone labels probe ${lang}`);
			await page.getByTestId("toggle-panel").click();
			const tabs = pane(page, "top").getByRole("tab");
			await expect(tabs).toHaveCount(ALL.length);
			// A bare icon is a name to guess at: each tab says what it is, in full.
			for (const id of ALL) await expect(page.getByTestId(`pane-tab-${id}`)).toHaveText(/\S/);
			const cut = await tabs.evaluateAll((els) =>
				els.filter((el) => el.scrollWidth > el.clientWidth + 1).map((el) => el.getAttribute("data-pane-tab")),
			);
			expect(cut).toEqual([]);
			// More tabs than a phone's width holds: the row shows that there are more, and reaches the last one.
			await expect(pane(page, "top").getByTestId("scroll-row-right")).toBeVisible();
			const last = ALL[ALL.length - 1] as PanelTab;
			await page.getByTestId(`pane-tab-${last}`).click();
			await expect(pane(page, "top")).toHaveAttribute("data-tab", last);
			await expect(pane(page, "top").getByTestId("scroll-row-left")).toBeVisible();
			// Wholly inside the row, not under the edge that fades.
			const row = await boxOf(pane(page, "top").getByRole("tablist"));
			const box = await boxOf(page.getByTestId(`pane-tab-${last}`));
			expect(box.x).toBeGreaterThanOrEqual(row.x);
			expect(box.x + box.width).toBeLessThanOrEqual(row.x + row.width);
		});
	}

	test("the Jobs tab's empty state keeps off the sheet's edges", async ({ page }) => {
		await openLive(page, 0x6a, "Split phone empty jobs probe");
		await page.getByTestId("toggle-panel").click();
		await tabOf(page, "top", "Jobs").click();
		const margin = await pane(page, "top")
			.getByTestId("pane-body-top")
			.evaluate((body) => {
				const edge = body.getBoundingClientRect();
				let least = Number.POSITIVE_INFINITY;
				for (const el of body.querySelectorAll("*")) {
					if (el.children.length > 0 || !el.textContent?.trim()) continue;
					const box = el.getBoundingClientRect();
					least = Math.min(least, box.left - edge.left, edge.right - box.right);
				}
				return least;
			});
		expect(margin, "the empty state's text, from the pane's edges").toBeGreaterThanOrEqual(8);
	});
});

// ------------------------------------------------------------------ the transcript

test.describe("what the panes subscribe to", () => {
	test.use({ viewport: { width: 1400, height: 900 } });

	test("moving the divider, folding a pane and picking a tab do not render the conversation again", async ({
		page,
	}) => {
		await page.addInitScript(COUNT_RENDERS);
		await openChat(page);
		// The conversation is the component that draws the transcript's own element.
		await countRendersOf(page, "transcript");
		// What the page was still loading (a late /api/model-config, /api/usage or /api/prefs answer redraws the conversation
		// once) is in before anything is counted.
		await settled(page);
		// The first move of any drag (the panel's width handle too) renders the conversation once, as the pointer takes
		// over: that is not the panes' doing, and is spent before counting.
		await drag(page, divider(page), 4);
		await painted(page);
		await painted(page);
		const before = await rendersCounted(page);

		await drag(page, divider(page), 80);
		await divider(page).focus();
		await page.keyboard.press("ArrowUp");
		await page.getByTestId("pane-fold-bottom").click();
		await page.getByTestId("pane-fold-bottom").click();
		await tabOf(page, "bottom", "Ask").click();
		await tabOf(page, "top", "Info").click();
		// A tab carried to the other pane's row is not the conversation's doing either.
		await carry(page, tabOf(page, "top", "Info"), async () => {
			const last = await boxOf(tabOf(page, "bottom", "Host"));
			return { x: last.x + last.width + 4, y: last.y + last.height / 2 };
		});
		await page.mouse.up();
		await painted(page);
		await painted(page);
		expect(await rendersCounted(page)).toBe(before);
		await expect(pane(page, "bottom")).toHaveAttribute("data-tab", "info");
	});

	test("a reply that streams renders the conversation as often with the panes open as with the panel closed", async ({
		page,
	}) => {
		await page.addInitScript(COUNT_RENDERS);
		const { frame, setTodos, startJobs } = await openLive(page, 0x67, "Split streaming probe");
		setTodos(PLAN);
		startJobs(2);
		await expect(page.getByTestId("todo-strip")).toBeVisible();
		await countRendersOf(page, "transcript");
		await settled(page);
		frame({ type: "agent_start" });
		frame({ type: "message_start", messageId: "m1", message: { role: "assistant", content: [], timestamp: 5 } });
		const event = (type: string, extra: Record<string, unknown> = {}) =>
			frame({
				type: "message_update",
				messageId: "m1",
				message: { role: "assistant" },
				assistantMessageEvent: { type, contentIndex: 0, ...extra },
			});
		event("text_start");
		await painted(page);
		let n = 0;
		/** The renders of the conversation while `words` tokens arrive, one to a frame. */
		const stream = async (words: number) => {
			const before = await rendersCounted(page);
			for (let i = 0; i < words; i++) {
				event("text_delta", { delta: `w${n++} ` });
				await painted(page);
			}
			await painted(page);
			await painted(page);
			return (await rendersCounted(page)) - before;
		};
		const closed = await stream(20);
		// The panel open with a pane showing the strip's tab, and the jobs list still above the composer.
		await page.getByTestId("toggle-panel").click();
		await tabOf(page, "top", /^Todos/).click();
		await expect(pane(page, "top")).toHaveAttribute("data-tab", "todos");
		await expect(page.getByTestId("todo-strip")).toHaveCount(0);
		await painted(page);
		await painted(page);
		const open = await stream(20);
		expect(closed, "the reply does render the conversation").toBeGreaterThan(0);
		// Open panes add no renders; under load a frame can coalesce two tokens, so fewer is fine too.
		expect(open).toBeLessThanOrEqual(closed);
	});
});
