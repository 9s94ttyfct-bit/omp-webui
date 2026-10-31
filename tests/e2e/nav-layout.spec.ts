import { boxOf } from "../support/geometry.ts";
import { choose } from "../support/select.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * The sidebar's and the rail's pages (#654, #660): one model feeds the sidebar, the rail and the palette's *Go to*; each
 * bar's items sit in a top group, a bottom group or nowhere, in an order the person sets by dragging (pointer and touch) or
 * with the controls of Settings (keyboard), kept on this device. The Guard page has its entry there (not on a page that came
 * through the tunnel), and Send feedback is a card of Settings, not a button of the sidebar. No model call.
 */

const KEY = "ompw.navLayout";
const ALL = ["agents", "usage", "memory", "cli", "settings", "guard"];
const sidebar = (page: Page) => page.getByRole("complementary", { name: "Conversations" });
const rail = (page: Page) => page.getByRole("navigation", { name: "Shortcuts of the hidden sidebar" });

type Group = "top" | "bottom";
/** The pages of one group of the sidebar (or the rail), in the order drawn. */
const itemsOf = (page: Page, surface: "sidebar" | "rail", group: Group) =>
	page
		.getByTestId(`nav-group-${surface}-${group}`)
		.locator("[data-nav-item]")
		.evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.navItem));
/** Wait for the sidebar's group to be drawn as `expected` (a layout change is drawn a moment after the pointer is let go). */
const expectRows = (page: Page, group: Group, expected: string[]) =>
	expect.poll(() => itemsOf(page, "sidebar", group)).toEqual(expected);
const expectIcons = (page: Page, group: Group, expected: string[]) =>
	expect.poll(() => itemsOf(page, "rail", group)).toEqual(expected);

type Stored = Record<"sidebar" | "rail", Record<"top" | "bottom" | "hidden", string[]>> | null;
const stored = (page: Page) => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null") as Stored, KEY);

/** A page that is not on this computer: `/api/meta` says so, as it does through the tunnel. */
async function asRemote(page: Page, questions?: number) {
	await page.route("**/api/meta", async (route) => {
		const real = await (await route.fetch()).json();
		const open = questions === undefined ? {} : { questions: { rev: 1, open: questions, byConversation: {} } };
		return route.fulfill({ json: { ...real, remote: true, ...open } });
	});
}

/** The point to press on, and to drop on: the middle of an element, or its upper or lower quarter. */
async function at(el: Locator, where: "top" | "middle" | "bottom" = "middle") {
	const box = await boxOf(el);
	const fraction = where === "top" ? 0.25 : where === "bottom" ? 0.75 : 0.5;
	return { x: box.x + box.width / 2, y: box.y + box.height * fraction };
}

/** A press on `from` that is dragged (in steps, as a hand does) onto the place `to` finds, and let go. */
async function drag(page: Page, from: Locator, to: () => Promise<{ x: number; y: number }>) {
	const start = await at(from);
	await page.mouse.move(start.x, start.y);
	await page.mouse.down();
	// A few pixels first: the drag begins, and the places to drop on that it shows are on the page before the target is found.
	await page.mouse.move(start.x + 8, start.y - 8, { steps: 3 });
	const end = await to();
	await page.mouse.move(end.x, end.y, { steps: 8 });
	await page.mouse.up();
	// The click that ends a drag is swallowed for a moment; a test is quicker than a hand.
	await page.waitForTimeout(60);
}

