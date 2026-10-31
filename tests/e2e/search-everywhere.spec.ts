import { rmSync, utimesSync } from "node:fs";
import { writeSimpleSession } from "../support/fixtures.ts";
import { choose } from "../support/select.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Better search in the three places it was asked for (#644), in both languages and from the keyboard: Settings' search
 * field finds a setting by its name, its description and the names people use for it and jumps to it; the sidebar's field
 * ranks conversations by a fuzzy title match, groups nothing while it searches, and its arrows walk the results; the model
 * picker's field matches the provider, the name, the id and the names people call a model. No model is called.
 */

const settingsRow = (page: Page) => page.getByTestId("settings-search-result");

test.describe("Settings", () => {
	test("a query finds settings by label, description and alias, and Enter takes the marked one", async ({ page }) => {
		await page.goto("/#/settings");
		const field = page.getByTestId("settings-search-input");
		await expect(field).toBeVisible();

		// By an alias that is in neither the label nor the description.
		await field.fill("dark mode");
		await expect(settingsRow(page).first()).toContainText("Theme");
		// The letters in order, anywhere in the label, the sentence or an alias.
		await field.fill("ntfctns");
		await expect(settingsRow(page).first()).toContainText("Notifications");

		// By a sentence of the description.
		await field.fill("drag the edge");
		await expect(settingsRow(page).first()).toContainText("Reset to default size");
		await field.press("Enter");
		await expect(page.locator('[data-marked="true"]')).toHaveCount(1);
		await expect(page.locator('[data-testid="reset-layout"]')).toBeFocused();

		// The keyboard walks the results, and the count says how many there are.
		await field.fill("model");
		await expect(settingsRow(page).first()).toBeVisible();
		await expect(page.getByTestId("settings-search-count")).toContainText(/\d+ settings/);
		await field.press("ArrowDown");
		await field.press("Enter");
		await expect(page.locator('[data-marked="true"]')).toHaveCount(1);

		// Nothing found says so, and clearing puts the field back.
		await field.fill("zzzzzz");
		await expect(page.getByTestId("settings-search-empty")).toBeVisible();
		await expect(page.getByTestId("settings-search-clear")).toBeVisible();
		await page.getByTestId("settings-search-clear").click();
		await expect(field).toHaveValue("");
		await expect(settingsRow(page)).toHaveCount(0);
	});

	test("in Chinese, the Chinese name and an English alias both find the setting", async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem("ompw.lang", "zh-CN"));
		await page.goto("/#/settings");
		const field = page.getByTestId("settings-search-input");

		await field.fill("主题");
		await expect(settingsRow(page).first()).toContainText("主题");
		// The group is the card's Chinese name.
		await expect(page.getByTestId("settings-search-results")).toContainText("外观");

		// An English alias finds the same card, whose name is Chinese.
		await field.fill("dark mode");
		await expect(settingsRow(page).first()).toContainText("主题");
		await field.press("Enter");
		await expect(page.locator('[data-marked="true"]')).toHaveCount(1);
	});
});

