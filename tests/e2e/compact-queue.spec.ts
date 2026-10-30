import { SIDES, show, startWorld, type World } from "../support/two-pages.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Compact while the agent works (#651), on two pages of one conversation: the button asks for the compact at the end of
 * the turn, the server holds it (so the other page, and a reload, show it), a follow-up sent meanwhile waits behind it, Cancel
 * takes it back, and when the turn ends omp is told `compact` before it gets the follow-up. The omp is a stand-in the test
 * conducts (`sync-omp.ts`); no model.
 */

let world: World;
test.beforeAll(async () => {
	world = await startWorld();
});
test.afterAll(async () => {
	await world?.stop();
});

const compactButton = (page: Page) => page.getByTestId("session-controls-panel").getByTestId("compact-now");

async function openControls(page: Page): Promise<void> {
	await page.getByTestId("session-controls").click();
	await expect(page.getByTestId("session-controls-panel")).toBeVisible();
}

/** What omp was sent that matters for the order, in order. */
const order = () =>
	world
		.received()
		.filter((c) => ["prompt", "compact", "remove_queued_message"].includes(c.type))
		.map((c) => (c.type === "prompt" ? `prompt:${String(c.message)}` : c.type));

test("the button queues the compact while a turn runs, the line and the other page show it, and the follow-up goes after the compact", async ({
	browser,
}) => {
	const title = "Compact queue order";
	const file = world.seed(0x91, title);
	const pages = await world.open(browser);
	try {
		await show(pages.local, title);
		await show(pages.remote, title);
		const composer = pages.local.getByTestId("composer");
		await composer.fill("Begin the work");
		await composer.press("Enter");
		const liveId = await world.turnOf(file);

		// While the turn runs the button asks for the end of the turn, not "now", and is enabled.
		await openControls(pages.local);
		await expect(compactButton(pages.local)).toBeEnabled();
		await expect(compactButton(pages.local)).toHaveAttribute("data-state", "queue");
		await expect(compactButton(pages.local)).toContainText("Compact after this turn");
		await pages.local.getByLabel("Compaction instructions").fill("keep the names");
		await compactButton(pages.local).click();

		// Queued: the button, the line above the message box and the other page all say so; nothing was sent to omp yet.
		await expect(compactButton(pages.local)).toHaveAttribute("data-state", "queued");
		await expect(compactButton(pages.local)).toContainText("Compact queued");
		await expect(compactButton(pages.local)).toBeDisabled();
		await expect(pages.local.getByTestId("compact-queued-note")).toContainText("keep the names");
		for (const side of SIDES) {
			await expect(pages[side].getByTestId("compact-queued-line")).toHaveAttribute("data-phase", "queued");
		}
		expect(order()).not.toContain("compact");

		// A follow-up sent while it waits is held behind it, and shown as queued on both pages.
		await composer.fill("after the compact");
		await composer.press("Enter");
		for (const side of SIDES) await expect(pages[side].getByTestId("queue-chip")).toContainText("after the compact");
		await expect(pages.local.getByTestId("compact-queued-line")).toContainText("1 message waits behind it");
		expect(order()).not.toContain("prompt:after the compact");

		// A reload keeps it: the server holds it.
		await pages.remote.reload();
		await show(pages.remote, title);
		await expect(pages.remote.getByTestId("compact-queued-line")).toHaveAttribute("data-phase", "queued");

		// The turn ends: omp is told to compact, and only then gets the follow-up.
		await world.finish(liveId);
		await expect.poll(() => order()).toContain("prompt:after the compact");
		const sent = order();
		expect(sent.indexOf("compact")).toBeGreaterThan(-1);
		expect(sent.indexOf("compact")).toBeLessThan(sent.indexOf("prompt:after the compact"));
		expect(world.received().find((c) => c.type === "compact")).toMatchObject({ customInstructions: "keep the names" });
		for (const side of SIDES) await expect(pages[side].getByTestId("compact-queued-line")).toHaveCount(0);
	} finally {
		await pages.close();
	}
});

