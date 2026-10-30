import { basename } from "node:path";
import { sessionRow, startLive } from "../support/live.ts";
import { topTab } from "../support/panel.ts";
import { type Msg, tapSocket } from "../support/socket-tap.ts";
import { appendCall, sessionWithSubagents, writeTranscript } from "../support/subagent-fixtures.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * What a conversation has cost includes its advisors: omp writes their requests to `__advisor*.jsonl` beside the
 * conversation, in no transcript and no frame, and its own session statistics leave them out. The header total and its
 * tooltip, the status line, the Info tab, the sidebar and the usage page all count them, once, and say how much of the
 * cost they are, also while the conversation's omp runs (no model call: the transcripts are written files).
 */

const rowOf = (page: Page, file: string) =>
	page.locator(`[data-testid="session-item"][data-file$="${basename(file)}"]`);
const headerCost = (page: Page) => page.getByTestId("session-cost");
const costOf = async (page: Page) => Number(await headerCost(page).getAttribute("data-cost"));
const info = (page: Page) => page.getByTestId("session-info");

test("the header total, its tooltip, the Info tab, the sidebar and the usage page count the advisors, apart from the subagents", async ({
	page,
}) => {
	// $0.012345 of its own, $1 for the scout, and the advisors' $2 + $0.5, a named one's $0.25 and the scout's own $0.125.
	const own = sessionWithSubagents(0xb4, "Advisor totals", { Scout: [1000] });
	writeTranscript(own.advisor(), [2000, 500]);
	writeTranscript(own.advisor("security"), [250]);
	writeTranscript(own.advisor("default", "Scout"), [125]);
	await page.goto("/");
	await expect(rowOf(page, own.file)).toHaveCount(1, { timeout: 15_000 });
	await expect(rowOf(page, own.file)).toHaveAttribute(
		"title",
		/\$3\.89 \(incl\. \$1\.00 by subagents, \$2\.88 by the advisor\)/,
	);
	await rowOf(page, own.file).click();
	await expect.poll(() => costOf(page)).toBeCloseTo(0.012345 + 1 + 2.875, 6);

	await headerCost(page).hover();
	const split = page.getByTestId("usage-split");
	await expect(split).toBeVisible();
	expect(Number(await split.getAttribute("data-main-cost"))).toBeCloseTo(0.012345, 9);
	expect(Number(await split.getAttribute("data-subagent-cost"))).toBeCloseTo(1, 9);
	expect(Number(await split.getAttribute("data-advisor-cost"))).toBeCloseTo(2.875, 9);
	expect(await split.getAttribute("data-advisor-requests")).toBe("4");
	await expect(split.locator('[data-split="main"]')).toContainText("Main agent");
	await expect(split.locator('[data-split="subagents"]')).toContainText("Subagents (1)");
	await expect(split.locator('[data-split="advisor"]')).toContainText("Advisor");

	// The status line says it in its tooltip; its chip adds the subagents' and the advisors' share.
	const chip = page.getByTestId("status-cost");
	await expect(chip).toHaveAttribute("data-advisor", "2.875");
	await expect(chip).toHaveAttribute("title", /advisor \$2\.875000/);

	await page.getByTestId("toggle-panel").click();
	await topTab(page, /Info/).click();
	await expect(info(page).locator('[data-stat="Total cost"]')).toHaveText("$3.887345");
	await expect(info(page).locator('[data-stat="Advisor cost"]')).toHaveText("$2.875000");

	await page.goto("/#/usage");
	const top = page.locator(`[data-testid="usage-session"][data-file$="${basename(own.file)}"]`);
	await expect(top).toBeVisible();
	expect(Number(await top.getByTestId("usage-session-cost").getAttribute("data-cost"))).toBeCloseTo(3.887345, 6);
	await expect(top.getByTestId("usage-session-split")).toContainText("incl. $1.00 subagents");
	await expect(top.getByTestId("usage-session-split")).toContainText("incl. $2.88 advisor");
});

test("a conversation without an advisor shows no advisor share", async ({ page }) => {
	const own = sessionWithSubagents(0xb5, "No advisor", { Scout: [1000] });
	await page.goto("/");
	await expect(rowOf(page, own.file)).toHaveCount(1, { timeout: 15_000 });
	await expect(rowOf(page, own.file)).toHaveAttribute("title", /\$1\.01 \(incl\. \$1\.00 by subagents\)/);
	await rowOf(page, own.file).click();
	await expect.poll(() => costOf(page)).toBeCloseTo(1.012345, 6);
	await headerCost(page).hover();
	await expect(page.getByTestId("usage-split")).toBeVisible();
	await expect(page.locator('[data-split="advisor"]')).toHaveCount(0);
	await expect(page.getByTestId("status-cost")).toHaveAttribute("data-advisor", "0");
});

test("while omp runs, an advisor that goes on writing moves every total once, with no frame to say so", async ({
	page,
}) => {
	const title = "Advisor live";
	const own = sessionWithSubagents(0xb6, title, {});
	writeTranscript(own.advisor(), [1000]);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, "advisor-live-probe");
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f } as Msg);
	await expect.poll(() => costOf(page)).toBeCloseTo(0.012345 + 1, 6);

	await page.getByTestId("toggle-panel").click();
	await topTab(page, /Info/).click();
	// The Info tab's tokens and cost are the whole conversation's, the advisor's included, read once (#687); omp gives the counts.
	await expect(info(page).locator('[data-stat="Total cost"]')).toHaveText("$1.012345");
	await expect(info(page).getByText(/Message and tool call counts from omp/)).toBeVisible();

	// omp tells that an advisor's cost changed (once its transcript was read back on a resume) without saying how much: it
	// is no source of figures, and counts for nothing.
	frame({ type: "advisor_cost_changed" });
	appendCall(own.advisor(), 2000);
	await expect.poll(() => costOf(page), { timeout: 20_000 }).toBeCloseTo(0.012345 + 3, 6);
	await expect(info(page).locator('[data-stat="Total cost"]')).toHaveText("$3.012345");
	await expect(info(page).locator('[data-stat="Advisor cost"]')).toHaveText("$3.000000");
	await expect(sessionRow(page, title)).toHaveAttribute("title", /\$3\.01 \(incl\. \$3\.00 by the advisor\)/);
	await page.getByTestId("session-cost").hover();
	await expect(page.locator('[data-split="advisor"]')).toBeVisible();
	expect(Number(await page.getByTestId("usage-split").getAttribute("data-advisor-cost"))).toBeCloseTo(3, 9);
});
