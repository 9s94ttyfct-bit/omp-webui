import { FIXTURE } from "../support/fixtures.ts";
import { boxOf } from "../support/style.ts";
import { devices, expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * Phone behavior (no model call): text fields are 16px on touch screens (iOS Safari zooms into smaller ones), the app,
 * the sidebar drawer and the composer keep clear of the notch, the status bar and the home indicator, palette titles
 * keep their room, and the composer's footer wraps instead of hiding controls behind Send.
 */

const { defaultBrowserType: _browser, ...pixel } = devices["Pixel 5"];
const PHONE = { ...pixel, viewport: { width: 390, height: 844 } };
/** The search button's name carries its shortcut: ⌘K on Apple platforms, Ctrl+K elsewhere (the CI runner). */
const SEARCH = /^Search \((⌘|Ctrl\+)K\)$/;

/** Visible text fields under 16px. */
const smallFields = (page: Page) =>
	page.evaluate(() => {
		const notText = ["checkbox", "radio", "file", "range", "color", "button", "submit", "reset", "image", "hidden"];
		return [...document.querySelectorAll<HTMLElement>("input, textarea, select")]
			.filter((el) => !(el instanceof HTMLInputElement && notText.includes(el.type)))
			.filter((el) => el.getClientRects().length > 0)
			.map((el) => ({
				field: el.getAttribute("aria-label") ?? el.dataset.testid ?? el.tagName,
				size: getComputedStyle(el).fontSize,
			}))
			.filter((f) => Number.parseFloat(f.size) < 16);
	});

/** The (virtual) notch, status bar and home indicator: what `env(safe-area-inset-*)` reports. */
async function setInsets(page: Page, insets: { top?: number; bottom?: number; left?: number; right?: number }) {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Emulation.setSafeAreaInsetsOverride", {
		insets: { top: 0, bottom: 0, left: 0, right: 0, ...insets },
	});
}

const composerCard = (page: Page) =>
	page.getByTestId("composer").locator("xpath=ancestor::div[contains(@class,'rounded-2xl')][1]");

/** Text as it reads, on one line. */
const words = (text: string) => text.replace(/\s+/g, " ").trim();

// New chat's own folder: left to itself it takes the most recent conversation's, which an earlier spec of the worker may
// have removed (git-status's, resume-folder's), and New chat then shows that error instead of the model picker.
test.beforeEach(async ({ page }) => {
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
});

test("on a desktop the fields keep their size", async ({ page }) => {
	await page.goto("/");
	expect(await page.getByTestId("composer").evaluate((el) => getComputedStyle(el).fontSize)).toBe("15px");
	expect(await page.getByTestId("session-filter").evaluate((el) => getComputedStyle(el).fontSize)).toBe("14px");
});

test("on a desktop the composer has no ⋯: every control is in its row", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	await expect(page.getByTestId("composer-more")).toBeHidden();
	for (const id of ["thinking-picker", "guard-picker", "goal-mode"])
		await expect(page.getByTestId(id), id).toBeVisible();
	// The wide row is unchanged: the value alone, as the name is in the tooltip.
	await expect(page.getByText("Thinking:", { exact: true })).toBeHidden();
	expect(words(await page.getByTestId("mode-picker").innerText())).toMatch(/^(Full|Light)$/);
});

/**
 * Types a word omp can complete and checks that the ghost-text layer drawn over the textarea sets its text exactly
 * like the textarea does (omp predicts offline, from its word list); if they differ, the prediction drifts off the
 * words. Returns the text size both share.
 */
async function ghostMatchesTextarea(page: Page): Promise<string> {
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 }); // omp is warm: it predicts
	const composer = page.getByTestId("composer");
	await composer.pressSequentially("Please refa", { delay: 40 });
	const ghost = page.getByTestId("ghost");
	await expect(ghost).toHaveText("ctoring", { timeout: 30_000 });
	const typeOf = (el: Locator) =>
		el.evaluate((e) => {
			const s = getComputedStyle(e);
			return [
				s.fontSize,
				s.lineHeight,
				s.fontFamily,
				s.letterSpacing,
				s.paddingTop,
				s.paddingLeft,
				s.paddingRight,
				s.whiteSpace,
				s.overflowWrap,
				e.clientWidth,
			].join("|");
		});
	expect(await typeOf(ghost.locator("xpath=.."))).toBe(await typeOf(composer));
	return composer.evaluate((e) => getComputedStyle(e).fontSize);
}

test("on a desktop the ghost text keeps the textarea's type", async ({ page }) => {
	expect(await ghostMatchesTextarea(page)).toBe("15px");
});

