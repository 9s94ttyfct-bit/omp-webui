import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The projects folder (Settings › Projects folder) and "New project folder" in the folder picker of a new chat (#615):
 * a name is made into a folder in the projects folder and the chat starts there; what cannot be a name is told as it is
 * typed; a folder that exists is never touched. No model call. The server's home is the test's own: nothing chosen is
 * `~/omp` in it, shown before it is there and made by the first project.
 */

const home = () => process.env.OMPW_E2E_HOME as string;
const work = () => process.env.OMPW_E2E_WORK as string;
/** The default projects folder in the test's own home. */
const omp = () => join(home(), "omp");

/** Back to the default, whatever an earlier test chose. */
test.beforeEach(async ({ e2eServer }) => {
	await fetch(`${e2eServer.url}/api/projects`, {
		method: "POST",
		headers: { "x-omp-webui-token": e2eServer.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
		body: JSON.stringify({ folder: null }),
	});
});

async function openPicker(page: Page, lang: "en" | "zh-CN" = "en") {
	await page.addInitScript(
		([cwd, l]) => {
			localStorage.setItem("ompw.cwd", cwd);
			localStorage.setItem("ompw.lang", l);
		},
		[work(), lang],
	);
	await page.goto("/");
	await page.getByTestId("cwd-picker").click();
	const dialog = page.getByRole("dialog");
	await expect(dialog.getByTestId("dir-up")).toBeVisible();
	return dialog;
}

test("a new project folder is made in the projects folder, and the chat starts in it", async ({ page }) => {
	const dialog = await openPicker(page);
	await dialog.getByTestId("new-project").click();
	await expect(dialog.getByTestId("new-project-in")).toHaveText("Made in ~/omp");
	await dialog.getByTestId("new-project-name").fill("my-app");
	await dialog.getByTestId("new-project-create").click();
	await expect(dialog).toHaveCount(0);
	const made = join(omp(), "my-app");
	expect(existsSync(made)).toBe(true);
	expect(readdirSync(made)).toEqual([]);
	await expect(page.getByTestId("cwd-picker")).toContainText("~/omp/my-app");
	// The chat has started there: omp runs in it, so its controls are on the page.
	await expect(page.getByTestId("goal-mode")).toBeVisible({ timeout: 60_000 });
	await expect(page.getByTestId("new-chat-error")).toHaveCount(0);
});

test("what cannot be a name is told as it is typed, and nothing is made", async ({ page }) => {
	const before = readdirSync(home()).sort();
	const dialog = await openPicker(page);
	await dialog.getByTestId("new-project").click();
	const name = dialog.getByTestId("new-project-name");
	const create = dialog.getByTestId("new-project-create");
	const problem = dialog.getByTestId("new-project-problem");
	await expect(create).toBeDisabled();
	for (const [typed, said] of [
		["a/b", "cannot contain / or \\"],
		["../escape", "cannot contain / or \\"],
		["..", "cannot start with a dot"],
		[".hidden", "cannot start with a dot"],
		[" spaced", "cannot start or end with a space"],
		["a:b", "cannot contain control characters"],
		["x".repeat(101), "too long (at most 100 characters)"],
	] as const) {
		await name.fill(typed);
		await expect(problem, typed).toContainText(said);
		await expect(create, typed).toBeDisabled();
		await expect(name, typed).toHaveAttribute("aria-invalid", "true");
	}
	await name.fill("fine-name");
	await expect(problem).toHaveCount(0);
	await expect(create).toBeEnabled();
	expect(readdirSync(home()).sort()).toEqual(before);
});

test("a folder that exists is not touched: the name is told to be taken and the dialog stays", async ({ page }) => {
	const taken = join(omp(), "taken");
	mkdirSync(taken, { recursive: true });
	writeFileSync(join(taken, "keep.txt"), "mine");
	const dialog = await openPicker(page);
	await dialog.getByTestId("new-project").click();
	await dialog.getByTestId("new-project-name").fill("taken");
	await dialog.getByTestId("new-project-create").click();
	await expect(dialog.getByTestId("new-project-problem")).toContainText("“taken” already exists");
	await expect(dialog).toBeVisible();
	// Another name goes through from the same dialog, and Enter makes it.
	await dialog.getByTestId("new-project-name").fill("taken-2");
	await dialog.getByTestId("new-project-name").press("Enter");
	await expect(dialog).toHaveCount(0);
	expect(readFileSync(join(taken, "keep.txt"), "utf8")).toBe("mine");
	expect(existsSync(join(omp(), "taken-2"))).toBe(true);
	await expect(page.getByTestId("cwd-picker")).toContainText("~/omp/taken-2");
});

test("Back closes the form, and the existing folders can still be picked", async ({ page }) => {
	mkdirSync(join(home(), "existing"), { recursive: true });
	const dialog = await openPicker(page);
	await dialog.getByLabel("Path").fill(home());
	await dialog.getByRole("button", { name: "Go" }).click();
	await dialog.getByTestId("new-project").click();
	await dialog.getByTestId("new-project-name").fill("never");
	await dialog.getByRole("button", { name: "Back", exact: true }).click();
	await expect(dialog.getByTestId("new-project-form")).toHaveCount(0);
	await expect(dialog.getByTestId("new-project")).toBeVisible();
	await dialog.getByRole("button", { name: "existing", exact: true }).click();
	await dialog.getByRole("button", { name: "Use this folder" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(page.getByTestId("cwd-picker")).toContainText("~/existing");
	expect(existsSync(join(home(), "never"))).toBe(false);
});

test("Settings › Projects folder: the default is shown, a chosen folder is kept and is where the next project is made", async ({
	page,
}) => {
	mkdirSync(join(home(), "dev"), { recursive: true });
	await page.goto("/#/settings/chats");
	const card = page.getByTestId("projects-settings");
	await expect(card.getByRole("heading", { level: 2, name: "Projects folder" })).toBeVisible();
	const field = card.getByTestId("projects-folder");
	await expect(field).toHaveValue("~/omp");
	await expect(card.getByTestId("projects-is-default")).toBeVisible();
	await expect(card.getByTestId("projects-save")).toBeDisabled();

	await field.fill("~/dev");
	await card.getByTestId("projects-save").click();
	await expect(card.getByTestId("projects-status")).toContainText("Saved");
	await expect(card.getByTestId("projects-is-default")).toHaveCount(0);
	await page.reload();
	await expect(page.getByTestId("projects-folder")).toHaveValue("~/dev");

	// The next project is made there.
	const dialog = await openPicker(page);
	await dialog.getByTestId("new-project").click();
	await expect(dialog.getByTestId("new-project-in")).toHaveText("Made in ~/dev");
	await dialog.getByTestId("new-project-name").fill("from-settings");
	await dialog.getByTestId("new-project-create").click();
	await expect(dialog).toHaveCount(0);
	expect(existsSync(join(home(), "dev", "from-settings"))).toBe(true);
	await expect(page.getByTestId("cwd-picker")).toContainText("~/dev/from-settings");

	await page.goto("/#/settings/chats");
	await page.getByTestId("projects-default").click();
	await expect(page.getByTestId("projects-folder")).toHaveValue("~/omp");
	await expect(page.getByTestId("projects-default")).toHaveCount(0);
});

test("a page that is not at this computer (on the network) sees the projects folder and cannot change it", async ({
	page,
}) => {
	// What the server's own 403 asks is `meta.local`; a page of the network is a remote page and not `local` (#621).
	await page.route("**/api/meta", async (route) => {
		const real = await (await route.fetch()).json();
		return route.fulfill({ json: { ...real, remote: true, local: false } });
	});
	await page.goto("/#/settings/chats");
	const card = page.getByTestId("projects-settings");
	await expect(card.getByTestId("projects-folder")).toHaveValue("~/omp");
	await expect(card.getByTestId("projects-folder")).toHaveJSProperty("readOnly", true);
	await expect(card.getByTestId("projects-choose")).toHaveCount(0);
	await expect(card.getByTestId("projects-save")).toHaveCount(0);
	await expect(card).toContainText("on the computer omp-webui runs on");
});

test("a folder that cannot be the projects folder is refused with a reason, and the setting stays", async ({
	page,
}) => {
	await page.goto("/#/settings/chats");
	const card = page.getByTestId("projects-settings");
	await card.getByTestId("projects-folder").fill("~/nowhere");
	await card.getByTestId("projects-save").click();
	await expect(card.getByTestId("projects-error")).toContainText("does not exist");
	await card.getByTestId("projects-folder").fill("relative/path");
	await card.getByTestId("projects-save").click();
	await expect(card.getByTestId("projects-error")).toContainText("not a full path");
	await page.reload();
	await expect(page.getByTestId("projects-folder")).toHaveValue("~/omp");
});

test("the projects folder can be chosen with the folder picker", async ({ page }) => {
	mkdirSync(join(home(), "picked"), { recursive: true });
	await page.goto("/#/settings/chats");
	const card = page.getByTestId("projects-settings");
	await card.getByTestId("projects-choose").click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toContainText("Choose the projects folder");
	// Not offered here: this picker chooses a folder, and does not make one.
	await expect(dialog.getByTestId("new-project")).toHaveCount(0);
	await dialog.getByLabel("Path").fill(join(home(), "picked"));
	await dialog.getByRole("button", { name: "Use this folder" }).click();
	await expect(card.getByTestId("projects-folder")).toHaveValue("~/picked");
	await expect(card.getByTestId("projects-status")).toContainText("Saved");
});

test("a chosen folder that has since gone is said so, and no project is made in its place", async ({ page }) => {
	// A folder that was chosen and is not there now: the server reads its setting file at each look, so it is written as
	// it would stand after the folder was moved away.
	const gone = join(home(), "soon-gone");
	writeFileSync(
		join(process.env.OMPW_E2E_ROOT as string, "data", "projects-folder.json"),
		JSON.stringify({ folder: gone }),
	);
	await page.goto("/#/settings/chats");
	await expect(page.getByTestId("projects-missing")).toBeVisible();
	const dialog = await openPicker(page);
	await dialog.getByTestId("new-project").click();
	await dialog.getByTestId("new-project-name").fill("lost");
	await dialog.getByTestId("new-project-create").click();
	await expect(dialog.getByTestId("new-project-problem")).toContainText("no longer exists");
	expect(existsSync(join(gone, "lost"))).toBe(false);
});

for (const lang of ["en", "zh-CN"] as const) {
	test(`the new project form reads in ${lang} and passes the accessibility check`, async ({ page }) => {
		const dialog = await openPicker(page, lang);
		await dialog.getByTestId("new-project").click();
		await dialog.getByTestId("new-project-name").fill("a/b");
		await expect(dialog.getByTestId("new-project-problem")).toContainText(
			lang === "en" ? "cannot contain" : "不能包含",
		);
		const { violations } = await new AxeBuilder({ page }).include('[role="dialog"]').analyze();
		expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
	});
}

// Screenshots for the pull request: OMPW_PROJECTS_SHOTS=<dir>, every combination of language and theme.
if (process.env.OMPW_PROJECTS_SHOTS) {
	for (const lang of ["en", "zh-CN"] as const) {
		for (const theme of ["light", "dark"] as const) {
			test(`screenshots ${lang} ${theme}`, async ({ page }) => {
				mkdirSync(join(omp(), "demo"), { recursive: true });
				await page.addInitScript((t) => localStorage.setItem("ompw.theme", t), theme);
				const dir = process.env.OMPW_PROJECTS_SHOTS as string;
				const dialog = await openPicker(page, lang);
				await dialog.getByTestId("new-project").click();
				await dialog.getByTestId("new-project-name").fill("demo");
				await dialog.getByTestId("new-project-create").click();
				await expect(dialog.getByTestId("new-project-problem")).toBeVisible();
				await dialog.screenshot({ path: `${dir}/picker-${lang}-${theme}.png`, animations: "disabled" });
				await dialog.getByTestId("new-project-name").fill("a/b");
				await dialog.screenshot({ path: `${dir}/picker-invalid-${lang}-${theme}.png`, animations: "disabled" });
				await page.keyboard.press("Escape");
				await page.goto("/#/settings/chats");
				const card = page.getByTestId("projects-settings");
				await expect(card.getByTestId("projects-folder")).toHaveValue("~/omp");
				await card.screenshot({ path: `${dir}/settings-${lang}-${theme}.png`, animations: "disabled" });
			});
		}
	}
}
