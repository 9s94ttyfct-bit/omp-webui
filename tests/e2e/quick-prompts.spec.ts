import { DEFAULT_QUICK_PROMPTS } from "../../shared/quick-prompts.ts";
import { show, startWorld, type World } from "../support/two-pages.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Quick prompts (#659) and the built-in Soft stop (#658), against a stand-in omp the test conducts (`sync-omp.ts`): a
 * prompt goes as it says while a turn runs (steer, or follow-up) and as a message when idle; Soft stop steers its handoff
 * instruction, the line says the session stops after the turn, and when the turn ends the process is ended and the
 * conversation says why; Cancel takes it back. Settings edits, saves and restores the list. No model.
 */

let world: World;
test.beforeAll(async () => {
	world = await startWorld();
});
test.afterAll(async () => {
	await world?.stop();
});

const sent = () => world.received().filter((c) => c.type === "prompt" || c.type === "steer");

async function pick(page: Page, id: string): Promise<void> {
	await page.getByTestId("quick-prompts").click();
	await page.locator(`[data-testid="quick-prompt-item"][data-id="${id}"]`).click();
}

test("Soft stop steers the handoff instruction into the running turn, and the session ends when that turn ends", async ({
	browser,
}) => {
	const title = "Quick prompts soft stop";
	const file = world.seed(0xa1, title);
	const pages = await world.open(browser);
	try {
		const page = pages.local;
		await show(page, title);
		const composer = page.getByTestId("composer");
		await composer.fill("Begin the work");
		await composer.press("Enter");
		const liveId = await world.turnOf(file);

		// Something typed: its button goes (Steer, beside it, has the same icon) and comes back once the box is empty.
		await composer.fill("a steer");
		await expect(page.getByRole("button", { name: /Steer/ })).toBeVisible();
		await expect(page.getByTestId("quick-prompts")).toHaveCount(0);
		await composer.fill("");
		await expect(page.getByTestId("quick-prompts")).toBeVisible();

		await pick(page, "soft-stop");
		await expect(page.getByTestId("soft-stop-line")).toBeVisible();
		await expect.poll(() => sent().map((c) => c.type)).toContain("steer");
		expect(String(sent().find((c) => c.type === "steer")?.message)).toContain("Soft stop: wrap up now");
		// The other page shows it too: the server holds it.
		await show(pages.remote, title);
		await expect(pages.remote.getByTestId("soft-stop-line")).toBeVisible();

		await world.finish(liveId);
		await expect(page.getByTestId("exit-notice")).toBeVisible();
		await expect(page.getByTestId("exit-soft-stop")).toBeVisible();
		await expect(page.getByTestId("soft-stop-line")).toHaveCount(0);
	} finally {
		await pages.close();
	}
});

test("Cancel takes the soft stop back, and the turn's end ends nothing", async ({ browser }) => {
	const title = "Quick prompts soft stop cancelled";
	const file = world.seed(0xa2, title);
	const pages = await world.open(browser);
	try {
		const page = pages.local;
		await show(page, title);
		await page.getByTestId("composer").fill("Begin");
		await page.getByTestId("composer").press("Enter");
		const liveId = await world.turnOf(file);
		await pick(page, "soft-stop");
		await expect(page.getByTestId("soft-stop-line")).toBeVisible();
		await page.getByTestId("soft-stop-cancel").click();
		await expect(page.getByTestId("soft-stop-line")).toHaveCount(0);
		await world.finish(liveId);
		await page.waitForTimeout(500);
		await expect(page.getByTestId("exit-notice")).toHaveCount(0);
	} finally {
		await pages.close();
	}
});

