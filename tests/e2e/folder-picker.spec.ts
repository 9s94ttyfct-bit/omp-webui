import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * New chat's folder picker lists what a person can click into: `~` is the home folder, a symlink to a folder can be
 * opened, a list that was cut says so, and a path that cannot be listed is explained in a sentence rather than as the
 * system's error (#438). The processes the page starts for the chosen folders make no model call.
 */

let base: string;
test.beforeAll(() => {
	base = mkdtempSync(join(process.env.OMPW_E2E_WORK as string, "picker-"));
});
test.afterAll(() => rmSync(base, { recursive: true, force: true }));

async function openPicker(page: Page) {
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await page.getByTestId("cwd-picker").click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByTestId("dir-up")).toBeVisible();
	return { dialog, path: dialog.getByLabel("Path") };
}

test("`~` is the home folder, a relative path is refused, a file is not a folder; none shows ENOENT", async ({
	page,
}) => {
	const { dialog, path } = await openPicker(page);
	const meta: { home: string } = await page.request.get("/api/meta").then((r) => r.json());
	await path.fill("~");
	await dialog.getByRole("button", { name: "Go", exact: true }).click();
	await expect(path).toHaveValue(meta.home);

	await path.fill("projects/x");
	await dialog.getByRole("button", { name: "Go", exact: true }).click();
	await expect(dialog).toContainText("is not a full path: start it with / or ~.");

	await path.fill(join(process.env.OMPW_E2E_AGENT_DIR as string, "config.yml"));
	await dialog.getByRole("button", { name: "Go", exact: true }).click();
	await expect(dialog).toContainText("is not a folder.");
	await expect(dialog).not.toContainText(/ENOENT|ENOTDIR|scandir/);
});

test("a symlink to a folder is listed and opens, and a list cut at 500 says how many folders it leaves out", async ({
	page,
}) => {
	const real = join(base, "real", "inner");
	mkdirSync(real, { recursive: true });
	symlinkSync(join(base, "real"), join(base, "linkproj"));
	const many = join(base, "many");
	for (let i = 1; i <= 520; i++) mkdirSync(join(many, `proj${String(i).padStart(3, "0")}`), { recursive: true });

	const { dialog, path } = await openPicker(page);
	await path.fill(base);
	await dialog.getByRole("button", { name: "Go", exact: true }).click();
	await dialog.getByRole("button", { name: "linkproj" }).click();
	await expect(dialog.getByRole("button", { name: "inner" })).toBeVisible();

	await path.fill(many);
	await dialog.getByRole("button", { name: "Go", exact: true }).click();
	await expect(dialog.getByRole("button", { name: "proj500" })).toBeVisible();
	await expect(dialog.getByRole("button", { name: "proj501" })).toHaveCount(0);
	await expect(dialog.getByTestId("dir-omitted")).toContainText("Showing the first 500. 20 more not listed");
});
