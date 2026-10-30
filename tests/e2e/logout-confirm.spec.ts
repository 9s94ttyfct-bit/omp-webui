import { tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/** Logging out of a provider account asks first, naming the provider and the account (stored accounts are faked; no model call). */

test("logout is confirmed before anything is sent, naming provider and account", async ({ page }) => {
	const tap = await tapSocket(page);
	tap.answer("get_logout_accounts", () => ({
		ok: true,
		data: {
			accounts: [{ credentialId: 7, provider: "anthropic", label: "work@example.com", detail: "OAuth", active: true }],
		},
	}));
	tap.answer("logout", () => ({ ok: true, data: {} }));
	await page.goto("/#/settings/models");
	// The list (and the omp process behind it) starts when asked for.
	await page.getByTestId("accounts-toggle").click();
	const anthropic = page.locator('[data-testid="provider"][data-provider="anthropic"]');
	await expect(anthropic).toBeVisible({ timeout: 60_000 });
	const providerName = (await anthropic.locator("span.truncate").first().textContent())?.trim() ?? "";
	expect(providerName).not.toBe("");

	await anthropic.getByRole("button", { name: "Accounts" }).click();
	const accounts = anthropic.getByTestId("provider-accounts");
	await expect(accounts).toContainText("work@example.com");
	const logOut = accounts.getByRole("button", { name: "Log out" });

	await logOut.click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toContainText(`Log out of ${providerName}?`);
	await expect(dialog).toContainText("work@example.com");
	await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
	expect(tap.commands("logout")).toHaveLength(0);

	// Cancel changes nothing and hands focus back to the button that asked.
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(logOut).toBeFocused();
	expect(tap.commands("logout")).toHaveLength(0);

	await logOut.click();
	await dialog.getByRole("button", { name: "Log out" }).click();
	await expect.poll(() => tap.commands("logout").length).toBe(1);
	expect(tap.commands("logout")[0]).toMatchObject({ providerId: "anthropic", credentialId: 7 });
	await expect(page.getByTestId("toast").filter({ hasText: "Logged out" })).toBeVisible();
});
