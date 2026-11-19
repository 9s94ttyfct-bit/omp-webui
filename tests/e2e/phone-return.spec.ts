import { FIXTURE } from "../support/fixtures.ts";
import { expect, test } from "./fixtures.ts";

/**
 * On a touch screen with no pointing device beside it the on-screen keyboard has a Return key and no Shift+Return, so
 * Return there makes a new line and the Send button sends (#370). A `!command` is run without a model call.
 */

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test("on a phone, Return in the message box is a new line and Send sends; the key is labelled for what it does", async ({
	page,
}) => {
	await page.goto("/");
	await page.getByRole("button", { name: "Show sidebar" }).click();
	await page
		.getByRole("complementary")
		.locator('[data-testid="session-item"]', { hasText: FIXTURE.alphaTitle })
		.click();
	const composer = page.getByTestId("composer");
	await expect(composer).toBeVisible();
	expect(await page.evaluate(() => matchMedia("(pointer: coarse) and (not (any-pointer: fine))").matches)).toBe(true);
	await expect(composer).toHaveAttribute("enterkeyhint", "enter");
	await composer.fill("first line");
	await composer.press("Enter");
	await composer.pressSequentially("second line");
	await expect(composer).toHaveValue("first line\nsecond line");
	// Send sends.
	await composer.fill("!echo sent-by-button");
	await page.getByTestId("send").click();
	await expect(page.getByText("sent-by-button", { exact: true })).toBeVisible({ timeout: 30_000 });
});
