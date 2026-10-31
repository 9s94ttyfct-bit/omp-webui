import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { choose } from "../support/select.ts";
import { type APIRequestContext, expect, type Page, test } from "./fixtures.ts";

/**
 * A preset carries the subagent models (omp's `task.agentModelOverrides`): the save dialogs say which they keep, Settings ›
 * Presets lists and edits them, and applying a preset applies them, a preset with none leaving the current ones. The presets
 * are omp's own, in the isolated config the E2E server uses; switching makes no model call. The config file is put back
 * after every test, as `presets.spec.ts` does.
 */

let agentDir: string;
let work: string;
let configFile: string;
let original = "";

const HAIKU = "anthropic/claude-haiku-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";
const csrf = { "x-omp-webui": "1" };

test.beforeAll(() => {
	agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
	work = process.env.OMPW_E2E_WORK as string;
	configFile = join(agentDir, "config.yml");
	original = readFileSync(configFile, "utf8");
});
test.beforeEach(() => {
	writeFileSync(configFile, original);
});
test.afterEach(() => {
	writeFileSync(configFile, original);
});

const globalConfig = async (request: APIRequestContext) => (await request.get("/api/model-config")).json();
const presetOf = async (request: APIRequestContext, name: string) =>
	(await globalConfig(request)).presets.find((p: { name: string }) => p.name === name);

/** The subagent models the global config has now, which a preset saved from it keeps. */
async function setSubagents(request: APIRequestContext, agents: Record<string, string>) {
	const { roles } = await globalConfig(request);
	const r = await request.post("/api/model-config/roles", {
		headers: csrf,
		data: { roles, agentModelOverrides: agents },
	});
	expect(r.ok()).toBe(true);
}

async function savePreset(request: APIRequestContext, name: string, agents: Record<string, string>, roles = DEEP) {
	const r = await request.post("/api/model-config/preset/save", {
		headers: csrf,
		data: { name, roles, defaultThinkingLevel: "high", agentModelOverrides: agents },
	});
	expect(r.ok()).toBe(true);
}

/** The test server's roles with the default role moved to Sonnet, as `presets.spec.ts` has them. */
const DEEP = { default: `${SONNET}:high`, smol: HAIKU, slow: HAIKU, tiny: `${HAIKU}:low`, commit: HAIKU };
const toast = (page: Page, text: string) => page.getByTestId("toast").filter({ hasText: text });

test("Settings › Presets: the save dialog says which subagent models it keeps, and the preset lists them", async ({
	page,
	request,
}) => {
	await setSubagents(request, { reviewer: `${HAIKU}:low`, scout: SONNET });
	await page.goto("/#/settings/models");
	const section = page.getByTestId("model-presets");
	await section.getByTestId("save-current-preset").click();
	const note = page.getByTestId("preset-agents-note");
	await expect(note).toContainText("Saved with it: subagent models reviewer → ");
	await expect(note).toContainText("scout → ");
	await expect(note).toContainText("Applying the preset replaces the subagent models with these");
	await page.getByTestId("preset-name").fill("agentic");
	await page.getByTestId("preset-name-submit").click();
	await expect(toast(page, "Saved preset “agentic”.")).toBeVisible();

	const row = section.locator('[data-testid="preset-row"][data-preset="agentic"]');
	await expect(row.getByTestId("preset-agents-summary")).toContainText("reviewer → ");
	await expect(row.getByTestId("preset-agents-summary")).toContainText("scout → ");
	expect((await presetOf(request, "agentic")).agentModelOverrides).toEqual({
		reviewer: `${HAIKU}:low`,
		scout: SONNET,
	});
	// The rule is on the page, not only in a dialog.
	await expect(page.getByTestId("preset-agents-rule")).toContainText("leaves them as they are");

	// With none set, the dialog says what that means, and the preset keeps none.
	writeFileSync(configFile, original);
	await page.reload();
	await expect(section.getByTestId("preset-row")).toHaveCount(0, { timeout: 30_000 });
	await section.getByTestId("save-current-preset").click();
	await expect(page.getByTestId("preset-agents-note")).toContainText("No subagent models are set");
	await expect(page.getByTestId("preset-agents-note")).toContainText("leaves them as they are");
	await page.getByTestId("preset-name").fill("plainone");
	await page.getByTestId("preset-name-submit").click();
	await expect(toast(page, "Saved preset “plainone”.")).toBeVisible();
	await expect(section.locator('[data-preset="plainone"]').getByTestId("preset-agents-summary")).toHaveCount(0);
	expect((await presetOf(request, "plainone")).agentModelOverrides).toBeUndefined();
});