test.describe("phone", () => {
	test.use(PHONE);

	test("every text field is 16px, so iOS does not zoom into it", async ({ page }) => {
		await page.goto("/");
		expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
		await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
		expect(await smallFields(page), "new chat").toEqual([]);
		await page.getByRole("button", { name: /^Options/ }).click();
		await expect(page.getByTestId("flag-form")).toBeVisible();
		expect(await smallFields(page), "session options").toEqual([]);

		await page.getByRole("button", { name: "Show sidebar" }).click();
		await expect(page.getByTestId("session-filter")).toBeVisible();
		expect(await smallFields(page), "sidebar").toEqual([]);

		await page.getByRole("button", { name: SEARCH }).click();
		await expect(page.getByTestId("palette-input")).toBeVisible();
		expect(await smallFields(page), "search").toEqual([]);
		await page.keyboard.press("Escape");

		await page.getByRole("button", { name: "Commands & terminal" }).click();
		await expect(page.getByTestId("cli-page")).toBeVisible();
		expect(await smallFields(page), "commands").toEqual([]);

		await page.getByRole("button", { name: "Show sidebar" }).click();
		await page.getByRole("button", { name: "Settings", exact: true }).click();
		await expect(page.getByTestId("settings-page")).toBeVisible();
		// Only the shown page's fields are on the screen: look at each of the five.
		for (const p of ["look", "chats", "models", "safety", "app"]) {
			await page.locator(`[data-testid="settings-page-tab"][data-page="${p}"]`).click();
			await expect(page.locator(`[data-settings-page="${p}"]`)).toBeVisible();
			expect(await smallFields(page), `settings ${p}`).toEqual([]);
		}

		await page.getByRole("button", { name: "Show sidebar" }).click();
		await page.locator('[data-testid="session-item"]', { hasText: FIXTURE.alphaTitle }).click();
		await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.alphaTitle);
		expect(await smallFields(page), "conversation").toEqual([]);
	});

	test("on a touch screen the ghost text grows to 16px together with the textarea", async ({ page }) => {
		expect(await ghostMatchesTextarea(page)).toBe("16px");
	});

	test("palette titles keep at least 20 characters", async ({ page }) => {
		await page.goto("/");
		await page.getByRole("button", { name: "Show sidebar" }).click();
		await page.getByRole("button", { name: SEARCH }).click();
		// Asked for by title: with no query only the six newest show, and other specs' conversations are newer.
		await page.getByTestId("palette-input").fill("Fixture");
		const row = page
			.getByRole("option")
			.filter({ hasText: /^Fixture / })
			.first();
		await expect(row).toBeVisible();
		const shown = await row
			.locator(".truncate")
			.first()
			.evaluate((el: HTMLElement) => {
				// The title is one text node (the cast is the DOM's: an element's first child here is that node).
				const node = el.firstChild as Text;
				if (el.scrollWidth <= el.clientWidth) return node.data.length;
				const range = document.createRange();
				range.setStart(node, 0);
				const probe = document.createElement("span");
				probe.textContent = "…";
				probe.style.cssText = "position:absolute;visibility:hidden;white-space:pre";
				el.append(probe);
				const ellipsis = probe.getBoundingClientRect().width;
				probe.remove();
				let n = node.data.length;
				for (; n > 0; n--) {
					range.setEnd(node, n);
					if (range.getBoundingClientRect().width + ellipsis <= el.clientWidth) break;
				}
				return n;
			});
		expect(shown).toBeGreaterThanOrEqual(20);
	});

	test("the composer footer keeps the main controls in its row and the rest behind ⋯, none behind Send", async ({
		page,
	}) => {
		await page.goto("/");
		await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
		await expect(page.getByTestId("guard-picker")).toBeAttached();
		const card = await boxOf(composerCard(page));
		const send = await boxOf(page.getByTestId("send"));
		const inCard = async (id: string) => {
			const b = await boxOf(page.getByTestId(id));
			expect(b.x, id).toBeGreaterThanOrEqual(card.x);
			expect(b.x + b.width, id).toBeLessThanOrEqual(card.x + card.width);
			expect(b.y + b.height, id).toBeLessThanOrEqual(card.y + card.height);
			const overlapsSend =
				b.x < send.x + send.width && send.x < b.x + b.width && b.y < send.y + send.height && send.y < b.y + b.height;
			expect(overlapsSend, `${id} overlaps Send`).toBe(false);
		};
		for (const id of ["model-picker", "approval-picker", "composer-more"]) await inCard(id);
		// The less used ones are not in the row until ⋯ is pressed…
		const more = ["thinking-picker", "guard-picker", "mode-picker", "goal-mode"];
		for (const id of more) await expect(page.getByTestId(id), id).toBeHidden();
		await page.getByTestId("composer-more").click();
		const panel = page.getByTestId("composer-more-panel");
		await expect(panel).toBeVisible();
		// …then each is in the panel, on the screen, and says what it is (its words, not only an icon).
		const view = page.viewportSize() ?? { width: 390, height: 844 };
		for (const id of more) {
			const control = panel.getByTestId(id);
			await expect(control, id).toBeVisible();
			const b = await boxOf(control);
			expect(b.x, id).toBeGreaterThanOrEqual(0);
			expect(b.x + b.width, id).toBeLessThanOrEqual(view.width);
			expect(b.y, id).toBeGreaterThanOrEqual(0);
			expect((await control.innerText()).trim(), id).not.toBe("");
		}
		// Each names its setting with the value, not "Low" or "Full" alone.
		await expect(panel.getByText("Thinking:", { exact: true })).toBeVisible();
		expect(words(await panel.getByTestId("mode-picker").innerText())).toMatch(/^Mode: (Full|Light)$/);
		// The guard and the permission mode are not two of the same shield.
		const icon = (id: string) =>
			page
				.getByTestId(id)
				.locator("svg")
				.first()
				.evaluate((el) => [...el.classList].find((c) => c.startsWith("lucide-") && c !== "lucide-icon") ?? "");
		expect(await icon("guard-picker")).not.toMatch(/shield/);
		expect(await icon("approval-picker")).toMatch(/shield/);
		// A picker opened from the panel keeps the panel open; Escape closes its popover first, then the panel.
		await panel.getByTestId("guard-picker").click();
		await expect(page.getByRole("dialog")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByRole("dialog")).toBeHidden();
		await expect(panel).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(panel).toBeHidden();
		await expect(page.getByTestId("composer-more")).toBeFocused();
	});

	test("the ⋯ panel names the settings in Chinese too", async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem("ompw.lang", "zh-CN"));
		await page.goto("/");
		await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
		await page.getByTestId("composer-more").click();
		const panel = page.getByTestId("composer-more-panel");
		await expect(panel.getByText("思考强度：", { exact: true })).toBeVisible();
		expect(words(await panel.getByTestId("mode-picker").innerText())).toMatch(/^模式： (完整|轻量)$/);
	});

	test("the app, the drawer and the composer keep clear of the status bar and the home indicator", async ({ page }) => {
		await page.goto("/");
		await setInsets(page, { top: 47, bottom: 34 });
		const toggle = page.getByRole("button", { name: "Show sidebar" });
		expect((await boxOf(toggle)).y).toBeGreaterThanOrEqual(47);

		// The drawer's background runs under the bars; what it holds does not.
		await toggle.click();
		const drawer = page.getByRole("complementary");
		await expect(drawer).toBeVisible();
		expect((await boxOf(drawer)).y).toBe(0);
		expect((await boxOf(drawer.locator("button").first())).y).toBeGreaterThanOrEqual(47);
		const last = await boxOf(drawer.locator(":scope > div").last());
		expect(last.y + last.height).toBeLessThanOrEqual(844 - 34 + 0.5);

		// A conversation: its header below the status bar, the composer's last line above the home indicator.
		await drawer.locator('[data-testid="session-item"]', { hasText: FIXTURE.alphaTitle }).click();
		await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.alphaTitle);
		expect((await boxOf(page.getByTestId("chat-title"))).y).toBeGreaterThanOrEqual(47);
		const note = await boxOf(page.getByText("omp can make mistakes"));
		expect(note.y + note.height).toBeLessThanOrEqual(844 - 34 + 0.5);
	});

	test.describe("landscape", () => {
		test.use({ viewport: { width: 844, height: 390 } });

		test("content keeps clear of the notch on both sides", async ({ page }) => {
			await page.goto("/");
			await setInsets(page, { left: 47, right: 47, bottom: 21 });
			const card = await boxOf(composerCard(page));
			expect(card.x).toBeGreaterThanOrEqual(47);
			expect(card.x + card.width).toBeLessThanOrEqual(844 - 47);

			await page.getByRole("button", { name: "Show sidebar" }).click();
			expect((await boxOf(page.getByRole("complementary").locator("button").first())).x).toBeGreaterThanOrEqual(47);
		});
	});
});
