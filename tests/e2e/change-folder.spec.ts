import { mkdirSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openSidebar, sessionRow } from "../support/live.ts";
import { removeTrackedTempDirs, tempDir } from "../support/temp-dirs.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * "Change folder…" of a conversation (v0.17.0): from its sidebar menu and from the folder on its status line, the folder
 * picker, then omp's own `/move` (real omp; no model call). The conversation works in the new folder; nothing of either
 * folder is touched.
 */

let root: string;

test.beforeAll(() => {
	root = realpathSync(tempDir("ompw-e2e-change-folder-"));
});
test.afterAll(removeTrackedTempDirs);

/** A folder of its own, with a file in it that the move must leave alone. */
function folder(name: string): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "keep.txt"), `${name}\n`);
	return dir;
}

/** A saved conversation whose folder is `cwd`; `k` makes it unique. */
function writeSession(k: number, cwd: string): string {
	const title = `Change folder probe ${k}`;
	const id = `01a00000-0000-7000-8000-0000000cf0${k}0`;
	const t0 = Date.UTC(2026, 0, 12, 10, k, 0);
	const entries = [
		{ type: "session", version: 3, id, timestamp: new Date(t0).toISOString(), cwd, title },
		{
			type: "message",
			id: `f${k}01`,
			parentId: null,
			timestamp: new Date(t0).toISOString(),
			message: { role: "user", content: [{ type: "text", text: title }], attribution: "user", timestamp: t0 },
		},
		{
			type: "message",
			id: `f${k}02`,
			parentId: `f${k}01`,
			timestamp: new Date(t0 + 1000).toISOString(),
			message: {
				role: "assistant",
				content: [{ type: "text", text: `Reply ${k}.` }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-opus-5-5",
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
				stopReason: "stop",
				timestamp: t0 + 1000,
			},
		},
	];
	const dir = join(process.env.OMPW_E2E_AGENT_DIR as string, "sessions", `-change-folder-probe-${k}`);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, `2026-01-12T10-0${k}-00-000Z_${id}.jsonl`),
		`${entries.map((e) => JSON.stringify(e)).join("\n")}\n`,
	);
	return title;
}

async function pick(page: Page, path: string): Promise<void> {
	const dialog = page.getByRole("dialog", { name: "Change the conversation's folder" });
	await expect(dialog.getByTestId("dir-up")).toBeVisible();
	await dialog.getByLabel("Path").fill(path);
	await dialog.getByRole("button", { name: "Use this folder" }).click();
}

const statusCwd = (page: Page) => page.getByTestId("chat-status").getByTestId("status-cwd");

test("the sidebar menu's Change folder moves a conversation that is not open; the folders keep what they hold", async ({
	page,
}) => {
	const from = folder("from-menu");
	const to = folder("to-menu");
	const title = writeSession(1, from);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.goto("/");
	await openSidebar(page);
	await expect(sessionRow(page, title)).toHaveCount(1, { timeout: 15_000 });
	await sessionRow(page, title).hover();
	await page.getByRole("button", { name: `Actions for ${title}` }).click();
	await page.getByTestId("session-change-folder").click();
	// The picker opens on the conversation's folder.
	await expect(page.getByRole("dialog").getByLabel("Path")).toHaveValue(from);
	await pick(page, to);
	await expect(page.getByTestId("toast").filter({ hasText: "now works in" })).toBeVisible({ timeout: 30_000 });

	await sessionRow(page, title).click();
	await expect(statusCwd(page)).toContainText("to-menu");
	await expect(page.getByTestId("msg-assistant").filter({ hasText: "Reply 1." })).toBeVisible();
	expect(readdirSync(from)).toEqual(["keep.txt"]);
	expect(readdirSync(to)).toEqual(["keep.txt"]);
});

test("the folder on the status line is the way to another one, and the conversation on screen follows it", async ({
	page,
}) => {
	const from = folder("from-status");
	const to = folder("to-status");
	const title = writeSession(2, from);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.goto("/");
	await openSidebar(page);
	await expect(sessionRow(page, title)).toHaveCount(1, { timeout: 15_000 });
	await sessionRow(page, title).click();
	await expect(statusCwd(page)).toContainText("from-status");
	await expect(statusCwd(page)).toHaveAttribute("title", `${from} · Change folder…`);
	await statusCwd(page).click();
	await pick(page, to);
	await expect(statusCwd(page)).toContainText("to-status", { timeout: 30_000 });
	// Still the same conversation, now from its new file.
	await expect(page.getByTestId("msg-assistant").filter({ hasText: "Reply 2." })).toBeVisible();
	await expect(page).toHaveURL(/to-status/);
	expect(readdirSync(from)).toEqual(["keep.txt"]);
	expect(readdirSync(to)).toEqual(["keep.txt"]);
});

test("the folder under the conversation's title is the way to another one too", async ({ page }) => {
	const from = folder("from-header");
	const to = folder("to-header");
	const title = writeSession(3, from);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.goto("/");
	await openSidebar(page);
	await expect(sessionRow(page, title)).toHaveCount(1, { timeout: 15_000 });
	await sessionRow(page, title).click();
	const header = page.getByTestId("chat-cwd-change");
	await expect(header).toContainText("from-header");
	await expect(header).toHaveAttribute("title", `${from} · Change folder…`);
	await header.click();
	// The picker opens on the conversation's folder.
	await expect(page.getByRole("dialog").getByLabel("Path")).toHaveValue(from);
	await pick(page, to);
	await expect(header).toContainText("to-header", { timeout: 30_000 });
	await expect(page.getByTestId("msg-assistant").filter({ hasText: "Reply 3." })).toBeVisible();
	expect(readdirSync(from)).toEqual(["keep.txt"]);
	expect(readdirSync(to)).toEqual(["keep.txt"]);
});
