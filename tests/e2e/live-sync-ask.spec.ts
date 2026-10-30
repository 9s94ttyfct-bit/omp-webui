import { sessionRow } from "../support/live.ts";
import * as omp from "../support/omp-frames.ts";
import { other, SIDES, type Side, show, startWorld, type World } from "../support/two-pages.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Two pages on one conversation (see live-sync.spec.ts): what omp waits on is on both, and answered on one is gone
 * from both; a message sent from either page while a turn runs is queued or steers exactly as one sent from the page
 * that started the turn, is in both pages' queues, and never stops the turn.
 */

let world: World;
test.beforeAll(async () => {
	world = await startWorld();
});
test.afterAll(async () => {
	await world?.stop();
});

const request = (page: Page) => page.getByTestId("ui-request");
const queued = (page: Page) => page.getByTestId("queue-chip");

/** Both pages show the conversation; `starter` sends the message that begins a turn, which omp has taken up when this returns. */
async function running(world: World, browser: Parameters<World["open"]>[0], n: number, title: string, starter: Side) {
	const file = world.seed(n, title);
	const pages = await world.open(browser);
	await show(pages.local, title);
	await show(pages.remote, title);
	await pages[starter].getByTestId("composer").fill(`Begin ${title}`);
	await pages[starter].getByTestId("composer").press("Enter");
	const liveId = await world.turnOf(file);
	for (const side of SIDES) await expect(pages[side].getByText(`Begin ${title}`)).toBeVisible();
	return { pages, liveId };
}

for (const acting of SIDES) {
	const watching: Side = other(acting);

	test(`an approval is on both pages, and answered on the ${acting} page it is gone from the ${watching} page too`, async ({
		browser,
	}) => {
		const title = `Approval answered on ${acting}`;
		const { pages, liveId } = await running(world, browser, acting === "local" ? 21 : 22, title, watching);
		try {
			await world.emit(liveId, omp.approval("a1", "bash", "echo hi"));
			for (const side of SIDES) {
				await expect(request(pages[side])).toBeVisible();
				await expect(request(pages[side])).toContainText("Allow tool: bash");
				await expect(sessionRow(pages[side], title).getByRole("img", { name: "Needs your input" })).toBeVisible();
			}
			await request(pages[acting])
				.getByRole("button", { name: /Allow once/ })
				.click();
			for (const side of SIDES) {
				await expect(request(pages[side])).toHaveCount(0);
				await expect(sessionRow(pages[side], title).getByRole("img", { name: "Running" })).toBeVisible();
			}
			expect(world.received().filter((c) => c.type === "extension_ui_response")).toHaveLength(1);
		} finally {
			await pages.close();
		}
	});

	test(`a message sent from the ${watching} page while the ${acting} page's turn streams is queued as a local one is, in both queues, and the turn goes on`, async ({
		browser,
	}) => {
		const title = `Queued from ${watching}`;
		const { pages, liveId } = await running(world, browser, acting === "local" ? 23 : 24, title, acting);
		try {
			await world.emit(liveId, omp.messageStart("m1"), ...omp.block("m1", "text", 0, ["Half an answer"]));
			for (const side of SIDES) await expect(pages[side].getByText("Half an answer")).toBeVisible();
			await pages[watching].getByTestId("composer").fill(`Then this from ${watching}`);
			await pages[watching].getByTestId("composer").press("Enter");
			for (const side of SIDES) await expect(queued(pages[side])).toContainText(`Then this from ${watching}`);
			const sent = world.received().findLast((c) => c.type === "prompt" && c.message === `Then this from ${watching}`);
			expect(sent?.streamingBehavior).toBe("followUp");
			expect(world.received().some((c) => c.type === "abort" || c.type === "abort_and_restore_queue")).toBe(false);
			// The turn was not touched, and when it ends the queued message is the next turn, on both pages.
			for (const side of SIDES) await expect(pages[side].getByTestId("stop")).toBeVisible();
			await world.emit(liveId, omp.messageEnd("m1", [{ type: "text", text: "Half an answer" }]));
			await world.finish(liveId);
			for (const side of SIDES) {
				await expect(queued(pages[side])).toHaveCount(0);
				await expect(pages[side].getByText(`Then this from ${watching}`)).toBeVisible();
				await expect(pages[side].getByTestId("stop")).toBeVisible();
			}
		} finally {
			await pages.close();
		}
	});

	test(`a steer sent from the ${watching} page while the ${acting} page's turn streams steers it, is in both queues, and the turn goes on`, async ({
		browser,
	}) => {
		const title = `Steered from ${watching}`;
		const { pages, liveId } = await running(world, browser, acting === "local" ? 25 : 26, title, acting);
		try {
			await world.emit(liveId, omp.messageStart("m1"), ...omp.block("m1", "text", 0, ["Half an answer"]));
			for (const side of SIDES) await expect(pages[side].getByText("Half an answer")).toBeVisible();
			await pages[watching].getByTestId("composer").fill(`Turn left from ${watching}`);
			await pages[watching].getByTestId("composer").press("ControlOrMeta+Enter");
			for (const side of SIDES) {
				await expect(queued(pages[side])).toContainText(`Turn left from ${watching}`);
				await expect(queued(pages[side])).toHaveAttribute("data-kind", "steering");
			}
			expect(world.received().some((c) => c.type === "steer" && c.message === `Turn left from ${watching}`)).toBe(true);
			expect(world.received().some((c) => c.type === "abort" || c.type === "abort_and_restore_queue")).toBe(false);
			for (const side of SIDES) await expect(pages[side].getByTestId("stop")).toBeVisible();
		} finally {
			await pages.close();
		}
	});
}