test("Settings › Presets: a preset's subagent models are edited in a dialog and saved into that preset alone", async ({
	page,
	request,
}) => {
	await savePreset(request, "fast", {}, { ...DEEP, default: `${HAIKU}:low` });
	await savePreset(request, "deep", {});
	await page.goto("/#/settings/models");
	const section = page.getByTestId("model-presets");
	const row = (name: string) => section.locator(`[data-testid="preset-row"][data-preset="${name}"]`);
	await expect(row("fast")).toBeVisible({ timeout: 30_000 });
	await expect(row("fast").getByTestId("preset-agents-summary")).toHaveCount(0);

	await row("fast").getByTestId("edit-preset-agents").click();
	const dialog = page.getByTestId("preset-agents-dialog");
	await expect(page.getByRole("dialog")).toContainText("Subagent models · fast");
	await expect(page.getByRole("dialog")).toContainText("with none below, it leaves them as they are");
	await expect(dialog).toContainText("No subagent models: applying this preset leaves the current ones as they are.");
	const save = dialog.getByTestId("save-agents");
	await expect(save).toBeDisabled();

	// Names are checked; a name in the list is not added twice.
	await dialog.getByTestId("new-agent").fill("1bad");
	await dialog.getByTestId("add-agent").click();
	await expect(dialog).toContainText("Use a letter, then letters, digits, - or _.");
	await dialog.getByTestId("new-agent").fill("reviewer");
	await dialog.getByTestId("add-agent").click();
	const agent = (name: string) => dialog.locator(`[data-testid="agent-row"][data-agent="${name}"]`);
	await expect(agent("reviewer")).toBeVisible();
	await dialog.getByTestId("new-agent").fill("reviewer");
	await dialog.getByTestId("add-agent").click();
	await expect(dialog).toContainText("That subagent is already in the list.");

	// A new subagent starts on the preset's default model; another model and its own thinking level are one choice each.
	await expect(agent("reviewer").getByTestId("agent-model")).toContainText("Claude Haiku 5.5", { timeout: 30_000 });
	await expect(agent("reviewer").getByTestId("agent-thinking")).toHaveAttribute("data-value", "low");
	await agent("reviewer").getByTestId("agent-model").click();
	await page.getByPlaceholder("Search models…").fill("Sonnet 5.5");
	await page.getByRole("option", { name: /Claude Sonnet 5\.5/ }).click();
	await choose(agent("reviewer").getByTestId("agent-thinking"), "high");
	await dialog.getByTestId("new-agent").fill("scout");
	await dialog.getByTestId("add-agent").click();
	await expect(agent("scout")).toBeVisible();
	await agent("scout").getByTestId("agent-remove").click();
	await expect(agent("scout")).toHaveCount(0);
	await expect(dialog.getByTestId("agents-unsaved")).toBeVisible();

	await expect(save).toBeEnabled();
	await save.click();
	await expect(toast(page, "Saved the subagent models of “fast”.")).toBeVisible();
	await expect(dialog).toHaveCount(0);
	await expect(row("fast").getByTestId("preset-agents-summary")).toContainText("reviewer → Claude Sonnet 5.5 · high");
	expect((await presetOf(request, "fast")).agentModelOverrides).toEqual({ reviewer: `${SONNET}:high` });
	// Only that preset's entry changed, and nothing of the roles in it.
	expect((await presetOf(request, "deep")).agentModelOverrides).toBeUndefined();
	expect((await presetOf(request, "fast")).roles.default).toBe(`${HAIKU}:low`);

	// Taking the last one away leaves a preset that sets none.
	await row("fast").getByTestId("edit-preset-agents").click();
	await expect(agent("reviewer")).toBeVisible();
	await agent("reviewer").getByTestId("agent-remove").click();
	await dialog.getByTestId("save-agents").click();
	await expect(toast(page, "“fast” no longer sets subagent models.")).toBeVisible();
	await expect(row("fast").getByTestId("preset-agents-summary")).toHaveCount(0);
	expect((await presetOf(request, "fast")).agentModelOverrides).toBeUndefined();
});

test("Settings › Presets: applying a preset replaces the subagent models with its own; a preset with none leaves them", async ({
	page,
	request,
}) => {
	await setSubagents(request, { scout: SONNET });
	await savePreset(request, "with", { reviewer: HAIKU });
	await savePreset(request, "without", {}, { ...DEEP, default: `${HAIKU}:low` });
	await page.goto("/#/settings/models");
	const row = (name: string) =>
		page.getByTestId("model-presets").locator(`[data-testid="preset-row"][data-preset="${name}"]`);

	await row("with").getByTestId("apply-preset").click();
	await expect(toast(page, "Applied preset “with”")).toBeVisible();
	await expect.poll(async () => (await globalConfig(request)).agentModelOverrides).toEqual({ reviewer: HAIKU });
	await expect(row("with")).toContainText("Active");

	// A preset that sets none applies its roles and leaves the subagent models as they are.
	await row("without").getByTestId("apply-preset").click();
	await expect(toast(page, "Applied preset “without”")).toBeVisible();
	await expect(row("without")).toContainText("Active");
	expect((await globalConfig(request)).agentModelOverrides).toEqual({ reviewer: HAIKU });
});

