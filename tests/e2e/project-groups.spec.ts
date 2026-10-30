import { writeChatSession } from "../support/chat-session.ts";
import {
	chooseProject,
	closeProjects,
	groupButton,
	openProjects,
	projectPopover,
	projectRow,
	projectTrigger,
} from "../support/project-groups.ts";
import { devices, expect, type Page, test } from "./fixtures.ts";

/**
 * The sidebar's project groups (#636): a group is made in the project list, a project is put in it from its own menu, folding
 * it is kept when the page is loaded again, and deleting it puts the project back at the top level. No model is called.
 *
 * The groups are the server's (`<data dir>/project-groups.json`), shared by the whole worker, so each test makes groups with
 * names of its own and deletes them when it is done.
 */

const row = (page: Page, title: string) =>
	page.getByRole("complementary").locator('[data-testid="session-item"]', { hasText: title });

/** A project with a conversation of its own, so that its row is in the list. */
function project(agentDir: string, n: number, title: string, cwd: string): string {
	return writeChatSession(agentDir, {
		n,
		title,
		cwd,
		turns: [{ prompt: "Where does the heron stand?", reply: "In the shallows." }],
	});
}

test("a group is made, a project moved in, folded (fold kept after a reload), renamed, and deleted", async ({
	page,
}) => {
	const agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
	const cwd = "/tmp/ompw-groups-blue";
	project(agentDir, 0x71, "Groups blue heron", cwd);
	await page.goto("/");
	await expect(row(page, "Groups blue heron")).toHaveCount(1, { timeout: 15_000 });

	// New group, from the list's own menu line.
	await openProjects(page);
	await projectPopover(page).getByTestId("new-project-group").click();
	await page.getByTestId("group-name").fill("Blue group");
	await page.getByTestId("save-group").click();
	const group = groupButton(page, "Blue group");
	await expect(group, "the group is in the list once it is made").toHaveCount(1);
	await expect(group, "and it is open").toHaveAttribute("aria-expanded", "true");

	// The project is still at the top level: it has not been put in the group yet.
	await expect(projectRow(page, cwd), "the project is at the top level").toHaveCount(1);
	await expect(projectPopover(page).getByTestId("group-projects").getByTestId("project-row")).toHaveCount(0);

	// Its own menu puts it in the group.
	await projectRow(page, cwd).locator("..").getByTestId("project-menu").click();
	await page.getByTestId("move-to-group").filter({ hasText: "Blue group" }).click();
	await expect(projectPopover(page).getByTestId("group-projects").locator(`[data-cwd="${cwd}"]`)).toHaveCount(1);
	// And only there: one row for it, in the group.
	await expect(projectPopover(page).locator(`[data-testid="project-row"][data-cwd="${cwd}"]`)).toHaveCount(1);

	// Folded: the projects in it are not drawn, and a screen reader is told it is folded.
	await groupButton(page, "Blue group").click();
	await expect(groupButton(page, "Blue group")).toHaveAttribute("aria-expanded", "false");
	await expect(projectPopover(page).getByTestId("group-projects")).toHaveCount(0);
	await expect(groupButton(page, "Blue group"), "the fold says what it folds").toHaveAttribute(
		"aria-controls",
		/^project-group-/,
	);

	// Folded, it is still folded after the page is loaded again: the state is the app's data, not this page's.
	await page.reload();
	await expect(row(page, "Groups blue heron")).toHaveCount(1, { timeout: 15_000 });
	await openProjects(page);
	await expect(groupButton(page, "Blue group")).toHaveAttribute("aria-expanded", "false");

	// Renamed: its id, its projects and its place are kept.
	await groupButton(page, "Blue group").locator("..").getByTestId("group-menu").click();
	await page.getByTestId("rename-group").click();
	await page.getByTestId("group-name").fill("Blue group renamed");
	await page.getByTestId("save-group").click();
	await expect(groupButton(page, "Blue group renamed")).toHaveCount(1);
	await groupButton(page, "Blue group renamed").click();
	await expect(groupButton(page, "Blue group renamed")).toHaveAttribute("aria-expanded", "true");
	await expect(
		projectPopover(page).getByTestId("group-projects").locator(`[data-cwd="${cwd}"]`),
		"the project is still in it",
	).toHaveCount(1);

	// Deleted: the project is at the top level again, and nothing in its folder is touched.
	await groupButton(page, "Blue group renamed").locator("..").getByTestId("group-menu").click();
	await page.getByTestId("delete-group").click();
	await expect(page.getByRole("dialog")).toContainText("Blue group renamed");
	await page.getByTestId("confirm-delete-group").click();
	await expect(groupButton(page, "Blue group renamed")).toHaveCount(0);
	await expect(projectRow(page, cwd), "the project is back at the top level").toHaveCount(1);
	// And it filters the list as before: choosing it shows only its conversation.
	await projectRow(page, cwd).click();
	await expect(row(page, "Groups blue heron")).toHaveCount(1);
	await expect(page.getByTestId("session-item")).toHaveCount(1);
	await chooseProject(page, null);
});

