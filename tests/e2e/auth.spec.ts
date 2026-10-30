import AxeBuilder from "@axe-core/playwright";
import { PALETTES } from "../../shared/prefs.ts";
import { expect, test } from "./fixtures.ts";

/** The API and WebSocket require the per-install access token. */

test.use({ storageState: { cookies: [], origins: [] } });

test("without the token the API refuses and the UI asks to unlock", async ({ page, request }) => {
	expect((await request.get("/api/sessions")).status()).toBe(401);
	expect((await request.get("/api/sessions", { headers: { "x-omp-webui-token": "wrong" } })).status()).toBe(401);
	await page.goto("/");
	await expect(page.getByTestId("unlock")).toBeVisible();
	await page.getByLabel("Access token").fill("not-the-token");
	await page.getByRole("button", { name: "Unlock" }).click();
	await expect(page.getByText("That token is not valid.")).toBeVisible();
	await page.getByLabel("Access token").fill(process.env.OMPW_E2E_ACCESS_TOKEN as string);
	await page.getByRole("button", { name: "Unlock" }).click();
	await expect(page.getByTestId("new-chat")).toBeVisible();
	await expect(page.getByTestId("session-item").first()).toBeVisible();
});

test("the unlock page names itself with a level-one heading and has nothing axe objects to", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByTestId("unlock")).toBeVisible();
	await expect(page.getByRole("heading", { level: 1, name: "omp web UI is locked" })).toBeVisible();
	const { violations } = await new AxeBuilder({ page }).analyze();
	expect(violations.map((v) => `${v.id}: ${v.help}`)).toEqual([]);
});

test("a wrong token's error is announced and readable in every look", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByTestId("unlock")).toBeVisible();
	await page.getByLabel("Access token").fill("not-the-token");
	await page.getByRole("button", { name: "Unlock" }).click();
	const error = page.getByTestId("unlock-error");
	await expect(error).toHaveText("That token is not valid.");
	await expect(error).toHaveAttribute("role", "alert");
	await expect(page.getByLabel("Access token")).toHaveAccessibleDescription("That token is not valid.");
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
			const { violations } = await new AxeBuilder({ page })
				.include('[data-testid="unlock-error"]')
				.withRules(["color-contrast"])
				.analyze();
			for (const v of violations) low.push(`${palette} ${dark ? "dark" : "light"}: ${v.help}`);
		}
	}
	expect(low).toEqual([]);
});
test("the startup link sets the cookie and strips the token from the URL", async ({ page, context }) => {
	await page.goto(`/?token=${encodeURIComponent(process.env.OMPW_E2E_ACCESS_TOKEN as string)}#/usage`);
	await expect(page).toHaveURL(/\/#\/usage$/);
	expect(page.url()).not.toContain("token=");
	await expect(page.getByTestId("usage-page")).toBeVisible();
	const cookie = (await context.cookies()).find((c) => c.name === "ompw_token");
	expect(cookie?.httpOnly).toBe(true);
	expect(cookie?.sameSite).toBe("Strict");
});

test("a wrong startup link is rejected", async ({ request }) => {
	const res = await request.get("/?token=nope", { maxRedirects: 0 });
	expect(res.status()).toBe(401);
});