test.describe("conversations", () => {
	/** A conversation named by one of the spec's own, so the ranking is read against known rows. */
	async function sidebar(page: Page) {
		await page.goto("/");
		await expect(page.getByTestId("session-list")).toBeVisible({ timeout: 30_000 });
		return page.getByTestId("session-filter");
	}

	test("a fuzzy match ranks a title above a project, and the arrows walk the results into the page", async ({
		page,
	}) => {
		const field = await sidebar(page);
		// "fxalp" is the initials of the fixture's title words, in order: a fuzzy match, not a substring.
		await field.fill("fxalp");
		const rows = page.getByTestId("session-item");
		await expect(rows.first()).toContainText("Fixture alpha");
		// A search shows a ranked list: no date headings cut it up.
		await expect(page.getByTestId("session-search-status")).toContainText(/\d+ matches/);

		// A match that is only the letters in order is listed and not marked: scattered letters read as noise (N1).
		await expect(rows.first().locator("mark")).toHaveCount(0);
		// A word as typed is marked where it stands, in one run.
		await field.fill("alpha");
		await expect(rows.first()).toContainText("Fixture alpha");
		await expect(rows.first().locator("mark")).toHaveText("alpha");
		await field.fill("fxalp");
		await expect(rows.first()).toContainText("Fixture alpha");

		// Down goes into the results; Enter opens the one focused.
		await field.press("ArrowDown");
		await expect(rows.first()).toBeFocused();
		await page.keyboard.press("Enter");
		await expect(page.getByTestId("chat-title")).toHaveText("Fixture alpha: zebra protocol");

		// Esc in the field empties it before it means anything else.
		await field.fill("fxalp");
		await field.press("Escape");
		await expect(field).toHaveValue("");
	});

	test("the date range narrows the list, in Chinese too", async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem("ompw.lang", "zh-CN"));
		// A conversation the spec dates itself: the fixtures are written "now", so one of them is always in today.
		const agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
		const old = writeSimpleSession(agentDir, 0xb7, "Old heron notes");
		const past = Date.now() / 1000 - 60 * 86_400;
		utimesSync(old, past, past);
		try {
			await page.goto("/");
			await expect(page.getByTestId("session-list")).toBeVisible({ timeout: 30_000 });
			const row = page.getByTestId("session-item").filter({ hasText: "Old heron notes" });
			await expect(row).toHaveCount(1);
			const range = page.getByTestId("session-range");
			await expect(range).toHaveCount(1);
			// Today keeps today's only; all time has the old one back.
			await choose(range, "today");
			await expect(row).toHaveCount(0);
			await choose(range, "all");
			await expect(row).toHaveCount(1);
			await expect(page.getByTestId("session-filter")).toHaveAttribute("placeholder", "筛选对话…");
			await expect(page.getByTestId("session-range")).toHaveAttribute("aria-label", "时间范围");
		} finally {
			rmSync(old, { force: true });
		}
	});
});

test.describe("the model picker", () => {
	const CURRENT = { provider: "anthropic", id: "claude-haiku-5-5", name: "Claude Haiku 5.5", reasoning: true };
	const MODELS = [
		{ provider: "acme", id: "alpha", name: "Acme alpha" },
		{ provider: "deepseek", id: "deepseek-chat", name: "DeepSeek Chat" },
		{ provider: "anthropic", id: "claude-sonnet-4-5", name: "Claude Sonnet 4.5" },
		{ provider: "anthropic", id: "claude-opus-4-1", name: "Claude Opus 4.1" },
		CURRENT,
	];

	async function openPicker(page: Page) {
		const tap = await tapSocket(page);
		tap.answer("get_available_models", () => ({ ok: true, data: { models: MODELS } }));
		await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
		await page.goto("/");
		await expect(page.getByTestId("model-picker")).toContainText("Haiku 5.5", { timeout: 60_000 });
		await page.getByTestId("model-picker").click();
		await expect(page.getByRole("option", { name: /DeepSeek Chat/ })).toBeAttached();
		return tap;
	}

	test("an alias finds the model, the name is marked, and Enter switches to it", async ({ page }) => {
		const tap = await openPicker(page);
		const field = page.getByTestId("model-search");

		// `ds` is nobody's name: it is the alias of the provider, so it finds the model and marks nothing in its name.
		await field.fill("ds");
		const options = page.locator("[cmdk-list]").getByRole("option");
		await expect(options.first()).toContainText("DeepSeek Chat");
		await expect(options.first().locator("mark")).toHaveCount(0);
		// A query in the name is marked there: the characters it matched, in the row a person reads.
		await field.fill("deep");
		await expect(options.first().locator("mark").first()).toHaveText(/Deep/);

		// A provider's name matches too, and a family's name matches every model of it.
		await field.fill("anthropic");
		await expect(options.first()).toContainText("Claude");
		await field.fill("opus");
		await expect(options).toHaveCount(1);
		await expect(options.first()).toContainText("Claude Opus 4.1");

		// The arrow keys move the highlight and Enter takes it.
		await field.fill("claude");
		await expect(page.locator('[cmdk-item][aria-selected="true"]')).toContainText("Claude");
		await page.keyboard.press("ArrowDown");
		const highlighted = await page.locator('[cmdk-item][aria-selected="true"]').textContent();
		await page.keyboard.press("Enter");
		await expect
			.poll(() => tap.commands("set_model"))
			.toEqual([expect.objectContaining({ type: "set_model", provider: "anthropic" })]);
		expect(highlighted).toBeTruthy();
	});

	test("a search that finds nothing says so instead of showing the whole catalog", async ({ page }) => {
		await openPicker(page);
		await page.getByTestId("model-search").fill("zzzzzz");
		await expect(page.getByText("No models")).toBeVisible();
		await expect(page.locator("[cmdk-list]").getByRole("option")).toHaveCount(0);
	});
});
