import * as omp from "../support/omp-frames.ts";
import { runningTurn, SIDES, startWorld, type World } from "../support/two-pages.ts";
import { expect, test } from "./fixtures.ts";

/**
 * Stop that omp does not take (#642): what the page says while it waits, what it says when the server has ended omp's
 * process, and that the conversation is kept and the next message works. The omp is the fake of the live-sync specs, which
 * is told to stop answering abort commands (`world.deaf`): the same silence as a process that hangs. No model call. The server
 * and the real omp are in tests/contract/stop-bounded.test.ts.
 */

let world: World;
test.beforeAll(async () => {
	world = await startWorld();
});
test.afterAll(async () => {
	await world?.stop();
});

let n = 300;
const next = () => n++;

test("Stop on an omp that does not answer: the page says it is stopping, then that the process was ended and why; the conversation is kept and the next message reopens it", async ({
	browser,
}) => {
	const title = "Deaf omp";
	const { pages, liveId, file } = await runningTurn(world, browser, next(), title, "local");
	try {
		await world.deaf(liveId);
		const stop = pages.local.getByTestId("stop");
		await stop.click();
		await expect(stop).toHaveAttribute("data-stopping", "");
		await expect(pages.local.getByTestId("stopping")).toBeVisible();

		// Pressed again while it runs, here and on the other page: the same press, nothing more goes to omp.
		await stop.click();
		await pages.remote.getByTestId("stop").click();

		// After a moment the page says that omp has not stopped yet, and what happens if it does not.
		await expect(pages.local.getByTestId("stopping")).toContainText("5 seconds");

		// The server ends omp, and the page that holds the process says who did and why, and that nothing was lost. A page that
		// only shows the conversation by its file (the other page here) is told no process, as for any omp that ends: it is
		// no longer shown as running.
		const notice = pages.local.getByTestId("exit-notice");
		await expect(notice).toHaveAttribute("data-ended-by", "server", { timeout: 30_000 });
		await expect(notice).toContainText("you pressed Stop");
		await expect(notice.getByTestId("exit-kept")).toBeVisible();
		await expect(pages.remote.getByTestId("stop")).toHaveCount(0);
		await expect(pages.remote.getByTestId("stopping")).toHaveCount(0);
		await expect(pages.local.getByTestId("stopping")).toHaveCount(0);
		await expect(pages.local.getByTestId("stop")).toHaveCount(0);
		expect(world.received().filter((c) => c.type === "abort_and_restore_queue")).toHaveLength(1);

		// What was said is still there, and the next message starts omp again on the same file.
		await expect(pages.local.getByText(`Begin ${title}`)).toBeVisible();
		await pages.local.getByTestId("composer").fill("After the stop");
		await pages.local.getByTestId("composer").press("Enter");
		const again = await world.turnOf(file);
		expect(again).not.toBe(liveId);
		await expect(pages.local.getByTestId("exit-notice")).toHaveCount(0);
		await expect(pages.local.getByText("After the stop")).toBeVisible();
		await expect(pages.local.getByText(`Begin ${title}`)).toBeVisible();
	} finally {
		await pages.close();
	}
});

test("what was queued behind a turn that had to be ended is back in the message box", async ({ browser }) => {
	const title = "Deaf omp with a queue";
	const { pages, liveId } = await runningTurn(world, browser, next(), title, "local");
	try {
		await pages.local.getByTestId("composer").fill("Queued behind");
		await pages.local.getByTestId("composer").press("Enter");
		await expect(pages.local.getByTestId("queue-chip")).toContainText("Queued behind");
		await world.deaf(liveId);
		await pages.local.getByTestId("stop").click();
		await expect(pages.local.getByTestId("exit-notice")).toContainText("you pressed Stop", { timeout: 30_000 });
		await expect(pages.local.getByTestId("composer")).toHaveValue(/Queued behind/);
	} finally {
		await pages.close();
	}
});

test("a subagent that works keeps the conversation busy after its turn is over: Stop is offered for it and cancels it", async ({
	browser,
}) => {
	const title = "Busy with a subagent";
	const { pages, liveId } = await runningTurn(world, browser, next(), title, "local");
	try {
		await world.state(liveId, { subagents: [{ id: "Scout", status: "running" }] });
		await world.finish(liveId);
		for (const side of SIDES) await expect(pages[side].getByTestId("stop")).toHaveCount(0);

		await world.emit(liveId, omp.subagentStarted("Scout", "call-1", 0, "look around"));
		for (const side of SIDES) await expect(pages[side].getByTestId("stop")).toBeVisible();

		await pages.local.getByTestId("stop").click();
		await expect
			.poll(() => world.received().flatMap((c) => (c.type === "cancel_subagent" ? [c.subagentId] : [])))
			.toEqual(["Scout"]);

		// It ends as omp says it does, and Stop goes with it.
		await world.state(liveId, { subagents: [] });
		await world.emit(liveId, omp.subagentEnded("Scout"));
		for (const side of SIDES) await expect(pages[side].getByTestId("stop")).toHaveCount(0);
	} finally {
		await pages.close();
	}
});
