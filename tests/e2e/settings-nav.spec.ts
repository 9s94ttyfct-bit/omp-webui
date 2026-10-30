import { boxOf } from "../support/geometry.ts";
import { appReady } from "../support/live.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * Settings is five pages of cards (v0.11.18 §10), each its own address; its index (no model call). Where the page leaves
 * a margin beside the column, the index is a list in that margin: the five pages, the shown page's cards under its name.
 * Below that it is two rows under the title: the pages, then the shown page's cards as chips. Choosing a card brings it
 * to the top, and the current card follows the scroll; choosing a page shows only its cards, from the top.
 */

/** The page's scroller. */
const settings = (page: Page) => page.getByTestId("settings-page");
/** The cards of the page shown. */
const cards = (page: Page) => settings(page).locator("[data-settings-page]:not(.hidden) > section");
const pageTab = (page: Page, id: string) => page.locator(`[data-testid="settings-page-tab"][data-page="${id}"]`);

/**
 * The name each card of the page shown has in the index, in page order: its short label when its heading is a sentence
 * (`data-index-title`), else its heading. Cards without a heading are not listed.
 */
async function titlesOf(page: Page): Promise<string[]> {
	return cards(page).evaluateAll((els) =>
		els
			.map((el) => (el as HTMLElement).dataset.indexTitle?.trim() || el.querySelector("h2")?.textContent?.trim() || "")
			.filter((title) => title !== ""),
	);
}

/** The card of the page shown with a given index name. */
async function cardByTitle(page: Page, title: string): Promise<Locator> {
	const titles = await cards(page).evaluateAll((els) =>
		els.map(
			(el) => (el as HTMLElement).dataset.indexTitle?.trim() || el.querySelector("h2")?.textContent?.trim() || "",
		),
	);
	const index = titles.indexOf(title);
	expect(index, `the page has a card named "${title}"`).toBeGreaterThanOrEqual(0);
	return cards(page).nth(index);
}

/** How far the top of `el` is below the top of the page's scroller. */
async function belowTop(page: Page, el: Locator): Promise<number> {
	return (await boxOf(el)).y - (await boxOf(settings(page))).y;
}

/** Scroll the page so that the card with a given title starts `gap` pixels under the top. */
async function scrollCardTo(page: Page, title: string, gap: number) {
	const card = await cardByTitle(page, title);
	await card.evaluate((el, g) => {
		const scroller = el.closest<HTMLElement>('[data-testid="settings-page"]');
		if (!scroller) return;
		scroller.scrollTop += el.getBoundingClientRect().top - scroller.getBoundingClientRect().top - g;
	}, gap);
}

async function open(page: Page, lang: "en" | "zh-CN", hash = "#/settings") {
	await page.addInitScript((l) => localStorage.setItem("ompw.lang", l), lang);
	await page.goto(`/${hash}`);
	await expect(settings(page)).toBeVisible();
}

const index = (page: Page, lang: "en" | "zh-CN") =>
	page.getByRole("navigation", { name: lang === "en" ? "Settings sections" : "设置分区" });

/** The index's entry for a card of the page shown (the margin's list, or a chip in the narrow row). */
const entryFor = (page: Page, lang: "en" | "zh-CN", title: string) =>
	index(page, lang).getByRole("button", { name: title, exact: true });