test("a name another group has is refused before the server is asked", async ({ page }) => {
	const agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
	project(agentDir, 0x72, "Groups name heron", "/tmp/ompw-groups-name");
	await page.goto("/");
	await expect(row(page, "Groups name heron")).toHaveCount(1, { timeout: 15_000 });
	await openProjects(page);
	const make = async (name: string) => {
		await projectPopover(page).getByTestId("new-project-group").click();
		await page.getByTestId("group-name").fill(name);
		await page.getByTestId("save-group").click();
	};
	await make("Name taken");
	await expect(groupButton(page, "Name taken")).toHaveCount(1);
	await make("name TAKEN");
	await expect(page.getByTestId("group-problem"), "the same name, case and all, is refused").toContainText(
		"Name taken",
	);
	await expect(page.getByTestId("group-name")).toBeFocused();
	// A name that is too long cannot be typed past the limit.
	await page.getByTestId("group-name").fill("x".repeat(80));
	await expect(page.getByTestId("group-name")).toHaveValue("x".repeat(60));
	await page.getByRole("button", { name: "Cancel" }).click();
	// Put the list back as it was.
	await groupButton(page, "Name taken").locator("..").getByTestId("group-menu").click();
	await page.getByTestId("delete-group").click();
	await page.getByTestId("confirm-delete-group").click();
	await expect(groupButton(page, "Name taken")).toHaveCount(0);
});

test("a project's menu takes it out of a group again", async ({ page }) => {
	const agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
	const cwd = "/tmp/ompw-groups-out";
	project(agentDir, 0x73, "Groups out heron", cwd);
	await page.goto("/");
	await expect(row(page, "Groups out heron")).toHaveCount(1, { timeout: 15_000 });
	await openProjects(page);
	await projectPopover(page).getByTestId("new-project-group").click();
	await page.getByTestId("group-name").fill("Out group");
	await page.getByTestId("save-group").click();
	await projectRow(page, cwd).locator("..").getByTestId("project-menu").click();
	await page.getByTestId("move-to-group").filter({ hasText: "Out group" }).click();
	await expect(projectPopover(page).getByTestId("group-projects").locator(`[data-cwd="${cwd}"]`)).toHaveCount(1);

	// Out again, from the row's own menu in the group.
	await projectPopover(page)
		.getByTestId("group-projects")
		.locator(`[data-cwd="${cwd}"]`)
		.locator("..")
		.getByTestId("project-menu")
		.click();
	await page.getByTestId("move-out").click();
	await expect(projectPopover(page).getByTestId("group-projects").locator(`[data-cwd="${cwd}"]`)).toHaveCount(0);
	await expect(projectRow(page, cwd), "back at the top level").toHaveCount(1);

	await groupButton(page, "Out group").locator("..").getByTestId("group-menu").click();
	await page.getByTestId("delete-group").click();
	await page.getByTestId("confirm-delete-group").click();
	await expect(groupButton(page, "Out group")).toHaveCount(0);
});

