import { askForFeedback } from "../support/feedback.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * A tab left open across an upgrade asks for page chunks the new build no longer has. The page
 * must reload once to pick up the new build and, if that doesn't help, show a Reload screen
 * instead of going blank (no model call). The 404 is simulated per test.
 */

const gone = { status: 404, contentType: "text/plain", body: "Not found" };
const USAGE_CHUNK = /\/assets\/UsagePage-[^/]+\.js$/;
const PALETTE_CHUNK = /\/assets\/Palette-[^/]+\.js$/;
const FEEDBACK_CHUNK = /\/assets\/Feedback-[^/]+\.js$/;
const SESSION_MENU_CHUNK = /\/assets\/SessionMenu-[^/]+\.js$/;
const MODEL_LIST_CHUNK = /\/assets\/ModelList-[^/]+\.js$/;
const NEW_CHAT_PICKERS_CHUNK = /\/assets\/NewChatPickers-[^/]+\.js$/;
const UI_REQUESTS_CHUNK = /\/assets\/UIRequests-[^/]+\.js$/;

/** How many times the browser has requested the page document (the first load plus each reload). */
function countDocuments(page: Page): () => number {
	let n = 0;
	page.on("request", (r) => {
		if (r.resourceType() === "document") n++;
	});
	return () => n;
}

test("a missing page chunk reloads once, then shows the Reload screen and the app stays usable", async ({ page }) => {
	const documents = countDocuments(page);
	await page.goto("/");
	await expect(page.getByTestId("new-chat")).toBeVisible();
	await page.route(USAGE_CHUNK, (route) => route.fulfill(gone));
	const reloaded = page.waitForEvent("load");

	await page
		.getByRole("complementary")
		.getByRole("button", { name: /^Usage/ })
		.click();
	// The screen that counts is the reloaded page's: the one before the reload is drawn too, for as long as it takes.
	await reloaded;
	const screen = page.getByTestId("error-screen");
	await expect(screen).toBeVisible();
	await expect(screen).toContainText(/updated/i);
	await expect(screen.getByRole("button", { name: "Reload" })).toBeVisible();
	// One automatic reload (first load + one), and it does not loop.
	expect(documents()).toBe(2);
	await page.evaluate(() => {
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(resolve, 500);
		return promise;
	});
	expect(documents()).toBe(2);

	// The failure is contained to the page: the sidebar still works and leaving clears the screen.
	await page.getByTestId("new-chat").click();
	await expect(screen).toHaveCount(0);
	await expect(page.getByTestId("composer")).toBeVisible();
});

test("the Reload button recovers once the chunk is back", async ({ page }) => {
	const documents = countDocuments(page);
	await page.goto("/");
	await expect(page.getByTestId("new-chat")).toBeVisible();
	await page.route(USAGE_CHUNK, (route) => route.fulfill(gone));
	const reloaded = page.waitForEvent("load");
	await page
		.getByRole("complementary")
		.getByRole("button", { name: /^Usage/ })
		.click();
	// The page reloads once on its own first (see the test above), and the screen the button is pressed on is the
	// reloaded page's. One found before the reload is taken away with its page: with the chunk back by then, the
	// reloaded page shows Usage, and no Reload button comes back to press.
	await reloaded;
	expect(documents()).toBe(2);
	const screen = page.getByTestId("error-screen");
	await expect(screen).toBeVisible();

	await page.unroute(USAGE_CHUNK);
	await screen.getByRole("button", { name: "Reload" }).click();
	await expect(page.getByRole("heading", { name: /Usage/ })).toBeVisible();
	await expect(page.getByTestId("error-screen")).toHaveCount(0);
});

