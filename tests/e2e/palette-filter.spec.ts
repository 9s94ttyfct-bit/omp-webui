import AxeBuilder from "@axe-core/playwright";
import { PALETTES } from "../../shared/prefs.ts";
import { Chain, writeRenderSession } from "../support/render-fixtures.ts";
import { contrastOf } from "../support/style.ts";
import { expect, test } from "./fixtures.ts";

/**
 * The command palette's results: quick prompts are filtered by what is typed, like every other group (a query that
 * names none leaves "No results", not the six prompts with the first one picked, which Enter would have sent to the
 * conversation; and no empty listbox), and a message hit's matched words are readable on the picked row in every look.
 * Hand-written conversations; no model call.
 */

test("a query keeps only the quick prompts it names, and one that names nothing says No results", async ({ page }) => {
	const c = new Chain("pf");
	c.user("Palette filter probe");
	c.assistant([{ type: "text", text: "Done." }]);
	const file = writeRenderSession(
		process.env.OMPW_E2E_AGENT_DIR as string,
		"01a00000-0000-7000-8000-0000000060c3",
		c.entries,
	);
	await page.goto(`/#/s/${encodeURIComponent(file)}`);
	await expect(page.getByTestId("composer")).toBeVisible({ timeout: 15_000 });
	await page.keyboard.press("ControlOrMeta+K");
	const prompts = page.getByTestId("palette-quick-prompt");
	await expect(prompts.first()).toBeVisible();
	const all = await prompts.count();
	expect(all).toBeGreaterThan(1);

	await page.getByTestId("palette-input").fill("soft");
	await expect(prompts).toHaveCount(1);
	await expect(prompts).toContainText("Soft stop");

	// The rows read "Send “…”": typing that word keeps them all, as it would any other row's words.
	await page.getByTestId("palette-input").fill("send");
	await expect(prompts).toHaveCount(all);

	await page.getByTestId("palette-input").fill("qqqzzz");
	await expect(prompts).toHaveCount(0);
	await expect(page.getByRole("dialog").getByText("No results")).toBeVisible();
});

test("a query that finds nothing leaves no empty listbox, and says No results", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByTestId("composer")).toBeVisible({ timeout: 15_000 });
	await page.keyboard.press("ControlOrMeta+K");
	await page.getByTestId("palette-input").fill("qqqzzz");
	await expect(page.getByRole("dialog").getByText("No results")).toBeVisible();
	// A listbox with no option in it is an error to a screen reader (axe: aria-required-children).
	const { violations } = await new AxeBuilder({ page })
		.include('[role="dialog"]')
		.withRules(["aria-required-children"])
		.analyze();
	expect(violations.flatMap((v) => v.nodes.map((n) => n.target.join(" ")))).toEqual([]);
});

test("a message hit's matched words stay readable on the picked row in every palette, light and dark", async ({
	page,
}) => {
	const c = new Chain("pm");
	c.user("Palette mark probe: zebracornish caching");
	c.assistant([{ type: "text", text: "The zebracornish cache is warm." }]);
	writeRenderSession(process.env.OMPW_E2E_AGENT_DIR as string, "01a00000-0000-7000-8000-0000000060c5", c.entries);
	await page.goto("/");
	await page.keyboard.press("ControlOrMeta+K");
	await page.getByTestId("palette-input").fill("zebracornish");
	const hit = page.getByTestId("search-hit").first();
	await expect(hit).toBeVisible({ timeout: 30_000 });
	// The conversation's title matches too and comes first: the arrow keys pick the message hit.
	for (let i = 0; i < 5 && (await hit.getAttribute("data-selected")) !== "true"; i++)
		await page.keyboard.press("ArrowDown");
	await expect(hit).toHaveAttribute("data-selected", "true");
	const mark = hit.locator("mark").first();
	const low: string[] = [];
	for (const palette of PALETTES) {
		for (const dark of [false, true]) {
			await page.evaluate(
				([id, on]) => {
					document.documentElement.dataset.palette = id as string;
					document.documentElement.classList.toggle("dark", on as boolean);
				},
				[palette, dark],
			);
			const ratio = await contrastOf(mark, "color");
			if (ratio < 4.5) low.push(`${palette} ${dark ? "dark" : "light"}: ${ratio.toFixed(2)}`);
		}
	}
	expect(low).toEqual([]);
});
