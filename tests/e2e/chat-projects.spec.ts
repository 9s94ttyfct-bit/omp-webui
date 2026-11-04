import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatProjects } from "../../shared/chat-projects.ts";
import { writeChatSession } from "../support/chat-session.ts";
import { sessionRow } from "../support/live.ts";
import { writeLongFakeOmp } from "../support/long-fake-omp-bin.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The sidebar's projects: named groups of conversations above the list by date. A project is made from the sidebar, a
 * conversation is put in it from its menu and by dragging its row onto the project's, and it then is listed under the
 * project and no longer by date; the project's folder button shows its folder in the Files panel; New chat in the project
 * lands in it (the server puts it there with its first message); deleting the project puts its conversations back in the
 * list by date. The omp is a stand-in that writes its file the way omp does (tests/support/long-fake-omp.ts): no model is
 * called. The server is this file's own, so its projects are nobody else's.
 */

let s: TestServer;
let binDir: string;
let folder: string;

test.beforeAll(async () => {
	binDir = mkdtempSync(join(tmpdir(), "ompw-fake-omp-"));
	s = await startTestServer(0, { OMP_BIN: writeLongFakeOmp(binDir) });
	mkdirSync(s.work, { recursive: true });
	folder = join(s.work, "birds");
	mkdirSync(folder, { recursive: true });
	writeFileSync(join(folder, "heron-notes.md"), "# Herons\n");
	const turns = [{ prompt: "Where does the heron stand?", reply: "In the shallows." }];
	writeChatSession(s.agentDir, { n: 0x31, title: "Heron north", cwd: s.work, turns });
	writeChatSession(s.agentDir, { n: 0x32, title: "Heron south", cwd: s.work, turns });
	writeChatSession(s.agentDir, { n: 0x33, title: "Heron east", cwd: s.work, turns });
});
test.afterAll(async () => {
	await s?.stop();
	rmSync(binDir, { recursive: true, force: true });
});

const home = () => `${s.url}/?token=${s.accessToken}`;
const projects = (page: Page) => page.getByTestId("projects-section");
const dated = (page: Page) => page.getByTestId("session-list");
const projectRow = (page: Page, name: string) =>
	page.getByTestId("project-row").filter({ has: page.getByTestId("project-name").getByText(name, { exact: true }) });
const listed = async (): Promise<ChatProjects> =>
	(await (
		await fetch(`${s.url}/api/chat-projects`, { headers: { "x-omp-webui-token": s.accessToken } })
	).json()) as ChatProjects;

async function makeProject(page: Page, name: string): Promise<void> {
	await page.getByTestId("projects-new").click();
	await page.getByTestId("project-name-input").fill(name);
	await page.getByTestId("project-save").click();
	await expect(projectRow(page, name)).toHaveCount(1);
}

async function moveByMenu(page: Page, title: string, project: string): Promise<void> {
	await sessionRow(page, title).hover();
	await page.getByRole("button", { name: `Actions for ${title}` }).click();
	await page.getByTestId("session-move-to-project").click();
	await page.getByTestId("move-to-project").filter({ hasText: project }).click();
}

async function drag(page: Page, title: string, project: string): Promise<void> {
	const from = await sessionRow(page, title).boundingBox();
	const to = await projectRow(page, project).boundingBox();
	if (!from || !to) throw new Error("the row or the project is not on screen");
	await page.mouse.move(from.x + 24, from.y + from.height / 2);
	await page.mouse.down();
	await page.mouse.move(from.x + 32, from.y + from.height / 2, { steps: 3 });
	await page.mouse.move(to.x + 40, to.y + to.height / 2, { steps: 8 });
	await expect(projectRow(page, project), "the project under the pointer is marked").toHaveAttribute(
		"data-drop-over",
		"true",
	);
	await page.mouse.up();
}

