import { ownSession, startLive } from "../support/live.ts";
import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * A paused conversation says what is frozen, can be stopped from its banner, hands focus to the right control
 * and does not resume behind the user's back. Pause is a signal to the omp process; no model call is made.
 */

async function pausedWith(page: Page, command: string, n: number, title: string): Promise<SocketTap> {
	ownSession(n, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	await startLive(page, tap, title, `${title.toLowerCase().replaceAll(" ", "-")}-up`);
	await page.getByTestId("composer").fill(command);
	await page.getByTestId("composer").press("Enter");
	await expect(page.getByTestId("pending-command")).toHaveCount(1);
	await page.getByTestId("pause").click();
	await expect(page.getByTestId("paused-banner")).toBeVisible();
	return tap;
}

/** The kinds of the messages the page sent that matter here, in order. */
const sentKinds = (tap: SocketTap) =>
	tap.sent
		.map((m) => (m.t === "rpc" ? m.command?.type : m.t))
		.filter((k) => k === "pause" || k === "resume" || k === "abort_bash" || k === "prompt" || k === "bash");

test("Stop in the paused banner resumes and cancels the command; its output never prints", async ({ page }) => {
	const tap = await pausedWith(page, "!sleep 30 && echo never-printed-by-stop", 0xd2, "Paused stop probe");
	const banner = page.getByTestId("paused-banner");
	const card = page.getByTestId("pending-command");

	// The banner names what is frozen, the card says it is paused, and focus is on the way out.
	await expect(banner).toContainText("sleep 30 && echo never-printed-by-stop");
	await expect(card).toContainText("Paused");
	await expect(page.getByTestId("paused-resume")).toBeFocused();
	await expect(page.getByTestId("stop")).toHaveCount(0);

	await page.getByTestId("paused-stop").click();
	await expect(banner).toHaveCount(0);
	await expect(card).toHaveCount(0, { timeout: 15_000 });
	await expect(page.getByTestId("composer")).toBeFocused();
	expect(sentKinds(tap).slice(-3)).toEqual(["pause", "resume", "abort_bash"]);
	await page.waitForTimeout(1500);
	await expect(page.getByText("never-printed-by-stop", { exact: true })).toHaveCount(0);
});

test("Esc on the banner asks first; a second Esc stops", async ({ page }) => {
	const tap = await pausedWith(page, "!sleep 30 && echo never-printed-by-esc", 0xd3, "Paused esc probe");
	await expect(page.getByTestId("paused-resume")).toBeFocused();
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("stop-confirm")).toBeVisible();
	await expect(page.getByTestId("paused-banner")).toBeVisible();
	await page.waitForTimeout(300);
	expect(tap.commands("abort_bash")).toHaveLength(0);
	await page.keyboard.press("Escape");
	await expect(page.getByTestId("paused-banner")).toHaveCount(0);
	await expect(page.getByTestId("pending-command")).toHaveCount(0, { timeout: 15_000 });
	expect(tap.commands("abort_bash")).toHaveLength(1);
});

test("Resume gives focus back to the composer and lets the command carry on", async ({ page }) => {
	const tap = await pausedWith(page, "!sleep 3 && echo carried-on-after-resume", 0xd4, "Paused resume probe");
	const composer = page.getByTestId("composer");
	await page.getByTestId("paused-banner").getByRole("button", { name: "Resume" }).click();
	await expect(page.getByTestId("paused-banner")).toHaveCount(0);
	await expect(composer).toBeFocused();
	await expect(page.getByText("carried-on-after-resume", { exact: true })).toBeVisible({ timeout: 15_000 });
	expect(tap.commands("abort_bash")).toHaveLength(0);
});

test("the paused composer explains itself, and sending is an explicit Resume & send", async ({ page }) => {
	const tap = await pausedWith(page, "!sleep 3 && echo held-command-done", 0xd5, "Paused send probe");
	const composer = page.getByTestId("composer");
	await expect(composer).toHaveAttribute("placeholder", /Paused.*resume/i);
	await expect(page.getByTestId("send")).toHaveCount(0);

	await composer.fill("!echo sent-while-paused");
	await expect(page.getByTestId("send")).toHaveText("Resume & send");
	await composer.press("Enter");
	await expect(page.getByTestId("paused-banner")).toHaveCount(0);
	await expect(page.getByText("sent-while-paused", { exact: true })).toBeVisible({ timeout: 10_000 });
	// The command that was frozen carried on, and nothing went to the model.
	await expect(page.getByText("held-command-done", { exact: true })).toBeVisible({ timeout: 15_000 });
	// In order: the probe, the frozen command, the pause; then Resume & send resumed first and ran the new command.
	expect(sentKinds(tap)).toEqual(["bash", "bash", "pause", "resume", "bash"]);
});
