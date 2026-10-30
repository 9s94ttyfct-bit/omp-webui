import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";
import { FIXTURE_FILES, USAGE_A3 } from "../support/fixtures.ts";
import { startLive } from "../support/live.ts";
import { topTab } from "../support/panel.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { appendCall, sessionWithSubagents } from "../support/subagent-fixtures.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * What a conversation has cost includes its subagents: the header total, its tooltip, the sidebar and the usage
 * page all count the subagent transcripts under the conversation's artifacts directory, nested ones included, and
 * say how much of it they are (no model call: the transcripts are written files).
 */

const gammaRow = (page: Page) => page.locator(`[data-testid="session-item"][data-file$="${FIXTURE_FILES.gamma}"]`);
/** The server lists the canonical path of a file (macOS temp directories are symlinks), so match by file name. */
const rowOf = (page: Page, file: string) =>
	page.locator(`[data-testid="session-item"][data-file$="${basename(file)}"]`);
const headerCost = (page: Page) => page.getByTestId("session-cost");
const costOf = async (page: Page) => Number(await headerCost(page).getAttribute("data-cost"));

test("the header total of a conversation with a subagent is its own cost plus the subagent's, split in the tooltip", async ({
	page,
}) => {
	await page.goto("/");
	await gammaRow(page).click();
	// Gamma's file holds three requests (one on an abandoned branch); its scout's transcript holds a fourth.
	await expect.poll(() => costOf(page)).toBeCloseTo(4 * USAGE_A3.cost, 9);

	await headerCost(page).hover();
	const split = page.getByTestId("usage-split");
	await expect(split).toBeVisible();
	expect(Number(await split.getAttribute("data-main-cost"))).toBeCloseTo(3 * USAGE_A3.cost, 9);
	expect(Number(await split.getAttribute("data-subagent-cost"))).toBeCloseTo(USAGE_A3.cost, 9);
	await expect(split.locator('[data-split="main"]')).toContainText("Main agent");
	await expect(split.locator('[data-split="subagents"]')).toContainText("Subagents (1)");
});

test("the Info tab's totals are the conversation's whole: the scout's request is in them", async ({ page }) => {
	await page.goto("/");
	await gammaRow(page).click();
	await page.getByTestId("toggle-panel").click();
	await topTab(page, /Info/).click();
	await expect(page.getByTestId("session-info").locator('[data-stat="Total cost"]')).toHaveText("$0.004000");
});

test("the sidebar tooltip and the usage page count a conversation's subagents, nested ones too, and say how much", async ({
	page,
}) => {
	// $0.012345 of its own, $5 + $1 for the scout and $2 for the scout's own subagent.
	const own = sessionWithSubagents(0xb0, "Totals probe", { Scout: [5000, 1000], "Scout.Deep": [2000] });
	await page.goto("/");
	await expect(rowOf(page, own.file)).toHaveCount(1, { timeout: 15_000 });
	await expect(rowOf(page, own.file)).toHaveAttribute("title", /\$8\.01 \(incl\. \$8\.00 by subagents\)/);

	await page.goto("/#/usage");
	const top = page.locator(`[data-testid="usage-session"][data-file$="${basename(own.file)}"]`);
	await expect(top).toBeVisible();
	expect(Number(await top.getByTestId("usage-session-cost").getAttribute("data-cost"))).toBeCloseTo(8.012345, 6);
	await expect(top.getByTestId("usage-session-split")).toContainText("incl. $8.00 subagents");
});

test("a subagent that is still writing moves the header total and the sidebar without a reload", async ({ page }) => {
	const own = sessionWithSubagents(0xb1, "Writing probe", { Scout: [1000] });
	await page.goto("/");
	await rowOf(page, own.file).click();
	await expect.poll(() => costOf(page)).toBeCloseTo(1.012345, 6);

	// The parent's file does not change: only the subagent's does.
	appendCall(own.transcript("Scout"), 2000);
	await expect.poll(() => costOf(page), { timeout: 20_000 }).toBeCloseTo(3.012345, 6);
	await expect(rowOf(page, own.file)).toHaveAttribute("title", /\$3\.01 \(incl\. \$3\.00 by subagents\)/);
});

