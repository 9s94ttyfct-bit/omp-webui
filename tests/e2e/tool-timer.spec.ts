import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_BUCKET, FIXTURE_CWD } from "../support/fixtures.ts";
import { ownSession, startLive } from "../support/live.ts";
import { agentStart, messageStart, toolCall, toolEnd, toolStart } from "../support/omp-frames.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Per-command timer (#657): a running call ticks on its card, a finished one keeps its length, Settings chooses which calls
 * show one, and a conversation opened from its file shows the lengths it can derive (bash's `wallTimeMs`, else the result's
 * time less when the assistant message ended). Frames are pushed over the page's socket: no model is called.
 */

const timerOf = (page: Page, tool: string) =>
	page.locator(`[data-testid="tool-card"][data-tool="${tool}"]`).getByTestId("tool-timer");

test("a running call ticks, and a finished one keeps its length", async ({ page }) => {
	ownSession(0xe0, "Tool timer probe");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, "Tool timer probe", "tool-timer-probe");
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });

	frame(agentStart());
	frame(messageStart("m-timer"));
	frame(toolCall("m-timer", 0, { id: "tc-bash", name: "bash", arguments: { command: "sleep 30" } }));
	frame(toolCall("m-timer", 1, { id: "tc-read", name: "read", arguments: { path: "a.txt" } }));
	frame(toolStart("tc-bash", "bash", { command: "sleep 30" }));
	frame(toolStart("tc-read", "read", { path: "a.txt" }));

	// Ticking: whole seconds, once one has passed, and it moves on.
	const running = timerOf(page, "bash");
	await expect(running).toHaveAttribute("data-state", "running", { timeout: 5000 });
	await expect(running).toHaveText(/^\d+s$/);
	const first = await running.textContent();
	await expect.poll(() => running.textContent(), { timeout: 5000 }).not.toBe(first);
	// The default is every tool call: the read has its clock too.
	await expect(timerOf(page, "read")).toHaveAttribute("data-state", "running");
	// When it started (#691): today's, so the time alone; it stays put when the call ends.
	const started = page.locator('[data-testid="tool-card"][data-tool="bash"]').getByTestId("start-time");
	await expect(started).toHaveText(/^\d{2}:\d{2}:\d{2}$/);
	const startedText = await started.textContent();

	// Done: the length stays as it was when the call ended.
	frame(toolEnd("tc-bash", "bash", "done"));
	const done = timerOf(page, "bash");
	await expect(done).toHaveAttribute("data-state", "done");
	const final = await done.textContent();
	expect(final).toMatch(/^\d+(\.\d)?s$|^\d+ms$|^\d+m \d+s$/);
	await page.waitForTimeout(1500);
	await expect(done).toHaveText(final ?? "");
	await expect(started).toHaveText(startedText ?? "");
});

test("shell only times bash, off times nothing, and the choice is set in Settings", async ({ page }) => {
	await page.goto("/#/settings/chats");
	const mode = page.getByTestId("tool-timer-mode");
	await expect(mode).toHaveValue("all");
	await mode.selectOption("shell");
	await expect.poll(() => page.evaluate(() => localStorage.getItem("ompw.toolTimer"))).toBe("shell");
	await mode.selectOption("off");
	await expect.poll(() => page.evaluate(() => localStorage.getItem("ompw.toolTimer"))).toBe("off");
	await page.reload();
	await expect(page.getByTestId("tool-timer-mode")).toHaveValue("off");
	await page.getByTestId("tool-timer-mode").selectOption("all");
	await expect.poll(() => page.evaluate(() => localStorage.getItem("ompw.toolTimer"))).toBe("all");
});

