import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Favorites in the model picker from the keyboard. Enter or Space on a heart toggles that favorite instead of
 * choosing the highlighted model, the hearts are out of the Tab order, and one key loves the highlighted row.
 * omp's model list is replaced by a known one (no model call).
 */

const CURRENT = { provider: "anthropic", id: "claude-haiku-5-5", name: "Claude Haiku 5.5", reasoning: true };
const MODELS = [
	{ provider: "acme", id: "alpha", name: "Acme alpha" },
	{ provider: "acme", id: "beta", name: "Acme beta" },
	{ provider: "acme", id: "gamma", name: "Acme gamma" },
	CURRENT,
];

const search = (page: Page) => page.getByPlaceholder("Search models…");

async function openPicker(page: Page) {
	const tap = await tapSocket(page);
	tap.answer("get_available_models", () => ({ ok: true, data: { models: MODELS } }));
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toContainText("Haiku 5.5", { timeout: 60_000 });
	await page.getByTestId("model-picker").click();
	await expect(page.getByRole("option", { name: /Acme gamma/ })).toBeAttached();
	return tap;
}

// Favorites live in the server's data dir, shared by every spec: leave none behind.
test.afterEach(async ({ page }) => {
	const headers = { "x-omp-webui": "1" };
	const loved: string[] = await (await page.request.get("/api/favorite-models")).json();
	for (const model of loved) await page.request.post("/api/favorite-models", { data: { model, on: false }, headers });
});

test("Enter on a heart adds the favorite without choosing the model, Space takes it away again", async ({ page }) => {
	const tap = await openPicker(page);
	const picker = page.getByTestId("model-picker");
	const before = await picker.textContent();

	await page
		.getByTestId("model-row")
		.filter({ hasText: /Acme beta/ })
		.getByTestId("model-love")
		.focus();
	await page.keyboard.press("Enter");
	const favorites = page.getByTestId("model-favorites");
	await expect(favorites.getByRole("option")).toHaveCount(1);
	await expect(favorites.getByRole("option").first()).toContainText("Acme beta");
	// The picker is still open and nothing was chosen.
	await expect(page.locator("[cmdk-list]")).toBeVisible();
	expect(tap.commands("set_model")).toHaveLength(0);
	await expect(picker).toHaveText(before ?? "");

	await favorites.getByTestId("model-love").focus();
	await page.keyboard.press("Space");
	await expect(page.getByTestId("model-favorites")).toHaveCount(0);
	await expect(page.locator("[cmdk-list]")).toBeVisible();
	expect(tap.commands("set_model")).toHaveLength(0);
});

test("the hearts are out of the Tab order", async ({ page }) => {
	await openPicker(page);
	const tabIndexes = await page
		.getByTestId("model-love")
		.evaluateAll((hearts) => hearts.map((heart) => (heart as HTMLElement).tabIndex));
	expect(tabIndexes).toHaveLength(MODELS.length);
	expect(tabIndexes.every((i) => i === -1)).toBe(true);

	// Tab from the search field leaves the picker's rows alone: it never stops on a heart.
	await search(page).focus();
	await page.keyboard.press("Tab");
	await expect(page.locator('[data-testid="model-love"]:focus')).toHaveCount(0);
});

test("the documented key loves the highlighted row and takes it away again", async ({ page }) => {
	const tap = await openPicker(page);
	// The picker says which key it is (⌘⇧L on Apple platforms, Ctrl+Shift+L elsewhere).
	await expect(page.getByTestId("model-love-hint")).toContainText(/(⌘⇧|Ctrl\+Shift\+)L/);

	// Searching moves the highlight to the first match.
	await search(page).fill("gamma");
	await expect(page.locator('[cmdk-item][aria-selected="true"]')).toContainText("Acme gamma");
	await page.keyboard.press("ControlOrMeta+Shift+L");
	const favorites = page.getByTestId("model-favorites");
	await expect(favorites.getByRole("option")).toHaveCount(1);
	await expect(favorites).toContainText("Acme gamma");
	// Still open, still typing in the search field, and nothing was chosen.
	await expect(search(page)).toBeFocused();
	expect(tap.commands("set_model")).toHaveLength(0);

	await page.keyboard.press("ControlOrMeta+Shift+L");
	await expect(page.getByTestId("model-favorites")).toHaveCount(0);
	await expect(page.locator("[cmdk-list]")).toBeVisible();
	expect(tap.commands("set_model")).toHaveLength(0);
});

test("the shortcuts page names the key under its own heading", async ({ page }) => {
	await page.goto("/#/settings");
	const list = page.getByTestId("shortcuts");
	await expect(page.getByTestId("shortcuts-settings")).toBeVisible();
	await expect(list.getByRole("heading", { name: "Model picker" })).toBeVisible();
	await expect(list.getByText("Add or remove the highlighted model from favorites", { exact: true })).toBeVisible();
});

/** A list long enough to scroll, whose last row (the current model) is highlighted as it opens. */
async function openLongList(page: Page) {
	const tap = await tapSocket(page);
	tap.answer("get_available_models", () => ({
		ok: true,
		data: {
			models: [
				...Array.from({ length: 30 }, (_, i) => ({ provider: "acme", id: `m-${i}`, name: `Acme model ${i}` })),
				CURRENT,
			],
		},
	}));
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toContainText("Haiku 5.5", { timeout: 60_000 });
	await page.getByTestId("model-picker").click();
	await expect(page.getByRole("option", { name: "Acme model 29", exact: true })).toBeAttached();
}

/** Past the frame in which the picker would bring the highlighted row into view, were it asked to. */
const afterNextFrames = (page: Page) =>
	page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));

test("a heart clicked with the pointer leaves the list where it was", async ({ page }) => {
	await openLongList(page);
	const list = page.locator("[cmdk-list]");
	const row = (name: string) => page.getByTestId("model-row").filter({ hasText: new RegExp(`${name}$`) });
	/** Where a row is in the list's window, so that a list that moved is seen whatever its scroll position says. */
	const offsetOf = (name: string) =>
		row(name).evaluate((el) => {
			const list = el.closest("[cmdk-list]");
			return list ? Math.round(el.getBoundingClientRect().top - list.getBoundingClientRect().top) : Number.NaN;
		});

	// Scrolled into the middle: the row to love and the one under it are on screen, and the top is not.
	await row("Acme model 22").scrollIntoViewIfNeeded();
	await row("Acme model 24").scrollIntoViewIfNeeded();
	expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
	const before = await offsetOf("Acme model 24");
	expect(before).toBeGreaterThanOrEqual(0);

	// The heart, with the pointer. The model moves to the favorites at the top; the list does not follow it there.
	await row("Acme model 22").getByTestId("model-love").click({ force: true });
	await expect(page.getByTestId("model-favorites")).toBeAttached();
	await afterNextFrames(page);
	expect(Math.abs((await offsetOf("Acme model 24")) - before)).toBeLessThanOrEqual(2);
	expect(await list.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);
});

test("the key that loves the highlighted row brings the list to where the row went", async ({ page }) => {
	await openLongList(page);
	const list = page.locator("[cmdk-list]");
	// The highlighted row is the last one, and the list is scrolled down to it.
	await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBeGreaterThan(100);

	await page.keyboard.press("ControlOrMeta+Shift+L");
	const favorites = page.getByTestId("model-favorites");
	await expect(favorites).toContainText("Claude Haiku 5.5");
	// The row went to the favorites at the top, and the list is shown there, with the row in view.
	await expect.poll(() => list.evaluate((el) => el.scrollTop)).toBe(0);
	await expect(favorites.getByRole("option")).toBeInViewport();
});
