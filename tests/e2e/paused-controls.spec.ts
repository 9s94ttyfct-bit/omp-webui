import { unfoldAdvanced } from "../support/controls.ts";
import { other, SIDES, type Side, show, startWorld, type World } from "../support/two-pages.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The session panel of a paused conversation (#619): omp is frozen and answers no `get_state`, so a page that was not there
 * when the conversation was paused (the other page, a page loaded since, any page after the server was restarted around the
 * conversation) used to open a panel with no row chosen. It shows what omp had when it was paused (the server asks omp as it
 * is frozen and keeps the answer), says that it is paused, and a change made in it runs omp for a moment, as the model
 * picker's does, and leaves the conversation paused. Two pages on one server, the omp a stand-in the test conducts
 * (`tests/support/sync-omp.ts`); each item is driven from each side.
 */

let world: World;
test.beforeAll(async () => {
	world = await startWorld();
});
test.afterAll(async () => {
	await world?.stop();
});

const panel = (page: Page) => page.getByTestId("session-controls-panel");
const choice = (page: Page, row: string, name: string) => panel(page).getByTestId(row).getByRole("radio", { name });
const star = (page: Page, row: string) => panel(page).getByTestId(`${row}-set-default`);
const dot = (page: Page, title: string, name: string) =>
	page
		.locator('[data-testid="session-item"]')
		.filter({ has: page.getByText(title, { exact: true }) })
		.getByRole("img", { name, exact: true });

/** What omp has, unlike omp's defaults in every row it reports; the two it does not report are told it from the panel. */
const CHOSEN = {
	steeringMode: "all",
	interruptMode: "wait",
	autoCompactionEnabled: false,
	fastModeEnabled: true,
	fastModeActive: true,
};

/** The conversation of `file` runs, with what omp has and was told as above; returns its process. */
async function running(pages: Record<Side, Page>, acting: Side, file: string, title: string): Promise<string> {
	await show(pages[acting], title);
	await pages[acting].getByTestId("composer").fill(`Run ${title}`);
	await pages[acting].getByTestId("composer").press("Enter");
	const liveId = await world.turnOf(file);
	// omp's own state is what it is asked for as it is frozen: this is not what the server last read.
	await world.state(liveId, CHOSEN);
	await pages[acting].getByTestId("session-controls").click();
	await unfoldAdvanced(pages[acting]);
	await panel(pages[acting]).getByTestId("auto-retry").getByText("Off").click();
	await panel(pages[acting]).getByTestId("cache-warming").getByText("Streaming").click();
	await expect(choice(pages[acting], "auto-retry", "Off")).toBeChecked();
	await expect(choice(pages[acting], "cache-warming", "Streaming")).toBeChecked();
	await pages[acting].keyboard.press("Escape");
	await expect(panel(pages[acting])).toHaveCount(0);
	return liveId;
}

/** The panel is open on `page` and says what `CHOSEN` is, with each row's star as the configuration's defaults make it. */
async function expectChosen(page: Page): Promise<void> {
	await page.getByTestId("session-controls").click();
	await expect(panel(page)).toBeVisible();
	await unfoldAdvanced(page);
	await expect(choice(page, "steering-mode", "All")).toBeChecked();
	await expect(choice(page, "interrupt-mode", "Wait")).toBeChecked();
	await expect(choice(page, "auto-compaction", "Off")).toBeChecked();
	await expect(choice(page, "fast-mode", "On")).toBeChecked();
	await expect(choice(page, "follow-up-mode", "One at a time")).toBeChecked();
	await expect(choice(page, "auto-retry", "Off")).toBeChecked();
	await expect(choice(page, "cache-warming", "Streaming")).toBeChecked();
	// A star is filled where the row is omp's default for new conversations, hollow where it differs.
	await expect(star(page, "follow-up-mode")).toHaveAttribute("aria-pressed", "true");
	for (const row of [
		"steering-mode",
		"interrupt-mode",
		"auto-compaction",
		"fast-mode",
		"auto-retry",
		"cache-warming",
	]) {
		await expect(star(page, row), row).toHaveAttribute("aria-pressed", "false");
		await expect(star(page, row), row).toBeEnabled();
	}
}

