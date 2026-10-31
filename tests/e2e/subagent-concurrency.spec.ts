import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LiveInfo } from "@shared/protocol.ts";
import { ownSession, startLive } from "../support/live.ts";
import { topTab } from "../support/panel.ts";
import { choose } from "../support/select.ts";
import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * "Parallel subagents" (omp's `task.maxConcurrency`): a conversation's own limit from the Advanced part of its session
 * settings, kept when the page is loaded again and reaching its process; omp's own value in Settings; and the subagents omp
 * queued under the limit, shown as Queued in the Agents list. No model call is made: the limit is a setting, and which
 * subagents wait is what the server tells every page (`LiveInfo.queuedSubagents`, whose source in omp's own progress
 * records is `tests/contract/subagent-concurrency.test.ts`'s), pushed here as the server pushes it.
 */

const panel = (page: Page) => page.getByTestId("session-controls-panel");
const row = (page: Page) => panel(page).getByTestId("subagent-concurrency");
/** omp's own configuration of the test server's isolated agent directory: what `omp config set` writes. */
const configFile = () => join(process.env.OMPW_E2E_AGENT_DIR as string, "config.yml");

async function chat(page: Page, title: string, n: number): Promise<{ tap: SocketTap; liveId: string }> {
	ownSession(n, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, `concurrency-${n}`);
	return { tap, liveId };
}

/** The server's own info for `liveId`, as every page is told it. */
async function infoOf(page: Page, liveId: string): Promise<LiveInfo> {
	const lives = (await (await page.request.get("/api/lives")).json()) as LiveInfo[];
	const found = lives.find((l) => l.liveId === liveId);
	if (!found) throw new Error(`the server does not list ${liveId}`);
	return found;
}

/** The panel's Advanced part, open. */
async function openAdvanced(page: Page): Promise<void> {
	await page.getByTestId("session-controls").click();
	await expect(panel(page)).toBeVisible({ timeout: 60_000 });
	const advanced = panel(page).getByTestId("session-controls-advanced");
	if ((await advanced.getAttribute("aria-expanded")) !== "true") await advanced.click();
	await expect(row(page)).toBeVisible();
}

test.describe.configure({ mode: "serial" });

test("a conversation's limit is its own, reaches its process, is kept across a load, and Default follows omp again", async ({
	page,
}) => {
	const { liveId } = await chat(page, "Parallel subagents row", 0x42);
	await openAdvanced(page);
	const choice = row(page).getByTestId("subagent-concurrency-choice");
	// Nothing chosen: omp's own value (its default, 32), and the row says so.
	await expect(choice).toHaveAttribute("data-value", "default");
	await expect(choice).toContainText("Default (32)");
	await expect(row(page).getByTestId("subagent-concurrency-effective")).toContainText("Subagents run up to 32 at once");

	await choose(choice, "2");
	await expect(page.getByTestId("toast").filter({ hasText: "Parallel subagents: up to 2 at once" })).toBeVisible();
	await expect(row(page).getByTestId("subagent-concurrency-effective")).toContainText("Subagents run up to 2 at once");
	// The process is told (its overlay, which omp reloads by itself), and the folded part says something in it changed.
	await expect.poll(async () => (await infoOf(page, liveId)).subagentConcurrency, { timeout: 20_000 }).toBe(2);
	await expect(panel(page).getByTestId("session-controls-advanced-changed")).toBeVisible();

	await page.reload();
	await expect(page.getByTestId("session-controls")).toBeVisible({ timeout: 30_000 });
	await openAdvanced(page);
	await expect(row(page).getByTestId("subagent-concurrency-choice")).toHaveAttribute("data-value", "2");

	await choose(row(page).getByTestId("subagent-concurrency-choice"), "default");
	await expect(page.getByTestId("toast").filter({ hasText: "Parallel subagents: omp's default" })).toBeVisible();
	await expect.poll(async () => (await infoOf(page, liveId)).subagentConcurrency, { timeout: 20_000 }).toBeUndefined();
});

test("Settings sets omp's own value in omp's own configuration, keeps it across a load, and Default takes it away", async ({
	page,
}) => {
	const original = readFileSync(configFile(), "utf8");
	try {
		await page.goto("/#/settings/models");
		const card = page.getByTestId("subagent-concurrency-settings");
		await expect(card).toBeVisible({ timeout: 60_000 });
		const choice = card.getByTestId("subagent-concurrency-choice");
		await expect(choice).toHaveAttribute("data-value", "default");
		await expect(card.getByTestId("subagent-concurrency-effective")).toContainText("(omp's default)");

		await choose(choice, "4");
		await expect(page.getByTestId("toast").filter({ hasText: "Parallel subagents: up to 4 at once" })).toBeVisible();
		await expect.poll(() => readFileSync(configFile(), "utf8")).toMatch(/maxConcurrency: 4/);
		await expect(card.getByTestId("subagent-concurrency-effective")).toContainText("(omp's setting)");

		await page.reload();
		await expect(card.getByTestId("subagent-concurrency-choice")).toHaveAttribute("data-value", "4", {
			timeout: 60_000,
		});

		await choose(card.getByTestId("subagent-concurrency-choice"), "default");
		await expect(page.getByTestId("toast").filter({ hasText: "Parallel subagents: omp's default" })).toBeVisible();
		await expect.poll(() => readFileSync(configFile(), "utf8")).not.toMatch(/maxConcurrency/);
	} finally {
		writeFileSync(configFile(), original);
	}
});

test("a subagent omp queued is listed as Queued after the running ones and says why, until omp starts it", async ({
	page,
}) => {
	const { tap, liveId } = await chat(page, "Queued subagents list", 0x43);
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });
	const say = async (queuedSubagents?: LiveInfo["queuedSubagents"]) =>
		tap.push({ t: "live", info: { ...(await infoOf(page, liveId)), ...(queuedSubagents ? { queuedSubagents } : {}) } });

	// One subagent of a task call runs; omp queued the other.
	frame({
		type: "subagent_lifecycle",
		payload: { id: "Runner", status: "started", agent: "task", parentToolCallId: "c1" },
	});
	await say([
		{ id: "Waiter", parentToolCallId: "c1", index: 1, agent: "task", assignment: "Wait your turn", since: Date.now() },
	]);
	if (!(await page.getByTestId("panel-pane-top").isVisible())) await page.getByTestId("toggle-panel").click();
	await topTab(page, /^Agents/).click();
	const items = page.getByTestId("subagent-item");
	await expect(items).toHaveCount(2);
	await expect(items.nth(0)).toContainText("Runner");
	await expect(items.nth(1)).toContainText("Waiter");
	await expect(items.nth(1).getByTestId("subagent-queued")).toHaveText("queued");
	await expect(items.nth(0).getByTestId("subagent-queued")).toHaveCount(0);
	await items.nth(1).click();
	await expect(page.getByTestId("subagent-detail-queued")).toContainText(
		"omp starts this one when a running subagent ends",
	);

	// omp started it: the server's list no longer has it, and the row is that of a running subagent.
	frame({
		type: "subagent_lifecycle",
		payload: { id: "Waiter", status: "started", agent: "task", parentToolCallId: "c1" },
	});
	await say();
	await expect(page.getByTestId("subagent-queued")).toHaveCount(0);
	await expect(page.getByTestId("subagent-detail-queued")).toHaveCount(0);
});