test("Settings adds a follow-up prompt that waits for the turn, and Restore brings the built-ins back and keeps it", async ({
	browser,
}) => {
	const title = "Quick prompts settings";
	const file = world.seed(0xa3, title);
	const pages = await world.open(browser);
	try {
		const page = pages.local;
		await page.goto(`${new URL(page.url()).origin}/#/settings/chats`);
		const card = page.getByTestId("quick-prompts-settings");
		await card.scrollIntoViewIfNeeded();
		await card.getByTestId("quick-prompt-add").click();
		const row = card.getByTestId("quick-prompt-row").last();
		await row.getByTestId("quick-prompt-name").fill("Run checks");
		await row.getByTestId("quick-prompt-text").fill("Run the tests next");
		await expect(row.getByTestId("quick-prompt-mode")).toHaveValue("followUp");
		await card.getByTestId("quick-prompts-save").click();
		await expect(card.getByTestId("quick-prompts-save")).toBeDisabled();

		await show(page, title);
		await page.getByTestId("composer").fill("Begin");
		await page.getByTestId("composer").press("Enter");
		const liveId = await world.turnOf(file);
		await page.getByTestId("quick-prompts").click();
		await page.getByTestId("quick-prompt-item").filter({ hasText: "Run checks" }).click();
		// A follow-up: a prompt omp queues behind the turn, not a steer.
		await expect
			.poll(() => sent().find((c) => c.message === "Run the tests next"))
			.toMatchObject({ type: "prompt", streamingBehavior: "followUp" });
		await world.finish(liveId);

		await page.getByTestId("quick-prompts").click();
		await page.getByTestId("quick-prompts-manage").click();
		const again = page.getByTestId("quick-prompts-settings");
		await expect(again).toBeInViewport();
		await again.getByTestId("quick-prompts-restore").click();
		// The built-ins as shipped, then the person's own prompt.
		const rows = again.getByTestId("quick-prompt-row");
		await expect(rows).toHaveCount(DEFAULT_QUICK_PROMPTS.length + 1);
		await expect(rows.first()).toHaveAttribute("data-id", "soft-stop");
		await expect(rows.last().getByTestId("quick-prompt-name")).toHaveValue("Run checks");
	} finally {
		await pages.close();
	}
});

test("on a phone the quick prompts are in the ⋯ panel with their name, and the panel closes once one is chosen", async ({
	browser,
}) => {
	const title = "Quick prompts phone panel";
	const file = world.seed(0xa4, title);
	const pages = await world.open(browser);
	try {
		const page = pages.local;
		await show(page, title);
		await expect(page.getByTestId("chat-title")).toHaveText(title);
		// The sidebar put away, so that narrowing the window opens no drawer over the page.
		await page.getByRole("button", { name: "Hide sidebar" }).click();
		await page.setViewportSize({ width: 390, height: 844 });
		await page.getByTestId("composer").fill("Begin the work");
		await page.getByTestId("composer").press("Enter");
		const liveId = await world.turnOf(file);

		// Not in the row; in the panel, as a button with its name and not a bare bolt (C1).
		await expect(page.getByTestId("composer-more")).toBeVisible();
		await expect(page.getByTestId("quick-prompts")).toBeHidden();
		await page.getByTestId("composer-more").click();
		const panel = page.getByTestId("composer-more-panel");
		const button = panel.getByTestId("quick-prompts");
		await expect(button).toHaveText("Quick prompts");
		expect((await button.boundingBox())?.width, "wider than the icon square").toBeGreaterThan(80);

		// The menu closed with Escape sends nothing: the panel stays, and its button has the focus back.
		await button.click();
		await expect(page.getByTestId("quick-prompts-menu")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("quick-prompts-menu")).toBeHidden();
		await expect(panel).toBeVisible();
		await expect(button).toBeFocused();

		// The next Escape closes the panel, and only that: the reply runs (Stop is there), and it does not also ask to stop it,
		// not even for a moment (a question that comes and goes is watched for from before the key).
		await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
		await page.evaluate(() => {
			document.body.dataset.stopAsked = "no";
			new MutationObserver(() => {
				if (document.querySelector('[data-testid="stop-confirm"]')) document.body.dataset.stopAsked = "yes";
			}).observe(document.body, { childList: true, subtree: true });
		});
		await page.keyboard.press("Escape");
		await expect(panel).toBeHidden();
		await expect(page.getByTestId("composer-more")).toBeFocused();
		await page.waitForTimeout(300);
		await expect(page.locator("body"), "the stop question was not shown").toHaveAttribute("data-stop-asked", "no");
		await page.getByTestId("composer-more").click();
		await expect(button).toBeVisible();

		// A prompt chosen sends something: the panel is done and goes away, with focus on ⋯ (its own button is hidden by then).
		await button.click();
		await page.locator('[data-testid="quick-prompt-item"][data-id="soft-stop"]').click();
		await expect(panel).toBeHidden();
		await expect(page.getByTestId("composer-more")).toBeFocused();
		await expect(page.getByTestId("soft-stop-line")).toBeVisible();
		await expect.poll(() => sent().map((c) => c.type)).toContain("steer");

		// Where the controls are in the row (a wide window), the button is the bolt alone.
		await page.setViewportSize({ width: 1280, height: 800 });
		await expect(page.getByTestId("composer-more")).toBeHidden();
		await expect(page.getByTestId("quick-prompts")).toBeVisible();
		expect((await page.getByTestId("quick-prompts").boundingBox())?.width, "an icon").toBeLessThanOrEqual(40);
		expect((await page.getByTestId("quick-prompts").innerText()).trim()).toBe("");
		await world.finish(liveId);
	} finally {
		await pages.close();
	}
});
