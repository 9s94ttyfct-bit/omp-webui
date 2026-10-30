import * as omp from "../support/omp-frames.ts";
import { other, SIDES, type Side, show, startWorld, type World } from "../support/two-pages.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * What omp does for a turn, on the app's own window and on a page through Cloudflare Access (see live-sync.spec.ts):
 * a running tool's card opens, shows what it prints as it prints it, and folds when it ends, the same on both; the
 * subagents a turn starts are in both pages' lists with what they are doing now, and a subagent opened full screen on
 * one page streams there whichever page started the turn.
 */

let world: World;
test.beforeAll(async () => {
	world = await startWorld();
});
test.afterAll(async () => {
	await world?.stop();
});

const header = (card: Locator) => card.locator("button[aria-expanded]").first();

/** Both pages show the conversation, and a turn runs on it (sent from `starter`'s page); resolves with the process. */
async function running(browser: Parameters<World["open"]>[0], n: number, title: string, starter: Side) {
	const file = world.seed(n, title);
	const pages = await world.open(browser);
	await show(pages.local, title);
	await show(pages.remote, title);
	await pages[starter].getByTestId("composer").fill(`Go ${title}`);
	await pages[starter].getByTestId("composer").press("Enter");
	const liveId = await world.turnOf(file);
	return { pages, liveId, file };
}

const card = (page: Page, command: string) => page.locator('[data-testid="tool-card"]', { hasText: command });

for (const acting of SIDES) {
	const watching: Side = other(acting);

	test(`a tool the ${acting} page's turn runs opens its card on both pages, streams its output, and folds it when it ends`, async ({
		browser,
	}) => {
		const { pages, liveId } = await running(browser, acting === "local" ? 61 : 62, `Tool from ${acting}`, acting);
		try {
			const call = { id: "toolu_1", name: "bash", arguments: { command: "make build-sync" } };
			await world.emit(liveId, omp.messageStart("m1"), omp.toolCall("m1", 0, call));
			for (const side of SIDES)
				await expect(header(card(pages[side], "make build-sync"))).toHaveAttribute("aria-expanded", "false");
			await world.emit(liveId, omp.toolStart("toolu_1", "bash", call.arguments));
			for (const side of SIDES)
				await expect(header(card(pages[side], "make build-sync"))).toHaveAttribute("aria-expanded", "true");
			await world.emit(liveId, omp.toolUpdate("toolu_1", "bash", "compiling a.c"));
			for (const side of SIDES)
				await expect(card(pages[side], "make build-sync").getByText("compiling a.c")).toBeVisible();
			await world.emit(liveId, omp.toolUpdate("toolu_1", "bash", "compiling a.c\ncompiling b.c"));
			for (const side of SIDES)
				await expect(card(pages[side], "make build-sync").getByText("compiling b.c")).toBeVisible();
			await world.emit(liveId, omp.toolEnd("toolu_1", "bash", "compiling a.c\ncompiling b.c\nlinked"));
			for (const side of SIDES)
				await expect(header(card(pages[side], "make build-sync"))).toHaveAttribute("aria-expanded", "false");
		} finally {
			await pages.close();
		}
	});

	test(`the subagents the ${acting} page's turn starts are in the ${watching} page's list with what they say now, and its full screen streams`, async ({
		browser,
	}) => {
		const { pages, liveId } = await running(browser, acting === "local" ? 63 : 64, `Agents from ${acting}`, acting);
		try {
			const call = {
				id: "toolu_task",
				name: "task",
				arguments: {
					tasks: [
						{ id: "ScoutA", assignment: "Look in a" },
						{ id: "ScoutB", assignment: "Look in b" },
					],
				},
			};
			await world.emit(
				liveId,
				omp.messageStart("m1"),
				omp.toolCall("m1", 0, call),
				omp.toolStart("toolu_task", "task", call.arguments),
				omp.subagentStarted("ScoutA", "toolu_task", 0, "Look in a"),
				omp.subagentStarted("ScoutB", "toolu_task", 1, "Look in b"),
				omp.subagentProgress("ScoutA", 0, 1),
				omp.subagentText("ScoutA", "Found ", "Found "),
			);
			for (const side of SIDES) {
				await pages[side].getByTestId("status-agents").click();
				await expect(pages[side].getByTestId("subagent-item")).toHaveCount(2);
			}
			// The page that did not start the turn opens ScoutA full screen (the list is not in the order they started), and sees it speak as it speaks.
			await pages[watching].getByTestId("subagent-item").filter({ hasText: "ScoutA" }).click();
			await pages[watching].getByTestId("subagent-full-enter").click();
			await world.emit(liveId, omp.subagentText("ScoutA", "three files", "Found three files"));
			await expect(pages[watching].getByTestId("subagent-full-detail").getByText("Found three files")).toBeVisible();
			await world.emit(liveId, omp.subagentEnded("ScoutA"), omp.subagentEnded("ScoutB"));
			await expect(pages[acting].getByTestId("subagent-item").first()).toBeVisible();
		} finally {
			await pages.close();
		}
	});

	test(`a window opened on a subagent's full screen while the ${acting} page's turn runs shows it and streams it, as the pages that hold the conversation do`, async ({
		browser,
	}) => {
		const { pages, liveId } = await running(browser, acting === "local" ? 65 : 66, `Window from ${acting}`, acting);
		try {
			const call = {
				id: "toolu_task",
				name: "task",
				arguments: { tasks: [{ id: "ScoutA", assignment: "Look in a" }] },
			};
			await world.emit(
				liveId,
				omp.messageStart("m1"),
				omp.toolCall("m1", 0, call),
				omp.toolStart("toolu_task", "task", call.arguments),
				omp.subagentStarted("ScoutA", "toolu_task", 0, "Look in a"),
				omp.subagentProgress("ScoutA", 0, 1),
				omp.subagentText("ScoutA", "Found ", "Found "),
			);
			// What omp's registry holds of it, which a page that comes later reads.
			await world.state(liveId, {
				subagents: [
					{
						id: "ScoutA",
						agent: "explore",
						index: 0,
						description: "probe ScoutA",
						assignment: "Look in a",
						parentToolCallId: "toolu_task",
						status: "running",
						progress: { id: "ScoutA", status: "running", toolCount: 1, durationMs: 100, tokens: 50 },
					},
				],
			});
			// A window of its own, as the full screen's pop-out opens it (at the conversation's address as the list gives it): a page
			// that holds nothing yet.
			const address = (await world.lives()).find((l) => l.liveId === liveId)?.sessionFile;
			expect(address).toBeTruthy();
			const popout = await pages[watching].context().newPage();
			const origin = new URL(pages[watching].url()).origin;
			await popout.goto(`${origin}/?popout#/s/${encodeURIComponent(address as string)}/agent/ScoutA`);
			await expect(popout.getByTestId("subagent-full")).toHaveAttribute("data-mode", "popout");
			await expect(popout.getByTestId("subagent-full-name")).toHaveText("ScoutA");
			await expect(popout.getByText("Look in a").first()).toBeVisible();
			await world.emit(liveId, omp.subagentText("ScoutA", "three files", "Found three files"));
			await expect(popout.getByText("Found three files")).toBeVisible();
		} finally {
			await pages.close();
		}
	});
}