for (const acting of SIDES) {
	const watching: Side = other(acting);

	test(`a conversation the ${acting} page paused shows, in the panel of the ${watching} page that was not there, what omp had when it was paused, says it is paused, and a change leaves it paused`, async ({
		browser,
	}) => {
		const title = `Paused panel from ${acting}`;
		const file = world.seed(acting === "local" ? 1 : 2, title);
		const pages = await world.open(browser);
		try {
			const liveId = await running(pages, acting, file, title);
			await pages[acting].getByTestId("pause").click();
			for (const side of SIDES) await expect(dot(pages[side], title, "Paused")).toBeVisible();

			// The page that was not there: the panel is as omp was, and it says that omp is frozen.
			await show(pages[watching], title);
			await expectChosen(pages[watching]);
			await expect(pages[watching].getByTestId("session-controls-paused")).toBeVisible();
			await expect(pages[watching].getByTestId("session-controls-paused")).toContainText("Paused");
			// So does the page that was there.
			await expectChosen(pages[acting]);
			await expect(pages[acting].getByTestId("session-controls-paused")).toBeVisible();

			// A change runs omp for a moment and leaves the conversation paused; both panels say what it is now.
			await panel(pages[watching]).getByTestId("steering-mode").getByText("One at a time").click();
			for (const side of SIDES) await expect(choice(pages[side], "steering-mode", "One at a time")).toBeChecked();
			await expect(star(pages[watching], "steering-mode")).toHaveAttribute("aria-pressed", "true");
			await expect(star(pages[acting], "steering-mode")).toHaveAttribute("aria-pressed", "true");
			expect(world.received().filter((c) => c.type === "set_steering_mode")).toHaveLength(1);
			expect(world.received().some((c) => c.type === "abort" || c.type === "abort_retry")).toBe(false);
			expect((await world.lives()).find((l) => l.liveId === liveId)?.pausedAt).not.toBeNull();
			for (const side of SIDES) {
				await expect(dot(pages[side], title, "Paused")).toBeVisible();
				await expect(panel(pages[side]).getByTestId("session-controls-paused")).toBeVisible();
			}

			// Resumed, omp answers for itself again: the note goes and the rows are what omp says.
			await pages[watching].keyboard.press("Escape");
			await pages[watching].getByTestId("paused-resume").click();
			for (const side of SIDES) await expect(dot(pages[side], title, "Running")).toBeVisible();
			await pages[watching].getByTestId("session-controls").click();
			await expect(panel(pages[watching]).getByTestId("session-controls-paused")).toHaveCount(0);
			await expect(choice(pages[watching], "steering-mode", "One at a time")).toBeChecked();
			await expect(choice(pages[watching], "interrupt-mode", "Wait")).toBeChecked();
			await expect(choice(pages[watching], "auto-compaction", "Off")).toBeChecked();
			await expect(choice(pages[watching], "fast-mode", "On")).toBeChecked();
			await world.finish(liveId);
		} finally {
			await pages.close();
		}
	});

	test(`after the server was restarted around a conversation the ${acting} page paused, the panel of either page shows what omp had when it was paused`, async ({
		browser,
	}) => {
		const title = `Paused panel over a restart from ${acting}`;
		const file = world.seed(acting === "local" ? 3 : 4, title);
		const first = await world.open(browser);
		let liveId: string;
		try {
			liveId = await running(first, acting, file, title);
			await first[acting].getByTestId("pause").click();
			await expect(dot(first[acting], title, "Paused")).toBeVisible();
		} finally {
			await first.close({ keepProcesses: true });
		}
		await world.restart();
		expect(await world.liveOf(file)).toBe(liveId);

		const pages = await world.open(browser);
		try {
			for (const side of SIDES) {
				await show(pages[side], title);
				await expectChosen(pages[side]);
				await expect(pages[side].getByTestId("session-controls-paused")).toBeVisible();
				await pages[side].keyboard.press("Escape");
			}
			await pages[watching].getByTestId("paused-resume").click();
			for (const side of SIDES) await expect(dot(pages[side], title, "Running")).toBeVisible();
			await world.finish(liveId);
		} finally {
			await pages.close();
		}
	});
}

test("the note of a paused conversation's panel is in the page's language", async ({ browser }) => {
	const title = "Paused panel in Chinese";
	const file = world.seed(5, title);
	const pages = await world.open(browser);
	try {
		const liveId = await running(pages, "local", file, title);
		await pages.local.getByTestId("pause").click();
		await expect(dot(pages.remote, title, "Paused")).toBeVisible();
		await pages.remote.evaluate(() => localStorage.setItem("ompw.lang", "zh-CN"));
		await pages.remote.reload();
		await show(pages.remote, title);
		await pages.remote.getByTestId("session-controls").click();
		await expect(panel(pages.remote).getByTestId("session-controls-paused")).toContainText("已暂停");
		await expect(panel(pages.remote).getByTestId("steering-mode").getByRole("radio", { checked: true })).toHaveCount(1);
		await pages.remote.keyboard.press("Escape");
		await pages.remote.getByTestId("paused-resume").click();
		await world.finish(liveId);
	} finally {
		await pages.close();
	}
});