test("a conversation read from its file shows each call's length, and the setting hides it", async ({ page }) => {
	const dir = join(process.env.OMPW_E2E_AGENT_DIR as string, "sessions", FIXTURE_BUCKET);
	mkdirSync(dir, { recursive: true });
	const id = "01a00000-0000-7000-8000-00000000e0e0";
	const stamp = (s: number) => new Date(Date.UTC(2026, 0, 7, 10, 0, s)).toISOString();
	const at = (s: number) => Date.parse(stamp(s));
	const msg = (entry: string, parent: string | null, s: number, message: Record<string, unknown>) => ({
		type: "message",
		id: entry,
		parentId: parent,
		timestamp: stamp(s),
		message,
	});
	const lines = [
		{ type: "session", version: 3, id, timestamp: stamp(0), cwd: FIXTURE_CWD },
		{ type: "title_change", id: "e0title", parentId: null, timestamp: stamp(0), title: "Saved timer probe" },
		msg("e0001", null, 1, {
			role: "user",
			content: [{ type: "text", text: "Time these" }],
			attribution: "user",
			timestamp: at(1),
		}),
		msg("e0002", "e0001", 2, {
			role: "assistant",
			content: [
				{ type: "toolCall", id: "tc-saved-bash", name: "bash", arguments: { command: "make build" } },
				{ type: "toolCall", id: "tc-saved-read", name: "read", arguments: { path: "a.txt" } },
			],
			provider: "anthropic",
			model: "claude-haiku-5-5",
			stopReason: "toolUse",
			timestamp: at(2),
			completedAt: at(3),
		}),
		msg("e0003", "e0002", 4, {
			role: "toolResult",
			toolCallId: "tc-saved-bash",
			toolName: "bash",
			content: [{ type: "text", text: "built" }],
			details: { wallTimeNoticeEmitted: false, timeoutSeconds: 300, wallTimeMs: 1500 },
			isError: false,
			timestamp: at(3) + 9000,
		}),
		msg("e0004", "e0003", 5, {
			role: "toolResult",
			toolCallId: "tc-saved-read",
			toolName: "read",
			content: [{ type: "text", text: "file" }],
			isError: false,
			timestamp: at(3) + 2750,
		}),
		msg("e0005", "e0004", 9, {
			role: "assistant",
			content: [{ type: "text", text: "Both calls are timed." }],
			provider: "anthropic",
			model: "claude-haiku-5-5",
			stopReason: "stop",
			timestamp: at(9),
		}),
	];
	writeFileSync(
		join(dir, `2026-01-07T10-00-00-000Z_${id}.jsonl`),
		`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
	);

	await page.goto("/");
	await page.getByRole("complementary").getByText("Saved timer probe").click();
	await expect(page.getByText("Both calls are timed.")).toBeVisible();
	// The turn folds its steps behind a summary when it is long enough to; open it if so.
	const summary = page.getByTestId("work-summary");
	if (await summary.count()) await summary.click();
	// bash: its own wall time, not the 9 s between the message and its result; read: the result's time less when the message ended.
	await expect(timerOf(page, "bash")).toHaveText("1.5s");
	await expect(timerOf(page, "read")).toHaveText("2.8s");
	// When each started (#691): another day's, so with its date; the call when the model finished writing it (10:00:03 UTC),
	// the replies when they began (the zone is the browser's, the minutes and seconds are not).
	const card = page.locator('[data-testid="tool-card"][data-tool="bash"]');
	await expect(card.getByTestId("start-time")).toHaveText(/^Jan 7 \d{2}:\d{2}:03$/);
	const replies = page.getByTestId("msg-assistant");
	await expect(replies.first().getByTestId("start-time").first()).toHaveText(/^Jan 7 \d{2}:\d{2}:02$/);
	await expect(replies.last().getByTestId("start-time").first()).toHaveText(/^Jan 7 \d{2}:\d{2}:09$/);

	// Shell commands only, chosen in Settings: the bash call keeps its length and the read loses its clock.
	await page.getByRole("complementary").getByText("Settings", { exact: true }).click();
	await page.locator('[data-testid="settings-page-tab"][data-page="chats"]').click();
	await page.getByTestId("tool-timer-mode").selectOption("shell");
	await page.getByRole("complementary").getByText("Saved timer probe").click();
	await expect(page.getByText("Both calls are timed.")).toBeVisible();
	if (await summary.count()) await summary.click();
	await expect(timerOf(page, "bash")).toHaveText("1.5s");
	await expect(timerOf(page, "read")).toHaveCount(0);

	// Leave the shared setting as it was found.
	await page.getByRole("complementary").getByText("Settings", { exact: true }).click();
	await page.locator('[data-testid="settings-page-tab"][data-page="chats"]').click();
	await page.getByTestId("tool-timer-mode").selectOption("all");
});

test("a !command shows how long it ran beside what it printed", async ({ page }) => {
	ownSession(0xe1, "Command timer probe");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	await startLive(page, tap, "Command timer probe", "command-timer-probe");
	const composer = page.getByTestId("composer");
	await composer.fill("!sleep 2 && echo slept-two");
	await composer.press("Enter");
	await expect(page.getByText("slept-two", { exact: true })).toBeVisible({ timeout: 15_000 });
	const slept = page.getByTestId("msg-exec").filter({ hasText: "slept-two" }).getByTestId("exec-time");
	await expect(slept).toHaveText(/^2\.\ds$/);
});
