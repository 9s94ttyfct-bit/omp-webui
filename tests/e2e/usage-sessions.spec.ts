import { realpathSync, rmSync } from "node:fs";
import { writeChatSession } from "../support/chat-session.ts";
import { FIXTURE_BUCKET, FIXTURE_CWD } from "../support/fixtures.ts";
import { topTab } from "../support/panel.ts";
import { sessionWithSubagents } from "../support/subagent-fixtures.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * The usage page's two lists that name a project. "Most expensive conversations" is a table of columns whose rows must
 * not move them (the project, the tokens and the cost were set after whatever a row had put before them, so a row with
 * "incl. $0.02 subagents" pushed its project 130px to the left, and the costs mixed `$0.06` with `$0.0040`). "By project"
 * calls a project what the sidebar and the list call it, not by the directory omp files it in (`-tmp-dev-acme-api`).
 * No model call.
 */

const agentDir = () => process.env.OMPW_E2E_AGENT_DIR as string;
const turn = [{ prompt: "How many?", reply: "Nine." }];

/**
 * What the spec's own conversations cost. The Usage page lists only the 12 costliest conversations, and a worker's
 * server keeps what the specs before it left, so a probe that costs less than the fixtures' can fall out of the list
 * and the spec fails for a reason that has nothing to do with what it checks (#505).
 */
const PROBE_COST = 50;

/** A conversation of the usage page: its row, whatever its title. */
const row = (page: Page, title: string) => page.getByTestId("usage-session").filter({ hasText: title });

/** Where the three right-hand cells of a row are: the project's left edge, the tokens' and the cost's right edge. */
async function columns(rows: Locator) {
	return rows.evaluateAll((els) =>
		els.map((el) => {
			// The three cells are found by what they are, not by what they say: a worker's server holds conversations
			// of other specs, and their projects are not named alike.
			const cell = (testid: string) => {
				const found = el.querySelector(`[data-testid="${testid}"]`);
				if (!found) throw new Error(`no cell ${testid} in "${el.textContent}"`);
				return found.getBoundingClientRect();
			};
			const cost = el.querySelector('[data-testid="usage-session-cost"]');
			if (!cost) throw new Error("no cost");
			const box = cost.getBoundingClientRect();
			return {
				project: cell("usage-session-project").left,
				tokens: cell("usage-session-tokens").right,
				cost: { right: box.right, width: box.width, text: cost.textContent ?? "" },
			};
		}),
	);
}

test("every row of the costliest conversations keeps its project, tokens and cost in the same columns", async ({
	page,
}) => {
	// A row with a subagent's share, and rows of projects with names of different lengths.
	// The Usage page lists only the 12 costliest conversations, and a worker's server keeps what earlier specs left,
	// so the probes are given a cost above any of the fixtures' (#505).
	const split = sessionWithSubagents(0xc0, "Usage rows: with a subagent", { Scout: [3] }, undefined, PROBE_COST);
	const others = [
		writeChatSession(agentDir(), {
			n: 0x72,
			title: "Usage rows: docs",
			cwd: "/tmp/ompw-usage-docs",
			turns: turn,
			cost: PROBE_COST,
		}),
		writeChatSession(agentDir(), {
			n: 0x73,
			title: "Usage rows: long",
			cwd: "/tmp/ompw-usage-a-much-longer-project-name",
			turns: turn,
			cost: PROBE_COST,
		}),
	];
	try {
		await page.goto("/#/usage");
		await expect(row(page, "Usage rows: with a subagent")).toBeVisible();
		await expect(row(page, "Usage rows: docs")).toBeVisible();
		await expect(row(page, "Usage rows: long")).toBeVisible();
		// The subagent's share is a line under the title now, and still said.
		await expect(row(page, "Usage rows: with a subagent").getByTestId("usage-session-split")).toContainText(
			"incl. $0.0030 subagents",
		);

		const rows = page.getByTestId("usage-session");
		const cells = await columns(rows);
		expect(cells.length, "rows").toBeGreaterThanOrEqual(7);
		const same = (values: number[], what: string) =>
			expect(Math.max(...values) - Math.min(...values), `${what} differs by row`).toBeLessThan(0.5);
		same(
			cells.map((c) => c.project),
			"the project's left edge",
		);
		same(
			cells.map((c) => c.tokens),
			"the tokens' right edge",
		);
		same(
			cells.map((c) => c.cost.right),
			"the cost's right edge",
		);
		same(
			cells.map((c) => c.cost.width),
			"the cost's width",
		);

		// One precision for the column, so the decimal points line up.
		const decimals = new Set(cells.map((c) => c.cost.text.split(".")[1]?.length));
		expect([...decimals], `the costs ${cells.map((c) => c.cost.text).join(" ")}`).toHaveLength(1);
	} finally {
		for (const file of [split.file, ...others]) rmSync(file, { force: true });
		rmSync(split.artifacts, { recursive: true, force: true });
	}
});