for (const [lang, all, newGroup, groupName, close] of [
	["en", "All projects", "New group", "Blue group", "Close"],
	["zh-CN", "所有项目", "新建分组", "蓝色分组", "关闭"],
] as const) {
	test(`the project list and its groups are worded in ${lang}`, async ({ page }) => {
		await page.addInitScript((l) => localStorage.setItem("ompw.lang", l), lang);
		await page.goto("/");
		await expect(page.getByTestId("session-item").first()).toBeVisible({ timeout: 15_000 });
		await openProjects(page);
		await expect(projectPopover(page).getByTestId("project-all")).toContainText(all);
		await projectPopover(page).getByTestId("new-project-group").click();
		await expect(page.getByRole("dialog")).toContainText(newGroup);
		await page.getByTestId("group-name").fill(groupName);
		await page.getByTestId("save-group").click();
		await expect(groupButton(page, groupName)).toHaveCount(1);
		// Its menu is the page's language, and a project's menu says what it does.
		await groupButton(page, groupName).locator("..").getByTestId("group-menu").click();
		await expect(page.getByTestId("delete-group")).toContainText(lang === "en" ? "Delete group" : "删除分组");
		await page.getByTestId("delete-group").click();
		await page.getByTestId("confirm-delete-group").click();
		await expect(groupButton(page, groupName)).toHaveCount(0);
		await projectPopover(page).getByRole("button", { name: close }).click();
		await expect(projectPopover(page)).toHaveCount(0);
		// The funnel still says what it filters by.
		await expect(projectTrigger(page)).toHaveAttribute("title", lang === "en" ? /^Project: / : /^项目: /);
	});
}

test.describe("on a phone", () => {
	const { defaultBrowserType: _browser, ...device } = devices["iPhone 15"];
	test.use({ ...device, hasTouch: true });

	test("the project list is a full-width sheet a finger can use", async ({ page }) => {
		const agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
		const cwd = "/tmp/ompw-groups-phone";
		project(agentDir, 0x74, "Groups phone heron", cwd);
		await page.goto("/");
		await page
			.getByTestId("show-sidebar")
			.click()
			.catch(() => {});
		await expect(row(page, "Groups phone heron")).toHaveCount(1, { timeout: 15_000 });
		await openProjects(page);
		const popover = await projectPopover(page).boundingBox();
		const screen = page.viewportSize();
		expect(popover).not.toBeNull();
		expect(screen).not.toBeNull();
		if (!popover || !screen) return;
		// Nothing of it is off the screen, and a finger reaches each row.
		expect(popover.x).toBeGreaterThanOrEqual(0);
		expect(popover.x + popover.width).toBeLessThanOrEqual(screen.width + 1);
		for (const el of [await projectPopover(page).getByTestId("project-all").boundingBox(), popover]) {
			expect(el?.height ?? 0).toBeGreaterThan(0);
		}
		const rowBox = await projectPopover(page).getByTestId("project-row").first().boundingBox();
		expect(rowBox?.height ?? 0, "a row a finger can hit").toBeGreaterThanOrEqual(32);
		// Making a group works by touch.
		await projectPopover(page).getByTestId("new-project-group").tap();
		await page.getByTestId("group-name").fill("Phone group");
		await page.getByTestId("save-group").tap();
		await expect(groupButton(page, "Phone group")).toHaveCount(1);
		await groupButton(page, "Phone group").locator("..").getByTestId("group-menu").tap();
		await page.getByTestId("delete-group").tap();
		await page.getByTestId("confirm-delete-group").tap();
		await expect(groupButton(page, "Phone group")).toHaveCount(0);
		await closeProjects(page);
	});
});

