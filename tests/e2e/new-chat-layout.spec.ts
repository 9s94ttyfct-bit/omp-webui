import { newChatIn } from "../support/new-chat.ts";
import { boxOf } from "../support/style.ts";
import { devices, expect, type Page, test } from "./fixtures.ts";

/**
 * New chat's layout (no model call): the settings of the conversation about to start are a bar under the composer, every
 * one of them always shown, at every width (a phone shows them as icons, wrapping); the composer itself holds the field,
 * Attach and Send.
 */

/** The settings in the bar's order: the model's, a divider, then the conversation's rules. */
const SETTINGS = [
	"preset-picker",
	"model-picker",
	"thinking-picker",
	"mode-picker",
	"guard-picker",
	"guidance-picker",
	"approval-picker",
	"unattended-toggle",
	"goal-mode",
];

const newChat = () => newChatIn(process.env.OMPW_E2E_WORK as string);

async function openNewChat(page: Page) {
	await page.goto(newChat());
	await expect(page.getByTestId("thinking-picker")).toBeVisible({ timeout: 60_000 });
	await expect(page.getByTestId("guidance-picker")).toBeVisible();
}

test.describe("at 1400 px", () => {
	test.use({ viewport: { width: 1400, height: 900 } });

	test("the settings are a bar under the composer, in order, none of them inside it", async ({ page }) => {
		await openNewChat(page);
		const footer = page.getByTestId("composer-footer");
		const bar = page.getByTestId("new-chat-settings");
		for (const id of SETTINGS) {
			await expect(footer.getByTestId(id), id).toHaveCount(0);
			await expect(bar.getByTestId(id), id).toBeVisible();
		}
		// In the bar's order: each one comes after the one before it in the document.
		const order = await bar.evaluate(
			(el, ids) =>
				ids.map((id) => {
					const all = [...el.querySelectorAll("[data-testid]")];
					return all.findIndex((n) => n.getAttribute("data-testid") === id);
				}),
			SETTINGS,
		);
		expect(order).toEqual([...order].sort((a, b) => a - b));
		const field = await boxOf(page.getByTestId("composer"));
		const send = await boxOf(page.getByTestId("send"));
		const top = (await boxOf(bar)).y;
		expect(top).toBeGreaterThanOrEqual(Math.max(field.y + field.height, send.y + send.height));
		await expect(page.getByTestId("composer-more")).toHaveCount(0);
	});
});

test.describe("phone", () => {
	const { defaultBrowserType: _browser, ...phone } = devices["iPhone 13"];
	test.use(phone);

	test("phone: every setting is an icon in the bar, none behind ⋯ and none past the screen", async ({ page }) => {
		await openNewChat(page);
		const bar = page.getByTestId("new-chat-settings");
		await expect(bar).toHaveAttribute("data-composer-narrow", "");
		await expect(page.getByTestId("composer-more")).toHaveCount(0);
		// The goal on: its "skip the questions" switch is in the bar too.
		await bar.getByTestId("goal-mode").click();
		const width = page.viewportSize()?.width ?? 0;
		for (const id of [...SETTINGS, "goal-direct"]) {
			const control = bar.getByTestId(id);
			await expect(control, id).toBeVisible();
			const b = await boxOf(control);
			expect(b.x + b.width, id).toBeLessThanOrEqual(width);
			// An icon, not a word: no wider than an icon button (32 px) and its focus ring's room.
			expect(b.width, id).toBeLessThanOrEqual(40);
			// It still says what it is to whoever cannot see the icon.
			await expect(control, id).toHaveAccessibleName(/\S/);
		}
	});
});
