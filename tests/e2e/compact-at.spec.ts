import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownSession, sessionRow, startLive } from "../support/live.ts";
import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * "Compact at" (#643): a conversation's own point for omp's automatic compaction — a share of the model's window or a
 * count of tokens — set from its session settings, kept for the conversation when the page is loaded again, and
 * "Default" back to omp's own configuration; and omp's own configuration itself in Settings. No model call is made: the
 * point is a setting, and the process only has to run.
 */

const panel = (page: Page) => page.getByTestId("session-controls-panel");
const compactRow = (page: Page) => panel(page).getByTestId("compact-at");
/** omp's own configuration of the test server's isolated agent directory: what `omp config set` writes. */
const configFile = () => join(process.env.OMPW_E2E_AGENT_DIR as string, "config.yml");

/** A page of its own on the shared server, with the page's socket tapped before it loads. */
async function openPage(page: Page, title: string, lang = "en") {
	const next = await page.context().newPage();
	await next.addInitScript(
		({ l }) => {
			localStorage.setItem("ompw.autoTitle", "off");
			localStorage.setItem("ompw.lang", l);
			localStorage.setItem("ompw.theme", "light");
		},
		{ l: lang },
	);
	const tap = await tapSocket(next);
	await next.goto("/");
	await expect(sessionRow(next, title)).toHaveCount(1, { timeout: 15_000 });
	return { page: next, tap };
}

/** What the conversation's process was told of its own point, as every page is told it (`LiveInfo.compactAt`). */
async function told(page: Page, liveId: string): Promise<unknown> {
	const lives = (await (await page.request.get("/api/lives")).json()) as { liveId: string; compactAt?: unknown }[];
	return lives.find((l) => l.liveId === liveId)?.compactAt;
}

/** The panel of a conversation whose omp is started by the one command run here (`!echo`: no model call). */
async function openPanel(page: Page, tap: SocketTap, title: string, probe: string): Promise<string> {
	const liveId = await startLive(page, tap, title, probe);
	await page.getByTestId("session-controls").click();
	await expect(panel(page)).toBeVisible({ timeout: 60_000 });
	await expect(compactRow(page)).toBeVisible();
	return liveId;
}

/** The conversation's panel, opened again from the top: what a page that has just been loaded knows. */
async function reopenPanel(page: Page): Promise<void> {
	await page.reload();
	await expect(page.getByTestId("session-controls")).toBeVisible({ timeout: 30_000 });
	await page.getByTestId("session-controls").click();
	await expect(panel(page)).toBeVisible({ timeout: 60_000 });
}

test.describe.configure({ mode: "serial" });

test("a conversation's point is a share, kept when the page is loaded again, and Default restores omp's configuration", async ({
	page,
}) => {
	ownSession(0x8b, "Compact at row");
	const only = await openPage(page, "Compact at row");
	const liveId = await openPanel(only.page, only.tap, "Compact at row", "compact-at-en-up");

	// Nothing was chosen: the conversation follows omp's configuration, which names no point, so omp's own reserve
	// decides — and the row says which.
	const row = compactRow(only.page);
	await expect(row.getByTestId("compact-at-mode")).toHaveValue("default");
	await expect(row.getByTestId("compact-at-effective")).toContainText("Compacts at");
	await expect(row.getByTestId("compact-at-effective")).toContainText("omp's default");

	// A share of the window.
	await row.getByTestId("compact-at-mode").selectOption("percent");
	await row.getByTestId("compact-at-percent").selectOption("70");
	await expect(only.page.getByTestId("toast").filter({ hasText: "Compact at: 70% of the window" })).toBeVisible();
	await expect(row.getByTestId("compact-at-effective")).toHaveText("Compacts at 70% of the window.");
	// The conversation's own point reaches its process, which omp reads at each check (the overlay, reloaded by omp).
	await expect.poll(async () => told(only.page, liveId), { timeout: 20_000 }).toEqual({ percent: 70 });

	// A page loaded again shows the conversation's own point, not what a fresh page would know.
	await reopenPanel(only.page);
	await expect(compactRow(only.page).getByTestId("compact-at-mode")).toHaveValue("percent");
	await expect(compactRow(only.page).getByTestId("compact-at-percent")).toHaveValue("70");

	// A count, typed the way the page prints amounts.
	await compactRow(only.page).getByTestId("compact-at-mode").selectOption("tokens");
	await compactRow(only.page).getByTestId("compact-at-tokens").fill("40k");
	await expect(compactRow(only.page).getByTestId("compact-at-share")).toContainText(/% of the window\.$/);
	await compactRow(only.page).getByTestId("compact-at-apply").click();
	await expect(only.page.getByTestId("toast").filter({ hasText: "Compact at: 40k tokens" })).toBeVisible();
	await expect(compactRow(only.page).getByTestId("compact-at-effective")).toHaveText("Compacts at 40k tokens.");
	await expect.poll(async () => told(only.page, liveId), { timeout: 20_000 }).toEqual({ tokens: 40_000 });

	// Default: the conversation follows omp's configuration again, and a page loaded again says so.
	await compactRow(only.page).getByTestId("compact-at-mode").selectOption("default");
	await expect(only.page.getByTestId("toast").filter({ hasText: "Compact at: omp's default" })).toBeVisible();
	await expect(compactRow(only.page).getByTestId("compact-at-mode")).toHaveValue("default");
	await expect(compactRow(only.page).getByTestId("compact-at-effective")).toContainText("omp's default");
	await expect.poll(async () => told(only.page, liveId), { timeout: 20_000 }).toBeUndefined();
	await reopenPanel(only.page);
	await expect(compactRow(only.page).getByTestId("compact-at-mode")).toHaveValue("default");
});

test("the row is in Simplified Chinese, says what it does there, and its choice is kept", async ({ page }) => {
	ownSession(0x8c, "压缩阈值测试");
	const only = await openPage(page, "压缩阈值测试", "zh-CN");
	const liveId = await openPanel(only.page, only.tap, "压缩阈值测试", "compact-at-zh-up");

	const row = compactRow(only.page);
	await expect(row).toContainText("压缩阈值（已用上下文）");
	await expect(row.getByTestId("compact-at-mode")).toContainText("默认");
	await expect(row.getByTestId("compact-at-effective")).toContainText("压缩");
	// Nothing of the row is left in English.
	expect(await row.innerText()).not.toMatch(/Compact at|Default|Percent of window|Tokens/);

	await row.getByTestId("compact-at-mode").selectOption("percent");
	await expect(only.page.getByTestId("toast").filter({ hasText: "压缩阈值：窗口的 85%" })).toBeVisible();
	await expect.poll(async () => told(only.page, liveId), { timeout: 20_000 }).toEqual({ percent: 85 });

	await only.page.reload();
	await expect(only.page.getByTestId("session-controls")).toBeVisible({ timeout: 30_000 });
	await only.page.getByTestId("session-controls").click();
	await expect(panel(only.page)).toBeVisible({ timeout: 60_000 });
	await expect(compactRow(only.page).getByTestId("compact-at-mode")).toHaveValue("percent");
	await expect(compactRow(only.page).getByTestId("compact-at-percent")).toHaveValue("85");
	// Default again, in the same words.
	await compactRow(only.page).getByTestId("compact-at-mode").selectOption("default");
	await expect(only.page.getByTestId("toast").filter({ hasText: "压缩阈值：omp 的默认值" })).toBeVisible();
	await only.page.close();
});

test("Settings sets omp's own point in omp's own configuration, keeps it across a load, and Default takes it away", async ({
	page,
}) => {
	const original = readFileSync(configFile(), "utf8");
	try {
		await page.goto("/#/settings/chats");
		const card = page.getByTestId("compact-at-settings");
		await expect(card).toBeVisible({ timeout: 60_000 });
		await expect(card).toContainText("When omp compacts by itself");
		await expect(card.getByTestId("compact-at-mode")).toHaveValue("default");
		// "Default" is omp's own reserve, said as the value for the window omp starts new conversations on.
		await expect(card.getByTestId("compact-at-effective")).toContainText("omp's default");

		await card.getByTestId("compact-at-mode").selectOption("percent");
		await card.getByTestId("compact-at-percent").selectOption("60");
		await expect(page.getByTestId("toast").filter({ hasText: "Compact at: 60% of the window" })).toBeVisible();
		// omp's own setting, as `omp config set` writes it (so the terminal sees it), and the count line cleared: omp takes
		// a positive count over a share, and a leftover one would win.
		await expect.poll(() => readFileSync(configFile(), "utf8")).toMatch(/thresholdPercent: 60/);
		expect(readFileSync(configFile(), "utf8")).not.toMatch(/thresholdTokens: [1-9]/);
		await expect(card.getByTestId("compact-at-effective")).toContainText("(omp's setting)");

		await page.reload();
		await expect(card.getByTestId("compact-at-mode")).toHaveValue("percent", { timeout: 60_000 });
		await expect(card.getByTestId("compact-at-percent")).toHaveValue("60");

		await card.getByTestId("compact-at-mode").selectOption("default");
		await expect(page.getByTestId("toast").filter({ hasText: "Compact at: omp's default" })).toBeVisible();
		await expect.poll(() => readFileSync(configFile(), "utf8")).not.toMatch(/thresholdPercent|thresholdTokens/);
	} finally {
		writeFileSync(configFile(), original);
	}
});
