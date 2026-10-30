import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Provider accounts via omp's RPC login API, in the isolated omp home. The
 * OAuth round trip itself needs a human, so the test starts a login, checks
 * the sign-in link and code prompt omp asks for, and cancels it.
 */

test("providers, stored accounts, and a cancelled login", async ({ page }) => {
	await page.goto("/#/settings/models");
	// The list (and the omp process behind it) starts when asked for.
	await page.getByTestId("accounts-toggle").click();
	const anthropic = page.locator('[data-testid="provider"][data-provider="anthropic"]');
	await expect(anthropic).toBeVisible({ timeout: 60_000 });
	await expect(anthropic).toContainText("Signed in");

	const manage = anthropic.getByRole("button", { name: /^Manage .* accounts$/ });
	await manage.click();
	await expect(manage).toHaveAttribute("aria-expanded", "true");
	await expect(anthropic.getByTestId("provider-accounts")).toContainText("No stored accounts");
	await manage.click();
	await expect(anthropic.getByTestId("provider-accounts")).toHaveCount(0);

	// Signed in already, so this adds an account rather than logging in.
	await anthropic.getByRole("button", { name: /^Add account to / }).click();
	const progress = page.getByTestId("login-progress");
	await expect(progress.getByTestId("login-link")).toHaveAttribute("href", /^https?:\/\//, { timeout: 30_000 });
	const prompt = progress.getByTestId("ui-request");
	await expect(prompt).toContainText(/authorization code/i);
	// omp keeps waiting for the browser callback; cancelling stops the sign-in process.
	await progress.getByTestId("cancel-login").click();
	await expect(page.getByTestId("toast").filter({ hasText: /Sign-in cancelled/ })).toBeVisible({ timeout: 30_000 });
	await expect(progress).toHaveCount(0);
	await expect(anthropic).toBeVisible({ timeout: 60_000 });
});

test("a sign-in address that omp sends and that is not a web address is no link; a good one still is", async ({
	page,
}) => {
	const tap = await tapSocket(page);
	await page.goto("/#/settings/models");
	await page.getByTestId("accounts-toggle").click();
	const anthropic = page.locator('[data-testid="provider"][data-provider="anthropic"]');
	await expect(anthropic).toBeVisible({ timeout: 60_000 });
	await anthropic.getByRole("button", { name: /^Add account to / }).click();
	const progress = page.getByTestId("login-progress");
	await expect(progress.getByTestId("login-link")).toHaveAttribute("href", /^https?:\/\//, { timeout: 30_000 });

	// What omp (or an extension in it) puts in its `open_url` request is untrusted: `javascript:` in an href would run here.
	const [liveId] = await helperIds(page);
	const openUrl = (url: string, launchUrl?: string) =>
		tap.push({
			t: "frame",
			liveId,
			frame: { type: "extension_ui_request", id: "hostile-open-url", method: "open_url", url, launchUrl },
		});
	openUrl("javascript:alert(document.cookie)", "data:text/html,<script>alert(1)</script>");
	await expect(progress.getByTestId("login-link")).toHaveCount(0);
	await expect(progress.getByTestId("login-link-refused")).toBeVisible();
	// The launch address is used when it is a web address, else the plain one.
	openUrl("https://example.com/plain", "javascript:alert(1)");
	await expect(progress.getByTestId("login-link")).toHaveAttribute("href", "https://example.com/plain");
	openUrl("https://example.com/plain", "https://example.com/launch");
	await expect(progress.getByTestId("login-link")).toHaveAttribute("href", "https://example.com/launch");

	await progress.getByTestId("cancel-login").click();
	await expect(progress).toHaveCount(0);
});

test("signed-in providers come first, the rest are folded away, and every button says what it acts on", async ({
	page,
}) => {
	await page.goto("/#/settings/models");
	// The list (and the omp process behind it) starts when asked for.
	await page.getByTestId("accounts-toggle").click();
	const section = page.getByTestId("accounts");
	await expect(section.locator('[data-provider="anthropic"]')).toBeVisible({ timeout: 60_000 });

	// `omp login` is code, not text between backticks.
	await expect(section.locator("code", { hasText: "omp login" })).toHaveCount(1);
	await expect(section).not.toContainText("`");

	// What shows by default is what is signed in, each with Manage and Add account (no Log in).
	const rows = section.getByTestId("provider");
	const shown = await rows.evaluateAll((els) =>
		els.filter((el) => el.checkVisibility()).map((el) => el.textContent ?? ""),
	);
	expect(shown.length).toBeGreaterThan(0);
	for (const text of shown) {
		expect(text).toContain("Signed in");
		expect(text).toContain("Manage");
		expect(text).toContain("Add account");
		expect(text).not.toContain("Log in");
	}

	// The others wait behind a disclosure that counts them.
	const toggle = section.getByTestId("other-providers");
	await expect(toggle).toHaveText(/^Other providers \(\d+\)$/);
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	const total = await rows.count();
	expect(total).toBeGreaterThan(shown.length);
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	const others = section.getByRole("button", { name: /^Log in to / });
	await expect(others).toHaveCount(total - shown.length);
	await expect(others.first()).toBeVisible();

	// Each button names the provider it acts on, so a screen reader hears which one it is for.
	const unnamed = await rows.evaluateAll((els) =>
		els.flatMap((row) => {
			const provider = row.querySelector("span")?.textContent ?? "";
			return [...row.querySelectorAll("button")]
				.filter((button) => !button.getAttribute("aria-label")?.includes(provider))
				.map((button) => `${provider}: ${button.textContent}`);
		}),
	);
	expect(unnamed).toEqual([]);
});

test("with nothing signed in, the providers are listed open and say so", async ({ page }) => {
	const tap = await tapSocket(page);
	tap.answer("get_login_providers", () => ({
		ok: true,
		data: {
			providers: [
				{ id: "alpha", name: "Alpha AI", available: true, authenticated: false },
				{ id: "beta", name: "Beta Labs", available: true, authenticated: false },
			],
		},
	}));
	await page.goto("/#/settings/models");
	// The list (and the omp process behind it) starts when asked for.
	await page.getByTestId("accounts-toggle").click();
	const section = page.getByTestId("accounts");
	const toggle = section.getByTestId("other-providers");
	await expect(toggle).toHaveText("Providers (2)", { timeout: 60_000 });
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	await expect(section.getByRole("button", { name: "Log in to Alpha AI" })).toBeVisible();
	await expect(section.getByRole("button", { name: "Log in to Beta Labs" })).toBeVisible();
	await toggle.click();
	await expect(section.getByRole("button", { name: "Log in to Alpha AI" })).toBeHidden();
});

/** The ids of the session-less `--no-session` omp processes the server is running (the Accounts section's helper). */
async function helperIds(page: Page): Promise<string[]> {
	const res = await page.request.get("/api/lives");
	const lives: { liveId: string; sessionFile: string | null; args: string[]; exited: boolean }[] = await res.json();
	return lives.filter((l) => !l.exited && !l.sessionFile && l.args.includes("--no-session")).map((l) => l.liveId);
}

test("Settings starts no omp until Accounts is asked for; the helper is named as one and stops with the list", async ({
	page,
}) => {
	const tap = await tapSocket(page);
	const before = await helperIds(page);
	await page.goto("/#/settings/models");
	const toggle = page.getByTestId("accounts-toggle");
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await expect(page.getByTestId("accounts")).not.toContainText("Anthropic");
	// Long enough for the page to have started anything it was going to: the list of running processes is its own.
	await page.waitForTimeout(2000);
	expect(tap.sent.filter((m) => m.t === "open")).toEqual([]);
	await expect(page.getByTestId("running-session")).toHaveCount(0);
	expect((await helperIds(page)).filter((id) => !before.includes(id))).toEqual([]);

	// Asking for the list starts it, and Running sessions says what it is instead of "new session".
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-expanded", "true");
	expect(tap.sent.filter((m) => m.t === "open").map((m) => m.target?.args)).toEqual([["--no-session"]]);
	const helper = page.getByTestId("running-session");
	await expect(helper).toHaveCount(1);
	await expect(helper).toHaveAttribute("data-helper", "accounts");
	await expect(helper).toContainText("Accounts helper (not a conversation)");
	await expect(helper).not.toContainText("new session");
	await expect(helper).not.toContainText("open in a tab");
	await expect(page.locator('[data-testid="provider"]').first()).toBeVisible({ timeout: 60_000 });

	// Hiding the list stops it ...
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await expect(helper).toHaveCount(0);
	await expect.poll(async () => (await helperIds(page)).filter((id) => !before.includes(id))).toEqual([]);

	// ... and so does leaving Settings.
	await toggle.click();
	await expect(helper).toHaveCount(1);
	await page.getByRole("button", { name: /^Usage/ }).click();
	await expect(page.getByTestId("settings-page")).toHaveCount(0);
	await expect.poll(async () => (await helperIds(page)).filter((id) => !before.includes(id))).toEqual([]);
});

test("closing the helper from Running sessions folds the Accounts list", async ({ page }) => {
	await page.goto("/#/settings/models");
	const toggle = page.getByTestId("accounts-toggle");
	await toggle.click();
	const helper = page.locator('[data-testid="running-session"][data-helper="accounts"]');
	await expect(helper).toHaveCount(1);
	// Running processes are on the App page; the Accounts list is on Models.
	await page.locator('[data-testid="settings-page-tab"][data-page="app"]').click();
	await helper.getByRole("button", { name: /^Close/ }).click();
	await page.locator('[data-testid="settings-page-tab"][data-page="models"]').click();
	await expect(toggle).toHaveAttribute("aria-expanded", "false");
	await expect(helper).toHaveCount(0);
});

test("Manage says why when omp's account list cannot be fetched, instead of doing nothing", async ({ page }) => {
	const errors: Error[] = [];
	page.on("pageerror", (e) => errors.push(e));
	const tap = await tapSocket(page);
	tap.answer("get_logout_accounts", () => ({ ok: false, error: "the helper omp died" }));
	await page.goto("/#/settings/models");
	await page.getByTestId("accounts-toggle").click();
	const anthropic = page.locator('[data-testid="provider"][data-provider="anthropic"]');
	await expect(anthropic).toBeVisible({ timeout: 60_000 });

	const manage = anthropic.getByRole("button", { name: /^Manage .* accounts$/ });
	await manage.click();
	await expect(page.getByTestId("toast").filter({ hasText: "the helper omp died" })).toBeVisible();
	await expect(manage).toHaveAttribute("aria-expanded", "false");
	await expect(anthropic.getByTestId("provider-accounts")).toHaveCount(0);
	// Not left for the console as an unhandled rejection either.
	expect(errors).toEqual([]);
});

test("a sign-in that worked is not reported as failed because the list could not be reloaded afterwards", async ({
	page,
}) => {
	const tap = await tapSocket(page);
	let listed = 0;
	tap.answer("get_login_providers", () => (++listed === 1 ? undefined : { ok: false, error: "list unavailable" }));
	tap.answer("login", () => ({ ok: true }));
	await page.goto("/#/settings/models");
	await page.getByTestId("accounts-toggle").click();
	const anthropic = page.locator('[data-testid="provider"][data-provider="anthropic"]');
	await expect(anthropic).toBeVisible({ timeout: 60_000 });

	await anthropic.getByRole("button", { name: /^Add account to / }).click();
	const toasts = page.getByTestId("toast");
	await expect(toasts.filter({ hasText: /^Logged in to / })).toBeVisible();
	await expect(toasts.filter({ hasText: "list unavailable" })).toBeVisible();
	// Counted now, not awaited: a toast goes away by itself, and "none" would come true by waiting.
	expect(await toasts.filter({ hasText: /Login failed/ }).count()).toBe(0);
});

test("a reconnect of the page's socket keeps the Accounts list and its helper omp, and starts no second one", async ({
	page,
}) => {
	const tap = await tapSocket(page);
	await page.goto("/#/settings/models");
	await page.getByTestId("accounts-toggle").click();
	const anthropic = page.locator('[data-testid="provider"][data-provider="anthropic"]');
	await expect(anthropic).toBeVisible({ timeout: 60_000 });
	const manage = anthropic.getByRole("button", { name: /^Manage .* accounts$/ });
	await manage.click();
	await expect(manage).toHaveAttribute("aria-expanded", "true");
	const opens = () => tap.sent.filter((m) => m.t === "open" && m.target?.args?.includes("--no-session")).length;
	expect(opens()).toBe(1);

	// The server's answer about itself comes again after every reconnect, as a new object with the same content.
	const meta = page.waitForResponse((res) => new URL(res.url()).pathname === "/api/meta" && res.ok());
	tap.drop();
	await meta;
	// The page attaches the helper again once the socket is back: by then the settled page has had its say.
	await expect.poll(() => tap.sent.filter((m) => m.t === "attach").length).toBeGreaterThan(0);
	await page.waitForTimeout(1000);
	expect(opens()).toBe(1);
	await expect(anthropic).toBeVisible();
	await expect(manage).toHaveAttribute("aria-expanded", "true");
});