test.describe("at 1400 px", () => {
	test.use({ viewport: { width: 1400, height: 900 } });

	test("the sidebar's foot lists the pages once, with the Guard among them and Send feedback gone", async ({
		page,
	}) => {
		await page.goto("/");
		await expect(page.getByTestId("nav-settings")).toBeVisible();
		await expectRows(page, "top", []);
		await expectRows(page, "bottom", ALL);
		await expect(page.getByTestId("sidebar-feedback")).toHaveCount(0);
		await expect(sidebar(page).getByRole("button", { name: /Send feedback/ })).toHaveCount(0);
		// Nothing is stored until the person arranges something.
		expect(await stored(page)).toBeNull();

		await sidebar(page).getByRole("button", { name: "Guard", exact: true }).click();
		await expect(page.getByTestId("guard-page")).toBeVisible();
		expect(new URL(page.url()).hash).toBe("#/guard");
		await expect(page.getByTestId("nav-guard")).toHaveAttribute("aria-current", "page");
	});

	test("the rail has the same pages in its own arrangement, and the Guard opens from it", async ({ page }) => {
		await page.goto("/");
		await page.getByRole("button", { name: "Hide sidebar" }).click();
		await expect(rail(page)).toBeVisible();
		await expectIcons(page, "bottom", ALL);
		await rail(page).getByRole("button", { name: "Guard", exact: true }).click();
		await expect(page.getByTestId("guard-page")).toBeVisible();
		await expect(rail(page).getByTestId("rail-guard")).toHaveAttribute("aria-current", "page");
	});

	test("the pages' place is held while their chunk loads: nothing moves when they arrive", async ({ page }) => {
		// The chunk with the bars' pages is held back until the place it takes has been measured.
		const release = Promise.withResolvers<void>();
		await page.route(/NavLinks-[^/]*\.js$/, async (route) => {
			await release.promise;
			await route.continue();
		});
		await page.goto("/");
		const group = page.getByTestId("nav-group-sidebar-bottom");
		await expect(group).toHaveAttribute("data-reserved", "true");
		const before = await boxOf(group);
		const below = await boxOf(page.getByTestId("new-chat"));
		release.resolve();
		await expect(page.getByTestId("nav-settings")).toBeVisible();
		await expect(group).not.toHaveAttribute("data-reserved", "true");
		expect(await boxOf(group)).toEqual(before);
		expect(await boxOf(page.getByTestId("new-chat"))).toEqual(below);
	});

	test("a page that came through the tunnel is offered no Guard, in either bar or the palette, and neither bar lists Questions (#693)", async ({
		page,
	}) => {
		await asRemote(page, 2);
		await page.goto("/");
		await expect(page.getByTestId("nav-settings")).toBeVisible();
		await expectRows(page, "bottom", ["agents", "usage", "memory", "cli", "settings"]);
		await expect(page.getByTestId("nav-questions-count")).toHaveCount(0);

		await page.getByRole("button", { name: "Hide sidebar" }).click();
		await expect(rail(page)).toBeVisible();
		await expectIcons(page, "bottom", ["agents", "usage", "memory", "cli", "settings"]);

		await page.keyboard.press("ControlOrMeta+k");
		await expect(page.getByTestId("palette-go-settings")).toBeVisible();
		await expect(page.getByTestId("palette-go-guard")).toHaveCount(0);
	});

	test("the palette's Go to lists every page, Questions and Guard included, whatever the bars show", async ({
		page,
	}) => {
		await page.addInitScript(
			([key]) => {
				// Every page hidden from both bars: the palette is still the way to each.
				const hidden = { top: [], bottom: [], hidden: ["agents", "usage", "memory", "cli", "settings", "guard"] };
				localStorage.setItem(key, JSON.stringify({ v: 1, sidebar: hidden, rail: hidden }));
			},
			[KEY],
		);
		await page.goto("/");
		await expect(page.getByTestId("new-chat")).toBeVisible();
		await expectRows(page, "bottom", []);
		await page.keyboard.press("ControlOrMeta+k");
		for (const id of [...ALL, "questions"]) await expect(page.getByTestId(`palette-go-${id}`)).toBeVisible();
		await page.getByTestId("palette-go-guard").click();
		await expect(page.getByTestId("guard-page")).toBeVisible();
	});

	test("Send feedback is a card of Settings that opens the dialog; the palette and the shortcuts card still do", async ({
		page,
	}) => {
		await page.goto("/#/settings/app");
		const card = page.getByTestId("feedback-settings");
		await expect(card).toBeVisible();
		await card.getByTestId("settings-feedback").scrollIntoViewIfNeeded();
		await card.getByTestId("settings-feedback").click();
		await expect(page.getByRole("dialog", { name: "Send feedback" })).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).toHaveCount(0);

		await page.keyboard.press("ControlOrMeta+k");
		await page.getByTestId("palette-input").fill("feedback");
		await expect(page.getByTestId("palette-feedback")).toBeVisible();
		await page.keyboard.press("Escape");

		// The shortcuts card is on the Look page.
		await page.locator('[data-testid="settings-page-tab"][data-page="look"]').click();
		await page.getByTestId("shortcuts-settings").scrollIntoViewIfNeeded();
		await expect(page.getByTestId("shortcuts-settings").getByTestId("help-feedback")).toBeVisible();
	});

	test("dragging a page reorders it within its group, and the order is kept on this device across a reload", async ({
		page,
	}) => {
		await page.goto("/");
		await expect(page.getByTestId("nav-settings")).toBeVisible();
		// Settings onto the upper half of Usage: just ahead of it (the Agent graph stays first).
		await drag(page, page.getByTestId("nav-settings"), () => at(page.getByTestId("nav-usage"), "top"));
		const order = ["agents", "settings", "usage", "memory", "cli", "guard"];
		await expectRows(page, "bottom", order);
		// The click a drag ends with did not open the page.
		await expect(page.getByTestId("settings-page")).toHaveCount(0);
		expect((await stored(page))?.sidebar).toEqual({ top: [], bottom: order, hidden: [] });

		await page.reload();
		await expect(page.getByTestId("nav-settings")).toBeVisible();
		await expectRows(page, "bottom", order);
		// The server's preference store is not told: the layout is this device's.
		expect(JSON.stringify(await (await page.request.get("/api/prefs")).json())).not.toContain("navLayout");
		// A plain click still opens the page.
		await page.getByTestId("nav-memory").click();
		await expect(page.getByTestId("memory-page")).toBeVisible();
	});

	test("an item can be dropped in the empty top group, and on the zone that hides it; each bar keeps its own", async ({
		page,
	}) => {
		await page.goto("/");
		await expect(page.getByTestId("nav-cli")).toBeVisible();
		// No place to drop on shows while nothing is dragged.
		await expect(page.getByTestId("nav-group-sidebar-top")).toBeHidden();
		await expect(page.getByTestId("nav-hide-sidebar")).toBeHidden();

		await drag(page, page.getByTestId("nav-cli"), async () => {
			await expect(page.getByTestId("nav-group-sidebar-top")).toBeVisible();
			await expect(page.getByTestId("nav-hide-sidebar")).toBeVisible();
			return at(page.getByTestId("nav-group-sidebar-top"));
		});
		await expectRows(page, "top", ["cli"]);
		await expectRows(page, "bottom", ["agents", "usage", "memory", "settings", "guard"]);

		await drag(page, page.getByTestId("nav-memory"), () => at(page.getByTestId("nav-hide-sidebar")));
		await expectRows(page, "bottom", ["agents", "usage", "settings", "guard"]);
		expect((await stored(page))?.sidebar).toEqual({
			top: ["cli"],
			bottom: ["agents", "usage", "settings", "guard"],
			hidden: ["memory"],
		});
		// The place to drop on is gone again, and the rail was not touched.
		await expect(page.getByTestId("nav-hide-sidebar")).toBeHidden();
		await page.getByRole("button", { name: "Hide sidebar" }).click();
		await expectIcons(page, "top", []);
		await expectIcons(page, "bottom", ALL);

		// On the rail: Guard to its (empty) top group, and the sidebar's own order survives showing it again.
		await drag(page, rail(page).getByTestId("rail-guard"), async () => {
			await expect(page.getByTestId("nav-group-rail-top")).toBeVisible();
			return at(page.getByTestId("nav-group-rail-top"));
		});
		await expectIcons(page, "top", ["guard"]);
		await rail(page).getByTestId("show-sidebar").click();
		await expectRows(page, "bottom", ["agents", "usage", "settings", "guard"]);
	});

	test("Esc while dragging puts the item back", async ({ page }) => {
		await page.goto("/");
		const settings = page.getByTestId("nav-settings");
		await expect(settings).toBeVisible();
		const start = await at(settings);
		await page.mouse.move(start.x, start.y);
		await page.mouse.down();
		await page.mouse.move(start.x + 10, start.y - 10, { steps: 3 });
		const target = await at(page.getByTestId("nav-usage"), "top");
		await page.mouse.move(target.x, target.y, { steps: 6 });
		await expect(page.getByTestId("nav-usage")).toHaveAttribute("data-drop", "before");
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("nav-usage")).not.toHaveAttribute("data-drop");
		await page.mouse.up();
		await expectRows(page, "bottom", ALL);
		expect(await stored(page)).toBeNull();
	});

	test("Settings arranges both bars without a pointer: move up and down, choose the group, hide, and reset", async ({
		page,
	}) => {
		await page.goto("/#/settings");
		const card = page.getByTestId("nav-layout-settings");
		await expect(card).toBeVisible();
		await card.scrollIntoViewIfNeeded();

		// A keyboard: focus the control and press Enter. The control stays where it is, and keeps the focus.
		const up = page.getByRole("button", { name: "Move Settings up in the Sidebar" });
		await up.focus();
		await page.keyboard.press("Enter");
		await expectRows(page, "bottom", ["agents", "usage", "memory", "settings", "cli", "guard"]);
		await expect(up).toBeFocused();
		await page.keyboard.press("Enter");
		await expectRows(page, "bottom", ["agents", "usage", "settings", "memory", "cli", "guard"]);
		// The first of a group has nothing above it.
		await expect(page.getByRole("button", { name: "Move Agent graph up in the Sidebar" })).toBeDisabled();

		// The group of Memory: Top. The item is in the top group now, and the control that moved it still has the focus.
		const memory = () => page.getByRole("combobox", { name: "Group of Memory in the Sidebar" });
		await memory().focus();
		await choose(memory(), "top");
		await expectRows(page, "top", ["memory"]);
		await expect(memory()).toBeFocused();

		// Hidden: gone from the sidebar, kept in the card's list, and still in the palette.
		await choose(page.getByRole("combobox", { name: "Group of Commands & terminal in the Sidebar" }), "hidden");
		await expect(page.getByTestId("nav-cli")).toHaveCount(0);
		await expect(page.getByTestId("nav-edit-group-sidebar-hidden").getByTestId("nav-edit-sidebar-cli")).toBeVisible();

		// The rail's controls are its own: the sidebar's arrangement did not move them.
		expect((await stored(page))?.rail).toEqual({ top: [], bottom: ALL, hidden: [] });
		await choose(page.getByRole("combobox", { name: /^Group of Guard in the Rail/ }), "top");
		await page.getByRole("button", { name: "Hide sidebar" }).click();
		await expectIcons(page, "top", ["guard"]);
		await page.getByRole("button", { name: "Show sidebar" }).click();
		await expectRows(page, "bottom", ["agents", "usage", "settings", "guard"]);

		await page.keyboard.press("ControlOrMeta+k");
		await expect(page.getByTestId("palette-go-cli")).toBeVisible();
		await page.keyboard.press("Escape");

		// Reset puts everything back, and says so in what is stored.
		await card.getByTestId("nav-layout-reset").click();
		await expectRows(page, "top", []);
		await expectRows(page, "bottom", ALL);
		expect(await stored(page)).toEqual({
			v: 1,
			sidebar: { top: [], bottom: ALL, hidden: [] },
			rail: { top: [], bottom: ALL, hidden: [] },
		});
	});

	test("a stored layout with a page this version does not know, or one it lacks, is read without losing the rest", async ({
		page,
	}) => {
		await page.addInitScript(
			([key]) => {
				localStorage.setItem(
					key,
					JSON.stringify({
						sidebar: { top: ["settings", "weather"], bottom: ["usage", "memory", "questions", "cli"], hidden: [] },
						rail: "garbage",
					}),
				);
			},
			[KEY],
		);
		await page.goto("/");
		await expect(page.getByTestId("nav-settings")).toBeVisible();
		await expectRows(page, "top", ["settings"]);
		// The Agent graph and the Guard, which the stored copy does not name, come in at their default group, after what is there.
		await expectRows(page, "bottom", ["usage", "memory", "cli", "agents", "guard"]);
		await page.getByRole("button", { name: "Hide sidebar" }).click();
		await expectIcons(page, "bottom", ALL);
	});

	test("the controls are named in Chinese", async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem("ompw.lang", "zh-CN"));
		await page.goto("/#/settings");
		const card = page.getByTestId("nav-layout-settings");
		await expect(card).toBeVisible();
		await expect(card.getByRole("heading", { level: 2 })).toHaveText("侧边栏与快捷栏");
		await expect(card.getByTestId("nav-layout-reset")).toHaveText("恢复默认");
		await expect(page.getByTestId("nav-guard")).toHaveText("防护");
		// Send feedback is a card of the App page.
		await page.locator('[data-testid="settings-page-tab"][data-page="app"]').click();
		await expect(page.getByTestId("feedback-settings").getByTestId("settings-feedback")).toContainText("发送反馈");
	});
});

