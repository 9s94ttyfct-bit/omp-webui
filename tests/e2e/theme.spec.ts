import { expect, test } from "./fixtures.ts";

/** Theme "System" follows the OS appearance while the app is open; an explicit theme ignores it (no model call). */

test("System follows OS light/dark changes live, an explicit theme does not", async ({ page }) => {
	await page.emulateMedia({ colorScheme: "dark" });
	await page.goto("/#/settings");
	const html = page.locator("html");
	const themeColor = page.locator('meta[name="theme-color"]');
	// The theme's own radios: Settings also has a Full / Light card, whose label says "Light" too.
	const pick = (name: string) =>
		page.locator("label", { has: page.locator('input[name="theme"]'), hasText: name }).click();

	await pick("System");
	await expect(html).toHaveClass(/\bdark\b/);

	await page.emulateMedia({ colorScheme: "light" });
	await expect(html).not.toHaveClass(/\bdark\b/);
	await expect(themeColor).toHaveAttribute("content", "#faf9f5");

	await page.emulateMedia({ colorScheme: "dark" });
	await expect(html).toHaveClass(/\bdark\b/);
	await expect(themeColor).toHaveAttribute("content", "#1a1918");

	// An explicit choice wins over the OS.
	await pick("Light");
	await expect(html).not.toHaveClass(/\bdark\b/);
	await page.emulateMedia({ colorScheme: "dark" });
	await page.emulateMedia({ colorScheme: "light" });
	await page.emulateMedia({ colorScheme: "dark" });
	await expect(html).not.toHaveClass(/\bdark\b/);

	await pick("Dark");
	await page.emulateMedia({ colorScheme: "light" });
	await expect(html).toHaveClass(/\bdark\b/);
});

test("System still follows the OS after a reload", async ({ page }) => {
	await page.emulateMedia({ colorScheme: "dark" });
	await page.goto("/#/settings");
	await page.locator("label", { has: page.locator('input[name="theme"]'), hasText: "System" }).click();
	await page.reload();
	const html = page.locator("html");
	await expect(html).toHaveClass(/\bdark\b/);
	await page.emulateMedia({ colorScheme: "light" });
	await expect(html).not.toHaveClass(/\bdark\b/);
});
