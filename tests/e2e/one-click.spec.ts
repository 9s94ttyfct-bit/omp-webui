import { execFileSync } from "node:child_process";
import { ownSession, sessionRow, startLive } from "../support/live.ts";
import { panelTab } from "../support/panel.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * Every control of a conversation works with one click, whatever state it is in: with no omp running (it is started
 * by the click) and while it is paused (the click runs omp just long enough, and the conversation stays paused).
 * No model call is made.
 */

test("with no omp running, the controls are there, and a click on one starts omp and does what it says", async ({
	page,
}) => {
	const title = "One click, no omp";
	ownSession(0xf1, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	await expect(sessionRow(page, title)).toHaveCount(1, { timeout: 15_000 });
	await sessionRow(page, title).click();

	for (const id of ["preset-picker", "model-picker", "thinking-picker", "approval-picker", "session-controls"])
		await expect(page.getByTestId(id), id).toBeVisible({ timeout: 15_000 });
	await expect(page.getByRole("button", { name: "Rename" })).toBeVisible();
	await expect(page.getByTestId("resume-session")).toHaveCount(0);
	const opens = () => tap.sent.filter((m) => m.t === "open" && m.target?.kind === "resume");
	expect(opens()).toHaveLength(0);

	// The session settings are omp's own: one click starts it, and the panel opens once it runs.
	await page.getByTestId("session-controls").click();
	await expect(page.getByTestId("session-controls-panel")).toBeVisible({ timeout: 60_000 });
	expect(opens()).toHaveLength(1);
	await page.keyboard.press("Escape");

	// The Ask tab has its field without a resume first.
	await page.getByTestId("toggle-panel").click();
	await panelTab(page, /Ask/).click();
	await expect(page.getByTestId("btw-input")).toBeVisible();
});

test("a paused conversation takes every action with one click, and stays paused", async ({ page }) => {
	const title = "One click, paused";
	ownSession(0xf2, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, "one-click-paused-up");
	await page.getByTestId("composer").fill("!/bin/sleep 60");
	await page.getByTestId("composer").press("Enter");
	await expect(page.getByTestId("pending-command")).toHaveCount(1);
	await page.getByTestId("pause").click();
	await expect(page.getByTestId("paused-banner")).toBeVisible();

	const toasts = page.getByTestId("toast");

	// The model list opens (omp is asked for it), and so does a change of level.
	await page.getByTestId("model-picker").click();
	await expect(page.getByPlaceholder("Search models…")).toBeVisible();
	await expect(page.locator("[cmdk-item]").first()).toBeVisible({ timeout: 30_000 });
	await page.keyboard.press("Escape");
	const select = page.getByTestId("thinking-picker");
	const levels = await select.locator("option").evaluateAll((els) => els.map((e) => (e as HTMLOptionElement).value));
	await select.selectOption(levels.find((v) => v !== (levels[0] ?? "")) ?? "off");

	// A session setting.
	await page.getByTestId("session-controls").click();
	await page.getByTestId("fast-mode").getByText("On", { exact: true }).click();
	await expect.poll(() => tap.commands("set_fast_mode").length).toBe(1);
	await page.keyboard.press("Escape");

	// Rename.
	await page.getByRole("button", { name: "Rename" }).click();
	await page.getByRole("dialog").getByRole("textbox").fill("Renamed while paused");
	await page.getByRole("button", { name: "Save" }).click();
	await expect.poll(() => tap.commands("set_session_name").length).toBe(1);

	// Nothing was refused, the conversation is still paused, and its whole process tree is stopped.
	await expect(toasts).toHaveCount(0);
	await expect(page.getByTestId("paused-banner")).toBeVisible();
	const pid = ((await (await page.request.get("/api/lives")).json()) as { liveId: string; pid: number }[]).find(
		(l) => l.liveId === liveId,
	)?.pid;
	expect(pid).toBeGreaterThan(0);
	// Each action runs omp for a moment, then stops it again: poll until the last one is over.
	const stopped = () => {
		const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,stat="])
			.toString()
			.trim()
			.split("\n")
			.map((l) => l.trim().split(/\s+/));
		const under = new Set([String(pid)]);
		for (let grew = true; grew; ) {
			grew = false;
			for (const [p, pp] of rows) if (under.has(pp) && !under.has(p)) grew = under.add(p).size > 0;
		}
		return rows.filter(([p]) => under.has(p)).every(([, , stat]) => stat.startsWith("T"));
	};
	await expect.poll(stopped, { timeout: 10_000 }).toBe(true);
	expect(tap.sent.filter((m) => m.t === "resume")).toHaveLength(0);
});
