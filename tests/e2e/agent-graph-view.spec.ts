import { PREF, type PrefsSnapshot } from "../../shared/prefs.ts";
import { sessionWithSubagents } from "../support/subagent-fixtures.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The agent graph remembers how it is looked at (v0.12.2): Grid, Focus with its minimap, and the status and time
 * filters are one choice for every conversation's graph, kept with the app's other preferences. A reload keeps them,
 * another conversation's graph opens with them, and so does a page with nothing of its own stored (the app restarted on
 * another port), which takes them from the server.
 */

const graphOf = (file: string) => `/#/agents/${encodeURIComponent(file)}`;

async function expectView(page: Page, where: string) {
	await expect(page.getByTestId("agents-grid"), `${where}: grid`).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByTestId("agents-focus"), `${where}: focus`).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByTestId("agents-minimap"), `${where}: minimap`).toBeVisible();
	await expect(page.getByTestId("agents-filter-status-running"), `${where}: status`).toHaveAttribute(
		"aria-pressed",
		"true",
	);
	await expect(page.getByTestId("agents-filter-time-hour"), `${where}: time`).toHaveAttribute("aria-pressed", "true");
	// The filters act, not only show: every subagent of these conversations finished long ago.
	await expect(page.getByTestId("agents-filter-empty"), `${where}: filtered`).toBeVisible();
}

test("grid, focus and both filters outlive a reload, follow to another conversation's graph and to a new origin", async ({
	page,
	browser,
	e2eServer,
}) => {
	const first = sessionWithSubagents(0x9a11, "Graph view first", { Scout: [1], Other: [1] });
	const second = sessionWithSubagents(0x9a12, "Graph view second", { Helper: [1] });

	await page.goto(graphOf(first.file));
	await expect(page.locator('[data-testid="agent-node"][data-agent-id="Scout"]')).toBeVisible();
	// The graph opens as it always did.
	await expect(page.getByTestId("agents-grid")).toHaveAttribute("aria-pressed", "false");
	await expect(page.getByTestId("agents-focus")).toHaveAttribute("aria-pressed", "false");
	await expect(page.getByTestId("agents-minimap")).toHaveCount(0);
	await expect(page.getByTestId("agents-filter-status-all")).toHaveAttribute("aria-pressed", "true");
	await expect(page.getByTestId("agents-filter-time-all")).toHaveAttribute("aria-pressed", "true");

	await page.getByTestId("agents-grid").click();
	await page.getByTestId("agents-focus").click();
	await page.getByTestId("agents-filter-status-running").click();
	await page.getByTestId("agents-filter-time-hour").click();
	await expectView(page, "as chosen");

	await page.reload();
	await expectView(page, "after a reload");

	// Another conversation's graph is looked at the same way.
	await page.goto(graphOf(second.file));
	await expect(page.getByTestId("agents-list").getByRole("button", { name: "Graph view second" })).toHaveAttribute(
		"aria-current",
		"page",
	);
	await expectView(page, "another conversation");

	// The server holds the choice, so a page that stored nothing of its own (the app on another port) has it too.
	await expect
		.poll(async () => {
			const { values } = (await (await page.request.get("/api/prefs")).json()) as PrefsSnapshot;
			return [values[PREF.graphGrid], values[PREF.graphFocus], values[PREF.graphStatus], values[PREF.graphTime]];
		})
		.toEqual(["on", "on", "running", "hour"]);
	// Signed in, and nothing in its localStorage: not even the sync mark the other tests' pages start with.
	const fresh = await browser.newContext({
		baseURL: e2eServer.url,
		storageState: {
			cookies: [
				{
					name: "ompw_token",
					value: e2eServer.accessToken,
					domain: "127.0.0.1",
					path: "/",
					expires: -1,
					httpOnly: true,
					secure: false,
					sameSite: "Strict",
				},
			],
			origins: [],
		},
	});
	try {
		const other = await fresh.newPage();
		await other.goto(graphOf(first.file));
		await expectView(other, "a new origin");

		// Put back there, and the first page hears it with no reload.
		await other.getByTestId("agents-grid").click();
		await other.getByTestId("agents-focus").click();
		await other.getByTestId("agents-filter-status-all").click();
		await other.getByTestId("agents-filter-time-all").click();
		await expect(page.getByTestId("agents-grid")).toHaveAttribute("aria-pressed", "false");
		await expect(page.getByTestId("agents-focus")).toHaveAttribute("aria-pressed", "false");
		await expect(page.getByTestId("agents-minimap")).toHaveCount(0);
		await expect(page.getByTestId("agents-filter-status-all")).toHaveAttribute("aria-pressed", "true");
		await expect(page.getByTestId("agents-filter-time-all")).toHaveAttribute("aria-pressed", "true");
		await expect(page.locator('[data-testid="agent-node"][data-agent-id="Helper"]')).toBeVisible();
	} finally {
		await fresh.close();
	}
});
