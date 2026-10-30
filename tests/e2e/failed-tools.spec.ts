import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE, FIXTURE_BUCKET, FIXTURE_CWD } from "../support/fixtures.ts";
import { expect, type Page, test } from "./fixtures.ts";

/** A finished turn folds its tool steps behind a summary: a step that failed must not disappear with them (no model call). */

const PROMPT = "Check why the deploy failed";
const ANSWER = "The deploy failed on the migration step.";
const SESSION_ID = "01a00000-0000-7000-8000-00000000d0d0";

const stamp = (minute: number) => new Date(Date.UTC(2026, 0, 6, 10, minute)).toISOString();

/** A conversation with one agent turn: three tool steps, the second of which errors, then the answer. */
function writeSession(agentDir: string): string {
	const dir = join(agentDir, "sessions", FIXTURE_BUCKET);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `2026-01-06T10-00-00-000Z_${SESSION_ID}.jsonl`);
	const entries: Record<string, unknown>[] = [
		{ type: "session", version: 3, id: SESSION_ID, timestamp: stamp(0), cwd: FIXTURE_CWD },
		{
			type: "message",
			id: "d0000001",
			parentId: null,
			timestamp: stamp(1),
			message: {
				role: "user",
				content: [{ type: "text", text: PROMPT }],
				attribution: "user",
				timestamp: Date.parse(stamp(1)),
			},
		},
	];
	let parent = "d0000001";
	for (const [i, tool] of ["bash", "read", "bash"].entries()) {
		const call = `d00000${2 + i * 2}`;
		const result = `d00000${3 + i * 2}`;
		const toolCallId = `toolu_failed_${i}`;
		entries.push(
			{
				type: "message",
				id: call,
				parentId: parent,
				timestamp: stamp(2 + i),
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: toolCallId, name: tool, arguments: { command: `step ${i}` } }],
					provider: "anthropic",
					model: "claude-haiku-5-5",
					stopReason: "toolUse",
					timestamp: Date.parse(stamp(2 + i)),
				},
			},
			{
				type: "message",
				id: result,
				parentId: call,
				timestamp: stamp(2 + i),
				message: {
					role: "toolResult",
					toolCallId,
					toolName: tool,
					content: [{ type: "text", text: i === 1 ? "ENOENT: no such file" : `ok ${i}` }],
					isError: i === 1,
					timestamp: Date.parse(stamp(2 + i)),
				},
			},
		);
		parent = result;
	}
	entries.push({
		type: "message",
		id: "d0000010",
		parentId: parent,
		timestamp: stamp(9),
		message: {
			role: "assistant",
			content: [{ type: "text", text: ANSWER }],
			provider: "anthropic",
			model: "claude-haiku-5-5",
			stopReason: "stop",
			timestamp: Date.parse(stamp(9)),
		},
	});
	writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
	return file;
}

/** What `color: <value>` computes to in this page. */
const cssColor = (page: Page, value: string) =>
	page.evaluate((v) => {
		const probe = document.createElement("i");
		probe.style.color = v;
		document.body.append(probe);
		const color = getComputedStyle(probe).color;
		probe.remove();
		return color;
	}, value);

test("a collapsed turn says how many of its tool calls failed, and the failed one is still there when expanded", async ({
	page,
}) => {
	const file = writeSession(process.env.OMPW_E2E_AGENT_DIR as string);
	try {
		await page.goto("/");
		await page.getByRole("complementary").getByText(PROMPT).click();
		await expect(page.getByText(ANSWER)).toBeVisible();

		const summary = page.getByTestId("work-summary");
		await expect(summary).toContainText("3 tool calls");
		const failed = summary.getByTestId("work-failed");
		await expect(failed).toHaveText("1 failed");
		await expect(failed.locator("svg")).toHaveCount(1);
		await expect(failed).toHaveCSS("color", await cssColor(page, "var(--danger)"));
		await expect(page.getByTestId("tool-card")).toHaveCount(0);

		await summary.click();
		await expect(page.getByTestId("tool-card")).toHaveCount(3);
		await expect(page.getByTestId("tool-card").getByLabel("Failed")).toHaveCount(1);
	} finally {
		rmSync(file, { force: true });
	}
});

test("a collapsed turn with no failed tool calls says nothing about failures", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("complementary").getByText(FIXTURE.epsilonTitle).click();
	await expect(page.getByTestId("work-summary")).toContainText("4 tool calls");
	await expect(page.getByTestId("work-failed")).toHaveCount(0);
});
