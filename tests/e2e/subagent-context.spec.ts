import { type Frame, lifecycle, openGraph } from "../support/agent-graph-seed.ts";
import { topTab } from "../support/panel.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * How full each subagent's context window is (no model call: omp's progress frames are pushed to the page by hand, with
 * the `contextTokens` and `contextWindow` omp puts in them): `ctx 41%` on its card in the agent graph, in its live view
 * and in the Agents list, with the tokens in the tooltip, coloured past 80%; nothing for one that has not said.
 */

const progress = (id: string, index: number, p: Frame): Frame => ({
	type: "subagent_progress",
	payload: {
		index,
		agent: "task",
		agentSource: "bundled",
		task: id,
		progress: { id, status: "running", durationMs: 1000, ...p },
	},
});

const node = (page: Page, id: string) => page.locator(`[data-testid="agent-node"][data-agent-id="${id}"]`);
const item = (page: Page, id: string) => page.locator(`[data-testid="subagent-item"][data-agent-id="${id}"]`);

test("each subagent's context use is on its graph card, its live view and the Agents list; past 80% it warns", async ({
	page,
}, info) => {
	const title = "Context share probe";
	const { running, frame } = await openGraph(page, 0x87, title);
	for (const [i, id] of ["Calm", "Full", "Quiet"].entries()) {
		running.add(id);
		frame(lifecycle(id, "started", { index: i, parentToolCallId: "call_ctx" }));
	}
	frame(
		progress("Calm", 0, { contextTokens: 41_000, contextWindow: 100_000, resolvedModel: "anthropic/claude-haiku-5-5" }),
	);
	frame(progress("Full", 1, { contextTokens: 172_000, contextWindow: 200_000 }));
	// Nothing measured yet (omp's first record says 0): no figure rather than 0%.
	frame(progress("Quiet", 2, { contextTokens: 0, contextWindow: 200_000, toolCount: 1 }));

	// The graph's cards.
	const calm = node(page, "Calm").getByTestId("subagent-context");
	await expect(calm).toHaveText("ctx 41%");
	await expect(calm).toHaveAttribute("data-level", "ok");
	await expect(calm).toHaveAttribute("title", "Context: 41,000 / 100,000 tokens");
	const full = node(page, "Full").getByTestId("subagent-context");
	await expect(full).toHaveText("ctx 86%");
	await expect(full).toHaveAttribute("data-level", "high");
	await expect(full).toHaveClass(/text-danger/);
	await expect(node(page, "Quiet")).toBeVisible();
	await expect(node(page, "Quiet").getByTestId("subagent-context")).toHaveCount(0);
	await info.attach("graph-cards", {
		body: await page.getByTestId("agents-canvas").screenshot(),
		contentType: "image/png",
	});

	// The live view beside the graph.
	await node(page, "Full").click();
	const detail = page.getByTestId("agents-detail");
	await expect(detail.getByTestId("subagent-context")).toHaveText("ctx 86%");
	await expect(detail.getByTestId("subagent-context")).toHaveAttribute("data-level", "high");
	await expect(detail.getByTestId("subagent-context")).toHaveAttribute("title", "Context: 172,000 / 200,000 tokens");
	await info.attach("graph-detail", { body: await detail.screenshot(), contentType: "image/png" });
	await page.getByTestId("agents-detail-close").click();
	await node(page, "Quiet").click();
	await expect(detail.getByTestId("subagent-full-detail")).toHaveAttribute("data-agent-id", "Quiet");
	await expect(detail.getByTestId("subagent-context")).toHaveCount(0);
	await page.getByTestId("agents-detail-close").click();

	// The conversation's Agents list, and the live view it opens.
	await node(page, "main").click();
	await expect(page.getByTestId("composer")).toBeVisible();
	await page.getByTestId("toggle-panel").click();
	await topTab(page, /Agents/).click();
	await expect(item(page, "Calm").getByTestId("subagent-context")).toHaveText("ctx 41%");
	await expect(item(page, "Full").getByTestId("subagent-context")).toHaveText("ctx 86%");
	await expect(item(page, "Full").getByTestId("subagent-context")).toHaveAttribute("data-level", "high");
	await expect(item(page, "Quiet")).toBeVisible();
	await expect(item(page, "Quiet").getByTestId("subagent-context")).toHaveCount(0);
	await info.attach("agents-list", {
		body: await page.getByTestId("subagent-list").screenshot(),
		contentType: "image/png",
	});
	await item(page, "Calm").click();
	const tab = page.getByTestId("subagent-detail");
	await expect(tab.getByTestId("subagent-context")).toHaveText("ctx 41%");
	await expect(tab.getByTestId("subagent-context")).toHaveAttribute("data-level", "ok");

	// A later frame moves it.
	frame(progress("Calm", 0, { contextTokens: 65_000, contextWindow: 100_000 }));
	await expect(tab.getByTestId("subagent-context")).toHaveText("ctx 65%");
	await expect(tab.getByTestId("subagent-context")).toHaveAttribute("data-level", "warn");
});
