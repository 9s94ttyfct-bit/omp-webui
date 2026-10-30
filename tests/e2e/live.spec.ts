import { execFileSync } from "node:child_process";
import { utcDate } from "../../web/src/lib/usage-series.ts";
import { appReady } from "../support/live.ts";
import { topTab } from "../support/panel.ts";
import { startTestServer } from "../support/server.ts";
import { expect, type Page, test } from "./fixtures.ts";

/** Real omp + Claude Haiku 5.5 through the web UI, in the isolated agent dir. */

test.describe.configure({ mode: "serial" });
test.skip(!process.env.OMPW_E2E_HAS_TOKEN, "needs an Anthropic token (omp token anthropic)");

async function startChat(page: Page, prompt: string, at = { url: "/", work: process.env.OMPW_E2E_WORK as string }) {
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), at.work);
	await page.goto(at.url);
	await expect(page.getByTestId("model-picker")).toContainText(/haiku/i, { timeout: 60_000 });
	await page.getByTestId("composer").fill(prompt);
	await page.getByTestId("send").click();
}

function parseDollars(text: string): number {
	return Number(text.replace(/[^0-9.]/g, ""));
}

test("new chat streams a reply and token cost matches omp's session stats", async ({ page }) => {
	// A real question: omp's title model declines to title trivial exchanges.
	await startChat(page, "What is the capital of France? Answer in one short sentence.");
	const reply = page.getByTestId("msg-assistant").last();
	await expect(reply).toContainText("Paris", { timeout: 90_000 });
	await expect(page).toHaveURL(/#\/s\//);
	await expect(page.getByTestId("stop")).toHaveCount(0);
	// Header total (summed from transcript usage) must equal omp's get_session_stats cost.
	await page.getByTestId("toggle-panel").click();
	await topTab(page, /Info/).click();
	const statCost = page.getByTestId("session-info").locator('[data-stat="Total cost"]');
	await expect(statCost).toHaveText(/\$0\.\d{6}/);
	await expect
		.poll(async () => Number(await page.getByTestId("session-cost").getAttribute("data-cost")))
		.toBeCloseTo(parseDollars(await statCost.innerText()), 6);
	await expect(page.getByTestId("msg-usage").last()).toBeVisible();
	await expect(page.getByTestId("command-output")).toHaveCount(0);
});

test("the server titles a new conversation after its first exchange", async ({ page }) => {
	// The worker's server has automatic titles off (a spec about something else must not make that model call), and omp
	// makes none in RPC mode: this server has them on, as a person's does, and the server asks omp for one (#721).
	const s = await startTestServer(0, { OMP_WEBUI_AUTO_TITLE: "on", PI_NO_TITLE: "" });
	try {
		// A real question: omp's title model declines to title trivial exchanges.
		await startChat(page, "What is the capital of France? Answer in one short sentence.", {
			url: `${s.url}/?token=${s.accessToken}`,
			work: s.work,
		});
		await expect(page.getByTestId("msg-assistant").last()).toContainText("Paris", { timeout: 90_000 });
		// The title shows in the header and the sidebar, not as chat output.
		const title = page.getByTestId("chat-title");
		await expect(title).not.toHaveText(/capital of France\?|Untitled session|New conversation/, { timeout: 60_000 });
		await expect(page.locator('[data-testid="session-item"]').first()).toHaveText(await title.innerText());
		await expect(page.getByTestId("command-output")).toHaveCount(0);
	} finally {
		await s.stop();
	}
});

test("editing a prompt creates a branch with navigable versions", async ({ page }) => {
	await page.goto("/");
	await appReady(page);
	await page.keyboard.press("ControlOrMeta+k");
	await page.getByTestId("palette-input").fill("capital of France");
	await page.getByTestId("search-hit").first().click();
	const userMsg = page.getByTestId("msg-user").first();
	await expect(userMsg).toContainText("France");
	await userMsg.hover();
	await userMsg.getByRole("button", { name: "Edit (creates a branch)" }).click();
	await page.getByLabel("Edit message").fill("What is the capital of Italy? Reply with exactly one word.");
	await page.getByRole("button", { name: "Send as new branch" }).click();
	await expect(page.getByTestId("msg-assistant").last()).toContainText("Rome", { timeout: 90_000 });
	const branched = page.getByTestId("msg-user").first();
	await branched.hover();
	await expect(branched.getByTestId("sibling-nav")).toContainText("2 / 2");
	await branched.getByRole("button", { name: "Previous version" }).click();
	await expect(page.getByTestId("msg-assistant").last()).toContainText("Paris");
});

test("subagents appear live in the side panel with their transcript", async ({ page }) => {
	await startChat(
		page,
		"Use the task tool to spawn exactly one subagent whose assignment is: run `echo subagent-ok` with bash and report the output. After it finishes, reply with DONE.",
	);
	await page.getByTestId("toggle-panel").click();
	const agent = page.getByTestId("subagent-item").first();
	await expect(agent).toBeVisible({ timeout: 90_000 });
	await expect(page.getByTestId("msg-assistant").last()).toContainText("DONE", { timeout: 120_000 });
	await agent.click();
	await expect(page.getByTestId("subagent-detail")).toContainText("subagent-ok", { timeout: 30_000 });
});

test("usage page daily totals match `omp stats --json`", async ({ page }) => {
	const raw = execFileSync("omp", ["stats", "--json"], {
		env: { ...process.env, HOME: process.env.OMPW_E2E_HOME, PI_CODING_AGENT_DIR: process.env.OMPW_E2E_AGENT_DIR },
		encoding: "utf8",
	});
	const stats = JSON.parse(raw) as { costSeries: { timestamp: number; cost: number }[] };
	const byDay = new Map<string, number>();
	for (const p of stats.costSeries) {
		const key = utcDate(p.timestamp);
		byDay.set(key, (byDay.get(key) ?? 0) + p.cost);
	}
	expect(byDay.size).toBeGreaterThan(0);
	await page.goto("/#/usage");
	await page.getByRole("button", { name: "Refresh" }).click();
	for (const [day, cost] of byDay) {
		await expect
			.poll(async () => Number(await page.locator(`[data-day-total="${day}"]`).getAttribute("data-cost")))
			.toBeCloseTo(cost, 9);
	}
});
