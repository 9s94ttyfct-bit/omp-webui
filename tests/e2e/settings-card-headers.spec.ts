import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * Every card on the Settings page is headed the same way: the title at one size and weight, and the sentence that says
 * what the card is for at a smaller one under it, whatever the card is about. Before, the intros of the Mode, Accounts,
 * Model roles and Model presets cards were 14px (as heavy as their 14px titles) while the Appearance ones were 12px.
 * Read from what the browser computes. No model call.
 */

/** The five Settings pages, in the order of the index. */
const PAGES = ["look", "chats", "models", "safety", "app"] as const;

/** The intro (the paragraph that says what the card is for) of some cards, found by a few of its words. */
const INTROS = [
	{ card: "mode-settings", intro: "Full runs omp as you have set it up" },
	{ card: "accounts", intro: "Log in to model providers" },
	{ card: "model-roles", intro: "Which model each role uses" },
	{ card: "model-presets", intro: "A preset is a named set of models" },
] as const;

const typeOf = (scope: Page | Locator, text: string) =>
	scope
		.getByText(text)
		.first()
		.evaluate((el) => {
			const s = getComputedStyle(el);
			return { px: Number.parseFloat(s.fontSize), line: s.lineHeight };
		});

test("every Settings card has the same title and the same intro, and the title is the larger", async ({ page }) => {
	// One title recipe for every card, on each of the five pages (one is shown at a time; the others' cards are hidden).
	let titleCount = 0;
	for (const id of PAGES) {
		await page.goto(`/#/settings/${id}`);
		await expect(page.getByTestId("settings-page")).toBeVisible();
		await expect(page.locator(`[data-testid="settings-page-tab"][data-page="${id}"]`)).toHaveAttribute(
			"aria-current",
			"page",
		);
		const titles = await page.locator(`[data-settings-page="${id}"] section h2`).evaluateAll((els) =>
			els.map((el) => {
				const s = getComputedStyle(el);
				return { text: el.textContent?.trim() ?? "", px: Number.parseFloat(s.fontSize), weight: Number(s.fontWeight) };
			}),
		);
		titleCount += titles.length;
		for (const title of titles)
			expect(title, `the title "${title.text}" on ${id}`).toMatchObject({ px: 15, weight: 600 });
	}
	expect(titleCount, "cards with a title").toBeGreaterThanOrEqual(8);

	// One intro recipe, smaller than the title: the cards of the Models page (every generation), then the one at the foot
	// of the Application page.
	await page.goto("/#/settings/models");
	for (const { card } of INTROS) await expect(page.getByTestId(card)).toBeVisible();
	const intros: { card: string; px: number; line: string }[] = await Promise.all(
		INTROS.map(async ({ card, intro }) => ({ card, ...(await typeOf(page.getByTestId(card), intro)) })),
	);
	await page.goto("/#/settings/app");
	const configCard = page.locator('[data-settings-page="app"] section', { hasText: "omp configuration" });
	await expect(configCard).toBeVisible();
	intros.push({ card: "omp configuration", ...(await typeOf(configCard, "omp's own settings (models")) });
	for (const intro of intros) {
		expect(intro.px, `the size of the intro of ${intro.card}`).toBe(12);
		expect(intro.line, `the line height of the intro of ${intro.card}`).toBe(intros[0].line);
	}
});
