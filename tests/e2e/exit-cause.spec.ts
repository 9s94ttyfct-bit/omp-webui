import { ownSession, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * What a conversation says when its omp process is gone: who ended it, and what can be done about it. An omp that
 * ended on its own is a fault to look into (its signal or exit code is shown); one the server closed is the server's
 * doing, and is said so, so that a conversation that is simply not running any more is not read as a crash (#472).
 * Either way the conversation can be opened again.
 */

test("an omp the server ended says so, and offers to reopen the conversation", async ({ page }) => {
	const title = "Server-ended probe";
	ownSession(0xd1, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, "server-ended-probe");

	// The server closed the process (the idle reaper, a Close, a restart): the page is told so.
	tap.push({ t: "live_exit", liveId, code: 0, stderr: "", by: "server", reason: "idle" });
	const notice = page.getByTestId("exit-notice");
	await expect(notice).toBeVisible({ timeout: 15_000 });
	await expect(notice).toHaveAttribute("data-ended-by", "server");
	await expect(notice).toContainText("The web server ended this conversation's omp process");
	await expect(notice).toContainText("it was idle and nobody was looking at it");
	await expect(page.getByTestId("exit-reopen")).toBeVisible();
});

test("an omp that ended on its own says so, with its signal", async ({ page }) => {
	const title = "Self-ended probe";
	ownSession(0xd2, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, "self-ended-probe");

	tap.push({ t: "live_exit", liveId, code: null, signal: "SIGKILL", stderr: "" });
	const notice = page.getByTestId("exit-notice");
	await expect(notice).toBeVisible({ timeout: 15_000 });
	await expect(notice).toHaveAttribute("data-ended-by", "omp");
	await expect(notice).toContainText("The omp process ended on its own.");
	await expect(notice).toContainText("Killed by SIGKILL.");
	await expect(page.getByTestId("exit-reopen")).toBeVisible();
});

test("a Reopen that fails says so in a toast, and raises no unhandled rejection", async ({ page }) => {
	const title = "Failed reopen probe";
	ownSession(0xd3, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const errors: Error[] = [];
	page.on("pageerror", (e) => errors.push(e));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, "failed-reopen-probe");

	// The process ended, so the notice offers to reopen it.
	tap.push({ t: "live_exit", liveId, code: 0, stderr: "", by: "server", reason: "idle" });
	await expect(page.getByTestId("exit-notice")).toBeVisible({ timeout: 15_000 });

	// The reopen fails: the server refuses to start the process again.
	tap.rewrite((msg, request) => {
		if (msg.t !== "reply" || request?.t !== "open") return msg;
		return { t: "reply", req: msg.req, ok: false, error: "the model is not available" };
	});
	await page.getByTestId("exit-reopen").click();

	// The failure is told where it can be read.
	await expect(page.getByTestId("toast").filter({ hasText: "the model is not available" })).toBeVisible({
		timeout: 15_000,
	});
	// And it is not raised again: a rejected promise the page does not handle is an unhandled rejection, which the
	// soak harness and the bench count as a page error (#516).
	expect(errors).toEqual([]);
});
