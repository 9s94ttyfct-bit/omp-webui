import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveInfo } from "@shared/protocol.ts";
import { unfoldAdvanced } from "../support/controls.ts";
import { ownSession, startLive } from "../support/live.ts";
import { newChatIn } from "../support/new-chat.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * omp's advisor per conversation: the session panel's Advisor row, which is the conversation's own (its process's overlay,
 * kept when the page is loaded again) and whose star writes omp's `advisor.enabled`; and New chat's switch, which starts at
 * omp's value and, once flipped, is what the next process starts with. No model call is made: the choice is a setting.
 * That a running omp stops or starts reviewing at once is `tests/contract/advisor.test.ts`'s.
 */

let configFile: string;
let original = "";
test.beforeAll(() => {
	configFile = join(process.env.OMPW_E2E_AGENT_DIR as string, "config.yml");
	original = readFileSync(configFile, "utf8");
});
test.afterEach(() => writeFileSync(configFile, original));

test.describe.configure({ mode: "serial" });

const panel = (page: Page) => page.getByTestId("session-controls-panel");
const row = (page: Page) => panel(page).getByTestId("advisor");

/** The server's own info for `liveId`, as every page is told it. */
async function infoOf(page: Page, liveId: string): Promise<LiveInfo | undefined> {
	const lives = (await (await page.request.get("/api/lives")).json()) as LiveInfo[];
	return lives.find((l) => l.liveId === liveId);
}

/** The panel open, with its Advanced part (where the Advisor row is) unfolded. */
async function openPanel(page: Page): Promise<void> {
	await page.getByTestId("session-controls").click();
	await expect(panel(page)).toBeVisible({ timeout: 60_000 });
	await unfoldAdvanced(page);
	await expect(row(page)).toBeVisible();
}

test("a conversation's Advisor row is its own, reaches its process, is kept across a load, and its star writes omp's setting", async ({
	page,
}) => {
	ownSession(0xad, "Advisor row");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, "Advisor row", "advisor-row");
	await openPanel(page);
	// Nothing chosen: omp's own setting, which leaves the advisor off where nothing sets it; and that is the default.
	await expect(row(page).getByRole("radio", { name: "Off" })).toBeChecked({ timeout: 30_000 });
	await expect(row(page).getByTestId("advisor-set-default")).toHaveAttribute("aria-pressed", "true");
	expect((await infoOf(page, liveId))?.advisor).toBeUndefined();

	await row(page).getByText("On", { exact: true }).click();
	await expect(row(page).getByRole("radio", { name: "On" })).toBeChecked();
	await expect.poll(async () => (await infoOf(page, liveId))?.advisor, { timeout: 20_000 }).toBe(true);
	await expect(row(page).getByTestId("advisor-set-default")).toHaveAttribute("aria-pressed", "false");
	// The fold it is in says one of its settings is not what omp starts new conversations with.
	await expect(panel(page).getByTestId("session-controls-advanced-changed")).toBeVisible();

	await page.reload();
	await expect(page.getByTestId("session-controls")).toBeVisible({ timeout: 30_000 });
	await openPanel(page);
	await expect(row(page).getByRole("radio", { name: "On" })).toBeChecked();

	// The star makes On omp's own setting for new conversations.
	await row(page).getByTestId("advisor-set-default").click();
	await expect(page.getByTestId("toast").filter({ hasText: "Advisor is now On by default" })).toBeVisible();
	await expect
		.poll(() => readFileSync(configFile, "utf8"), { timeout: 15_000 })
		.toMatch(/advisor:\n(?:\s+\w+: .*\n)*\s+enabled: true/);
	await expect(row(page).getByTestId("advisor-set-default")).toHaveAttribute("aria-pressed", "true");

	// Off again for this conversation only: omp's setting stays On.
	await row(page).getByText("Off", { exact: true }).click();
	await expect.poll(async () => (await infoOf(page, liveId))?.advisor, { timeout: 20_000 }).toBe(false);
	expect(readFileSync(configFile, "utf8")).toMatch(/advisor:\n(?:\s+\w+: .*\n)*\s+enabled: true/);
});

test("New chat's switch starts at omp's setting, acts on the warm-up process, and what it says is what the next process starts with", async ({
	page,
}) => {
	const lives = async () => (await (await page.request.get("/api/lives")).json()) as LiveInfo[];
	// The processes of this test: the ones the server did not run before New chat opened.
	const before = new Set((await lives()).map((l) => l.liveId));
	const mine = async () => (await lives()).filter((l) => !before.has(l.liveId) && !l.exited);
	const tap = await tapSocket(page);
	await page.goto(newChatIn(process.env.OMPW_E2E_WORK as string));
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	const toggle = page.getByTestId("advisor-toggle");
	// omp's setting leaves the advisor off, and the page sends no choice of its own.
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	const opens = () => tap.sent.filter((m) => m.t === "open");
	expect(opens()[0]?.target).not.toHaveProperty("advisor");
	await expect.poll(async () => (await mine()).length, { timeout: 30_000 }).toBeGreaterThan(0);
	expect((await mine()).some((l) => l.advisor !== undefined)).toBe(false);

	// A flip acts on the warm-up process at once.
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	await expect.poll(async () => (await mine()).some((l) => l.advisor === true)).toBe(true);

	// A process started after the pick is started with it.
	await page.getByRole("button", { name: /^Options/ }).click();
	const field = page.locator('[data-flag="--append-system-prompt"]');
	await field.fill("kept");
	await field.press("Enter");
	await expect.poll(() => opens().length).toBe(2);
	expect(opens()[1]?.target?.advisor).toBe(true);
	await expect(page.getByTestId("advisor-toggle")).toHaveAttribute("aria-checked", "true", { timeout: 30_000 });
});
