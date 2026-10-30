import AxeBuilder from "@axe-core/playwright";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The model picker opens on the model in use, scrolled into view, and models that share a name show their
 * ids. omp's model list is replaced by a known one: the real catalog changes with the omp release and
 * the credentials at hand (no model call).
 */

/** The model the E2E omp starts with (`modelRoles.default` in the test server's config). */
const CURRENT = { provider: "anthropic", id: "claude-haiku-5-5", name: "Claude Haiku 5.5", reasoning: true };

/** Thirty models listed before the current one (so it starts out of view), two sharing a name, then the current. */
const MODELS = [
	...Array.from({ length: 30 }, (_, i) => ({ provider: "acme", id: `m-${i}`, name: `Acme model ${i}` })),
	{ provider: "acme", id: "twin", name: "Acme twin" },
	{ provider: "acme", id: "twin-20251001", name: "Acme twin" },
	CURRENT,
];

async function openPicker(page: Page) {
	const tap = await tapSocket(page);
	tap.answer("get_available_models", () => ({ ok: true, data: { models: MODELS } }));
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toContainText("Haiku 5.5", { timeout: 60_000 });
	await page.getByTestId("model-picker").click();
	await expect(page.getByRole("option", { name: /Claude Haiku 5\.5/ })).toBeAttached();
	return tap;
}

test("the picker opens on the model in use, in view, and Enter keeps it", async ({ page }) => {
	const tap = await openPicker(page);
	const list = page.locator("[cmdk-list]");
	const highlighted = page.locator('[cmdk-item][aria-selected="true"]');

	// The row the list points at is the one with the check mark, not the first row.
	await expect(highlighted).toHaveCount(1);
	await expect(highlighted).toContainText("Claude Haiku 5.5");
	await expect(highlighted.locator("svg.opacity-100")).toHaveCount(1);

	// It is scrolled into view (the list is 344px tall, 33 rows long); layout may round by a pixel.
	await expect
		.poll(async () => {
			const [row, box] = await Promise.all([highlighted.boundingBox(), list.boundingBox()]);
			return Boolean(row && box && row.y >= box.y - 1 && row.y + row.height <= box.y + box.height + 1);
		})
		.toBe(true);

	// Enter on the opening highlight is not a switch to some other model.
	await page.keyboard.press("Enter");
	await expect(list).toHaveCount(0);
	expect(tap.commands("set_model")).toHaveLength(0);
});

test("models that share a name show their ids; the others do not", async ({ page }) => {
	await openPicker(page);
	const options = page.locator("[cmdk-list]").getByRole("option");
	await expect(options.filter({ hasText: "Acme twin" })).toHaveCount(2);
	await expect(options.filter({ hasText: "twin-20251001" })).toHaveCount(1);
	await expect(options.filter({ hasText: /Acme twin\s*twin$/ })).toHaveCount(1);
	// A name only one model has stays a plain name, and so does the model in use.
	await expect(options.filter({ hasText: /^Acme model 3$/ })).toHaveCount(1);
	await expect(options.filter({ hasText: /^Claude Haiku 5\.5$/ })).toHaveCount(1);
});

test("choosing another model still switches, and the picker keeps following the highlight when searching", async ({
	page,
}) => {
	const tap = await openPicker(page);
	await page.getByPlaceholder("Search models…").fill("twin-2025");
	await expect(page.locator('[cmdk-item][aria-selected="true"]')).toContainText("twin-20251001");
	await page.keyboard.press("Enter");
	await expect
		.poll(() => tap.commands("set_model"))
		.toEqual([{ type: "set_model", provider: "acme", modelId: "twin-20251001" }]);
});

test("a list omp answered empty is not kept: the picker asks again the next time it opens", async ({ page }) => {
	const tap = await tapSocket(page);
	// Seen on CI: omp's first answer was an empty list for a process that had a model (#208).
	let answers = 0;
	tap.answer("get_available_models", () => ({ ok: true, data: { models: answers++ === 0 ? [] : MODELS } }));
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	const picker = page.getByTestId("model-picker");
	await expect(picker).toContainText("Haiku 5.5", { timeout: 60_000 });
	const dialog = page.getByRole("dialog", { name: "Choose model" });

	await picker.click();
	await expect(dialog.getByText("No models")).toBeVisible();
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);

	await picker.click();
	await expect(page.getByRole("option", { name: /Claude Haiku 5\.5/ })).toBeAttached();
	await expect(dialog.getByText("No models")).toHaveCount(0);
	expect(tap.commands("get_available_models")).toHaveLength(2);

	// A list with models in it is kept: opening the picker again does not ask.
	await page.keyboard.press("Escape");
	await expect(dialog).toHaveCount(0);
	await picker.click();
	await expect(page.getByRole("option", { name: /Claude Haiku 5\.5/ })).toBeAttached();
	expect(tap.commands("get_available_models")).toHaveLength(2);
});

test("the open picker is a named dialog whose hearts sit beside the options, and axe finds nothing in it", async ({
	page,
}) => {
	const tap = await openPicker(page);
	const search = page.getByPlaceholder("Search models…");
	const violations = async () =>
		(await new AxeBuilder({ page }).include('[role="dialog"]').analyze()).violations.map(
			(v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`,
		);
	await expect(page.getByRole("dialog", { name: "Choose model" })).toBeVisible();
	await expect(page.getByRole("listbox", { name: "Choose model" })).toBeVisible();
	// An option holds no control: every heart is next to its option, and there is one for each model.
	await expect(page.getByRole("option").getByTestId("model-love")).toHaveCount(0);
	await expect(page.getByTestId("model-love")).toHaveCount(MODELS.length);
	expect(await violations(), "list showing").toEqual([]);

	// Nothing found leaves the listbox without an option, and nothing else in it.
	await search.fill("no such model");
	await expect(page.getByText("No models")).toBeVisible();
	expect(await violations(), "nothing found").toEqual([]);

	// The pointer still loves a model, without choosing it.
	await search.fill("model 3");
	const row = page.getByTestId("model-row").filter({ hasText: /^Acme model 3/ });
	await row.hover();
	await row.getByTestId("model-love").click();
	await expect(page.getByTestId("model-favorites").getByRole("option")).toHaveCount(1);
	expect(tap.commands("set_model")).toHaveLength(0);
	await expect(page.getByRole("dialog", { name: "Choose model" })).toBeVisible();
});

// Favorites live in the server's data dir, shared by every spec: leave none behind.
test.afterEach(async ({ page }) => {
	const headers = { "x-omp-webui": "1" };
	const loved: string[] = await (await page.request.get("/api/favorite-models")).json();
	for (const model of loved) await page.request.post("/api/favorite-models", { data: { model, on: false }, headers });
});
