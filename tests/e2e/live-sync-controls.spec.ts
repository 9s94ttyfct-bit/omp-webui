import { unfoldAdvanced } from "../support/controls.ts";
import * as omp from "../support/omp-frames.ts";
import { other, SIDES, type Side, show, startWorld, type World } from "../support/two-pages.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * What a conversation is set to, on the app's own window and on a page through Cloudflare Access (see
 * live-sync.spec.ts): the permission mode, the model, the thinking level, the goal, the todo list, a failed turn omp
 * waits to retry, and what the conversation has cost are the same on both, whichever page changed them, with no reload.
 */

let world: World;
test.beforeAll(async () => {
	world = await startWorld();
});
test.afterAll(async () => {
	await world?.stop();
});

/** Both pages show the conversation, and a turn runs on it (sent from `starter`'s page); resolves with the process. */
async function running(browser: Parameters<World["open"]>[0], n: number, title: string, starter: Side) {
	const file = world.seed(n, title);
	const pages = await world.open(browser);
	await show(pages.local, title);
	await show(pages.remote, title);
	await pages[starter].getByTestId("composer").fill(`Go ${title}`);
	await pages[starter].getByTestId("composer").press("Enter");
	const liveId = await world.turnOf(file);
	return { pages, liveId };
}

const picker = (page: Page) => page.getByTestId("approval-picker");