test("Cancel takes the queued compact back from the line and from the button, and the turn ends without a compact", async ({
	browser,
}) => {
	const title = "Compact queue cancel";
	const file = world.seed(0x92, title);
	const pages = await world.open(browser);
	try {
		await show(pages.local, title);
		await pages.local.getByTestId("composer").fill("Begin");
		await pages.local.getByTestId("composer").press("Enter");
		const liveId = await world.turnOf(file);

		await openControls(pages.local);
		await compactButton(pages.local).click();
		await expect(pages.local.getByTestId("compact-queued-line")).toBeVisible();

		// From the line above the message box.
		await pages.local.getByTestId("compact-queued-cancel").click();
		await expect(pages.local.getByTestId("compact-queued-line")).toHaveCount(0);
		// Clicking outside closed the panel: open it again.
		await openControls(pages.local);
		await expect(compactButton(pages.local)).toHaveAttribute("data-state", "queue");

		// And from the button's own Cancel.
		await compactButton(pages.local).click();
		await expect(pages.local.getByTestId("compact-cancel")).toBeVisible();
		await pages.local.getByTestId("compact-cancel").click();
		await expect(pages.local.getByTestId("compact-queued-line")).toHaveCount(0);

		await world.finish(liveId);
		// When the turn is over the button is "now" again, and nothing was compacted.
		await expect(compactButton(pages.local)).toHaveAttribute("data-state", "idle");
		expect(world.received().filter((c) => c.type === "compact")).toHaveLength(0);
	} finally {
		await pages.close();
	}
});

test("the place the compact runs is chosen in This session, starts from Settings, and a conversation that cannot be held between steps says so", async ({
	browser,
}) => {
	const title = "Compact queue where";
	const file = world.seed(0x93, title);
	const pages = await world.open(browser);
	try {
		// Settings has the preference (the default: when the turn ends), and it is remembered.
		// In the app (a navigation by URL would lose the token this page was opened with).
		await pages.local.evaluate(() => {
			location.hash = "#/settings/chats";
		});
		const pref = pages.local.getByTestId("compact-where");
		await expect(pref).toHaveValue("turn");
		await pref.selectOption("step");
		await expect.poll(() => pages.local.evaluate(() => localStorage.getItem("ompw.compactWhere"))).toBe("step");

		await show(pages.local, title);
		await show(pages.remote, title);
		await pages.local.getByTestId("composer").fill("Begin");
		await pages.local.getByTestId("composer").press("Enter");
		const liveId = await world.turnOf(file);

		// While a turn runs This session has the choice, and it starts from the preference.
		await openControls(pages.local);
		const choice = pages.local.getByTestId("compact-where-choice");
		await expect(choice).toHaveValue("step");
		await expect(compactButton(pages.local)).toContainText("Compact between steps");
		await choice.selectOption("turn");
		await expect(compactButton(pages.local)).toContainText("Compact after this turn");
		await choice.selectOption("step");

		// The stand-in omp does not run the app's extension, so a compact between steps is for the end of the turn, and says so.
		await compactButton(pages.local).click();
		await expect(compactButton(pages.local)).toHaveAttribute("data-state", "queued");
		await expect(pages.local.getByTestId("compact-queued-note")).toHaveAttribute("data-where", "turn");
		await expect(
			pages.local.getByTestId("compact-queued-note").getByTestId("compact-step-unavailable"),
		).toHaveAttribute("data-reason", "notLoaded");
		for (const side of SIDES) {
			await expect(pages[side].getByTestId("compact-queued-line")).toHaveAttribute("data-where", "turn");
			await expect(
				pages[side].getByTestId("compact-queued-line").getByTestId("compact-step-unavailable"),
			).toBeVisible();
		}
		// The choice was for that compact: the next one starts from the preference again.
		expect(order()).not.toContain("compact");

		await world.finish(liveId);
		await expect.poll(() => order()).toContain("compact");
		await pages.local.evaluate(() => localStorage.removeItem("ompw.compactWhere"));
	} finally {
		await pages.close();
	}
});