for (const lang of ["en", "zh-CN"] as const) {
	test.describe(`beside the column (1400 px), ${lang}`, () => {
		test.use({ viewport: { width: 1400, height: 900 } });

		test("the margin lists the pages and the shown page's cards, takes you to one, and follows the scroll", async ({
			page,
		}) => {
			// `#/settings` alone is the page last shown: none yet, so the first; the address names it.
			await open(page, lang);
			await expect(page).toHaveURL(/#\/settings\/look$/);
			await expect(pageTab(page, "look")).toHaveAttribute("aria-current", "page");
			await expect(page.getByTestId("settings-page-tab")).toHaveCount(5);

			// The Conversations page: only its cards are shown, and they are what the margin lists under its name.
			await pageTab(page, "chats").click();
			await expect(page).toHaveURL(/#\/settings\/chats$/);
			await expect(page.getByTestId("quick-prompts-settings")).toBeVisible();
			await expect(page.getByTestId("palette-picker")).toBeHidden();
			const nav = index(page, lang);
			const entries = nav.getByTestId("settings-index-entry");
			await expect
				.poll(async () => (await entries.allTextContents()).map((s) => s.trim()))
				.toEqual(await titlesOf(page));
			const titles = await titlesOf(page);
			expect(titles.length, "the page has several cards").toBeGreaterThanOrEqual(5);

			// It hangs in the margin left of the column, and the first card is the current one.
			const column = await boxOf(cards(page).first());
			const first = await boxOf(entries.first());
			expect(first.x).toBeGreaterThanOrEqual(0);
			expect(first.x + first.width, "left of the column").toBeLessThanOrEqual(column.x);
			await expect(entries.first()).toHaveAttribute("aria-current", "true");
			await expect(nav.locator('[data-testid="settings-index-entry"][aria-current="true"]')).toHaveCount(1);
			const page0 = await boxOf(settings(page));
			const listBox = await boxOf(nav.locator("ul").first());
			expect(listBox.y + listBox.height, "the list ends inside the page").toBeLessThanOrEqual(page0.y + page0.height);

			// Choosing an entry brings its card to the top of the page and makes it current; the address stays the page's.
			const target = titles[3];
			await entryFor(page, lang, target).click();
			const targetCard = await cardByTitle(page, target);
			await expect.poll(() => belowTop(page, targetCard)).toBeLessThan(60);
			expect(await belowTop(page, targetCard)).toBeGreaterThanOrEqual(-2);
			await expect(entryFor(page, lang, target)).toHaveAttribute("aria-current", "true");
			expect(new URL(page.url()).hash, "the route is unchanged").toBe("#/settings/chats");

			// The list stays in view while the page scrolls.
			const listed = await boxOf(pageTab(page, "look"));
			expect(listed.y, "the index is still on screen").toBeGreaterThanOrEqual(0);
			expect(listed.y).toBeLessThan(120);

			// The current entry follows the scroll, up and down, and the last one is current at the very end.
			for (const at of [1, 2, 0]) {
				await scrollCardTo(page, titles[at], 40);
				await expect(entryFor(page, lang, titles[at])).toHaveAttribute("aria-current", "true");
			}
			await settings(page).evaluate((scroller) => {
				scroller.scrollTop = scroller.scrollHeight;
			});
			await expect(entries.last()).toHaveAttribute("aria-current", "true");

			// Another page starts at its top and lists its own cards; Back is the page before, where it was left.
			await pageTab(page, "safety").click();
			await expect(page).toHaveURL(/#\/settings\/safety$/);
			await expect(page.getByTestId("approval-settings")).toBeVisible();
			await expect.poll(() => settings(page).evaluate((el) => el.scrollTop)).toBe(0);
			await expect
				.poll(async () => (await entries.allTextContents()).map((s) => s.trim()))
				.toEqual(await titlesOf(page));
			await page.goBack();
			await expect(page).toHaveURL(/#\/settings\/chats$/);
			await expect(page.getByTestId("quick-prompts-settings")).toBeVisible();

			// `#/settings` opens the page last shown.
			await page.goto("/#/");
			await page.goto("/#/settings");
			await expect(page).toHaveURL(/#\/settings\/chats$/);
		});
	});
}

/** Scroll the page so that the bottom of a card is `left` pixels under the top of the page. */
async function scrollCardEndTo(card: Locator, left: number) {
	await card.evaluate((el, g) => {
		const scroller = el.closest<HTMLElement>('[data-testid="settings-page"]');
		if (!scroller) return;
		scroller.scrollTop += el.getBoundingClientRect().bottom - scroller.getBoundingClientRect().top - g;
	}, left);
}

for (const lang of ["en", "zh-CN"] as const) {
	test.describe(`a tall window (1920 × 1080), ${lang}`, () => {
		test.use({ viewport: { width: 1920, height: 1080 } });

		test("a card scrolled mostly out of the top is no longer the current one: the card below it is what is read (S10)", async ({
			page,
		}) => {
			await open(page, lang, "#/settings/chats");
			await expect(page.getByTestId("quick-prompts-settings")).toBeVisible();
			const titles = await titlesOf(page);
			await expect
				.poll(async () => (await index(page, lang).getByTestId("settings-index-entry").allTextContents()).length)
				.toBe(titles.length);
			// A tall card that has a card after it: the quick prompts, the longest card of the page.
			const heights = await cards(page).evaluateAll((els) =>
				els.map((el) => ({
					title: (el as HTMLElement).dataset.indexTitle?.trim() || el.querySelector("h2")?.textContent?.trim() || "",
					height: el.getBoundingClientRect().height,
				})),
			);
			const named = heights.filter((c) => c.title !== "");
			const at = named.findIndex((c, i) => i < named.length - 1 && c.height >= 600);
			expect(at, "a tall card with another after it").toBeGreaterThanOrEqual(0);
			const card = await cardByTitle(page, named[at].title);
			const top = await boxOf(settings(page));
			const [here, below] = [entryFor(page, lang, named[at].title), entryFor(page, lang, named[at + 1].title)];
			const current = index(page, lang).locator('[data-testid="settings-index-entry"][aria-current="true"]');

			// 500 px of it left in the page (the window is 1080 tall): it is what is being read.
			await scrollCardEndTo(card, 500);
			await expect(here).toHaveAttribute("aria-current", "true");
			// 200 px of it left: that is a few lines at the top of a page of 1080, and the card below is on its way up.
			await scrollCardEndTo(card, 200);
			const box = await boxOf(card);
			expect(box.y, "the card has scrolled out at the top").toBeLessThan(top.y);
			expect(box.y + box.height - top.y, "with 200 px of it left").toBeCloseTo(200, -1);
			await expect(below).toHaveAttribute("aria-current", "true");
			await expect(current).toHaveCount(1);
			// At the top of the page the first card is the current one again.
			await settings(page).evaluate((scroller) => {
				scroller.scrollTop = 0;
			});
			await expect(index(page, lang).getByTestId("settings-index-entry").first()).toHaveAttribute(
				"aria-current",
				"true",
			);
		});
	});
}

test.describe("links into Settings (1400 px)", () => {
	test.use({ viewport: { width: 1400, height: 900 } });

	test("the search finds a setting on another page, shows that page and marks it", async ({ page }) => {
		await open(page, "en", "#/settings/look");
		// The card is a chunk of its own: until it has loaded it is not a result (the test below covers that moment).
		await expect(page.getByTestId("unattended-settings")).toBeAttached();
		await page.getByTestId("settings-search").getByRole("combobox").fill("unattended");
		await page.keyboard.press("Enter");
		await expect(page).toHaveURL(/#\/settings\/safety$/);
		const card = page.getByTestId("unattended-settings");
		await expect(card).toBeInViewport();
		await expect(page.locator('[data-marked="true"]')).toHaveCount(1);
	});

	test("a mouse pointer resting where the results open does not take Enter from the top result (#679)", async ({
		page,
	}) => {
		await open(page, "en", "#/settings/look");
		await expect(page.getByTestId("unattended-settings")).toBeAttached();
		const field = page.getByTestId("settings-search").getByRole("combobox");
		// Learn where the second result shows, then close the list and leave the pointer there, unmoved. "away" finds
		// Unattended mode by its alias first, and other settings by the word in their sentences.
		await field.fill("away");
		const second = page.getByTestId("settings-search-result").nth(1);
		const box = await second.boundingBox();
		if (!box) throw new Error("no second result");
		await field.fill("");
		await page.keyboard.press("Escape");
		await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
		await field.fill("away");
		await expect(page.getByTestId("settings-search-result").first()).toHaveAttribute("aria-selected", "true");
		await page.keyboard.press("Enter");
		await expect(page).toHaveURL(/#\/settings\/safety$/);
	});

	test("a card that loads after the query was typed joins the results, and Enter takes the first result then (#679)", async ({
		page,
	}) => {
		// The Unattended mode card is a chunk of its own: hold it until the query is typed, as a slow machine does.
		let release!: () => void;
		const held = new Promise<void>((r) => {
			release = r;
		});
		await page.route(/\/UnattendedSettings-[^/]+\.js$/, async (route) => {
			await held;
			await route.continue();
		});
		await open(page, "en", "#/settings/look");
		await page.getByTestId("settings-search").getByRole("combobox").fill("away");
		const results = page.getByTestId("settings-search-result");
		await expect(results.first()).toHaveAttribute("aria-selected", "true");
		await expect(page.locator('[data-entry="unattended"]')).toHaveCount(0);
		release();
		await expect(results.first()).toHaveAttribute("data-entry", "unattended");
		await expect(results.first()).toHaveAttribute("aria-selected", "true");
		await page.keyboard.press("Enter");
		await expect(page).toHaveURL(/#\/settings\/safety$/);
	});

	test("the keyboard shortcuts key opens the page that has its card, at the card", async ({ page }) => {
		await open(page, "en", "#/settings/app");
		await page.goto("/#/");
		await appReady(page);
		await page.locator("body").click({ position: { x: 600, y: 10 } });
		await page.keyboard.press("?");
		await expect(page).toHaveURL(/#\/settings\/look$/);
		await expect(page.getByTestId("shortcuts-settings")).toBeInViewport();
	});
});

test.describe("under the title (390 px)", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("a row of pages and a row of the page's cards stay at the top, and a chosen card is not hidden under them", async ({
		page,
	}) => {
		await open(page, "en", "#/settings/chats");
		const nav = index(page, "en");
		const tabs = page.getByTestId("settings-page-tab");
		const tabTops = await tabs.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
		expect(new Set(tabTops).size, "the pages are one row").toBe(1);
		const chips = nav.getByTestId("settings-index-chip");
		// Cards that load late (quick prompts, the projects folder, notifications) join both lists: compare them as they are now.
		await expect
			.poll(async () => {
				const shown = (await chips.allTextContents()).map((s) => s.trim());
				return JSON.stringify(shown) === JSON.stringify(await titlesOf(page)) && shown.length > 0;
			})
			.toBe(true);
		const titles = await titlesOf(page);
		const chipTops = await chips.evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)));
		expect(new Set(chipTops).size, "the cards are one row").toBe(1);
		expect(chipTops[0], "under the pages").toBeGreaterThan(tabTops[0]);
		const row = chips.first().locator("xpath=../..");
		expect(await row.evaluate((el) => el.scrollWidth > el.clientWidth), "more chips than fit scroll sideways").toBe(
			true,
		);
		expect((await boxOf(chips.first())).height, "a comfortable target").toBeGreaterThanOrEqual(28);

		// The rows stay at the top of the page while it scrolls, and a chosen card starts below them.
		await settings(page).evaluate((scroller) => {
			scroller.scrollTop = 900;
		});
		await expect.poll(() => belowTop(page, nav)).toBeLessThanOrEqual(2);
		// A card with enough of the page after it to reach the top (the last ones cannot).
		const target = titles[2];
		const chip = entryFor(page, "en", target);
		await chip.scrollIntoViewIfNeeded();
		await chip.click();
		await expect(chip).toHaveAttribute("aria-current", "true");
		const bar = await boxOf(nav);
		const targetCard = await cardByTitle(page, target);
		await expect.poll(async () => (await boxOf(targetCard)).y).toBeGreaterThanOrEqual(bar.y + bar.height - 1);
		expect((await boxOf(targetCard)).y, "right under the rows").toBeLessThan(bar.y + bar.height + 40);
		// The current chip is inside the row's visible part.
		const chipBox = await boxOf(chip);
		const visible = await boxOf(row);
		expect(chipBox.x).toBeGreaterThanOrEqual(visible.x - 1);
		expect(chipBox.x + chipBox.width).toBeLessThanOrEqual(visible.x + visible.width + 1);
	});
});
