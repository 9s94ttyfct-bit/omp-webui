import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platformId } from "../../server/platform/capabilities.ts";
import { writeSimpleSession } from "../support/fixtures.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The Disk space page (docs/superpowers/specs/2026-11-26-disk-space-page-design.md): the rows of a projects folder of the
 * spec's own, sorted, and the "Clean up…" dialog, with a stand-in for the Trash command (`OMP_WEBUI_TRASH_COMMAND`). No
 * model is called.
 */

test.skip(platformId === "win32", "the stand-in Trash command is a POSIX shell script");

const root = realpathSync(mkdtempSync(join(tmpdir(), "ompw-e2e-disk-")));
const projects = join(root, "projects");
const trashDir = join(root, "trash");
let s: TestServer;

/** A project folder with `kb` KiB in it and a conversation in it per title. */
function project(name: string, kb: number, titles: string[], n: number): { folder: string; files: string[] } {
	const folder = join(projects, name);
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, "data.bin"), Buffer.alloc(kb * 1024, 1));
	const files = titles.map((title, i) => writeSimpleSession(s.agentDir, n + i, title, undefined, folder));
	return { folder, files };
}

let big: { folder: string; files: string[] };
let small: { folder: string; files: string[] };

test.beforeAll(async () => {
	mkdirSync(projects);
	mkdirSync(trashDir);
	const bin = join(root, "trash.sh");
	writeFileSync(bin, `#!/bin/sh\nmv "$1" "${trashDir}/$(basename "$1")-$$"\n`);
	chmodSync(bin, 0o755);
	s = await startTestServer(0, { OMP_WEBUI_TRASH_COMMAND: bin }, { login: false });
	const res = await fetch(`${s.url}/api/projects`, {
		method: "POST",
		headers: { "x-omp-webui-token": s.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
		body: JSON.stringify({ folder: projects }),
	});
	expect(res.ok).toBe(true);
	big = project("aardvark", 2048, ["Aardvark one", "Aardvark two"], 0xa0);
	small = project("zebra", 64, ["Zebra one"], 0xa8);
});
test.afterAll(async () => {
	await s?.stop();
	rmSync(root, { recursive: true, force: true });
});

/** The names of the rows of the spec's projects folder, in the order shown (the test server has a fixture conversation elsewhere). */
const names = async (page: Page) =>
	(
		await page
			.getByTestId("disk-row")
			.evaluateAll((rows) =>
				rows.map((r) => [
					r.getAttribute("data-folder") ?? "",
					r.querySelector("[data-testid=disk-row-name]")?.textContent ?? "",
				]),
			)
	)
		.filter(([folder]) => folder.startsWith(`${projects}/`))
		.map(([, name]) => name);
const rowOf = (page: Page, folder: string) => page.locator(`[data-testid="disk-row"][data-folder="${folder}"]`);

async function open(page: Page): Promise<void> {
	await page.goto(`${s.url}/?token=${s.accessToken}#/disk`);
	await expect(page.getByTestId("disk-space-page")).toBeVisible();
	// The first visit measures: wait until both rows have their folder's size.
	await expect(page.getByTestId("disk-scan-state")).toContainText("Measured", { timeout: 30_000 });
	await expect(rowOf(page, big.folder).getByTestId("disk-row-total")).toContainText("MB");
}

test("the page lists the projects biggest first and sorts by each column", async ({ page }) => {
	await open(page);
	expect(await names(page)).toEqual(["aardvark", "zebra"]);
	await page.getByTestId("disk-sort-total").click();
	expect(await names(page)).toEqual(["zebra", "aardvark"]);
	await page.getByTestId("disk-sort-name").click();
	expect(await names(page)).toEqual(["aardvark", "zebra"]);
	await page.getByTestId("disk-sort-name").click();
	expect(await names(page)).toEqual(["zebra", "aardvark"]);
	await page.getByTestId("disk-sort-conversations").click();
	expect(await names(page)).toEqual(["aardvark", "zebra"]);
	await expect(page.getByTestId("disk-footer")).toContainText("folders");
	// The sort is remembered.
	await page.reload();
	await expect(page.getByTestId("disk-sort-conversations")).toHaveAttribute("title", /Conversations/);
	await expect(page.locator('th[aria-sort="descending"]')).toContainText("Conversations");
});

test("the confirm button says what it will do and the room it frees", async ({ page }) => {
	await open(page);
	await rowOf(page, big.folder).getByTestId("disk-clean").click();
	const dialog = page.getByRole("dialog");
	const confirm = dialog.getByTestId("disk-confirm");
	await expect(confirm).toHaveText("Clean up");
	await expect(confirm).toBeDisabled();
	await expect(dialog.getByTestId("disk-conversation")).toHaveCount(2);
	await dialog.getByTestId("disk-conversation").first().check();
	await expect(confirm).toHaveText(/^Delete 1 conversation · frees /);
	await dialog.getByTestId("cleanup-folder").check();
	await expect(confirm).toHaveText(/^Delete 1 conversation and move 1 item to the Trash · frees 2(\.\d)? MB$/);
	await expect(dialog.getByTestId("disk-kept-note")).toContainText("1 conversation that ran here stays");
	await page.keyboard.press("Escape");
	await expect(dialog).toBeHidden();
	expect(existsSync(big.folder)).toBe(true);
});

test("the dialog deletes only the ticked conversations", async ({ page }) => {
	await open(page);
	await rowOf(page, big.folder).getByTestId("disk-clean").click();
	const dialog = page.getByRole("dialog");
	await dialog.locator("li", { hasText: "Aardvark two" }).getByTestId("disk-conversation").check();
	await dialog.getByTestId("disk-confirm").click();
	await expect(dialog).toBeHidden({ timeout: 60_000 });
	await expect.poll(() => existsSync(big.files[1]), { timeout: 30_000 }).toBe(false);
	expect(existsSync(big.files[0])).toBe(true);
	expect(existsSync(big.folder)).toBe(true);
});

test("the dialog moves only the folder when only it is ticked, and the row is measured again", async ({ page }) => {
	await open(page);
	await rowOf(page, small.folder).getByTestId("disk-clean").click();
	const dialog = page.getByRole("dialog");
	await dialog.getByTestId("cleanup-folder").check();
	await expect(dialog.getByTestId("disk-confirm")).toHaveText(/^Move 1 item to the Trash · frees /);
	await dialog.getByTestId("disk-confirm").click();
	await expect(dialog).toBeHidden({ timeout: 60_000 });
	expect(existsSync(small.folder)).toBe(false);
	expect(existsSync(small.files[0])).toBe(true);
	// The folder is gone; its conversation is still listed, under a row whose folder is gone.
	await expect(rowOf(page, small.folder)).toContainText("folder gone", { timeout: 30_000 });
});

test.describe("on a phone", () => {
	test.use({ viewport: { width: 390, height: 844 } });
	test("the table shows name, total and the button", async ({ page }) => {
		await open(page);
		const row = rowOf(page, big.folder);
		await expect(row.getByTestId("disk-row-name")).toBeVisible();
		await expect(row.getByTestId("disk-row-total")).toBeVisible();
		await expect(row.getByTestId("disk-clean")).toBeVisible();
		await expect(page.getByTestId("disk-sort-folder")).toBeHidden();
		await expect(page.getByTestId("disk-sort-lastUsed")).toBeHidden();
		const box = await page.getByTestId("disk-table").boundingBox();
		expect(box && box.width <= 390).toBe(true);
	});
});
