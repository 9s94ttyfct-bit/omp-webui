import { expect, test } from "./fixtures.ts";

/**
 * Shortcut hints use the key names of the platform they are shown on: ⌘ on Apple platforms, Ctrl elsewhere.
 * The platform is faked before the page's scripts run. The sidebar and the shortcuts page need no omp; the
 * steer hint is on the composer of a chat with a command running (no model call).
 */

const platforms = [
	{
		name: "Windows",
		platform: "Win32",
		search: "Search (Ctrl+K)",
		newChat: "Ctrl+Shift+O",
		steer: "Ctrl+Enter",
		mod: "Ctrl",
	},
	{ name: "macOS", platform: "MacIntel", search: "Search (⌘K)", newChat: "⌘⇧O", steer: "⌘↵", mod: "⌘" },
];

for (const p of platforms) {
	test(`hints use ${p.name} key names`, async ({ page }) => {
		await page.addInitScript(
			(platform) => Object.defineProperty(navigator, "platform", { get: () => platform }),
			p.platform,
		);
		await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
		await page.goto("/");

		const side = page.getByRole("complementary");
		await expect(side.getByTestId("new-chat")).toContainText(p.newChat);
		await expect(side.getByRole("button", { name: p.search })).toBeVisible();

		// The list is a card of Settings (#639): `?` opens it there, and the key names are the platform's.
		await page.locator("body").click({ position: { x: 600, y: 10 } });
		await page.keyboard.press("?");
		await expect(page.getByTestId("shortcuts")).toContainText(p.mod);
		await page.goBack();

		// While a command runs the composer queues, and says how to steer instead.
		await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
		const composer = page.getByTestId("composer");
		await composer.fill("!sleep 30");
		await composer.press("Enter");
		await expect(page.getByTestId("stop")).toBeVisible();
		await expect(composer).toHaveAttribute("placeholder", `Queue a follow-up… (${p.steer} to steer now)`);
		await page.getByTestId("stop").click();
		await expect(page.getByTestId("stop")).toHaveCount(0, { timeout: 15_000 });

		// Nowhere does the other platform's key name leak in.
		if (p.mod === "Ctrl") await expect(page.locator("body")).not.toContainText(/[⌘⇧↵]/);
	});
}
