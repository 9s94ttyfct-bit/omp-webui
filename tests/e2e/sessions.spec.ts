import { existsSync, rmSync } from "node:fs";
import { basename } from "node:path";
import { writeChatSession } from "../support/chat-session.ts";
import { expect, type Page, test } from "./fixtures.ts";

/** Sidebar actions use conversations of their own: renaming or deleting a shared fixture poisons later files. */
const RENAME = "Session rename probe";
const RUNNING = "Session running rename probe";
const PIN = "Session pin probe";
const TERMINAL = "Session terminal probe";
const DELETE = "Session delete probe";
let files: string[] = [];
const own = (n: number, title: string) => {
	const file = writeChatSession(process.env.OMPW_E2E_AGENT_DIR as string, {
		n,
		title,
		cwd: process.env.OMPW_E2E_WORK as string,
		turns: [{ prompt: `${title}?`, reply: `${title}.` }],
	});
	files.push(file);
	return file;
};
test.afterEach(() => {
	for (const file of files) rmSync(file, { force: true });
	files = [];
});

const row = (page: Page, title: string) => page.locator('[data-testid="session-item"]', { hasText: title });
const menuFor = async (page: Page, title: string) => {
	const item = row(page, title);
	await item.hover();
	await page.getByRole("button", { name: `Actions for ${title}` }).click();
};

test("rename a conversation through omp", async ({ page }) => {
	own(0x31, RENAME);
	await page.goto("/");
	await menuFor(page, RENAME);
	await page.getByRole("menuitem", { name: "Rename" }).click();
	await page.getByTestId("rename-input").fill("Renamed session probe");
	await page.getByTestId("confirm-session-action").click();
	await expect(row(page, "Renamed session probe")).toBeVisible({ timeout: 60_000 });
	await expect(row(page, RENAME)).toHaveCount(0);
});

test("renaming a running conversation updates its header, from the header or the sidebar (no model call)", async ({
	page,
}) => {
	own(0x32, RUNNING);
	await page.goto("/");
	await row(page, RUNNING).click();
	const title = page.getByTestId("chat-title");
	await expect(title).toHaveText(RUNNING);
	// A `!command` starts the conversation's omp process without calling the model.
	await page.getByTestId("composer").fill("!echo live-$((5*5))");
	await page.getByTestId("composer").press("Enter");
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	await expect(page.getByText("live-25")).toBeVisible({ timeout: 30_000 });

	await page.locator("header").getByRole("button", { name: "Rename" }).click();
	await page.getByRole("textbox", { name: "Conversation name" }).fill("Header rename");
	await page.getByRole("button", { name: "Save" }).click();
	await expect(title).toHaveText("Header rename");

	await menuFor(page, "Header rename");
	await page.getByRole("menuitem", { name: "Rename" }).click();
	await page.getByTestId("rename-input").fill("Sidebar rename");
	await page.getByTestId("confirm-session-action").click();
	await expect(title).toHaveText("Sidebar rename");
});

test("pin and unpin a conversation", async ({ page }) => {
	own(0x33, PIN);
	await page.goto("/");
	await menuFor(page, PIN);
	await page.getByRole("menuitem", { name: "Pin" }).click();
	const list = page.getByTestId("session-list");
	// The pinned group is the first one: its heading, then the pinned conversation, ahead of every other row.
	await expect(list).toContainText("Pinned");
	await expect(list.getByTestId("session-item").first()).toContainText(PIN);
	await expect(list.getByText("Pinned", { exact: true })).toBeVisible();
	await page.reload();
	await expect(list.getByTestId("session-item").first()).toContainText(PIN);
	// Folded, the Pinned heading stays and says how many it holds; the fold is remembered (#700).
	const fold = page.getByTestId("pinned-fold");
	await fold.click();
	await expect(fold).toHaveAttribute("aria-expanded", "false");
	await expect(fold).toContainText("1");
	await expect(row(page, PIN)).toHaveCount(0);
	await page.reload();
	await expect(page.getByTestId("pinned-fold")).toHaveAttribute("aria-expanded", "false");
	await page.getByTestId("pinned-fold").click();
	await expect(row(page, PIN)).toHaveCount(1);
	await menuFor(page, PIN);
	await page.getByRole("menuitem", { name: "Unpin" }).click();
	await expect(page.getByTestId("session-list")).not.toContainText("Pinned");
});

test("the list is sorted the way the person chose, and the choice is remembered (#701)", async ({ page }) => {
	own(0x34, "Sort probe");
	await page.goto("/");
	const sort = page.getByTestId("session-sort");
	await expect(sort).toHaveValue("activity");
	await expect(page.getByTestId("session-list")).toContainText("Today");
	try {
		await sort.selectOption("title");
		// By name: one list under one heading, A to Z.
		await expect(page.getByTestId("session-list")).toContainText("By name");
		await expect(page.getByTestId("session-list")).not.toContainText("Today");
		const names = await page
			.getByTestId("session-item")
			.evaluateAll((rows) => rows.map((r) => r.getAttribute("data-file") ?? ""));
		expect(names.length).toBeGreaterThan(1);
		await page.reload();
		await expect(page.getByTestId("session-sort")).toHaveValue("title");
		await expect(page.getByTestId("session-list")).toContainText("By name");
	} finally {
		await page.getByTestId("session-sort").selectOption("activity");
	}
	await expect(page.getByTestId("session-list")).toContainText("Today");
});

test("opening a conversation in the terminal releases the web UI's omp for it, so no copy is forked", async ({
	page,
}) => {
	const file = own(0x34, TERMINAL);
	const livesFor = async () =>
		((await (await page.request.get("/api/lives")).json()) as { sessionFile: string | null; exited: boolean }[]).filter(
			(l) => l.sessionFile?.endsWith(basename(file)) && !l.exited,
		).length;
	await page.goto("/");
	// Make this conversation live in the web UI (a `!command` needs no model).
	await row(page, TERMINAL).click();
	await page.getByTestId("composer").fill("!echo held");
	await page.getByTestId("composer").press("Enter");
	await expect(page.getByText("held", { exact: true })).toBeVisible({ timeout: 30_000 });
	expect(await livesFor()).toBe(1);
	const sessionsBefore = (await (await page.request.get("/api/sessions")).json()).length;

	await menuFor(page, TERMINAL);
	await page.getByRole("menuitem", { name: "Open in terminal" }).click();
	await expect(page.getByTestId("cli-line")).toHaveValue(/^--resume \S+\.jsonl$/);
	await expect(page.getByTestId("terminal-status")).toHaveText("running", { timeout: 30_000 });
	expect(await livesFor()).toBe(0);
	// Leaving stops the terminal's omp; with a single writer it does not fork a branch file.
	await page.goto("/");
	await expect(row(page, TERMINAL)).toHaveCount(1);
	expect((await (await page.request.get("/api/sessions")).json()).length).toBe(sessionsBefore);
});

test("delete a conversation through omp", async ({ page }) => {
	const file = own(0x35, DELETE);
	expect(existsSync(file)).toBe(true);
	await page.goto("/");
	await menuFor(page, DELETE);
	await page.getByRole("menuitem", { name: "Delete…" }).click();
	await expect(page.getByRole("dialog")).toContainText("cannot be undone");
	await page.getByTestId("confirm-session-action").click();
	await expect(row(page, DELETE)).toHaveCount(0, { timeout: 60_000 });
	expect(existsSync(file)).toBe(false);
});