test("composer: a switched conversation saves the subagent models it runs on, keeps them across a preset that sets none, and sets them as the default", async ({
	page,
	request,
}) => {
	await savePreset(request, "review", { reviewer: HAIKU });
	await savePreset(request, "bare", {});
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), work);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toContainText("Haiku 5.5", { timeout: 60_000 });
	const item = (name: string) => page.getByTestId("preset-menu").locator(`[data-preset="${name}"]`);

	await page.getByTestId("preset-picker").click();
	await item("review").click();
	await expect(toast(page, "Switched to preset “review”.")).toBeVisible();
	await expect(page.getByTestId("preset-picker")).toContainText("review");

	// The menu marks the preset that carries them, and says so in words a screen reader reads (a `title` is not
	// announced): the tooltip names the models, the item's own name says it sets subagent models.
	await page.getByTestId("preset-picker").click();
	const mark = item("review").getByTestId("preset-carries-agents");
	await expect(mark).toBeVisible();
	await expect(mark).toHaveAttribute("title", /^Also sets subagent models: reviewer → /);
	await expect(item("review")).toContainText("subagent models");
	await expect(item("bare").getByTestId("preset-carries-agents")).toHaveCount(0);
	// The accessible name of the marked item carries it, which is what a reader hears before choosing.
	expect(await item("review").evaluate((el) => el.textContent)).toContain("subagent models");
	// The menu is still open: Save current is in it.
	await page.getByTestId("preset-save-current").click();
	await expect(page.getByTestId("preset-agents-note")).toContainText("subagent models reviewer → ");
	await page.getByTestId("preset-name").fill("copyreview");
	await page.getByTestId("preset-name-submit").click();
	await expect(toast(page, "Saved preset “copyreview”.")).toBeVisible();
	expect((await presetOf(request, "copyreview")).agentModelOverrides).toEqual({ reviewer: HAIKU });
	expect((await globalConfig(request)).agentModelOverrides).toEqual({});

	// A preset that sets none leaves the conversation's: the next save still names them.
	await page.getByTestId("preset-picker").click();
	await item("bare").click();
	await expect(toast(page, "Switched to preset “bare”.")).toBeVisible();
	// `review` and `bare` have the same roles: the conversation shows the one it was switched to (`review`, picked first, was
	// shown though `bare` comes before it by name).
	await expect(page.getByTestId("preset-picker")).toContainText("bare");
	await page.getByTestId("preset-picker").click();
	await page.getByTestId("preset-save-current").click();
	await expect(page.getByTestId("preset-agents-note")).toContainText("subagent models reviewer → ");
	await page.keyboard.press("Escape");

	// Set as default brings them to the global config.
	await page.getByTestId("preset-picker").click();
	await page.getByTestId("preset-set-default").click();
	await expect(toast(page, "Default models set to")).toBeVisible();
	await expect.poll(async () => (await globalConfig(request)).agentModelOverrides).toEqual({ reviewer: HAIKU });
});

test("composer: a conversation that follows the config saves the config's subagent models, and says none when it has none", async ({
	page,
	request,
}) => {
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), work);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toContainText("Haiku 5.5", { timeout: 60_000 });
	await page.getByTestId("preset-picker").click();
	await page.getByTestId("preset-save-current").click();
	await expect(page.getByTestId("preset-agents-note")).toContainText("No subagent models are set");
	await page.keyboard.press("Escape");

	await setSubagents(request, { scout: SONNET });
	await page.reload();
	await expect(page.getByTestId("model-picker")).toContainText("Haiku 5.5", { timeout: 60_000 });
	await page.getByTestId("preset-picker").click();
	await page.getByTestId("preset-save-current").click();
	await expect(page.getByTestId("preset-agents-note")).toContainText("subagent models scout → ");
	await page.getByTestId("preset-name").fill("followed");
	await page.getByTestId("preset-name-submit").click();
	await expect(toast(page, "Saved preset “followed”.")).toBeVisible();
	expect((await presetOf(request, "followed")).agentModelOverrides).toEqual({ scout: SONNET });
});

test("the Chinese interface calls them 子代理 in the editor, the note and the rule", async ({ page, request }) => {
	await page.addInitScript(() => localStorage.setItem("ompw.lang", "zh-CN"));
	await savePreset(request, "fast", { reviewer: HAIKU });
	await page.goto("/#/settings/models");
	const section = page.getByTestId("model-presets");
	const row = section.locator('[data-testid="preset-row"][data-preset="fast"]');
	await expect(row.getByTestId("preset-agents-summary")).toContainText("子代理：reviewer → ", { timeout: 30_000 });
	await expect(page.getByTestId("preset-agents-rule")).toContainText("子代理模型");
	await section.getByTestId("save-current-preset").click();
	await expect(page.getByTestId("preset-agents-note")).toContainText("子代理模型");
	await page.keyboard.press("Escape");
	await row.getByTestId("edit-preset-agents").click();
	await expect(page.getByRole("dialog")).toContainText("子代理模型 · fast");
	await expect(page.getByTestId("new-agent")).toHaveAttribute("placeholder", /子代理/);
});
