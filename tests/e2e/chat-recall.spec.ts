import { FIXTURE } from "../support/fixtures.ts";
import { expect, test } from "./fixtures.ts";

/** Up and Down in the composer walk through the conversation's earlier prompts (a saved chat; no omp process needed). */

test("Up and Down cycle through the earlier prompts and give the draft back", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("complementary").getByText(FIXTURE.alphaTitle).click();
	const composer = page.getByTestId("composer");
	await expect(page.getByTestId("msg-user")).toHaveCount(2);
	await composer.focus();

	// Empty composer: the newest prompt first, then older ones, stopping at the oldest.
	await composer.press("ArrowUp");
	await expect(composer).toHaveValue("And what about quokka mode?");
	await composer.press("ArrowUp");
	await expect(composer).toHaveValue("Explain the zebra protocol");
	await composer.press("ArrowUp");
	await expect(composer).toHaveValue("Explain the zebra protocol");

	// Down goes forward again and ends on the empty draft.
	await composer.press("ArrowDown");
	await expect(composer).toHaveValue("And what about quokka mode?");
	await composer.press("ArrowDown");
	await expect(composer).toHaveValue("");
	await composer.press("ArrowDown");
	await expect(composer).toHaveValue("");

	// A half-typed message on the first line is the draft that comes back.
	await composer.fill("half typed");
	await composer.press("ArrowUp");
	await expect(composer).toHaveValue("And what about quokka mode?");
	await composer.press("ArrowDown");
	await expect(composer).toHaveValue("half typed");
});

test("Up only recalls from the first line, and typing in a recalled prompt leaves the history", async ({ page }) => {
	await page.goto("/");
	await page.getByRole("complementary").getByText(FIXTURE.alphaTitle).click();
	const composer = page.getByTestId("composer");
	await expect(page.getByTestId("msg-user")).toHaveCount(2);

	// On the second line Up moves the caret, as in any text box.
	await composer.fill("first line\nsecond line");
	await composer.press("ArrowUp");
	await expect(composer).toHaveValue("first line\nsecond line");
	// On the first line it recalls, and the draft is kept for the way back.
	await composer.press("ArrowUp");
	await expect(composer).toHaveValue("And what about quokka mode?");
	await composer.press("ArrowDown");
	await expect(composer).toHaveValue("first line\nsecond line");

	// Editing a recalled prompt is typing a new message: the next Up starts again from the newest prompt.
	await composer.fill("");
	await composer.press("ArrowUp");
	await composer.press("ArrowUp");
	await expect(composer).toHaveValue("Explain the zebra protocol");
	await composer.press("End");
	await composer.pressSequentially("!");
	await expect(composer).toHaveValue("Explain the zebra protocol!");
	await composer.press("ArrowUp");
	await expect(composer).toHaveValue("And what about quokka mode?");
	await composer.press("ArrowDown");
	await expect(composer).toHaveValue("Explain the zebra protocol!");
});

/** What the init script of the next test puts on the page's window: frame callbacks held back, then run all at once. */
interface FrameGate {
	hold(): void;
	run(): void;
}

test("a recall puts the caret at the end of the prompt with the text, not in a later frame that could undo a selection", async ({
	page,
}) => {
	// A page busy for a few frames runs its frame callbacks late. fill("") selects all and then presses Delete: a
	// callback of the recall landing between the two collapses the selection, and Delete has nothing to delete.
	await page.addInitScript(() => {
		const real = window.requestAnimationFrame.bind(window);
		const held: FrameRequestCallback[] = [];
		let holding = false;
		window.requestAnimationFrame = (callback) => (holding ? held.push(callback) : real(callback));
		const gate: FrameGate = {
			hold: () => {
				holding = true;
			},
			run: () => {
				holding = false;
				for (const callback of held.splice(0)) callback(performance.now());
			},
		};
		Reflect.set(window, "frameGate", gate);
	});
	const frames = (action: keyof FrameGate) =>
		page.evaluate((what) => {
			const gate: FrameGate = Reflect.get(window, "frameGate");
			gate[what]();
		}, action);
	await page.goto("/");
	await page.getByRole("complementary").getByText(FIXTURE.alphaTitle).click();
	const composer = page.getByTestId("composer");
	await expect(page.getByTestId("msg-user")).toHaveCount(2);
	await composer.focus();

	await frames("hold");
	await composer.press("ArrowUp");
	await expect(composer).toHaveValue("And what about quokka mode?");
	// Select all of the recalled prompt (what fill("") does first), then let the frames that were held run.
	await composer.evaluate((el: HTMLTextAreaElement) => el.select());
	await frames("run");
	const selection = await composer.evaluate((el: HTMLTextAreaElement) => [el.selectionStart, el.selectionEnd]);
	expect(selection).toEqual([0, "And what about quokka mode?".length]);
});

test("a !command that was run is recalled with its !", async ({ page }) => {
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	const composer = page.getByTestId("composer");
	await composer.fill("!echo recall-me");
	await composer.press("Enter");
	await expect(page.getByText("recall-me", { exact: true })).toBeVisible({ timeout: 30_000 });
	await composer.focus();
	await composer.press("ArrowUp");
	await expect(composer).toHaveValue("!echo recall-me");
});
