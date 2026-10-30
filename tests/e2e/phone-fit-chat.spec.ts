import { openSidebar, startLive } from "../support/live.ts";
import { Chain, writeRenderSession } from "../support/render-fixtures.ts";
import { rpcState } from "../support/rpc-state.ts";
import { type Msg, tapSocket } from "../support/socket-tap.ts";
import { boxOf } from "../support/style.ts";
import { sessionWithSubagents } from "../support/subagent-fixtures.ts";
import { devices, expect, type Locator, test } from "./fixtures.ts";

/**
 * A conversation's bars and New chat's options fit a phone (390 px): the goal bar keeps room for the objective beside a
 * long status, the goal dialog's buttons keep their labels inside them, the paused banner gives its text the width
 * and puts its buttons under it, and the session options' value fields stay inside their card. No model call.
 */

const { defaultBrowserType: _browser, ...pixel } = devices["Pixel 5"];
test.use({ ...pixel, viewport: { width: 390, height: 844 } });

/** Whether the box's own content spills out of it (a label wrapped past a fixed height, or wider than the box). */
const spills = (el: Locator) =>
	el.evaluate((n) => n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1);

test("the goal bar keeps room for the objective beside a long status", async ({ page }) => {
	const title = "Phone goal bar probe";
	sessionWithSubagents(0x32, title, {});
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	await openSidebar(page);
	const liveId = await startLive(page, tap, title, "phone-goal-1");
	const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f } as Msg);
	tap.answer("get_state", () => ({ ok: true, data: rpcState() }));
	frame({ type: "agent_start" });
	frame({
		type: "goal_updated",
		goal: { id: "g", objective: "Ship the release notes", status: "paused", tokenBudget: 50_000, tokensUsed: 900 },
	});
	await expect(page.getByTestId("goal-state")).toHaveText("Pausing · finishing the current step");
	// Before: the status kept its whole width and left the objective two letters ("Sh…").
	expect((await boxOf(page.getByTestId("goal-toggle"))).width).toBeGreaterThan(72);
});

test("the goal dialog's buttons keep their labels inside them", async ({ page }) => {
	const c = new Chain("pg");
	c.user("Phone goal dialog probe");
	c.assistant([{ type: "text", text: "Done." }]);
	const file = writeRenderSession(
		process.env.OMPW_E2E_AGENT_DIR as string,
		"01a00000-0000-7000-8000-0000000060c4",
		c.entries,
	);
	await page.goto(`/#/s/${encodeURIComponent(file)}`);
	// On a phone the goal is in the header's More menu.
	await page.getByTestId("chat-more").click();
	await page.getByTestId("chat-more-panel").getByTestId("open-goal").click();
	const dialog = page.getByRole("dialog");
	const start = dialog.getByTestId("goal-guided-start");
	await expect(start).toBeVisible();
	expect(await spills(start)).toBe(false);
	const box = await boxOf(dialog);
	for (const b of [start, dialog.getByRole("button", { name: "Cancel" })]) {
		const r = await boxOf(b);
		expect(r.x + r.width).toBeLessThanOrEqual(box.x + box.width);
	}
	await dialog.getByTestId("goal-direct-toggle").click();
	expect(await spills(dialog.getByTestId("goal-create"))).toBe(false);
});

test("the paused banner gives its text the width and puts its buttons under it", async ({ page }) => {
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	const composer = page.getByTestId("composer");
	await composer.fill("!/bin/sleep 4 && echo phone-paused-$((1+1))");
	await composer.press("Enter");
	await page.getByTestId("pause").click();
	const banner = page.getByTestId("paused-banner");
	await expect(banner).toBeVisible();
	const text = banner.locator("> div").first();
	// Before: a column of about 110 px beside the buttons, the hint ten lines long.
	expect((await boxOf(text)).width).toBeGreaterThan(220);
	const resume = banner.getByTestId("paused-resume");
	const t = await boxOf(text);
	expect((await boxOf(resume)).y).toBeGreaterThanOrEqual(t.y + t.height - 1);
	await resume.click();
	await expect(page.getByText("phone-paused-2")).toBeVisible({ timeout: 15_000 });
});

test("the session options' value fields stay inside their card", async ({ page }) => {
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	await page.getByRole("button", { name: /^Options/ }).click();
	const form = page.getByTestId("flag-form");
	await expect(form).toBeVisible();
	const card = await boxOf(form);
	const fields = form.locator("input[data-flag]:not([type=checkbox])");
	await expect(fields.first()).toBeVisible();
	for (const field of await fields.all()) {
		if (!(await field.isVisible())) continue;
		const r = await boxOf(field);
		expect(r.x + r.width, (await field.getAttribute("data-flag")) ?? "").toBeLessThanOrEqual(card.x + card.width);
	}
});

test("the arrow to the end is a strip under the transcript on a phone, over none of its text", async ({ page }) => {
	const c = new Chain("pa");
	c.user("Phone arrow probe");
	c.assistant([
		{ type: "text", text: Array.from({ length: 80 }, (_, i) => `Line ${i + 1} of a long answer.`).join("\n\n") },
	]);
	const file = writeRenderSession(
		process.env.OMPW_E2E_AGENT_DIR as string,
		"01a00000-0000-7000-8000-0000000073a1",
		c.entries,
	);
	await page.goto(`/#/s/${encodeURIComponent(file)}`);
	const transcript = page.getByTestId("transcript");
	await expect(transcript).toBeVisible();
	await expect(page.getByText("Line 80 of a long answer.")).toBeVisible();
	await transcript.evaluate((el) => {
		el.scrollTop = 0;
	});
	const arrow = page.getByRole("button", { name: "Scroll to bottom" });
	await expect(arrow).toBeVisible();
	// Before: a round button floating over the last lines of what was on screen.
	const list = await boxOf(transcript);
	const button = await boxOf(arrow);
	expect(button.y).toBeGreaterThanOrEqual(list.y + list.height - 1);
	await arrow.click();
	await expect(arrow).toHaveCount(0);
});
