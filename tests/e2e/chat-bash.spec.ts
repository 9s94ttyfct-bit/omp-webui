import { ownSession, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * A `!command` always runs as a command, however busy omp is, and every command that is running shows as a card
 * with its own Stop. The socket is tapped to see what the page sends; no model call is made.
 */

test("a !command sent while another one runs is a second bash command and never a prompt", async ({ page }) => {
	ownSession(0xd0, "Bash routing probe");
	// Auto-titling would send a prompt of its own when a turn ends.
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	await startLive(page, tap, "Bash routing probe", "bash-routing-probe");
	const bashBefore = tap.commands("bash").length;
	const composer = page.getByTestId("composer");

	await composer.fill("!sleep 4 && echo first-routing-done");
	await composer.press("Enter");
	// The command is on screen within a second of sending, with its age, a spinner and a Stop.
	const cards = page.getByTestId("pending-command");
	await expect(cards).toHaveCount(1, { timeout: 1000 });
	await expect(cards.first()).toContainText("sleep 4 && echo first-routing-done");
	await expect(cards.first()).toContainText(/\d+(\.\d)?(ms|s)/);
	await expect(cards.first().locator(".animate-spin")).toBeVisible();
	await expect(cards.first().getByTestId("pending-stop")).toBeVisible();

	// The composer is in its "queue a follow-up" state now; a !command is still not a follow-up.
	await composer.fill("!echo second-routing-done");
	await composer.press("Enter");
	await expect(page.getByText("second-routing-done", { exact: true })).toBeVisible({ timeout: 5000 });
	// The first one is still going while the second has finished and left the list.
	await expect(cards).toHaveCount(1);

	expect(
		tap
			.commands("bash")
			.map((c) => c.command)
			.slice(bashBefore),
	).toEqual(["sleep 4 && echo first-routing-done", "echo second-routing-done"]);
	expect(tap.commands("prompt")).toHaveLength(0);
	expect(tap.commands("steer")).toHaveLength(0);

	await expect(page.getByText("first-routing-done", { exact: true })).toBeVisible({ timeout: 15_000 });
	await expect(cards).toHaveCount(0);
});

test("two commands running at once are two cards, and Stop on either cancels them both", async ({ page }) => {
	ownSession(0xd1, "Bash stop-all probe");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	await startLive(page, tap, "Bash stop-all probe", "bash-stop-all-probe");
	const composer = page.getByTestId("composer");
	const cards = page.getByTestId("pending-command");

	await composer.fill("!sleep 30 && echo never-printed-one");
	await composer.press("Enter");
	await expect(cards).toHaveCount(1);
	await composer.fill("!sleep 30 && echo never-printed-two");
	await composer.press("Enter");
	await expect(cards).toHaveCount(2);
	await expect(cards.nth(0)).toContainText("never-printed-one");
	await expect(cards.nth(1)).toContainText("never-printed-two");

	// omp has one abort for all running commands, and the button says so.
	await expect(cards.nth(1).getByTestId("pending-stop")).toHaveText("Stop all");
	await cards.nth(1).getByTestId("pending-stop").click();
	await expect(cards).toHaveCount(0, { timeout: 15_000 });
	expect(tap.commands("abort_bash")).toHaveLength(1);
	await expect(page.getByTestId("stop")).toHaveCount(0);
	await page.waitForTimeout(1000);
	await expect(page.getByText(/^never-printed-(one|two)$/)).toHaveCount(0);
});
