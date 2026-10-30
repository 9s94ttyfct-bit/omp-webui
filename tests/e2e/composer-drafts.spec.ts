import { rmSync } from "node:fs";
import { attachPicked } from "../support/drop-files.ts";
import { FIXTURE, writeSimpleSession } from "../support/fixtures.ts";
import { expect, type Page, test } from "./fixtures.ts";

/** What is typed and not sent stays with its conversation while the user looks at another one (no model call). */

const PNG_1X1 = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
	"base64",
);

test("an unsent message and its image stay with their conversation across a switch", async ({ page }) => {
	await page.goto("/");
	const sidebar = page.getByRole("complementary");
	const composer = page.getByTestId("composer");

	await sidebar.getByText(FIXTURE.alphaTitle).click();
	await composer.fill("half a thought for alpha");
	await attachPicked(page, { name: "dot.png", mimeType: "image/png", buffer: PNG_1X1 });
	await expect(page.getByRole("img", { name: "dot.png" })).toBeVisible();

	// Another conversation has its own, empty, message box.
	await sidebar.getByText(FIXTURE.betaTitle).click();
	await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.betaTitle);
	await expect(composer).toHaveValue("");
	await expect(page.getByRole("img", { name: "dot.png" })).toHaveCount(0);
	await composer.fill("beta's own");

	// Back in alpha: its text and image are where they were left; beta keeps its own.
	await sidebar.getByText(FIXTURE.alphaTitle).click();
	await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.alphaTitle);
	await expect(composer).toHaveValue("half a thought for alpha");
	await expect(page.getByRole("img", { name: "dot.png" })).toBeVisible();
	await sidebar.getByText(FIXTURE.betaTitle).click();
	await expect(composer).toHaveValue("beta's own");

	// Clearing the box clears what is kept.
	await composer.fill("");
	await sidebar.getByText(FIXTURE.alphaTitle).click();
	await sidebar.getByText(FIXTURE.betaTitle).click();
	await expect(composer).toHaveValue("");
});

test("the new-chat page keeps its unsent message while a conversation is open", async ({ page }) => {
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	const sidebar = page.getByRole("complementary");
	const composer = page.getByTestId("composer");
	await composer.fill("an idea for later");

	await sidebar.getByText(FIXTURE.alphaTitle).click();
	await expect(composer).toHaveValue("");
	await sidebar.getByTestId("new-chat").click();
	await expect(composer).toHaveValue("an idea for later");
});

const rowOf = (page: Page, title: string) =>
	page.getByRole("complementary").locator('[data-testid="session-item"]', { hasText: title });

test("deleting a conversation forgets its unsent message, one at a time and in bulk", async ({ page }) => {
	const agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
	const files = [writeSimpleSession(agentDir, 0xd1, "Tapir single"), writeSimpleSession(agentDir, 0xd2, "Tapir bulk")];
	try {
		await page.goto("/");
		const composer = page.getByTestId("composer");
		for (const title of ["Tapir single", "Tapir bulk"]) {
			await expect(rowOf(page, title)).toHaveCount(1, { timeout: 15_000 });
			await rowOf(page, title).click();
			await expect(page.getByTestId("chat-title")).toHaveText(title);
			await composer.fill(`unsent for ${title}`);
		}
		// Look at another conversation: neither one is on screen when it is deleted.
		await rowOf(page, FIXTURE.alphaTitle).click();
		await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.alphaTitle);

		await rowOf(page, "Tapir single").hover();
		await page.getByRole("button", { name: "Actions for Tapir single" }).click();
		await page.getByRole("menuitem", { name: "Delete…" }).click();
		await page.getByTestId("confirm-session-action").click();
		await expect(rowOf(page, "Tapir single")).toHaveCount(0, { timeout: 60_000 });

		await page.getByTestId("select-sessions").click();
		await rowOf(page, "Tapir bulk").click();
		await page.getByTestId("selection-bar").getByRole("button", { name: "Delete" }).click();
		await page.getByTestId("confirm-bulk-delete").click();
		await expect(rowOf(page, "Tapir bulk")).toHaveCount(0, { timeout: 60_000 });

		// The same files are back (same names): nothing of what was typed in their previous life comes with them.
		// The list reloads when a session file changes; touch the files until it has seen both.
		await expect(async () => {
			writeSimpleSession(agentDir, 0xd1, "Tapir single");
			writeSimpleSession(agentDir, 0xd2, "Tapir bulk");
			await expect(rowOf(page, "Tapir single")).toHaveCount(1, { timeout: 3000 });
			await expect(rowOf(page, "Tapir bulk")).toHaveCount(1, { timeout: 3000 });
		}).toPass({ timeout: 40_000 });
		for (const title of ["Tapir single", "Tapir bulk"]) {
			await rowOf(page, title).click();
			await expect(page.getByTestId("chat-title")).toHaveText(title);
			await expect(composer).toHaveValue("");
		}
	} finally {
		for (const f of files) rmSync(f, { force: true });
	}
});

test("unsent messages and their images come back after a reload, for every conversation", async ({ page }) => {
	await page.goto("/");
	const sidebar = page.getByRole("complementary");
	const composer = page.getByTestId("composer");

	await sidebar.getByText(FIXTURE.alphaTitle).click();
	await composer.fill("half a thought for alpha");
	await attachPicked(page, { name: "dot.png", mimeType: "image/png", buffer: PNG_1X1 });
	await expect(page.getByRole("img", { name: "dot.png" })).toBeVisible();
	await sidebar.getByText(FIXTURE.betaTitle).click();
	await composer.fill("beta, too");

	// ⌘R: no pause for the draft to settle first.
	await page.reload();
	await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.betaTitle);
	await expect(composer).toHaveValue("beta, too");
	await sidebar.getByText(FIXTURE.alphaTitle).click();
	await expect(composer).toHaveValue("half a thought for alpha");
	await expect(page.getByRole("img", { name: "dot.png" })).toBeVisible();

	// Clearing a box forgets its draft: the next reload finds nothing.
	await composer.fill("");
	await page.getByRole("button", { name: "Remove dot.png" }).click();
	await sidebar.getByText(FIXTURE.betaTitle).click();
	await composer.fill("");
	await page.reload();
	await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.betaTitle);
	await expect(composer).toHaveValue("");
	await sidebar.getByText(FIXTURE.alphaTitle).click();
	await expect(composer).toHaveValue("");
	await expect(page.getByRole("img", { name: "dot.png" })).toHaveCount(0);
});

test("the automatic reload after an upgrade keeps what was typed", async ({ page }) => {
	await page.goto("/");
	const composer = page.getByTestId("composer");
	await page.getByRole("complementary").getByText(FIXTURE.alphaTitle).click();
	await composer.fill("typed a moment before the upgrade");

	// What main.tsx does when a chunk of the old build is gone: fetch the new build, once.
	await Promise.all([
		page.waitForEvent("load"),
		page.evaluate(() => window.dispatchEvent(new Event("vite:preloadError"))),
	]);
	await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.alphaTitle);
	await expect(composer).toHaveValue("typed a moment before the upgrade");
});
