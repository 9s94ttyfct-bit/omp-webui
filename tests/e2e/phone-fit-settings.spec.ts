import { DEFAULT_REMOTE_CONFIG, type RemoteSnapshot } from "../../shared/remote.ts";
import { NO_REMOTE_AI } from "../../shared/remote-ai.ts";
import { openSidebar } from "../support/live.ts";
import { distance, pixelsAt } from "../support/pixels.ts";
import { openProjects, projectPopover } from "../support/project-groups.ts";
import { type Box, boxOf } from "../support/style.ts";
import { devices, expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * Text that fits on a phone. At 390 px a title, a label or a select's own text was squeezed by the control beside it:
 * "Model guidance" broke over two lines under its buttons, "File transfer" was cut by its select, a running
 * conversation's name left one letter, "Model default" lost its last letters, "跟随系统" and "关闭" broke inside a box.
 * What is measured is layout, not wording: how many lines a text sits on, whether a select's text fits inside it, and
 * whether two boxes overlap. No model is called.
 */

const PHONE = { width: 390, height: 844 };
// A phone, touch and all: its text fields are 16px (iOS zooms into smaller ones), which is what squeezes a select's text.
const { defaultBrowserType: _browser, ...pixel } = devices["Pixel 5"];
test.use({ ...pixel, viewport: PHONE });

/** How many lines the text of `target` sits on: the text nodes' client rects, grouped by their top (the words of a select are not counted). */
async function linesOf(target: Locator): Promise<number> {
	return target.evaluate((el) => {
		const tops: number[] = [];
		const walk = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
		for (let node = walk.nextNode(); node; node = walk.nextNode()) {
			if (!node.textContent?.trim() || node.parentElement?.closest("select,option")) continue;
			const range = document.createRange();
			range.selectNodeContents(node);
			for (const rect of range.getClientRects()) if (rect.width > 0) tops.push(rect.top);
		}
		tops.sort((a, b) => a - b);
		let lines = 0;
		let last = Number.NEGATIVE_INFINITY;
		for (const top of tops) {
			// A line is taller than 4px: rects of one line differ by a fraction of a pixel.
			if (top - last > 4) lines++;
			last = top;
		}
		return lines;
	});
}

/** The width the text a `<select>` shows needs, and the width it has for it (its box without padding and chevron's room). */
async function selectFit(select: Locator): Promise<{ text: string; needs: number; has: number }> {
	return select.evaluate((el) => {
		const s = el as HTMLSelectElement;
		const css = getComputedStyle(s);
		const text = s.selectedOptions[0]?.text ?? "";
		const ctx = document.createElement("canvas").getContext("2d");
		if (!ctx) throw new Error("no canvas");
		ctx.font = `${css.fontStyle} ${css.fontWeight} ${css.fontSize} ${css.fontFamily}`;
		return {
			text,
			needs: ctx.measureText(text).width,
			has: s.clientWidth - Number.parseFloat(css.paddingLeft) - Number.parseFloat(css.paddingRight),
		};
	});
}

const intersect = (a: Box, b: Box): boolean =>
	a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** A text that is whole in its select: nothing the select shows is cut at its end. */
async function expectSelectTextFits(select: Locator): Promise<void> {
	const fit = await selectFit(select);
	expect(fit.needs, `"${fit.text}" in a select with room for ${fit.has}px`).toBeLessThanOrEqual(fit.has);
}

declare global {
	interface Window {
		/** How many ResizeObservers have watched a row of the settings index (see the test that counts them). */
		rowObservers: number;
	}
}

/** Settings at phone width, in the language the context has. */
async function settings(page: Page, to: string, size = PHONE): Promise<void> {
	await page.setViewportSize(size);
	await page.goto(`/#/settings/${to}`);
}

function suite(): void {
	test("Model guidance's title keeps one line above its buttons", async ({ page }) => {
		await settings(page, "models");
		const card = page.getByTestId("guidance-settings");
		await expect(card).toBeVisible({ timeout: 60_000 });
		const title = card.locator("h2");
		expect(await linesOf(title)).toBe(1);
		const titleBox = await boxOf(title);
		for (const id of ["guidance-restore", "guidance-new"]) {
			const button = card.getByTestId(id);
			expect(await linesOf(button), `${id} is on one line`).toBe(1);
			expect(intersect(titleBox, await boxOf(button)), `the title and ${id} overlap`).toBe(false);
		}
	});

	test("a model role's thinking select shows its whole text", async ({ page }) => {
		await settings(page, "models");
		const selects = page.getByTestId("model-roles").getByTestId("role-thinking");
		await expect(selects.first()).toBeVisible({ timeout: 60_000 });
		for (const select of await selects.all()) await expectSelectTextFits(select);
	});

	test("a quick prompt's 'while the agent works' select shows its whole text, its label on one line", async ({
		page,
	}) => {
		await settings(page, "chats");
		const select = page.getByTestId("quick-prompt-mode").first();
		await expect(select).toBeVisible({ timeout: 60_000 });
		await expectSelectTextFits(select);
		expect(await linesOf(select.locator("xpath=ancestor::label[1]"))).toBe(1);
	});

	test("every Appearance option is on one line", async ({ page }) => {
		await settings(page, "look");
		const options = page.locator('fieldset:has(input[name="theme"]) label');
		await expect(options).toHaveCount(3, { timeout: 60_000 });
		for (const option of await options.all()) expect(await linesOf(option)).toBe(1);
	});

	test("the rows of pages and cards say there is more beyond the edge, and their arrows show it (S1)", async ({
		page,
	}) => {
		await settings(page, "chats");
		const index = page.getByTestId("settings-index");
		await expect(index.getByTestId("settings-index-chip").first()).toBeVisible({ timeout: 60_000 });
		const right = index.getByTestId("scroll-row-right");
		// At least one of the two rows (pages, cards) runs past the phone's width and offers its arrow.
		await expect(right.first()).toBeVisible();
		const row = right.first().locator("xpath=ancestor::div[1]/preceding-sibling::ul[1]");
		const before = await row.evaluate((el) => el.scrollLeft);
		await right.first().click();
		await expect.poll(() => row.evaluate((el) => el.scrollLeft)).toBeGreaterThan(before);
		await expect(index.getByTestId("scroll-row-left").first()).toBeVisible();
	});

	test("a row of pages or cards keeps one size observer while the page renders again", async ({ page }) => {
		// Counts the ResizeObservers that watch a row of the index (the `ul` of a `ScrollRow` in it).
		await page.addInitScript(() => {
			const Real = window.ResizeObserver;
			const rows = new WeakSet<ResizeObserver>();
			window.rowObservers = 0;
			window.ResizeObserver = class extends Real {
				override observe(target: Element, options?: ResizeObserverOptions) {
					const row = target.parentElement?.parentElement?.getAttribute("data-testid") === "settings-index";
					if (row && target.tagName === "UL" && !rows.has(this)) {
						rows.add(this);
						window.rowObservers++;
					}
					super.observe(target, options);
				}
			};
		});
		const observers = () => page.evaluate(() => window.rowObservers);
		await settings(page, "chats");
		const index = page.getByTestId("settings-index");
		await expect(index.getByTestId("settings-index-chip").first()).toBeVisible({ timeout: 60_000 });
		// The two rows, pages and cards.
		await expect.poll(observers).toBe(2);
		// A row renders again each time an edge has more to see, or no longer has: scroll it there and back.
		for (let i = 0; i < 2; i++) {
			await index.getByTestId("scroll-row-right").first().click();
			await expect(index.getByTestId("scroll-row-left").first()).toBeVisible();
			await index.getByTestId("scroll-row-left").first().click();
			await expect(index.getByTestId("scroll-row-left")).toHaveCount(0);
		}
		expect(await observers(), "still one per row").toBe(2);
	});

	test("an arrow of those rows sits on the plain background, never on a half-faded label", async ({ page }) => {
		await settings(page, "chats");
		const index = page.getByTestId("settings-index");
		await expect(index.getByTestId("settings-index-chip").first()).toBeVisible({ timeout: 60_000 });
		const right = index.getByTestId("scroll-row-right").first();
		await expect(right).toBeVisible();
		// A row of pages whose right arrow lies on the first label that runs past the edge.
		const row = right.locator("xpath=ancestor::div[1]/preceding-sibling::ul[1]");
		await page.mouse.move(0, 0);
		// The pixels under an arrow, left and right of its chevron, are those of the page's own background.
		const under = async (arrow: Locator) => {
			const box = await boxOf(arrow);
			const nav = await boxOf(index);
			const y = box.y + box.height / 2;
			const points = [-4, 0, 4].flatMap((dy) =>
				[2, 3, 4, 5, 23, 24, 25, 26].map((dx) => ({ x: box.x + dx, y: y + dy })),
			);
			const png = await page.screenshot({ scale: "css" });
			const [plain, ...pixels] = await pixelsAt(page, png, [{ x: nav.x + 2, y: nav.y + 2 }, ...points]);
			return pixels.map((p) => distance(p, plain));
		};
		expect(Math.max(...(await under(right))), "the right arrow").toBeLessThanOrEqual(2);
		await right.click();
		const left = index.getByTestId("scroll-row-left").first();
		await expect(left).toBeVisible();
		await expect.poll(() => row.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);
		await page.mouse.move(0, 0);
		// The scroll is smooth: wait until the row stopped.
		await expect
			.poll(async () => {
				const a = await row.evaluate((el) => el.scrollLeft);
				await page.waitForTimeout(120);
				return a === (await row.evaluate((el) => el.scrollLeft));
			})
			.toBe(true);
		expect(Math.max(...(await under(left))), "the left arrow").toBeLessThanOrEqual(2);
	});

	test("a card whose heading is a sentence has a short chip (S2)", async ({ page }) => {
		await settings(page, "chats");
		const chips = page.getByTestId("settings-index-chip");
		await expect(chips.first()).toBeVisible({ timeout: 60_000 });
		for (const chip of await chips.all()) {
			const text = (await chip.textContent()) ?? "";
			expect(text.length, `"${text}" is a short label`).toBeLessThanOrEqual(24);
		}
	});

	test("the navigation order keeps each item's whole name (S3)", async ({ page }) => {
		await settings(page, "look");
		const names = page.locator('[data-testid^="nav-edit-sidebar-"] > span:first-child > span');
		await expect(names.first()).toBeVisible({ timeout: 60_000 });
		for (const name of await names.all()) {
			const cut = await name.evaluate((el) => el.scrollWidth > el.clientWidth);
			expect(cut, `"${await name.textContent()}" is cut`).toBe(false);
		}
	});

	test("every shortcut puts its name on a line above its keys (S4)", async ({ page }) => {
		await settings(page, "look");
		const rows = page.locator('[data-testid^="shortcut-"]:is(li)');
		await expect(rows.first()).toBeVisible({ timeout: 60_000 });
		for (const row of (await rows.all()).slice(0, 8)) {
			const name = row.locator("div > span").first();
			const keys = row.locator("div > span").nth(1);
			const [n, k] = [await boxOf(name), await boxOf(keys)];
			expect(k.y, "the keys are under the name").toBeGreaterThanOrEqual(n.y + n.height - 1);
		}
	});

	test("File transfer's title is whole and the select does not cover it", async ({ page }) => {
		const snap: RemoteSnapshot = {
			config: { ...DEFAULT_REMOTE_CONFIG },
			status: { state: "off" },
			installed: false,
			loggedIn: false,
			url: "",
			ai: NO_REMOTE_AI,
		};
		await page.route(/\/api\/remote(\/|$)/, (route) => route.fulfill({ json: snap }));
		await settings(page, "app");
		const card = page.getByTestId("remote-file-transfer");
		await expect(card).toBeVisible({ timeout: 60_000 });
		const title = card.locator("label").first();
		expect(await linesOf(title)).toBe(1);
		const select = card.getByTestId("remote-file-transfer-select");
		expect(intersect(await boxOf(title), await boxOf(select)), "the title and the select overlap").toBe(false);
		await expectSelectTextFits(select);
	});

	test("a running conversation's name keeps most of its row", async ({ page }) => {
		// The Accounts helper is the one running process a spec can ask for without a conversation: its name is long.
		await settings(page, "models");
		await page.getByTestId("accounts-toggle").click();
		await expect(page.getByTestId("provider").first()).toBeVisible({ timeout: 60_000 });
		await page.locator('[data-testid="settings-page-tab"][data-page="app"]').click();
		// The helper an earlier test of this file started may still be running on the same server: any row will do.
		const row = page.getByTestId("running-session").first();
		await expect(row).toBeVisible();
		const name = row.locator("span.truncate");
		const rowBox = await boxOf(row);
		const nameBox = await boxOf(name);
		// It was one letter wide beside "idle · closes after 15 min", the process id and Close.
		expect(nameBox.width).toBeGreaterThan(rowBox.width / 2);
		expect(intersect(nameBox, await boxOf(row.getByTestId("running-status")))).toBe(false);
	});

	test("the sidebar's project list has its Close button on one line", async ({ page }) => {
		await page.goto("/");
		// On a phone the sidebar is a drawer, closed at first.
		await openSidebar(page);
		await openProjects(page);
		const close = projectPopover(page).getByRole("button", { name: /^(Close|关闭)$/ });
		await expect(close).toBeVisible();
		expect(await linesOf(close)).toBe(1);
		const box = await boxOf(close);
		expect(box.width).toBeGreaterThan(box.height);
	});
}

test.describe("on a phone", suite);

test.describe("on a phone, in Chinese", () => {
	test.use({ locale: "zh-CN" });
	suite();
});

test("a signed-in provider's badge and buttons stay on one line each on a narrow phone", async ({ page }) => {
	// Onboarding's frame is narrower than Settings', so the row breaks at 390 there; at 320 it does here.
	await settings(page, "models", { width: 320, height: 640 });
	await page.getByTestId("accounts-toggle").click();
	const provider = page.locator('[data-testid="provider"][data-provider="anthropic"]');
	await expect(provider).toBeVisible({ timeout: 60_000 });
	const controls = provider.locator("button, span.inline-flex");
	const count = await controls.count();
	expect(count).toBeGreaterThan(2);
	const row = await boxOf(provider);
	for (let i = 0; i < count; i++) {
		const control = controls.nth(i);
		expect(await linesOf(control), `control ${i} is on one line`).toBe(1);
		const box = await boxOf(control);
		expect(box.x + box.width, `control ${i} stays inside the row`).toBeLessThanOrEqual(row.x + row.width + 1);
	}
});
