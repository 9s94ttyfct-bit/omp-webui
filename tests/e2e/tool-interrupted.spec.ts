import { ownSession, sessionRow, startLive } from "../support/live.ts";
import { assistant, user, writeEntries } from "../support/session-entries.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * omp writes a tool call's result only when the tool ends. A conversation whose omp or server was killed while a tool ran
 * (SIGKILL, a crash, the app quit mid-turn) keeps the call without a result for good: its card says so, instead of
 * spinning as if the tool still ran. A call that is about to start, in a conversation that is streaming, still spins.
 */

const card = (page: Page, command: string) => page.locator('[data-testid="tool-card"]', { hasText: command });
const spinner = (page: Page, command: string) => card(page, command).locator(".animate-spin");

test("a saved call that nobody answered reads as interrupted, whether or not the conversation went on", async ({
	page,
}) => {
	const agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
	const call = { t1: "bash" };
	writeEntries(agentDir, 0x10, "Interrupted tool went on", [
		user("u1", null, 1, "Build it"),
		assistant("a1", "u1", 2, { text: "Running make.", calls: call }),
		user("u2", "a1", 3, "continue"),
		assistant("a2", "u2", 4, { text: "ok" }),
	]);
	// The file as a SIGKILL leaves it: the call, and nothing after it.
	writeEntries(agentDir, 0x11, "Interrupted tool at the end", [
		user("u1", null, 1, "Build it"),
		assistant("a1", "u1", 2, { text: "Running make.", calls: call }),
	]);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	tap.answer("prompt", (c) => (c.message === "continue" ? { ok: true, data: { agentInvoked: true } } : undefined));
	await page.goto("/");

	for (const title of ["Interrupted tool went on", "Interrupted tool at the end"]) {
		await sessionRow(page, title).click();
		const c = card(page, "run t1");
		await expect(c).toHaveCount(1);
		await expect(c.getByTestId("tool-interrupted")).toBeVisible();
		await expect(c.getByTestId("tool-interrupted")).toHaveAttribute("title", /interrupted/);
		await expect(spinner(page, "run t1")).toHaveCount(0);
		await expect(c.getByLabel("Done")).toHaveCount(0);
	}

	// Only the conversation that ends there offers a way on: `/retry` has nothing to redo for it, so it is Continue.
	await expect(page.getByTestId("resume-button")).toHaveCount(1);
	await page.getByTestId("resume-button").click();
	await expect.poll(() => tap.commands("prompt").map((c) => c.message)).toEqual(["continue"]);
	await sessionRow(page, "Interrupted tool went on").click();
	await expect(card(page, "run t1")).toHaveCount(1);
	await expect(page.getByTestId("resume-button")).toHaveCount(0);
});

test("a call between the model's message and its tool's first frame spins; when the turn ends without an answer it is interrupted", async ({
	page,
}) => {
	const title = "Interrupted tool live";
	ownSession(0x90, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, "interrupted-probe");
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });

	frame({ type: "agent_start" });
	frame({
		type: "message_start",
		messageId: "m-live",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "toolu_live", name: "bash", arguments: { command: "make live" } }],
		},
	});
	await expect(card(page, "make live")).toHaveCount(1);
	await expect(spinner(page, "make live")).toHaveCount(1);
	await expect(card(page, "make live").getByTestId("tool-interrupted")).toHaveCount(0);

	// The tool starts and ends: the verdict is its own, never "interrupted".
	frame({ type: "tool_execution_start", toolCallId: "toolu_live", toolName: "bash", args: { command: "make live" } });
	frame({
		type: "tool_execution_end",
		toolCallId: "toolu_live",
		toolName: "bash",
		isError: false,
		result: { content: [{ type: "text", text: "built" }] },
	});
	await expect(card(page, "make live").getByLabel("Done")).toBeVisible();

	// A second call that the turn ends without ever running.
	frame({
		type: "message_start",
		messageId: "m-live-2",
		message: {
			role: "assistant",
			content: [{ type: "toolCall", id: "toolu_lost", name: "bash", arguments: { command: "make lost" } }],
		},
	});
	await expect(spinner(page, "make lost")).toHaveCount(1);
	frame({ type: "agent_end" });
	await expect(card(page, "make lost").getByTestId("tool-interrupted")).toBeVisible();
	await expect(spinner(page, "make lost")).toHaveCount(0);
	await expect(card(page, "make live").getByLabel("Done")).toBeVisible();
});
