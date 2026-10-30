import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import AxeBuilder from "@axe-core/playwright";
import type { Page } from "@playwright/test";
import { FIXTURE_BUCKET, FIXTURE_CWD } from "../support/fixtures.ts";
import { expect, test } from "./fixtures.ts";

/**
 * A box that scrolls can be scrolled from the keyboard (axe: scrollable-region-focusable): a tool's long output, a long
 * diff, a side panel tab of text only (Info) and the Feedback dialog's preview are stops of the Tab key while their content is taller than they are,
 * and a short output is not. Safari and Firefox do not make such a box focusable by themselves. A hand-written
 * session; no model call.
 */

const TITLE = "Scroll focus probe";
const SESSION_ID = "01a00000-0000-7000-8000-00000000f0c5";
const stamp = (minute: number) => new Date(Date.UTC(2026, 0, 6, 12, minute)).toISOString();
const LONG_OUTPUT = Array.from({ length: 80 }, (_, i) => `line ${i + 1} of the build log`).join("\n");
const LONG_DIFF = Array.from({ length: 60 }, (_, i) => `+${i + 1}|export const value${i} = ${i};`).join("\n");

function writeSession(agentDir: string): string {
	const dir = join(agentDir, "sessions", FIXTURE_BUCKET);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `2026-01-06T12-00-00-000Z_${SESSION_ID}.jsonl`);
	const entries: Record<string, unknown>[] = [
		{ type: "session", version: 3, id: SESSION_ID, timestamp: stamp(0), cwd: FIXTURE_CWD },
	];
	let parent: string | null = null;
	let n = 0;
	const push = (minute: number, message: Record<string, unknown>) => {
		const id = `f0${(++n).toString(16).padStart(6, "0")}`;
		entries.push({
			type: "message",
			id,
			parentId: parent,
			timestamp: stamp(minute),
			message: { ...message, timestamp: Date.parse(stamp(minute)) },
		});
		parent = id;
	};
	const model = { provider: "anthropic", model: "claude-haiku-5-5" };
	const turn = (minute: number, prompt: string, tool: string, args: unknown, text: string, details: unknown) => {
		const id = `toolu_scroll_${minute}`;
		push(minute, { role: "user", content: [{ type: "text", text: prompt }], attribution: "user" });
		push(minute + 1, {
			role: "assistant",
			content: [{ type: "toolCall", id, name: tool, arguments: args }],
			stopReason: "toolUse",
			...model,
		});
		push(minute + 2, {
			role: "toolResult",
			toolCallId: id,
			toolName: tool,
			content: [{ type: "text", text }],
			details,
			isError: false,
		});
		push(minute + 3, {
			role: "assistant",
			content: [{ type: "text", text: `Done at ${minute}.` }],
			stopReason: "stop",
			...model,
		});
	};
	turn(1, TITLE, "bash", { command: "bun run build" }, LONG_OUTPUT, {});
	turn(5, "And a short one", "bash", { command: "echo hi" }, "hi", {});
	turn(9, "Write the values", "edit", { input: "[proj/values.ts#1111]\nPUT 1:\n+x" }, "[proj/values.ts#1111]\n1:\tx", {
		diff: LONG_DIFF,
		firstChangedLine: 1,
		op: "create",
		path: "/Users/x/proj/values.ts",
	});
	writeFileSync(file, `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`);
	return file;
}

let file = "";
test.beforeAll(() => {
	file = writeSession(process.env.OMPW_E2E_AGENT_DIR as string);
});
test.afterAll(() => {
	rmSync(file, { force: true });
});

const card = (page: Page, text: string) => page.getByTestId("tool-card").filter({ hasText: text });

async function openSession(page: Page) {
	await page.goto("/");
	await page.getByRole("complementary").getByText(TITLE).click();
	await expect(page.getByText("Done at 9.")).toBeVisible();
}

/** What axe's rule finds under `selector`, as targets (none is the pass). */
async function unreachable(page: Page, selector: string): Promise<string[]> {
	const { violations } = await new AxeBuilder({ page })
		.include(selector)
		.withRules(["scrollable-region-focusable"])
		.analyze();
	return violations.flatMap((v) => v.nodes.map((n) => n.target.join(" ")));
}

test("a long tool output and a long diff can be scrolled from the keyboard; a short output is no stop", async ({
	page,
}) => {
	await openSession(page);
	// The turns are folded behind their summary; each card opens on its header.
	for (const s of await page.getByTestId("work-summary").all())
		if ((await s.getAttribute("aria-expanded")) === "false") await s.click();
	for (const text of ["bun run build", "echo hi", "values.ts"]) {
		const header = card(page, text).getByRole("button").first();
		if ((await header.getAttribute("aria-expanded")) === "false") await header.click();
	}
	const long = card(page, "bun run build").locator("pre").filter({ hasText: "line 80 of the build log" });
	await expect(long).toHaveAttribute("tabindex", "0");
	await expect(card(page, "echo hi").locator("pre").filter({ hasText: /^hi$/ })).not.toHaveAttribute("tabindex");
	const diff = card(page, "values.ts").getByTestId("diff-view").locator("[tabindex]");
	await expect(diff).toHaveAttribute("tabindex", "0");
	expect(await unreachable(page, '[data-testid="transcript"]')).toEqual([]);

	// Reached and scrolled with the keyboard.
	await long.focus();
	await page.keyboard.press("End");
	await expect.poll(() => long.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
});

test("the Info tab, taller than its pane, can be scrolled from the keyboard", async ({ page }) => {
	await page.setViewportSize({ width: 1400, height: 420 });
	await openSession(page);
	await page.getByTestId("toggle-panel").click();
	await page.getByTestId("pane-tab-info").first().click();
	await expect(page.getByTestId("session-info")).toBeVisible();
	expect(await unreachable(page, '[data-testid="right-panel"]')).toEqual([]);
});

test("the Feedback preview, taller than its box, can be scrolled from the keyboard", async ({ page }) => {
	await page.goto("/#/settings/app");
	await page.getByTestId("settings-feedback").click();
	const dialog = page.getByRole("dialog", { name: "Send feedback" });
	await dialog.getByTestId("feedback-summary").fill("The list resets");
	await dialog.getByTestId("feedback-happened").fill("It resets.\n".repeat(30));
	await dialog.getByTestId("feedback-steps").fill("1. Select two\n2. Archive");
	await dialog.getByTestId("feedback-expected").fill("The selection stays");
	await dialog.getByTestId("feedback-actual").fill("It resets");
	await dialog.getByTestId("feedback-preview-button").click();
	const body = dialog.getByTestId("feedback-body");
	await expect(body).toHaveAttribute("tabindex", "0");
	expect(await unreachable(page, '[data-testid="feedback-body"]')).toEqual([]);
});
