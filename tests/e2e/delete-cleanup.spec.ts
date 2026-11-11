import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platformId } from "../../server/platform/capabilities.ts";
import { writeSimpleSession } from "../support/fixtures.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The delete dialogs offer to move what a conversation left on disk to the Trash
 * (docs/superpowers/specs/2026-11-11-delete-session-folder-design.md): the server of the spec's own has a stand-in for the
 * Trash command (`OMP_WEBUI_TRASH_COMMAND`) that moves what it is given into a folder of the spec's. No model is called.
 */

test.skip(platformId === "win32", "the stand-in Trash command is a POSIX shell script");

const root = realpathSync(mkdtempSync(join(tmpdir(), "ompw-e2e-cleanup-")));
const trashDir = join(root, "trash");
let s: TestServer;

test.beforeAll(async () => {
	mkdirSync(trashDir);
	const bin = join(root, "trash.sh");
	writeFileSync(bin, `#!/bin/sh\nmv "$1" "${trashDir}/$(basename "$1")-$$"\n`);
	chmodSync(bin, 0o755);
	s = await startTestServer(0, { OMP_WEBUI_TRASH_COMMAND: bin }, { login: false });
});
test.afterAll(async () => {
	await s?.stop();
	rmSync(root, { recursive: true, force: true });
});

const row = (page: Page, title: string) =>
	page.getByRole("complementary").locator('[data-testid="session-item"]', { hasText: title });

/** A conversation that worked in a folder of its own, with `node_modules` in it. */
function conversation(n: number, name: string): { file: string; folder: string } {
	const folder = join(root, name);
	mkdirSync(join(folder, "node_modules", "left-pad"), { recursive: true });
	writeFileSync(join(folder, "index.js"), "1");
	return { file: writeSimpleSession(s.agentDir, n, `Tidy ${name}`, undefined, folder), folder };
}

test("the delete dialog offers the folder and its dependency folders; a ticked dependency folder goes to the Trash", async ({
	page,
}) => {
	const { file, folder } = conversation(0xd0, "walnut");
	await page.goto(`${s.url}/?token=${s.accessToken}`);
	await row(page, "Tidy walnut").hover();
	await page.getByRole("button", { name: "Actions for Tidy walnut" }).click();
	await page.getByRole("menuitem", { name: "Delete…" }).click();

	const dialog = page.getByRole("dialog");
	await expect(dialog.getByTestId("cleanup-folder")).not.toBeChecked();
	await expect(dialog).toContainText("Also move its folder to the Trash");
	await expect(dialog).toContainText(`${folder}`);
	const dep = dialog.getByTestId("cleanup-dep");
	await expect(dep).toHaveCount(1);
	await expect(dialog).toContainText(join(folder, "node_modules"));
	// The folder ticked: the dependency folders go with it, and cannot be ticked alone.
	await dialog.getByTestId("cleanup-folder").check();
	await expect(dep).toBeDisabled();
	await expect(dialog.getByTestId("cleanup-summary")).toHaveText("After the delete, 1 item goes to the Trash.");
	await dialog.getByTestId("cleanup-folder").uncheck();
	await dep.check();

	await dialog.getByTestId("confirm-session-action").click();
	await expect.poll(() => existsSync(file), { timeout: 60_000 }).toBe(false);
	await expect.poll(() => existsSync(join(folder, "node_modules")), { timeout: 15_000 }).toBe(false);
	expect(existsSync(join(folder, "index.js"))).toBe(true);
});

test("the bulk delete dialog lists every selected conversation, each with its own options", async ({ page }) => {
	const titles: string[] = [];
	for (let i = 0; i < 10; i++) {
		conversation(0xe0 + i, `pecan-${i}`);
		titles.push(`Tidy pecan-${i}`);
	}
	await page.goto(`${s.url}/?token=${s.accessToken}`);
	await expect(row(page, "Tidy pecan-9")).toHaveCount(1, { timeout: 15_000 });
	await page.getByTestId("select-sessions").click();
	for (const title of titles) await row(page, title).click();
	await page.getByTestId("selection-bar").getByRole("button", { name: "Delete" }).click();

	const list = page.getByRole("dialog").getByTestId("bulk-delete-list");
	await expect(list.locator(":scope > li")).toHaveCount(10);
	// Every one, past the eighth too, offers its folder and its node_modules, behind its title until opened.
	for (const title of titles)
		await expect(list.locator("summary", { hasText: title })).toContainText("2 can go to the Trash");
	const last = list.locator("li", { hasText: "Tidy pecan-9" });
	await expect(last.getByTestId("cleanup-folder")).toBeHidden();
	await last.locator("summary").click();
	await expect(last.getByTestId("cleanup-folder")).toBeVisible();
	await expect(last.getByTestId("cleanup-dep")).toBeVisible();
	await page.keyboard.press("Escape");
});
