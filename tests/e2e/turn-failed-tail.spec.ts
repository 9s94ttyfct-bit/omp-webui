import type { SessionEntry } from "../../shared/protocol.ts";
import { sessionRow } from "../support/live.ts";
import { assistant, result, user, writeEntries } from "../support/session-entries.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * A finished turn folds its steps behind "Worked for … · 2 tool calls" and keeps its answer. When its last step failed
 * (a 429 after a long tool run) or was stopped before it wrote anything, there is no answer after the steps: the
 * failure stays on screen with its Retry, and the summary says how the turn ended. Hand-written conversations, no model.
 */

const ERROR = "429 rate_limit_error: This request would exceed your rate limit.";

/** A prompt, two tool steps and a narrated third, then `tail`. */
function conversation(tail: SessionEntry): SessionEntry[] {
	return [
		user("u1", null, 1, "Fix the build"),
		assistant("a1", "u1", 2, { calls: { t1: "bash" } }),
		result("r1", "a1", 3, "t1", "ok 1"),
		assistant("a2", "r1", 4, { text: "Second step.", calls: { t2: "bash" } }),
		result("r2", "a2", 5, "t2", "ok 2"),
		assistant("a3", "r2", 6, { text: "Third step." }),
		tail,
	];
}

async function open(page: Page, title: string) {
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	tap.answer("prompt", (c) => (c.message === "/retry" ? { ok: true, data: { agentInvoked: true } } : undefined));
	await page.goto("/");
	await sessionRow(page, title).click();
	return tap;
}

test("a turn that ended in an error keeps the error and its Retry while the steps are folded, after a reload too", async ({
	page,
}) => {
	const title = "Failed tail error";
	writeEntries(
		process.env.OMPW_E2E_AGENT_DIR as string,
		0x01,
		title,
		conversation(assistant("a4", "a3", 7, { stopReason: "error", errorMessage: ERROR })),
	);
	const tap = await open(page, title);

	const error = page.getByTestId("assistant-error");
	await expect(page.getByTestId("work-summary")).toContainText("2 tool calls");
	await expect(page.getByTestId("work-summary")).toHaveAttribute("aria-expanded", "false");
	await expect(error).toContainText("429 rate_limit_error");
	await expect(page.getByTestId("work-ended")).toContainText("ended in an error");
	// What folded is still folded: the narration of the second step is behind the summary.
	await expect(page.getByText("Second step.")).toHaveCount(0);

	await error.getByTestId("retry-button").click();
	await expect.poll(() => tap.commands("prompt").map((c) => c.message)).toEqual(["/retry"]);

	await page.reload();
	await sessionRow(page, title).click();
	await expect(page.getByTestId("assistant-error")).toContainText("429 rate_limit_error");
	await expect(page.getByTestId("retry-button")).toBeVisible();
	await expect(page.getByTestId("work-summary")).toHaveAttribute("aria-expanded", "false");
});

test("a turn the reader stopped before its last step wrote anything keeps its Interrupted row", async ({ page }) => {
	const title = "Failed tail stopped";
	writeEntries(
		process.env.OMPW_E2E_AGENT_DIR as string,
		0x02,
		title,
		conversation(assistant("a4", "a3", 7, { stopReason: "aborted" })),
	);
	await open(page, title);

	await expect(page.getByTestId("work-summary")).toContainText("2 tool calls");
	await expect(page.getByTestId("assistant-error")).toContainText("Interrupted");
	await expect(page.getByTestId("work-ended")).toContainText("interrupted");
	await expect(page.getByText("Second step.")).toHaveCount(0);
});

test("a turn that ended well still folds to its answer alone", async ({ page }) => {
	const title = "Failed tail control";
	writeEntries(
		process.env.OMPW_E2E_AGENT_DIR as string,
		0x03,
		title,
		conversation(assistant("a4", "a3", 7, { text: "All done." })),
	);
	await open(page, title);

	await expect(page.getByTestId("work-summary")).toContainText("2 tool calls");
	await expect(page.getByText("All done.")).toBeVisible();
	await expect(page.getByTestId("assistant-error")).toHaveCount(0);
	await expect(page.getByTestId("work-ended")).toHaveCount(0);
	await expect(page.getByText("Third step.")).toHaveCount(0);
});