test("a project is made, filled by menu and by drag, shows its folder, takes a new chat, and is deleted", async ({
	page,
}) => {
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.goto(home());
	await expect(sessionRow(page, "Heron north")).toHaveCount(1, { timeout: 15_000 });
	// Shown with no project yet, with a line that says what it is for.
	await expect(projects(page).getByRole("heading", { name: "Projects" })).toBeVisible();
	await expect(page.getByTestId("projects-hint")).toBeVisible();

	await makeProject(page, "Birds");
	await expect(page.getByTestId("projects-hint")).toHaveCount(0);

	// By the conversation's menu: it is under the project now, and no longer in the list by date.
	await moveByMenu(page, "Heron north", "Birds");
	await expect(projects(page).locator('[data-testid="session-item"]', { hasText: "Heron north" })).toHaveCount(1);
	await expect(dated(page).locator('[data-testid="session-item"]', { hasText: "Heron north" })).toHaveCount(0);
	await expect(projectRow(page, "Birds").getByTestId("project-count")).toHaveText("1");

	// By dragging its row onto the project's.
	await drag(page, "Heron south", "Birds");
	await expect(projects(page).locator('[data-testid="session-item"]', { hasText: "Heron south" })).toHaveCount(1);
	await expect(dated(page).locator('[data-testid="session-item"]', { hasText: "Heron south" })).toHaveCount(0);
	await expect(projectRow(page, "Birds").getByTestId("project-count")).toHaveText("2");
	// The drop is no click on the row: the page did not open the conversation.
	await expect(page).not.toHaveURL(/#\/s\//);

	// Its folder, with the folder picker; then its folder button shows the folder in the Files panel.
	await projectRow(page, "Birds").hover();
	await projectRow(page, "Birds").getByTestId("project-menu").click();
	await page.getByTestId("project-menu-folder").click();
	const picker = page.getByRole("dialog");
	await picker.getByLabel("Path").fill(folder);
	await picker.getByRole("button", { name: "Use this folder" }).click();
	await expect(projectRow(page, "Birds").getByTestId("project-folder")).toHaveCount(1);
	await projectRow(page, "Birds").getByTestId("project-folder").click();
	await expect(page).toHaveURL(/#\/project\//);
	await expect(page.getByTestId("project-page-name")).toHaveText("Birds");
	await expect(page.getByTestId("project-files").getByText("heron-notes.md")).toBeVisible({ timeout: 15_000 });

	// New chat in the project: in its folder, and in the project once the first message is sent.
	await projectRow(page, "Birds").hover();
	await projectRow(page, "Birds").getByTestId("project-new-chat").click();
	await expect(page.getByTestId("new-chat-project")).toHaveText(/Birds/);
	const composer = page.getByTestId("composer");
	await expect(async () => {
		await composer.fill("Which birds wade?");
		await composer.press("Enter");
		await expect(page).toHaveURL(/#\/(chat|live|s)\//, { timeout: 2000 });
	}).toPass({ timeout: 30_000, intervals: [500] });
	await expect.poll(async () => (await listed()).projects[0]?.sessions.length, { timeout: 30_000 }).toBe(3);
	await expect(
		projects(page).locator('[data-testid="session-item"]', { hasText: "Which birds wade?" }),
		"the new chat is listed under its project",
	).toHaveCount(1, { timeout: 30_000 });
	await expect(dated(page).locator('[data-testid="session-item"]', { hasText: "Which birds wade?" })).toHaveCount(0);

	// Deleted: its conversations are back in the list by date, and none was deleted.
	await projectRow(page, "Birds").hover();
	await projectRow(page, "Birds").getByTestId("project-menu").click();
	await page.getByTestId("project-menu-delete").click();
	await expect(page.getByRole("dialog")).toContainText("Birds");
	await page.getByTestId("project-delete-confirm").click();
	await expect(projectRow(page, "Birds")).toHaveCount(0);
	for (const title of ["Heron north", "Heron south", "Which birds wade?"])
		await expect(dated(page).locator('[data-testid="session-item"]', { hasText: title }), title).toHaveCount(1);
	await expect(page.getByTestId("projects-hint")).toBeVisible();
});

test.describe("in Chinese", () => {
	test.use({ locale: "zh-CN" });

	test("the projects are worded in zh-CN, and Move to project puts a conversation in one", async ({ page }) => {
		await page.goto(home());
		await expect(sessionRow(page, "Heron east")).toHaveCount(1, { timeout: 15_000 });
		await expect(projects(page).getByRole("heading", { name: "项目" })).toBeVisible();
		await expect(page.getByTestId("projects-hint")).toContainText("新建项目");
		await page.getByRole("button", { name: "新建项目" }).click();
		await expect(page.getByRole("dialog")).toContainText("新建项目");
		await page.getByTestId("project-name-input").fill("鸟类");
		await page.getByTestId("project-save").click();
		await expect(projectRow(page, "鸟类")).toHaveCount(1);
		await sessionRow(page, "Heron east").hover();
		await sessionRow(page, "Heron east").locator("..").getByTestId("session-menu").click();
		await expect(page.getByTestId("session-move-to-project")).toHaveText("移到项目");
		await page.getByTestId("session-move-to-project").click();
		await page.getByTestId("move-to-project").filter({ hasText: "鸟类" }).click();
		await expect(projects(page).locator('[data-testid="session-item"]', { hasText: "Heron east" })).toHaveCount(1);
		await expect(page.getByText("已移到 鸟类")).toBeVisible();
		// Done: the project goes, the conversation stays.
		const id = (await listed()).projects.find((p) => p.name === "鸟类")?.id;
		await fetch(`${s.url}/api/chat-projects/delete`, {
			method: "POST",
			headers: { "x-omp-webui-token": s.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
			body: JSON.stringify({ id }),
		});
		await expect(dated(page).locator('[data-testid="session-item"]', { hasText: "Heron east" })).toHaveCount(1);
	});
});
