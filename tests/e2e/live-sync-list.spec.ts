import { sessionRow } from "../support/live.ts";
import * as omp from "../support/omp-frames.ts";
import { other, SIDES, type Side, show, startWorld, type World } from "../support/two-pages.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The conversation list and what each conversation is doing, on the app's own window and on a page through Cloudflare
 * Access (see live-sync.spec.ts): a conversation started on one is in the other's list with no reload, and the dot
 * beside each conversation (running, needs your input, paused, open) is the same on both, whichever page started it,
 * whichever conversation each page is looking at.
 */

let world: World;
test.beforeAll(async () => {
	world = await startWorld();
});
test.afterAll(async () => {
	await world?.stop();
});

const dot = (page: Page, title: string, name: string) =>
	sessionRow(page, title).getByRole("img", { name, exact: true });

for (const acting of SIDES) {
	const watching: Side = other(acting);

	test(`a conversation started on the ${acting} page is in the ${watching} page's list, running, with no reload`, async ({
		browser,
	}) => {
		const pages = await world.open(browser);
		try {
			const title = `Started on ${acting}`;
			await pages[acting].getByTestId("composer").fill(title);
			await pages[acting].getByTestId("composer").press("Enter");
			const liveId = await world.newLive();
			await world.emit(liveId, omp.messageStart("m1"), ...omp.block("m1", "text", 0, ["Working on it"]));
			// The file is there once omp has written an answer.
			await world.emit(liveId, omp.messageEnd("m1", [{ type: "text", text: "Working on it" }]));
			for (const side of SIDES) {
				await expect(sessionRow(pages[side], title)).toHaveCount(1);
				await expect(dot(pages[side], title, "Running")).toBeVisible();
			}
			await world.finish(liveId);
			for (const side of SIDES) await expect(dot(pages[side], title, "Open")).toBeVisible();
		} finally {
			await pages.close();
		}
	});

	test(`the ${watching} page shows the dot of a conversation the ${acting} page runs while it looks at another one`, async ({
		browser,
	}) => {
		const title = `Running on ${acting}`;
		const elsewhere = `Looked at on ${watching}`;
		const file = world.seed(acting === "local" ? 31 : 32, title);
		world.seed(acting === "local" ? 33 : 34, elsewhere);
		const pages = await world.open(browser);
		try {
			await show(pages[acting], title);
			await show(pages[watching], elsewhere);
			await pages[acting].getByTestId("composer").fill(`Run ${title}`);
			await pages[acting].getByTestId("composer").press("Enter");
			const liveId = await world.turnOf(file);
			for (const side of SIDES) await expect(dot(pages[side], title, "Running")).toBeVisible();
			// It asks, and both lists say it waits for an answer.
			await world.emit(liveId, omp.approval("a1", "bash", "echo hi"));
			for (const side of SIDES) await expect(dot(pages[side], title, "Needs your input")).toBeVisible();
			// Answered where it is not looked at: the dot goes back to running on both.
			await show(pages[watching], title);
			await pages[watching]
				.getByTestId("ui-request")
				.getByRole("button", { name: /Allow once/ })
				.click();
			for (const side of SIDES) await expect(dot(pages[side], title, "Running")).toBeVisible();
			await world.finish(liveId);
			for (const side of SIDES) await expect(dot(pages[side], title, "Open")).toBeVisible();
		} finally {
			await pages.close();
		}
	});

	test(`a conversation paused on the ${acting} page is paused on the ${watching} page, and running again once resumed`, async ({
		browser,
	}) => {
		const title = `Paused on ${acting}`;
		const file = world.seed(acting === "local" ? 35 : 36, title);
		const pages = await world.open(browser);
		try {
			await show(pages.local, title);
			await show(pages.remote, title);
			await pages[acting].getByTestId("composer").fill(`Run ${title}`);
			await pages[acting].getByTestId("composer").press("Enter");
			await world.turnOf(file);
			await pages[acting].getByTestId("pause").click();
			for (const side of SIDES) {
				await expect(dot(pages[side], title, "Paused")).toBeVisible();
				await expect(pages[side].getByTestId("stop")).toHaveCount(0);
			}
			await pages[watching]
				.getByRole("button", { name: /Resume/ })
				.first()
				.click();
			for (const side of SIDES) await expect(dot(pages[side], title, "Running")).toBeVisible();
		} finally {
			await pages.close();
		}
	});

	test(`a dialog for a conversation nobody looks at is the same toast and tab-title count on both pages, whichever page started the turn (${acting})`, async ({
		browser,
	}) => {
		const title = `Asks unseen from ${acting}`;
		const elsewhere = `Looked at instead of ${title}`;
		const file = world.seed(acting === "local" ? 37 : 38, title);
		world.seed(acting === "local" ? 39 : 40, elsewhere);
		const pages = await world.open(browser);
		try {
			await show(pages[acting], title);
			await pages[acting].getByTestId("composer").fill(`Run ${title}`);
			await pages[acting].getByTestId("composer").press("Enter");
			const liveId = await world.turnOf(file);
			// Neither page looks at it now.
			for (const side of SIDES) await show(pages[side], elsewhere);
			for (const side of SIDES) await expect(pages[side]).not.toHaveTitle(/^\(/);
			await world.emit(liveId, omp.approval("a1", "bash", "echo hi"));
			for (const side of SIDES) {
				await expect(pages[side].getByText(`“${title}” needs your input`)).toBeVisible();
				await expect(pages[side]).toHaveTitle(/^\(1\) /);
			}
			// Answered where it is opened: the count is gone from both.
			await show(pages[watching], title);
			await pages[watching]
				.getByTestId("ui-request")
				.getByRole("button", { name: /Allow once/ })
				.click();
			for (const side of SIDES) await expect(pages[side]).not.toHaveTitle(/^\(/);
			await world.finish(liveId);
		} finally {
			await pages.close();
		}
	});

	test(`a ${watching} page that is loaded while the ${acting} page's turn runs lists it as running, and as waiting once it asks`, async ({
		browser,
	}) => {
		const title = `Running when ${watching} loaded`;
		const elsewhere = `Looked at when ${watching} loaded`;
		const file = world.seed(acting === "local" ? 41 : 42, title);
		world.seed(acting === "local" ? 43 : 44, elsewhere);
		const pages = await world.open(browser);
		try {
			await show(pages[acting], title);
			await show(pages[watching], elsewhere);
			await pages[acting].getByTestId("composer").fill(`Run ${title}`);
			await pages[acting].getByTestId("composer").press("Enter");
			const liveId = await world.turnOf(file);
			await world.emit(liveId, omp.approval("a2", "bash", "echo hi"));
			await expect(dot(pages[watching], title, "Needs your input")).toBeVisible();
			// The page is loaded again while the conversation waits for an answer: it was told nothing of it.
			await pages[watching].reload();
			await expect(dot(pages[watching], title, "Needs your input")).toBeVisible();
			await pages[watching].getByTestId("composer").waitFor();
			await expect(pages[watching]).toHaveTitle(/^\(1\) /);
			// Answered on the page that was loaded again: running on both, and open once the turn ends.
			await show(pages[watching], title);
			await pages[watching]
				.getByTestId("ui-request")
				.getByRole("button", { name: /Allow once/ })
				.click();
			for (const side of SIDES) await expect(dot(pages[side], title, "Running")).toBeVisible();
			await world.finish(liveId);
			for (const side of SIDES) await expect(dot(pages[side], title, "Open")).toBeVisible();
		} finally {
			await pages.close();
		}
	});
}