for (const acting of SIDES) {
	const watching: Side = other(acting);

	test(`the permission mode chosen on the ${acting} page is the one the ${watching} page shows`, async ({
		browser,
	}) => {
		const { pages } = await running(browser, acting === "local" ? 41 : 42, `Mode from ${acting}`, acting);
		try {
			for (const side of SIDES) await expect(picker(pages[side])).toHaveAttribute("data-mode", "yolo");
			await picker(pages[acting]).click();
			await pages[acting].getByTestId("approval-always-ask").click();
			for (const side of SIDES) await expect(picker(pages[side])).toHaveAttribute("data-mode", "always-ask");
			await picker(pages[watching]).click();
			await pages[watching].getByTestId("approval-write").click();
			for (const side of SIDES) await expect(picker(pages[side])).toHaveAttribute("data-mode", "write");
		} finally {
			await pages.close();
		}
	});

	test(`the model chosen on the ${acting} page is the one the ${watching} page shows`, async ({ browser }) => {
		const { pages } = await running(browser, acting === "local" ? 43 : 44, `Model from ${acting}`, acting);
		try {
			for (const side of SIDES) await expect(pages[side].getByTestId("model-picker")).toContainText("Opus 5.5");
			await pages[acting].getByTestId("model-picker").click();
			await pages[acting]
				.getByRole("option", { name: /Sonnet 5\.5/ })
				.first()
				.click();
			for (const side of SIDES) await expect(pages[side].getByTestId("model-picker")).toContainText("Sonnet 5.5");
		} finally {
			await pages.close();
		}
	});

	test(`the thinking level chosen on the ${acting} page is the one the ${watching} page shows`, async ({ browser }) => {
		const { pages } = await running(browser, acting === "local" ? 45 : 46, `Thinking from ${acting}`, acting);
		try {
			for (const side of SIDES) await expect(pages[side].getByTestId("thinking-picker")).toHaveValue("high");
			await pages[acting].getByTestId("thinking-picker").selectOption("low");
			for (const side of SIDES) await expect(pages[side].getByTestId("thinking-picker")).toHaveValue("low");
			await pages[watching].getByTestId("thinking-picker").selectOption("medium");
			for (const side of SIDES) await expect(pages[side].getByTestId("thinking-picker")).toHaveValue("medium");
		} finally {
			await pages.close();
		}
	});

	test(`a goal omp holds is on both pages, and paused on the ${acting} page it is paused on the ${watching} page`, async ({
		browser,
	}) => {
		const { pages, liveId } = await running(browser, acting === "local" ? 47 : 48, `Goal from ${acting}`, acting);
		try {
			await world.emit(
				liveId,
				omp.goalUpdated({
					id: "g1",
					objective: "Ship the release",
					status: "active",
					tokensUsed: 0,
					timeUsedSeconds: 0,
				}),
			);
			for (const side of SIDES) {
				await expect(pages[side].getByTestId("goal-bar")).toContainText("Ship the release");
				await expect(pages[side].getByTestId("goal-state")).toContainText("Working on goal");
			}
			await pages[acting].getByRole("button", { name: "Pause goal" }).click();
			for (const side of SIDES)
				await expect(pages[side].getByTestId("goal-bar")).toHaveAttribute("data-status", "paused");
		} finally {
			await pages.close();
		}
	});

	test(`a change omp makes to the todo list on a turn the ${acting} page started shows at once on both pages`, async ({
		browser,
	}) => {
		const { pages, liveId } = await running(browser, acting === "local" ? 49 : 50, `Todos from ${acting}`, acting);
		try {
			await world.state(liveId, {
				todoPhases: [{ name: "Release", tasks: [{ content: "Write the notes", status: "in_progress" }] }],
			});
			await world.emit(liveId, omp.toolStart("todo1", "todo", {}), omp.toolEnd("todo1", "todo", "ok"));
			for (const side of SIDES) await expect(pages[side].getByTestId("todo-strip")).toContainText("Write the notes");
		} finally {
			await pages.close();
		}
	});

	test(`a failed turn omp waits to retry shows its countdown on both pages, and goes from both when the ${acting} page cancels it`, async ({
		browser,
	}) => {
		const { pages, liveId } = await running(browser, acting === "local" ? 51 : 52, `Retry from ${acting}`, acting);
		try {
			await world.emit(liveId, omp.retryStart(1, 3, 600_000, "Overloaded"));
			for (const side of SIDES) await expect(pages[side].getByTestId("retry-wait")).toBeVisible();
			await pages[acting].getByTestId("retry-cancel").click();
			for (const side of SIDES) await expect(pages[side].getByTestId("retry-wait")).toHaveCount(0);
		} finally {
			await pages.close();
		}
	});

	test(`what a turn the ${acting} page started cost is the same on both pages once it has ended`, async ({
		browser,
	}) => {
		const { pages, liveId } = await running(browser, acting === "local" ? 53 : 54, `Cost from ${acting}`, acting);
		try {
			await world.emit(liveId, omp.messageStart("m1"), ...omp.block("m1", "text", 0, ["Done"]));
			await world.emit(liveId, omp.messageEnd("m1", [{ type: "text", text: "Done" }]));
			await world.finish(liveId);
			for (const side of SIDES) await expect(pages[side].getByTestId("stop")).toHaveCount(0);
			const shown = await pages.local.getByTestId("session-cost").first().innerText();
			await expect(pages.remote.getByTestId("session-cost").first()).toHaveText(shown);
		} finally {
			await pages.close();
		}
	});

	test(`the session settings changed on the ${acting} page (omp announces none of them) are the ones the ${watching} page shows, with no reload`, async ({
		browser,
	}) => {
		const { pages } = await running(browser, acting === "local" ? 71 : 72, `Settings from ${acting}`, acting);
		try {
			const panel = (page: Page) => page.getByTestId("session-controls-panel");
			const choice = (page: Page, row: string, name: string) =>
				panel(page).getByTestId(row).getByRole("radio", { name });
			for (const side of SIDES) {
				await pages[side].getByTestId("session-controls").click();
				await unfoldAdvanced(pages[side]);
				await expect(choice(pages[side], "steering-mode", "One at a time")).toBeChecked();
				await expect(choice(pages[side], "auto-compaction", "On")).toBeChecked();
				await expect(choice(pages[side], "interrupt-mode", "Immediately")).toBeChecked();
			}
			await panel(pages[acting]).getByTestId("steering-mode").getByText("All").click();
			await panel(pages[acting]).getByTestId("auto-compaction").getByText("Off").click();
			await panel(pages[acting]).getByTestId("interrupt-mode").getByText("Wait").click();
			for (const side of SIDES) {
				await expect(choice(pages[side], "steering-mode", "All")).toBeChecked();
				await expect(choice(pages[side], "auto-compaction", "Off")).toBeChecked();
				await expect(choice(pages[side], "interrupt-mode", "Wait")).toBeChecked();
			}
			// And the other way round.
			await panel(pages[watching]).getByTestId("steering-mode").getByText("One at a time").click();
			for (const side of SIDES) await expect(choice(pages[side], "steering-mode", "One at a time")).toBeChecked();
		} finally {
			await pages.close();
		}
	});
}
