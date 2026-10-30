import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE, FIXTURE_BUCKET, FIXTURE_CWD } from "../support/fixtures.ts";
import { expect, test } from "./fixtures.ts";

/** Finished thinking folds away unless Settings › Keep thinking expanded is on (fixtures, no model call). */

test("thinking folds after the answer by default and stays open with the setting on", async ({ page }) => {
	await page.goto("/");
	const side = page.getByRole("complementary");
	const openAlpha = async () => {
		await side.locator('[data-testid="session-item"]', { hasText: FIXTURE.alphaTitle }).click();
		await expect(page.getByText(FIXTURE.alphaFinal)).toBeVisible();
	};
	await openAlpha();
	const thinking = page.getByTestId("thinking").last();
	await expect(thinking.getByRole("button")).toHaveAttribute("aria-expanded", "false");
	await expect(page.getByText(FIXTURE.alphaThinking)).toHaveCount(0);

	await side.getByRole("button", { name: /^Settings$/ }).click();
	await page.locator('[data-testid="settings-page-tab"][data-page="chats"]').click();
	await page.getByTestId("keep-thinking").check();
	await openAlpha();
	await expect(thinking.getByRole("button")).toHaveAttribute("aria-expanded", "true");
	await expect(page.getByText(FIXTURE.alphaThinking)).toBeVisible();

	// A click still folds that block; the preference survives a reload.
	await thinking.getByRole("button").click();
	await expect(page.getByText(FIXTURE.alphaThinking)).toHaveCount(0);
	await page.reload();
	await expect(page.getByText(FIXTURE.alphaThinking)).toBeVisible();

	await side.getByRole("button", { name: /^Settings$/ }).click();
	await page.locator('[data-testid="settings-page-tab"][data-page="chats"]').click();
	await page.getByTestId("keep-thinking").uncheck();
});

const TURN_PROMPT = "Plan the storage migration";
const TURN_ANSWER = "The migration plan is ready.";
const STEP_THINKING = "Check the schema before touching any table.";
const TURN_SESSION_ID = "01a00000-0000-7000-8000-00000000d1d1";

/** One agent turn of three steps (two tool calls, then the answer); the first step thinks before its tool call. */
function writeThinkingTurn(agentDir: string): string {
	const dir = join(agentDir, "sessions", FIXTURE_BUCKET);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `2026-01-06T11-00-00-000Z_${TURN_SESSION_ID}.jsonl`);
	const stamp = (minute: number) => new Date(Date.UTC(2026, 0, 6, 11, minute)).toISOString();
	const assistant = (id: string, parentId: string, minute: number, content: unknown[]) => ({
		type: "message",
		id,
		parentId,
		timestamp: stamp(minute),
		message: {
			role: "assistant",
			content,
			provider: "anthropic",
			model: "claude-haiku-5-5",
			stopReason: "stop",
			timestamp: Date.parse(stamp(minute)),
		},
	});
	const result = (id: string, parentId: string, minute: number, toolCallId: string, tool: string) => ({
		type: "message",
		id,
		parentId,
		timestamp: stamp(minute),
		message: {
			role: "toolResult",
			toolCallId,
			toolName: tool,
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: Date.parse(stamp(minute)),
		},
	});
	const entries = [
		{ type: "session", version: 3, id: TURN_SESSION_ID, timestamp: stamp(0), cwd: FIXTURE_CWD },
		{
			type: "message",
			id: "d1000001",
			parentId: null,
			timestamp: stamp(1),
			message: {
				role: "user",
				content: [{ type: "text", text: TURN_PROMPT }],
				attribution: "user",
				timestamp: Date.parse(stamp(1)),
			},
		},
		assistant("d1000002", "d1000001", 2, [
			{ type: "thinking", thinking: STEP_THINKING },
			{ type: "toolCall", id: "toolu_think_1", name: "bash", arguments: { command: "ls" } },
		]),
		result("d1000003", "d1000002", 3, "toolu_think_1", "bash"),
		assistant("d1000004", "d1000003", 4, [
			{ type: "toolCall", id: "toolu_think_2", name: "read", arguments: { path: "schema.sql" } },
		]),
		result("d1000005", "d1000004", 5, "toolu_think_2", "read"),
		assistant("d1000006", "d1000005", 6, [{ type: "text", text: TURN_ANSWER }]),
	];
	writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
	return file;
}

test("a finished agent turn starts open when its steps thought and Keep thinking expanded is on", async ({ page }) => {
	const file = writeThinkingTurn(process.env.OMPW_E2E_AGENT_DIR as string);
	const openTurn = async () => {
		await page.goto("/");
		await page.getByRole("complementary").getByText(TURN_PROMPT).click();
		await expect(page.getByText(TURN_ANSWER)).toBeVisible();
	};
	try {
		// Off: the steps are folded behind the summary, thinking included.
		await openTurn();
		const summary = page.getByTestId("work-summary");
		await expect(summary).toHaveAttribute("aria-expanded", "false");
		await expect(page.getByText(STEP_THINKING)).toHaveCount(0);

		// On: the turn opens by itself and the step's thinking is there to read; a click still folds it.
		await page.evaluate(() => localStorage.setItem("ompw.keepThinking", "on"));
		await openTurn();
		await expect(summary).toHaveAttribute("aria-expanded", "true");
		await expect(page.getByText(STEP_THINKING)).toBeVisible();
		await summary.click();
		await expect(summary).toHaveAttribute("aria-expanded", "false");
		await expect(page.getByText(STEP_THINKING)).toHaveCount(0);
	} finally {
		rmSync(file, { force: true });
	}
});
