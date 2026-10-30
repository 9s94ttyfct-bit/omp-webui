import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The model list is a chunk of its own, fetched when the button is pressed. What is typed right after the press
 * must not be lost while the chunk is on its way: the field is on the page before the list is, and what is typed
 * in it is the list's search.
 *
 * The chunk is made slow here, so that the keys are typed while it is still on its way.
 */

const CURRENT = { provider: "anthropic", id: "claude-haiku-5-5", name: "Claude Haiku 5.5", reasoning: true };
const MODELS = [
	...Array.from({ length: 30 }, (_, i) => ({ provider: "acme", id: `m-${i}`, name: `Acme model ${i}` })),
	CURRENT,
];

/** The list's chunk, answered as slowly as the test asks for. */
const LIST_CHUNK = /\/assets\/ModelList-[^/]+\.js$/;

async function openWithSlowList(page: Page, delayMs: number) {
	const tap = await tapSocket(page);
	tap.answer("get_available_models", () => ({ ok: true, data: { models: MODELS } }));
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	/** Settles once the chunk has been handed to the page. */
	const served = Promise.withResolvers<void>();
	await page.route(LIST_CHUNK, async (route) => {
		await new Promise((resolve) => setTimeout(resolve, delayMs));
		await route.continue();
		served.resolve();
	});
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toContainText("Haiku 5.5", { timeout: 60_000 });
	return { tap, served: served.promise };
}

test("what is typed while the list is fetched is kept when it comes: no key is lost on the way", async ({ page }) => {
	await openWithSlowList(page, 600);
	await page.getByTestId("model-picker").click();
	// The keys are typed at once, one by one across the moment the chunk arrives: some in the field that is on the
	// page first, the rest in the list's own. Nothing waits for either field to be there.
	await page.keyboard.type("acme model 2", { delay: 100 });
	const field = page.getByTestId("model-search");
	// The list is there by now, and what it shows is searched by every key that was typed.
	await expect(page.locator("[cmdk-list]")).toBeAttached();
	await expect(field).toHaveValue("acme model 2");
	await expect(field).toBeFocused();
	await expect(page.getByRole("option", { name: "Acme model 2", exact: true })).toBeAttached();
	await expect(page.getByRole("option", { name: "Acme model 3", exact: true })).toHaveCount(0);
	// The text goes on from where it was: the caret is at its end.
	await page.keyboard.type("5");
	await expect(field).toHaveValue("acme model 25");
	await expect(page.getByRole("option", { name: "Acme model 25", exact: true })).toBeAttached();
});

test("the search field is on the page before the list is, and takes the keys", async ({ page }) => {
	await openWithSlowList(page, 2000);
	await page.getByTestId("model-picker").click();
	// The field is there while the list is still on its way.
	const field = page.getByTestId("model-search");
	await expect(field).toBeVisible();
	await expect(field).toBeFocused();
	await expect(page.locator("[cmdk-list]")).toHaveCount(0);
	await page.keyboard.type("acme", { delay: 10 });
	await expect(field).toHaveValue("acme");
});

test("a search that was typed for one opening is not there at the next", async ({ page }) => {
	await openWithSlowList(page, 0);
	await page.getByTestId("model-picker").click();
	const field = page.getByTestId("model-search");
	await expect(page.locator("[cmdk-list]")).toBeAttached();
	await field.fill("acme model 2");
	await page.keyboard.press("Escape");
	await expect(field).toHaveCount(0);
	await page.getByTestId("model-picker").click();
	await expect(page.getByTestId("model-search")).toHaveValue("");
});

test("a composition (IME) begun in the field that is on the page first is not cut by the list arriving", async ({
	page,
}) => {
	const { served } = await openWithSlowList(page, 800);
	await page.getByTestId("model-picker").click();
	const field = page.getByTestId("model-search");
	await expect(field).toBeFocused();
	await field.evaluate((el) => {
		(window as unknown as { composed: Element }).composed = el;
	});

	// The pre-edit of a composition ("zhong", to become 中) is in the field when the chunk arrives.
	const ime = await page.context().newCDPSession(page);
	await ime.send("Input.imeSetComposition", { text: "zhong", selectionStart: 5, selectionEnd: 5 });
	await expect(field).toHaveValue("zhong");
	await served;
	await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 300)));
	// The list waits for the composition to end: the field it is in is the one it began in.
	await expect(page.locator("[cmdk-list]")).toHaveCount(0);
	expect(
		await page.evaluate(
			() =>
				document.querySelector('[data-testid="model-search"]') ===
				(window as unknown as { composed: Element }).composed,
		),
	).toBe(true);

	// The composition ends with 中: that is the search, not "zhong中", and the list is there for it.
	await ime.send("Input.insertText", { text: "中" });
	await expect(page.locator("[cmdk-list]")).toBeAttached();
	await expect(page.getByTestId("model-search")).toHaveValue("中");
	await expect(page.getByTestId("model-search")).toBeFocused();
	// Typing goes on from there.
	await page.keyboard.type("x");
	await expect(page.getByTestId("model-search")).toHaveValue("中x");
});