test.describe("on a phone (390 px, touch)", () => {
	test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

	test("a finger drags a page in the drawer, and the order is kept", async ({ page }) => {
		await page.goto("/");
		await page.getByRole("button", { name: "Show sidebar" }).click();
		const usage = page.getByTestId("nav-usage");
		const memory = page.getByTestId("nav-memory");
		await expect(usage).toBeVisible();
		const cdp = await page.context().newCDPSession(page);
		const touch = (type: "touchStart" | "touchMove" | "touchEnd", p?: { x: number; y: number }) =>
			cdp.send("Input.dispatchTouchEvent", { type, touchPoints: p ? [p] : [] });
		// Usage onto the lower half of Memory.
		const from = await at(usage);
		await touch("touchStart", from);
		for (let i = 1; i <= 3; i++) await touch("touchMove", { x: from.x + 2 * i, y: from.y + 4 * i });
		const to = await at(memory, "bottom");
		for (let i = 1; i <= 8; i++) {
			await touch("touchMove", {
				x: from.x + ((to.x - from.x) * i) / 8,
				y: from.y + 12 + ((to.y - from.y - 12) * i) / 8,
			});
		}
		await touch("touchEnd");
		const order = ["agents", "memory", "usage", "cli", "settings", "guard"];
		await expectRows(page, "bottom", order);
		expect((await stored(page))?.sidebar.bottom).toEqual(order);
		await expect(page.getByTestId("usage-page")).toHaveCount(0);
	});
});