test("the Info tab of a running conversation counts what a compaction dropped from its context, and its subagents (#687)", async ({
	page,
}) => {
	// $0.012345 of its own before the compaction, $0.001 after it, $5 for its scout. A number no other spec uses: the files
	// of a worker share one agent folder, and another spec's conversation (or its subagents) of the same number would mix in.
	const own = sessionWithSubagents(0xaa, "Compacted while running", { Scout: [5000] });
	const at = "2026-01-07T01:00:00.000Z";
	const zero = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	const kept = {
		type: "message",
		id: "sb2c0001",
		parentId: "saa000002",
		timestamp: at,
		message: {
			role: "assistant",
			content: [{ type: "text", text: "After the summary." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-haiku-5-5",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { ...zero, total: 0.001 } },
			stopReason: "stop",
			timestamp: Date.parse(at),
		},
	};
	const compaction = {
		type: "compaction",
		id: "sb2c0002",
		parentId: "sb2c0001",
		timestamp: at,
		summary: "What came before.",
		firstKeptEntryId: "sb2c0001",
		tokensBefore: 1000,
	};
	appendFileSync(own.file, `${JSON.stringify(kept)}\n${JSON.stringify(compaction)}\n`);
	const tap = await tapSocket(page);
	await page.goto("/");
	// omp runs on it: its own figures would be of what it holds in context, the request after the summary only.
	await startLive(page, tap, "Compacted while running", "probe-687");
	await expect.poll(() => costOf(page)).toBeCloseTo(5.013345, 6);
	await page.getByTestId("toggle-panel").click();
	await topTab(page, /Info/).click();
	const info = page.getByTestId("session-info");
	await expect(info.locator('[data-stat="Tool calls"]')).toBeVisible();
	await expect(info.locator('[data-stat="Total cost"]')).toHaveText("$5.013345");
	await expect(info.locator('[data-stat="Subagent cost"]')).toHaveText("$5.000000");
});

test("the Info tab says how long the agent worked in all, its subagents too, the same from the file and live (#692)", async ({
	page,
}) => {
	const own = sessionWithSubagents(0xad, "Worked across turns", {});
	const at = (hms: string) => `2026-01-08T${hms}.000Z`;
	let parent = "sad000002";
	const line = (id: string, time: string, message: Record<string, unknown>) => {
		const entry = { type: "message", id, parentId: parent, timestamp: at(time), message };
		parent = id;
		return JSON.stringify(entry);
	};
	const prompt = (id: string, time: string) =>
		line(id, time, {
			role: "user",
			content: [{ type: "text", text: "Go on" }],
			attribution: "user",
			timestamp: Date.parse(at(time)),
		});
	const reply = (id: string, time: string) =>
		line(id, time, {
			role: "assistant",
			content: [{ type: "text", text: `Done at ${time}` }],
			provider: "anthropic",
			model: "claude-haiku-5-5",
			stopReason: "stop",
			timestamp: Date.parse(at(time)),
		});
	// Three turns of 40 s, 80 s and 5 s, with the half hours between them nobody asked anything.
	const turns = [
		prompt("sf5t0001", "10:00:00"),
		reply("sf5t0002", "10:00:40"),
		prompt("sf5t0003", "10:30:00"),
		reply("sf5t0004", "10:31:20"),
		prompt("sf5t0005", "11:00:00"),
		reply("sf5t0006", "11:00:05"),
	];
	appendFileSync(own.file, `${turns.join("\n")}\n`);
	// Its scout worked a minute on the task it was given (a prompt omp writes on the agent's behalf).
	const scout = own.transcript("Scout");
	mkdirSync(dirname(scout), { recursive: true });
	writeFileSync(
		scout,
		`${[
			{ type: "session", version: 3, id: "sub-f5", timestamp: at("10:30:05"), cwd: "/tmp/ompw-fixture-project" },
			{
				type: "message",
				id: "sf5s0001",
				parentId: null,
				timestamp: at("10:30:05"),
				message: { role: "user", content: [{ type: "text", text: "Scout" }], attribution: "agent" },
			},
			{
				type: "message",
				id: "sf5s0002",
				parentId: "sf5s0001",
				timestamp: at("10:31:05"),
				message: { role: "assistant", content: [{ type: "text", text: "Found" }], stopReason: "stop" },
			},
		]
			.map((l) => JSON.stringify(l))
			.join("\n")}\n`,
	);
	const worked = "3m 05s (subagents 1m 00s)";
	const tap = await tapSocket(page);
	await page.goto("/");
	await rowOf(page, own.file).click();
	await page.getByTestId("toggle-panel").click();
	await topTab(page, /Info/).click();
	const stat = page.getByTestId("session-info").locator('[data-stat="Time worked"]');
	await expect(stat).toHaveText(worked);
	// A new page: the conversation is opened again, and counts the same.
	await page.reload();
	await rowOf(page, own.file).click();
	await expect(page.getByTestId("toggle-panel")).toBeVisible();
	if (!(await topTab(page, /Info/).isVisible())) await page.getByTestId("toggle-panel").click();
	await topTab(page, /Info/).click();
	await expect(stat).toHaveText(worked);
	// omp runs on it now: the same count, from the entries it holds.
	await startLive(page, tap, "Worked across turns", "probe-692");
	await expect(page.getByTestId("session-info").locator('[data-stat="Tool calls"]')).toBeVisible();
	await expect(stat).toHaveText(worked);
});