const bucket = (folder: string, totalCost: number) => ({
	totalRequests: 4,
	successfulRequests: 4,
	failedRequests: 0,
	errorRate: 0,
	totalInputTokens: 1000,
	totalOutputTokens: 200,
	totalCacheReadTokens: 5000,
	totalCacheWriteTokens: 300,
	cacheRate: 0.8,
	totalCost,
	avgDuration: 1500,
	avgTtft: 400,
	avgTokensPerSecond: 60,
	firstTimestamp: Date.UTC(2026, 0, 5),
	lastTimestamp: Date.UTC(2026, 0, 6),
	folder,
});

test("By project calls a folder what the conversation list calls its project, with the path as its title", async ({
	page,
}) => {
	const docs = writeChatSession(agentDir(), {
		n: 0x74,
		title: "Usage rows: label",
		cwd: "/tmp/ompw-usage-docs",
		turns: turn,
		// The list of the costliest conversations has to hold this one, whatever the worker holds (#505).
		cost: PROBE_COST,
	});
	// What omp's stats call the folders: the directory its conversations are filed in.
	const slugs = [FIXTURE_BUCKET, "-tmp-ompw-usage-docs", "--Volumes-gone-project--"];
	await page.route(/\/api\/stats(\?|$)/, (route) =>
		route.fulfill({
			json: {
				overall: bucket("", 0.42),
				byModel: [],
				byFolder: slugs.map((slug, i) => bucket(slug, 3 - i)),
				costSeries: [],
			},
		}),
	);
	try {
		await page.goto("/#/usage");
		const names = page.getByTestId("table-By project").locator("tbody tr td:first-child");
		await expect(names).toHaveText(["ompw-fixture-project", "ompw-usage-docs", "--Volumes-gone-project--"]);
		// The full path on hover; a folder nobody lives in any more keeps its directory's name.
		expect(await names.evaluateAll((els) => els.map((e) => e.getAttribute("title")))).toEqual([
			FIXTURE_CWD,
			"/tmp/ompw-usage-docs",
			"--Volumes-gone-project--",
		]);
		// The same name as the conversations below it.
		const listed = await page.getByTestId("usage-session").evaluateAll((els) => els.map((e) => e.textContent ?? ""));
		expect(listed.some((text) => text.includes("ompw-fixture-project"))).toBe(true);
		expect(listed.some((text) => text.includes("ompw-usage-docs"))).toBe(true);
	} finally {
		rmSync(docs, { force: true });
	}
});

test("the Agents list writes the costs of its subagents as one column too", async ({ page }) => {
	// $0.008 and $0.020: two decimals would write them as `$0.01` and `$0.02`, four keep them apart.
	const own = sessionWithSubagents(0xc1, "Agents column probe", { Scout: [8], Other: [20] });
	try {
		await page.goto(`/#/s/${encodeURIComponent(realpathSync(own.file))}`);
		await page.getByTestId("toggle-panel").click();
		await topTab(page, /Agents/).click();
		const costOf = (id: string) =>
			page.locator(`[data-testid="subagent-item"][data-agent-id="${id}"]`).getByText(/^\$\d/);
		await expect(costOf("Scout")).toHaveText("$0.0080");
		await expect(costOf("Other")).toHaveText("$0.0200");
	} finally {
		rmSync(own.file, { force: true });
		rmSync(own.artifacts, { recursive: true, force: true });
	}
});
