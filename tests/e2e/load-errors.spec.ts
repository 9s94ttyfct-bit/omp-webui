import { FIXTURE } from "../support/fixtures.ts";
import { sessionRow } from "../support/live.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * A load that fails says so, with a Retry that works once the server is back, and never shows a spinner next to
 * the error (no model call: the API is forced to answer 500, then let through).
 */

/** Answer `pattern` with a 500 while `server.down` is true, and let it through after; `hits` counts the asks. */
async function breakApi(page: Page, pattern: string) {
	const server = { down: true, hits: 0 };
	await page.route(pattern, (route) => {
		server.hits++;
		return server.down ? route.fulfill({ status: 500, json: { error: "Internal Server Error" } }) : route.continue();
	});
	return server;
}

/** The pieces of a conversation's chrome that only make sense once it is on screen. */
const CHAT_CHROME = ["session-cost", "export-html", "open-goal", "toggle-panel", "composer"];

test("a conversation that fails to load shows the reason and a Retry, with no spinner and no chrome", async ({
	page,
}) => {
	const server = await breakApi(page, "**/api/family**");
	await page.goto("/");
	await sessionRow(page, FIXTURE.alphaTitle).click();

	const failed = page.getByTestId("load-error");
	await expect(failed).toContainText("Couldn't load this conversation");
	await expect(failed).toContainText("Internal Server Error");
	// The title and folder are known from the list; the buttons and the composer would act on nothing.
	await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.alphaTitle);
	await expect(page.locator("main").getByLabel("Loading")).toHaveCount(0);
	for (const id of CHAT_CHROME) await expect(page.getByTestId(id), id).toHaveCount(0);

	// Still down: Retry asks again, and the reason is back.
	const asked = server.hits;
	await failed.getByTestId("load-retry").click();
	await expect.poll(() => server.hits).toBeGreaterThan(asked);
	await expect(failed).toContainText("Internal Server Error");

	server.down = false;
	await failed.getByTestId("load-retry").click();
	await expect(page.getByText(FIXTURE.alphaReply)).toBeVisible();
	await expect(page.getByTestId("load-error")).toHaveCount(0);
	for (const id of CHAT_CHROME) await expect(page.getByTestId(id), id).toBeVisible();
});

test("while a conversation loads there is a spinner and none of its chrome", async ({ page }) => {
	const release = Promise.withResolvers<void>();
	await page.route("**/api/family**", async (route) => {
		await release.promise;
		await route.continue();
	});
	await page.goto("/");
	await sessionRow(page, FIXTURE.alphaTitle).click();

	await expect(page.getByTestId("chat-loading")).toBeVisible();
	for (const id of CHAT_CHROME) await expect(page.getByTestId(id), id).toHaveCount(0);

	release.resolve();
	await expect(page.getByText(FIXTURE.alphaReply)).toBeVisible();
	await expect(page.getByTestId("chat-loading")).toHaveCount(0);
	for (const id of CHAT_CHROME) await expect(page.getByTestId(id), id).toBeVisible();
});

test("a conversation list that fails to load shows the reason and a Retry instead of a spinner", async ({ page }) => {
	const server = await breakApi(page, "**/api/sessions");
	await page.goto("/");

	const failed = page.getByTestId("sessions-error");
	await expect(failed).toContainText("Couldn't load conversations");
	await expect(failed).toContainText("Internal Server Error");
	await expect(page.getByTestId("session-list").getByLabel("Loading")).toHaveCount(0);

	server.down = false;
	await failed.getByTestId("load-retry").click();
	await expect(sessionRow(page, FIXTURE.alphaTitle)).toBeVisible();
	await expect(failed).toHaveCount(0);
});

test("help for a command that fails to load shows the reason and a Retry, and the command can still run", async ({
	page,
}) => {
	const server = await breakApi(page, "**/api/cli/help**");
	await page.goto("/#/cli/auth");

	const failed = page.getByTestId("load-error");
	await expect(failed).toContainText("Couldn't load help for this command");
	await expect(failed).toContainText("Internal Server Error");
	await expect(page.getByTestId("cli-page").getByLabel("Loading")).toHaveCount(0);
	await expect(page.getByTestId("cli-run")).toBeVisible();

	server.down = false;
	await failed.getByTestId("load-retry").click();
	await expect(page.getByRole("heading", { name: "omp auth" })).toBeVisible();
	await expect(page.getByTestId("load-error")).toHaveCount(0);
});

test("a command list that fails to load shows the reason and a Retry instead of a spinner", async ({ page }) => {
	const server = await breakApi(page, "**/api/cli");
	await page.goto("/#/cli");

	const failed = page.getByTestId("load-error");
	await expect(failed).toContainText("Couldn't load the command list");
	await expect(page.getByTestId("cli-page").getByLabel("Loading")).toHaveCount(0);

	server.down = false;
	await failed.getByTestId("load-retry").click();
	await expect(page.getByTestId("cli-command").first()).toBeVisible();
	await expect(page.getByTestId("load-error")).toHaveCount(0);
});