test.describe("in the narrowest sidebar", () => {
	test.use({ viewport: { width: 1400, height: 800 } });

	test("the list fits inside a 200px sidebar and its rows still read", async ({ page }) => {
		await page.goto("/");
		await expect(page.getByTestId("session-item").first()).toBeVisible({ timeout: 15_000 });
		const grip = page.getByTestId("resize-sidebar");
		await grip.focus();
		await page.keyboard.press("Home");
		const aside = await page.locator("aside", { has: page.getByTestId("session-list") }).boundingBox();
		await openProjects(page);
		const popover = await projectPopover(page).boundingBox();
		expect(aside).not.toBeNull();
		expect(popover).not.toBeNull();
		if (!aside || !popover) return;
		expect(popover.width, "no wider than the window").toBeLessThanOrEqual(1400);
		expect(popover.x, "inside the window").toBeGreaterThanOrEqual(0);
		expect(popover.x + popover.width).toBeLessThanOrEqual(1401);
		// The group line and the new-group line are on one line each: a row that wraps says nothing in 200px.
		await projectPopover(page).getByTestId("new-project-group").click();
		await page.getByTestId("group-name").fill("Narrow group");
		await page.getByTestId("save-group").click();
		const group = await groupButton(page, "Narrow group").boundingBox();
		expect(group?.height ?? 0).toBeLessThanOrEqual(34);
		await groupButton(page, "Narrow group").locator("..").getByTestId("group-menu").click();
		await page.getByTestId("delete-group").click();
		await page.getByTestId("confirm-delete-group").click();
		await expect(groupButton(page, "Narrow group")).toHaveCount(0);
		await page.getByTestId("resize-sidebar").focus();
		await page.keyboard.press("Enter");
	});
});
test("the keyboard opens the list, chooses a project and folds a group", async ({ page }) => {
	const agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
	const cwd = "/tmp/ompw-groups-keys";
	project(agentDir, 0x75, "Groups keys heron", cwd);
	await page.goto("/");
	await expect(row(page, "Groups keys heron")).toHaveCount(1, { timeout: 15_000 });

	// Enter on the funnel opens the list, and the keyboard is in it (Radix focuses the popup's content, and its own
	// focus scope keeps Tab inside it, which is what a popup that is a dialog is for).
	await projectTrigger(page).focus();
	await page.keyboard.press("Enter");
	await expect(projectPopover(page)).toBeVisible();
	const inside = await page.evaluate(() => document.activeElement?.closest('[data-testid="project-popover"]') !== null);
	expect(inside, "the keyboard is in the project list").toBe(true);

	// A project's row takes Enter and chooses that project.
	await projectRow(page, cwd).focus();
	await page.keyboard.press("Enter");
	await expect(projectPopover(page)).toHaveCount(0);
	await expect(page.getByTestId("session-item")).toHaveCount(1);
	await chooseProject(page, null);

	// A group is a real disclosure button: Enter folds it, Enter opens it again, and a screen reader is told which.
	await openProjects(page);
	await projectPopover(page).getByTestId("new-project-group").click();
	await page.getByTestId("group-name").fill("Keyboard group");
	await page.getByTestId("save-group").click();
	await expect(groupButton(page, "Keyboard group")).toHaveAttribute("aria-expanded", "true");
	await groupButton(page, "Keyboard group").focus();
	await page.keyboard.press("Enter");
	await expect(groupButton(page, "Keyboard group"), "Enter folds it").toHaveAttribute("aria-expanded", "false");
	await groupButton(page, "Keyboard group").focus();
	await page.keyboard.press("Enter");
	await expect(groupButton(page, "Keyboard group"), "Enter opens it again").toHaveAttribute("aria-expanded", "true");

	// Escape closes the list and gives the keyboard back to the funnel.
	await page.keyboard.press("Escape");
	await expect(projectPopover(page)).toHaveCount(0);
	await expect(projectTrigger(page)).toBeFocused();

	// Put the list back as it was.
	await openProjects(page);
	await groupButton(page, "Keyboard group").locator("..").getByTestId("group-menu").click();
	await page.getByTestId("delete-group").click();
	await page.getByTestId("confirm-delete-group").click();
	await expect(groupButton(page, "Keyboard group")).toHaveCount(0);
});
