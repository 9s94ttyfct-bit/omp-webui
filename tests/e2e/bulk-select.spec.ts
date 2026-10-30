import { existsSync, rmSync } from "node:fs";
import { writeSimpleSession } from "../support/fixtures.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Bulk actions in the sidebar act on the selected rows the list shows: a filter that hides a selected row
 * takes it out of the count, the confirmation and the action. The confirmation names what it deletes, and
 * Esc inside a dialog closes the dialog without ending selection mode (no model call).
 */

const row = (page: Page, title: string) =>
	page.getByRole("complementary").locator('[data-testid="session-item"]', { hasText: title });

/** Two conversations of the spec's own; both selected, then the filter hides one of them. */
async function selectBothFilterToNorth(page: Page, n: number) {
	const agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
	const north = writeSimpleSession(agentDir, n, "Quince north");
	const south = writeSimpleSession(agentDir, n + 1, "Quince south");
	await page.goto("/");
	await expect(row(page, "Quince north")).toHaveCount(1, { timeout: 15_000 });
	await expect(row(page, "Quince south")).toHaveCount(1);
	await page.getByTestId("select-sessions").click();
	await row(page, "Quince north").click();
	await row(page, "Quince south").click();
	await expect(page.getByTestId("selection-count")).toHaveText("2 selected");
	await page.getByTestId("session-filter").fill("north");
	await expect(row(page, "Quince south")).toHaveCount(0);
	return { north, south };
}

test("a filter that hides a selected row takes it out of the count, the confirmation and the delete", async ({
	page,
}) => {
	const { north, south } = await selectBothFilterToNorth(page, 0xc0);
	try {
		await expect(page.getByTestId("selection-count")).toHaveText("1 selected");
		await page.getByTestId("selection-bar").getByRole("button", { name: "Delete" }).click();

		const dialog = page.getByRole("dialog");
		// One row: the singular, its title, and nothing about the hidden one.
		await expect(dialog).toContainText("Delete 1 conversation?");
		await expect(dialog).not.toContainText("Delete 1 conversations?");
		await expect(dialog).toContainText("omp removes this transcript");
		await expect(dialog.getByTestId("bulk-delete-list").locator("li")).toHaveText(["Quince north"]);
		await expect(dialog).not.toContainText("Quince south");

		await page.getByTestId("confirm-bulk-delete").click();
		await expect.poll(() => existsSync(north), { timeout: 60_000 }).toBe(false);
		// The hidden row was never part of it.
		expect(existsSync(south)).toBe(true);
		await page.getByTestId("session-filter").fill("");
		await expect(row(page, "Quince south")).toHaveCount(1);
	} finally {
		rmSync(north, { force: true });
		rmSync(south, { force: true });
	}
});

test("bulk-deleting the conversation on screen takes the page back to New chat", async ({ page }) => {
	const file = writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, 0xcc, "Okapi shelf");
	try {
		await page.goto("/");
		await row(page, "Okapi shelf").click();
		await expect(page.getByTestId("chat-title")).toHaveText("Okapi shelf");
		await page.getByTestId("select-sessions").click();
		await row(page, "Okapi shelf").click();
		await page.getByTestId("selection-bar").getByRole("button", { name: "Delete" }).click();
		await page.getByTestId("confirm-bulk-delete").click();
		await expect.poll(() => existsSync(file), { timeout: 60_000 }).toBe(false);
		await expect(page.getByTestId("chat-title")).toHaveCount(0);
		await expect(page.getByTestId("cwd-picker")).toBeVisible();
	} finally {
		rmSync(file, { force: true });
	}
});

test("Archive acts on the visible selected rows only", async ({ page }) => {
	const { north, south } = await selectBothFilterToNorth(page, 0xc2);
	try {
		await page.getByTestId("selection-bar").getByRole("button", { name: "Archive" }).click();
		await expect(page.getByTestId("toast")).toContainText("Archived 1 conversation");
		await expect(page.getByTestId("selection-bar")).toHaveCount(0);

		// The hidden row stayed where it was; the visible one is archived.
		await page.getByTestId("session-filter").fill("");
		await expect(row(page, "Quince south")).toHaveCount(1);
		await expect(row(page, "Quince north")).toHaveCount(0);
		await page.getByTestId("show-archived").click();
		await expect(row(page, "Quince north")).toHaveCount(1);
		await expect(row(page, "Quince south")).toHaveCount(0);
	} finally {
		await page.request.post("/api/archive", {
			data: { files: [north], archived: false },
			headers: { "x-omp-webui": "1" },
		});
		rmSync(north, { force: true });
		rmSync(south, { force: true });
	}
});

test("Esc in the delete confirmation closes it and keeps selection mode; Esc outside leaves it", async ({ page }) => {
	const agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
	const file = writeSimpleSession(agentDir, 0xc4, "Marmot shelf");
	try {
		await page.goto("/");
		await expect(row(page, "Marmot shelf")).toHaveCount(1, { timeout: 15_000 });
		await page.getByTestId("select-sessions").click();
		await row(page, "Marmot shelf").click();
		await page.getByTestId("selection-bar").getByRole("button", { name: "Delete" }).click();
		const dialog = page.getByRole("dialog");
		await expect(dialog).toContainText("Delete 1 conversation?");

		await page.keyboard.press("Escape");
		await expect(dialog).toHaveCount(0);
		await expect(page.getByTestId("selection-bar")).toBeVisible();
		await expect(page.getByTestId("selection-count")).toHaveText("1 selected");
		await expect(page.getByTestId("select-sessions")).toHaveAttribute("aria-pressed", "true");
		expect(existsSync(file)).toBe(true);

		// With no dialog open the same key still leaves selection mode.
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("selection-bar")).toHaveCount(0);
		await expect(page.getByTestId("select-sessions")).toHaveAttribute("aria-pressed", "false");
	} finally {
		rmSync(file, { force: true });
	}
});