test("a render error shows the Reload screen instead of a blank page", async ({ page }) => {
	// A session without `usage` crashes the sidebar row while it renders.
	await page.route("**/api/sessions", (route) =>
		route.fulfill({
			json: [
				{
					file: "/tmp/ompw-fixture-project/broken.jsonl",
					id: "broken",
					title: "Broken row",
					preview: "",
					cwd: "/tmp/ompw-fixture-project",
					project: "ompw-fixture-project",
					createdAt: "2026-01-05T10:00:00.000Z",
					modifiedAt: 1,
					size: 1,
					messageCount: 1,
					userMessageCount: 1,
					parentSession: null,
					models: [],
					subagentCount: 0,
				},
			],
		}),
	);
	await page.goto("/");
	const screen = page.getByTestId("error-screen");
	await expect(screen).toBeVisible();
	await expect(screen).toContainText("Something went wrong");
	await expect(page.locator("#root")).not.toBeEmpty();

	await page.unroute("**/api/sessions");
	await screen.getByRole("button", { name: "Reload" }).click();
	await expect(page.getByTestId("new-chat")).toBeVisible();
	await expect(page.getByTestId("error-screen")).toHaveCount(0);
});

test("a missing search chunk is contained: a toast, not the Reload screen", async ({ page }) => {
	const documents = countDocuments(page);
	await page.route(PALETTE_CHUNK, (route) => route.fulfill(gone));
	await page.goto("/");
	await expect(page.getByTestId("new-chat")).toBeVisible();
	await page.keyboard.press("ControlOrMeta+k");
	// The first failure reloads the tab once; the chunk is still gone afterwards.
	await expect.poll(documents).toBe(2);
	await expect(page.getByTestId("new-chat")).toBeVisible();

	await page.keyboard.press("ControlOrMeta+k");
	await expect(page.getByTestId("toast").filter({ hasText: /Search couldn't load/ })).toBeVisible();
	await expect(page.getByTestId("error-screen")).toHaveCount(0);
	await expect(page.getByTestId("new-chat")).toBeVisible();
});

// A browser keeps a module that failed to load for the life of the page (only Firefox 155 and later retry it), so the
// chunk coming back is for a reload to pick up. What a page can do is not to be left in a state that hides the failure:
// the overlay is given up, and every later attempt says again what went wrong.

test("a missing feedback form is contained: a toast, not the Reload screen; the dialog is given up, and every later request says so again", async ({
	page,
}) => {
	const documents = countDocuments(page);
	await page.route(FEEDBACK_CHUNK, (route) => route.fulfill(gone));
	await page.goto("/");
	await expect(page.getByTestId("new-chat")).toBeVisible();
	await askForFeedback(page);
	// The first failure reloads the tab once; the chunk is still gone afterwards.
	await expect.poll(documents).toBe(2);
	await expect(page.getByTestId("new-chat")).toBeVisible();

	const toasts = page.getByTestId("toast").filter({ hasText: /feedback form couldn't load/ });
	await askForFeedback(page);
	await expect(toasts).toHaveCount(1);
	await expect(page.getByTestId("error-screen")).toHaveCount(0);
	await expect(page.getByTestId("new-chat")).toBeVisible();

	// Asking again is a new request, not a dialog that is already "open" and stays silent.
	await askForFeedback(page);
	await expect(toasts).toHaveCount(2);
	await expect(page.getByRole("dialog")).toHaveCount(0);
});

test("a missing conversation menu is contained: a toast, the row's button closed, and every later open says so again", async ({
	page,
}) => {
	const documents = countDocuments(page);
	await page.route(SESSION_MENU_CHUNK, (route) => route.fulfill(gone));
	await page.goto("/");
	await expect(page.getByTestId("session-item").first()).toBeVisible();
	await page.getByTestId("session-menu").first().click({ force: true });
	// The first failure reloads the tab once; the chunk is still gone afterwards.
	await expect.poll(documents).toBe(2);
	await expect(page.getByTestId("session-item").first()).toBeVisible();

	const trigger = page.getByTestId("session-menu").first();
	const toasts = page.getByTestId("toast").filter({ hasText: /actions couldn't load/ });
	await trigger.click({ force: true });
	await expect(toasts).toHaveCount(1);
	await expect(page.getByTestId("error-screen")).toHaveCount(0);
	// The menu that did not come is not left open on the button, and the row and the sidebar are as they were.
	await expect(trigger).toHaveAttribute("aria-expanded", "false");
	await expect(trigger).toHaveAttribute("data-state", "closed");
	await expect(page.getByTestId("session-item").first()).toBeVisible();
	await expect(page.getByTestId("new-chat")).toBeVisible();

	// The next open is a new attempt: said again, and closed again.
	await trigger.click({ force: true });
	await expect(toasts).toHaveCount(2);
	await expect(trigger).toHaveAttribute("aria-expanded", "false");
	await expect(page.getByRole("menuitem")).toHaveCount(0);
});

test("a missing model list is contained: a toast, the popover gone, and every later open says so again", async ({
	page,
}) => {
	const documents = countDocuments(page);
	await page.route(MODEL_LIST_CHUNK, (route) => route.fulfill(gone));
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toContainText("Haiku 5.5", { timeout: 60_000 });
	await page.getByTestId("model-picker").click();
	// The first failure reloads the tab once; the chunk is still gone afterwards.
	await expect.poll(documents).toBe(2);
	await expect(page.getByTestId("model-picker")).toContainText("Haiku 5.5", { timeout: 60_000 });

	const toasts = page.getByTestId("toast").filter({ hasText: /model list couldn't load/ });
	await page.getByTestId("model-picker").click();
	await expect(toasts).toHaveCount(1);
	await expect(page.getByTestId("error-screen")).toHaveCount(0);
	// The empty popover goes with the failure, and the composer is as it was.
	await expect(page.getByRole("dialog", { name: "Choose model" })).toHaveCount(0);
	await expect(page.getByTestId("composer")).toBeVisible();

	// The next open is a new attempt: said again, and the popover goes again.
	await page.getByTestId("model-picker").click();
	await expect(toasts).toHaveCount(2);
	await expect(page.getByRole("dialog", { name: "Choose model" })).toHaveCount(0);
});

test("a model list chunk that cannot be fetched ahead of the click does not reload the tab; the click still reaches the toast", async ({
	page,
}) => {
	const documents = countDocuments(page);
	await page.route(MODEL_LIST_CHUNK, (route) => route.fulfill(gone));
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	const picker = page.getByTestId("model-picker");
	await expect(picker).toContainText("Haiku 5.5", { timeout: 60_000 });

	// The pointer and the focus fetch the list ahead of the click. It is not there; nobody has asked for it yet.
	const fetched = page.waitForResponse((r) => MODEL_LIST_CHUNK.test(r.url()));
	await picker.hover();
	await picker.focus();
	await fetched;
	await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
	expect(documents()).toBe(1);
	await expect(page.getByTestId("error-screen")).toHaveCount(0);
	await expect(page.getByTestId("toast")).toHaveCount(0);

	// The click asks for it: the first failure reloads the tab, the next is a toast, as for any other overlay.
	await picker.click();
	await expect.poll(documents).toBe(2);
	await expect(picker).toContainText("Haiku 5.5", { timeout: 60_000 });
	await picker.click();
	await expect(page.getByTestId("toast").filter({ hasText: /model list couldn't load/ })).toBeVisible();
	await expect(page.getByTestId("error-screen")).toHaveCount(0);
});

// New chat shows its controls and the cards for omp's questions from chunks of their own, once its process runs.

for (const [name, chunk, message] of [
	["pickers", NEW_CHAT_PICKERS_CHUNK, /model and permission controls couldn't load/],
	["request cards", UI_REQUESTS_CHUNK, /question or approval request from omp couldn't load/],
] as const) {
	test(`missing New chat ${name} are contained: a toast, not the Reload screen; the composer and the goal switch stay`, async ({
		page,
	}) => {
		const documents = countDocuments(page);
		await page.route(chunk, (route) => route.fulfill(gone));
		await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
		await page.goto("/");
		// The first failure reloads the tab once; the chunk is still gone afterwards, so the second one is a toast.
		await expect.poll(documents, { timeout: 60_000 }).toBe(2);
		await expect(page.getByTestId("toast").filter({ hasText: message })).toBeVisible({ timeout: 60_000 });
		await expect(page.getByTestId("error-screen")).toHaveCount(0);
		await expect(page.getByTestId("composer")).toBeVisible();
		await expect(page.getByTestId("goal-mode")).toBeVisible();
	});
}
