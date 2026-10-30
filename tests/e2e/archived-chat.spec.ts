import { rmSync } from "node:fs";
import { basename } from "node:path";
import { writeSimpleSession } from "../support/fixtures.ts";
import { boxOf } from "../support/geometry.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Archived conversations stay findable once opened: the chat header says so and offers Unarchive, sending to one
 * brings it back, and archiving says how many went with an Undo (no model call).
 */

const mutating = { "x-omp-webui": "1" };

const row = (page: Page, title: string) =>
	page.getByRole("complementary").locator('[data-testid="session-item"]', { hasText: title });

const archiveViaApi = (page: Page, file: string, archived: boolean) =>
	page.request.post("/api/archive", { data: { files: [file], archived }, headers: mutating });

/** Whether the server lists the conversation as archived (paths may differ by a symlink: compare file names). */
async function isArchived(page: Page, file: string): Promise<boolean> {
	const files: string[] = await (await page.request.get("/api/archive")).json();
	return files.some((f) => basename(f) === basename(file));
}

test("archiving says how many conversations went and Undo brings them back", async ({ page }) => {
	const file = writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, 0xc6, "Heron shelf");
	try {
		await page.goto("/");
		await expect(row(page, "Heron shelf")).toHaveCount(1, { timeout: 15_000 });
		await row(page, "Heron shelf").hover();
		await page.getByRole("button", { name: "Actions for Heron shelf" }).click();
		await page.getByRole("menuitem", { name: "Archive" }).click();

		const toast = page.getByTestId("toast");
		await expect(toast).toContainText("Archived 1 conversation");
		await expect(row(page, "Heron shelf")).toHaveCount(0);

		await toast.getByTestId("toast-action").click();
		await expect(toast).toHaveCount(0);
		await expect(row(page, "Heron shelf")).toHaveCount(1);
		expect(await isArchived(page, file)).toBe(false);
	} finally {
		await archiveViaApi(page, file, false);
		rmSync(file, { force: true });
	}
});

test("an archived conversation says so in its header, and Unarchive brings it back", async ({ page }) => {
	const file = writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, 0xc7, "Ibis shelf");
	try {
		await archiveViaApi(page, file, true);
		await page.goto("/");
		await page.getByTestId("show-archived").click();
		await row(page, "Ibis shelf").click();

		const mark = page.locator("header").getByTestId("archived-mark");
		await expect(mark).toContainText("Archived");
		await mark.getByTestId("unarchive").click();
		await expect(mark).toHaveCount(0);
		await expect.poll(() => isArchived(page, file)).toBe(false);
		// It left the archived list for the main one.
		await expect(row(page, "Ibis shelf")).toHaveCount(0);
		await page.getByTestId("show-all-sessions").click();
		await expect(row(page, "Ibis shelf")).toHaveCount(1);
	} finally {
		await archiveViaApi(page, file, false);
		rmSync(file, { force: true });
	}
});

test("a conversation that is not archived has no mark", async ({ page }) => {
	const file = writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, 0xc8, "Kudu shelf");
	try {
		await page.goto("/");
		await row(page, "Kudu shelf").click();
		await expect(page.getByTestId("chat-title")).toHaveText("Kudu shelf");
		await expect(page.getByTestId("archived-mark")).toHaveCount(0);
	} finally {
		rmSync(file, { force: true });
	}
});

test("sending to an archived conversation unarchives it, so its running dot shows in the list", async ({ page }) => {
	const file = writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, 0xc9, "Lynx shelf");
	await archiveViaApi(page, file, true);
	await page.goto("/");
	await page.getByTestId("show-archived").click();
	await row(page, "Lynx shelf").click();
	await expect(page.getByTestId("archived-mark")).toBeVisible();

	// A `!command` starts the conversation's omp without calling the model.
	await page.getByTestId("composer").fill("!echo lynx-back");
	await page.getByTestId("composer").press("Enter");
	await expect(page.getByText("lynx-back", { exact: true })).toBeVisible({ timeout: 30_000 });

	await expect(page.getByTestId("archived-mark")).toHaveCount(0);
	await expect.poll(() => isArchived(page, file)).toBe(false);
	await page.getByTestId("show-all-sessions").click();
	await expect(row(page, "Lynx shelf")).toHaveCount(1);
	await expect(row(page, "Lynx shelf").getByRole("img", { name: /^(Open|Running)$/ })).toBeVisible();
});

test.describe("phone", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("the mark fits the header and its Unarchive is easy to hit", async ({ page }) => {
		const file = writeSimpleSession(
			process.env.OMPW_E2E_AGENT_DIR as string,
			0xca,
			"Mink shelf: a title long enough to need the whole header",
		);
		try {
			await archiveViaApi(page, file, true);
			await page.goto(`/#/s/${encodeURIComponent(file)}`);
			const mark = page.getByTestId("archived-mark");
			await expect(mark).toBeVisible({ timeout: 15_000 });

			const header = page.locator("header");
			expect(await header.evaluate((el) => el.scrollWidth <= el.clientWidth), "nothing hangs off the header").toBe(
				true,
			);
			expect((await boxOf(page.getByTestId("chat-title"))).width, "title width").toBeGreaterThanOrEqual(120);
			const unarchive = await boxOf(page.getByTestId("unarchive"));
			expect(unarchive.height, "Unarchive height").toBeGreaterThanOrEqual(20);
			const box = await boxOf(header);
			expect(unarchive.y + unarchive.height, "inside the header").toBeLessThanOrEqual(box.y + box.height);
		} finally {
			await archiveViaApi(page, file, false);
			rmSync(file, { force: true });
		}
	});
});
