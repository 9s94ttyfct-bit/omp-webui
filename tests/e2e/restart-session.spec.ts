import * as omp from "../support/omp-frames.ts";
import { show, startWorld, type World } from "../support/two-pages.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * `restart_session` as a page shows it (`shared/restart.ts`): the agent's call says above the message box that the process
 * is restarted when the turn ends; then the page follows to the new process, and the conversation shows where it was
 * restarted as a divider ("Restarted by the agent: …", with what the agent asked to do next behind it), on a reload too.
 * And the person's own Force restart (This session) ends the turn and the process, and the page follows. One server, the omp
 * a stand-in the test conducts (`tests/support/sync-omp.ts`).
 */

let world: World;
test.beforeAll(async () => {
	world = await startWorld();
});
test.afterAll(async () => {
	await world?.stop();
});

/** The conversation `title` runs a turn begun on `page`; returns its process. */
async function running(page: Page, file: string, title: string): Promise<string> {
	await show(page, title);
	await page.getByTestId("composer").fill(`Run ${title}`);
	await page.getByTestId("composer").press("Enter");
	return await world.turnOf(file);
}

/** The process that runs `file` once it is not `old`. */
async function successor(file: string, old: string): Promise<string> {
	await expect.poll(async () => (await world.liveOf(file)) !== old, { timeout: 30_000 }).toBe(true);
	return await world.liveOf(file);
}

test("the agent's restart: pending above the message box, then a divider where the conversation went on in a new process", async ({
	browser,
}) => {
	const title = "Restarted by its agent";
	const file = world.seed(61, title);
	const pages = await world.open(browser);
	try {
		const page = pages.local;
		const liveId = await running(page, file, title);
		await world.emit(
			liveId,
			omp.toolStart("r1", "restart_session", {
				reason: "bash calls hang",
				continue_with: "Check whether the build finished, then go on.",
			}),
			omp.toolEnd("r1", "restart_session", "Restart requested."),
		);
		await expect(page.getByTestId("restart-pending")).toContainText("bash calls hang");
		// The turn ends: the process is restarted, and the new one is sent what the agent asked for.
		await world.finish(liveId);
		const next = await successor(file, liveId);
		await expect(page.getByTestId("restart-pending")).toHaveCount(0);
		// The new process was sent what the agent asked for; the stand-in has written it to the conversation's file. A page
		// loaded anew shows it where it happened, as a divider and not as a bubble of the person's.
		await world.finish(next);
		await page.reload();
		const divider = page.getByTestId("restart-divider");
		await expect(divider).toHaveCount(1);
		await expect(divider).toHaveAttribute("data-kind", "restarted");
		await expect(divider.getByTestId("restart-divider-title")).toHaveText("Restarted by the agent: bash calls hang");
		await expect(divider.getByTestId("restart-divider-details")).toBeHidden();
		await divider.getByTestId("restart-divider-toggle").click();
		await expect(divider.getByTestId("restart-divider-details")).toContainText(
			"Check whether the build finished, then go on.",
		);
		await expect(page.getByTestId("msg-user").filter({ hasText: "Restarted by the agent" })).toHaveCount(0);
	} finally {
		await pages.close();
	}
});

test("Force restart in This session ends the turn and the process, and the page follows to the new one", async ({
	browser,
}) => {
	const title = "Force-restarted by the person";
	const file = world.seed(62, title);
	const pages = await world.open(browser);
	try {
		const page = pages.local;
		const liveId = await running(page, file, title);
		await page.getByTestId("session-controls").click();
		const restart = page.getByTestId("session-restart");
		await restart.getByTestId("session-restart-button").click();
		// It asks once before it cuts anything off; Cancel leaves everything as it was.
		await restart.getByTestId("session-restart-cancel").click();
		await expect(restart.getByTestId("session-restart-confirm")).toHaveCount(0);
		expect(await world.liveOf(file)).toBe(liveId);
		await restart.getByTestId("session-restart-button").click();
		await restart.getByTestId("session-restart-yes").click();
		const next = await successor(file, liveId);
		expect(next).not.toBe(liveId);
		// The turn that ran was aborted before the process was ended.
		expect(world.received().some((c) => c.type === "abort")).toBe(true);
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("restart-note")).toHaveAttribute("data-kind", "restarted");
		await expect(page.getByTestId("restart-note")).toContainText("Force-restarted");
		// Nothing was sent on the person's behalf: no divider, no message.
		await expect(page.getByTestId("restart-divider")).toHaveCount(0);
	} finally {
		await pages.close();
	}
});
