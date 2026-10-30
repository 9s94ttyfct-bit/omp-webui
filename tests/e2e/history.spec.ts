import { existsSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE, FIXTURE_BUCKET, FIXTURE_FILES, USAGE_A1, USAGE_A2, USAGE_A3, USAGE_B2 } from "../support/fixtures.ts";
import { appReady } from "../support/live.ts";
import { topTab } from "../support/panel.ts";
import { expect, test } from "./fixtures.ts";

const item = (title: string) => `[data-testid="session-item"]:has-text("${title}")`;

test.describe("history (fixture sessions)", () => {
	test("sidebar lists sessions and opens one", async ({ page }) => {
		await page.goto("/");
		await expect(page.locator(item(FIXTURE.alphaTitle))).toBeVisible();
		await expect(page.locator(item(FIXTURE.betaTitle))).toBeVisible();
		await page.locator(item(FIXTURE.alphaTitle)).click();
		await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.alphaTitle);
		await expect(page.getByText(FIXTURE.alphaReply)).toBeVisible();
		await expect(page.getByText(FIXTURE.alphaFinal)).toBeVisible();
		await expect(page.locator('[data-testid="tool-card"][data-tool="bash"]')).toBeVisible();
	});

	test("switching between sessions swaps the transcript and URL", async ({ page }) => {
		await page.goto("/");
		await page.locator(item(FIXTURE.alphaTitle)).click();
		await expect(page.getByText(FIXTURE.alphaFinal)).toBeVisible();
		const alphaUrl = page.url();
		await page.locator(item(FIXTURE.gammaTitle)).click();
		await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.gammaTitle);
		await expect(page.getByText(FIXTURE.alphaFinal)).toHaveCount(0);
		expect(page.url()).not.toBe(alphaUrl);
		await page.goBack();
		await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.alphaTitle);
	});

	test("filter narrows the sidebar", async ({ page }) => {
		await page.goto("/");
		await page.getByTestId("session-filter").fill("wombat");
		await expect(page.locator(item(FIXTURE.betaTitle))).toBeVisible();
		await expect(page.locator(item(FIXTURE.alphaTitle))).toHaveCount(0);
	});

	test("full-text search finds message content and opens the session", async ({ page }) => {
		await page.goto("/");
		await appReady(page);
		await page.keyboard.press("ControlOrMeta+k");
		await page.getByTestId("palette-input").fill("striped packets");
		const hit = page.getByTestId("search-hit").first();
		await expect(hit).toContainText("striped packets");
		await hit.click();
		await expect(page.getByText(FIXTURE.alphaReply)).toBeVisible();
	});

	test("a search hit scrolls to and highlights its message", async ({ page }) => {
		await page.goto("/");
		await appReady(page);
		await page.keyboard.press("ControlOrMeta+k");
		await page.getByTestId("palette-input").fill("striped packets");
		await page.getByTestId("search-hit").first().click();
		const target = page.locator('[data-entry-id="f0000003"]');
		await expect(target).toHaveAttribute("data-focused", "true");
		await expect(target).toBeInViewport();
	});

	test("a search hit on an abandoned in-file branch shows that branch", async ({ page }) => {
		await page.goto("/");
		await appReady(page);
		await page.keyboard.press("ControlOrMeta+k");
		await page.getByTestId("palette-input").fill("README located");
		await page.getByTestId("search-hit").first().click();
		await expect(page.getByText(FIXTURE.gammaSideReply)).toBeVisible();
		await expect(page.getByText("Viewing an earlier branch")).toBeVisible();
		await expect(page.getByText("The scout found 3 files.")).toHaveCount(0);
		await expect(page.locator('[data-entry-id="f0000028"]')).toHaveAttribute("data-focused", "true");
	});

	test("branch siblings across files are navigable", async ({ page }) => {
		await page.goto("/");
		await page.locator(item(FIXTURE.alphaTitle)).click();
		const userMsg = page.locator('[data-testid="msg-user"]', { hasText: "quokka" });
		await userMsg.hover();
		const nav = userMsg.getByTestId("sibling-nav");
		await expect(nav).toContainText("1 / 2");
		await nav.getByRole("button", { name: "Next version" }).click();
		await expect(page.getByText(FIXTURE.betaFinal)).toBeVisible();
		await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.betaTitle);
		const betaMsg = page.locator('[data-testid="msg-user"]', { hasText: "wombat" });
		await betaMsg.hover();
		await betaMsg.getByRole("button", { name: "Previous version" }).click();
		await expect(page.getByText(FIXTURE.alphaFinal)).toBeVisible();
	});

	test("a long agent turn collapses its tool steps behind a summary", async ({ page }) => {
		await page.goto("/");
		await page.locator(item(FIXTURE.epsilonTitle)).click();
		await expect(page.getByText(FIXTURE.epsilonFinal)).toBeVisible();
		const summary = page.getByTestId("work-summary");
		await expect(summary).toContainText("4 tool calls");
		await expect(summary).toContainText("2 bash");
		await expect(page.getByTestId("tool-card")).toHaveCount(0);
		await summary.click();
		await expect(page.getByTestId("tool-card")).toHaveCount(4);
		await expect(page.getByText(FIXTURE.epsilonFinal)).toBeVisible();
	});

	test("a compaction shows as an expandable summary note", async ({ page }) => {
		await page.goto("/");
		await page.locator(item(FIXTURE.gammaTitle)).click();
		const note = page.getByRole("button", { name: /Context compacted \(12k tokens before\)/ });
		await expect(note).toBeVisible();
		await note.click();
		await expect(page.getByText(FIXTURE.compactionSummary)).toBeVisible();
	});

	test("subagent transcripts are listed in the side panel", async ({ page }) => {
		await page.goto("/");
		await page.locator(item(FIXTURE.gammaTitle)).click();
		await page.getByTestId("toggle-panel").click();
		const agent = page.locator(`[data-testid="subagent-item"][data-agent-id="${FIXTURE.subagentId}"]`);
		await expect(agent).toBeVisible();
		await agent.click();
		await expect(page.getByTestId("subagent-detail")).toContainText(FIXTURE.subagentReply);
	});

	test("per-turn and per-session token cost match the session file", async ({ page }) => {
		await page.goto("/");
		await page.locator(item(FIXTURE.alphaTitle)).click();
		// Two agent turns: one request, then a tool step + final answer (two requests, one footer).
		await expect(page.getByTestId("turn-footer")).toHaveCount(2);
		const usage = page.getByTestId("msg-usage");
		const costs = await usage.evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-cost"))));
		expect(costs[0]).toBeCloseTo(USAGE_A1.cost, 9);
		expect(costs[1]).toBeCloseTo(USAGE_A2.cost + USAGE_A3.cost, 9);
		expect(await usage.evaluateAll((els) => els.map((e) => e.getAttribute("data-requests")))).toEqual(["1", "2"]);
		const total = Number(await page.getByTestId("session-cost").getAttribute("data-cost"));
		expect(total).toBeCloseTo(USAGE_A1.cost + USAGE_A2.cost + USAGE_A3.cost, 9);
		await page.getByTestId("toggle-panel").click();
		await topTab(page, /Info/).click();
		const info = page.getByTestId("session-info");
		const sum = (k: "input" | "output" | "cacheRead" | "cacheWrite") => USAGE_A1[k] + USAGE_A2[k] + USAGE_A3[k];
		await expect(info.locator('[data-stat="Input tokens"]')).toHaveText(sum("input").toLocaleString("en-US"));
		await expect(info.locator('[data-stat="Output tokens"]')).toHaveText(sum("output").toLocaleString("en-US"));
		await expect(info.locator('[data-stat="Cache read"]')).toHaveText(sum("cacheRead").toLocaleString("en-US"));
		// The branch file counts only its own entries (shared prefix + its own reply).
		await page.locator(item(FIXTURE.betaTitle)).click();
		await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.betaTitle);
		await expect
			.poll(async () => Number(await page.getByTestId("session-cost").getAttribute("data-cost")))
			.toBeCloseTo(USAGE_A1.cost + USAGE_B2.cost, 9);
	});

	test("deep link through a symlinked path shows the transcript under the canonical path", async ({ page }) => {
		const link = join(process.env.OMPW_E2E_ROOT as string, "sessions-link");
		if (!existsSync(link)) symlinkSync(join(process.env.OMPW_E2E_AGENT_DIR as string, "sessions"), link);
		const viaLink = join(link, FIXTURE_BUCKET, FIXTURE_FILES.alpha);
		await page.goto(`/#/s/${encodeURIComponent(viaLink)}`);
		await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.alphaTitle);
		await expect(page.getByText(FIXTURE.alphaFinal)).toBeVisible();
		expect(decodeURIComponent(new URL(page.url()).hash)).not.toContain("sessions-link");
	});

	test("resuming a session whose model has no credentials offers another model", async ({ page }) => {
		await page.goto("/");
		await page.locator(item(FIXTURE.deltaTitle)).click();
		await expect(page.getByText("I am an OpenAI model.")).toBeVisible();
		await page.getByTestId("model-picker").click();
		const list = page.getByTestId("resume-model-list");
		await expect(list).toBeVisible({ timeout: 60_000 });
		await expect(page.getByRole("dialog")).toContainText("Could not restore model");
		await list
			.getByRole("option", { name: /Haiku 5\.5/ })
			.first()
			.click();
		await expect(page.getByTestId("model-picker")).toContainText(/Haiku 5\.5/, { timeout: 60_000 });
		await expect(page.getByText("I am an OpenAI model.")).toBeVisible();
	});
});
