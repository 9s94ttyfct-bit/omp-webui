import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type APIRequestContext, expect, type Page, test } from "./fixtures.ts";

/**
 * Settings › Presets: one Edit dialog per saved global preset (role models, default thinking level, subagent models, saved
 * in one write), read-only project presets, and the active preset listed first — in Settings (the config's) and in the
 * composer's menu (the conversation's). The presets are omp's own, in the isolated config the E2E server uses; switching
 * makes no model call. The config file is put back after every test, as `presets.spec.ts` does.
 */

let agentDir: string;
let work: string;
let configFile: string;
let original = "";

const HAIKU = "anthropic/claude-haiku-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";
const csrf = { "x-omp-webui": "1" };
/** The test server's roles with the default role moved to Sonnet. */
const DEEP = { default: `${SONNET}:high`, smol: HAIKU, slow: HAIKU, tiny: `${HAIKU}:low`, commit: HAIKU };

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
	rmSync(join(work, ".omp"), { recursive: true, force: true });
});

const globalConfig = async (request: APIRequestContext) => (await request.get("/api/model-config")).json();
const presetOf = async (request: APIRequestContext, name: string) =>
	(await globalConfig(request)).presets.find((p: { name: string }) => p.name === name);
const toast = (page: Page, text: string) => page.getByTestId("toast").filter({ hasText: text });

/**
 * `aaa` (Sonnet as the default model) sorts before `zzz` (what the config is now, so the active one): by name the first is
 * not the active one, which is what ordering has to fix.
 */
async function seed(request: APIRequestContext) {
	let r = await request.post("/api/model-config/preset/save", { headers: csrf, data: { name: "zzz" } });
	expect(r.ok()).toBe(true);
	r = await request.post("/api/model-config/preset/save", {
		headers: csrf,
		data: { name: "aaa", roles: DEEP, defaultThinkingLevel: "high", agentModelOverrides: { scout: HAIKU } },
	});
	expect(r.ok()).toBe(true);
}

const listed = async (page: Page, testid: string, scope: string) =>
	page
		.getByTestId(scope)
		.locator(`[data-testid="${testid}"]`)
		.evaluateAll((els) => els.map((e) => e.getAttribute("data-preset")));

test("Settings › Presets lists the config's active preset first, marked, and the others in their order", async ({
	page,
	request,
}) => {
	await seed(request);
	await request.post("/api/model-config/preset/save", {
		headers: csrf,
		data: { name: "mmm", roles: { default: HAIKU }, defaultThinkingLevel: "low" },
	});
	await page.goto("/#/settings/models");
	const section = page.getByTestId("model-presets");
	await expect(section.getByTestId("preset-row").first()).toBeVisible({ timeout: 30_000 });
	expect(await listed(page, "preset-row", "model-presets")).toEqual(["zzz", "aaa", "mmm"]);
	await expect(section.locator('[data-preset="zzz"]')).toContainText("Active");
	await expect(section.locator('[data-preset="aaa"]')).not.toContainText("Active");

	// Applying another preset makes it the active one, and it moves up.
	await section.locator('[data-preset="aaa"]').getByTestId("apply-preset").click();
	await expect(toast(page, "Applied preset “aaa”.")).toBeVisible();
	await expect.poll(() => listed(page, "preset-row", "model-presets")).toEqual(["aaa", "mmm", "zzz"]);
	await expect(section.locator('[data-preset="aaa"]')).toContainText("Active");
	await expect(section.locator('[data-preset="zzz"]')).not.toContainText("Active");
});

test("the composer's menu lists the conversation's active preset first, marked; a conversation switched elsewhere has its own", async ({
	page,
	request,
}) => {
	await seed(request);
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), work);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toContainText("Haiku 5.5", { timeout: 60_000 });

	await page.getByTestId("preset-picker").click();
	const menu = page.getByTestId("preset-menu");
	await expect(menu.getByTestId("preset-item")).toHaveCount(2);
	expect(await listed(page, "preset-item", "preset-menu")).toEqual(["zzz", "aaa"]);
	await expect(menu.locator('[data-preset="zzz"]').getByTestId("preset-active-mark")).toBeVisible();
	await expect(menu.getByTestId("preset-active-mark")).toHaveCount(1);

	// Switching this conversation to `aaa` makes it the active one here, first and marked.
	await menu.locator('[data-preset="aaa"]').click();
	await expect(toast(page, "Switched to preset “aaa”.")).toBeVisible();
	await expect(page.getByTestId("model-picker")).toContainText("Sonnet 5.5", { timeout: 30_000 });
	await page.getByTestId("preset-picker").click();
	expect(await listed(page, "preset-item", "preset-menu")).toEqual(["aaa", "zzz"]);
	await expect(menu.locator('[data-preset="aaa"]').getByTestId("preset-active-mark")).toBeVisible();
	await expect(menu.locator('[data-preset="aaa"]')).toHaveAttribute("aria-checked", "true");
	// The config's own order and active preset are untouched by a conversation's switch.
	expect((await globalConfig(request)).active).toBe("zzz");
});

test("a conversation on no preset (Custom) marks none, and the list stays in its order", async ({ page, request }) => {
	await seed(request);
	await request.post("/api/model-config/roles", {
		headers: csrf,
		data: { roles: { default: `${SONNET}:low`, smol: HAIKU }, defaultThinkingLevel: "high" },
	});
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), work);
	await page.goto("/");
	await expect(page.getByTestId("preset-picker")).toContainText("Custom", { timeout: 60_000 });
	await page.getByTestId("preset-picker").click();
	await expect(page.getByTestId("preset-menu").getByTestId("preset-item")).toHaveCount(2);
	expect(await listed(page, "preset-item", "preset-menu")).toEqual(["aaa", "zzz"]);
	await expect(page.getByTestId("preset-active-mark")).toHaveCount(0);
});

test("Settings › Presets: one Edit dialog changes a preset's roles, thinking level and subagent models in one save", async ({
	page,
	request,
}) => {
	await seed(request);
	const bystander = await presetOf(request, "zzz");
	await page.goto("/#/settings/models");
	const section = page.getByTestId("model-presets");
	const row = (name: string) => section.locator(`[data-testid="preset-row"][data-preset="${name}"]`);
	await expect(row("aaa")).toBeVisible({ timeout: 30_000 });

	await row("aaa").getByTestId("edit-preset").click();
	const dialog = page.getByTestId("preset-edit-dialog");
	await expect(page.getByRole("dialog")).toContainText("Edit preset · aaa");
	await expect(dialog.getByTestId("default-thinking")).toHaveValue("high");
	await expect(dialog.locator('[data-testid="role-row"][data-role="default"]').getByTestId("role-model")).toContainText(
		"Claude Sonnet 5.5",
		{ timeout: 30_000 },
	);
	await expect(dialog.locator('[data-testid="agent-row"][data-agent="scout"]')).toBeVisible();
	const save = dialog.getByTestId("save-preset-edit");
	await expect(save).toBeDisabled();

	// Roles: another model for one role, and a role removed.
	const role = (name: string) => dialog.locator(`[data-testid="role-row"][data-role="${name}"]`);
	await role("smol").getByTestId("role-model").click();
	await page.getByPlaceholder("Search models…").fill("Sonnet 5.5");
	await page.getByRole("option", { name: /Claude Sonnet 5\.5/ }).click();
	await role("commit").getByTestId("role-remove").click();
	await expect(role("commit")).toHaveCount(0);
	// The default thinking level, which the preset may also leave unset.
	await dialog.getByTestId("default-thinking").selectOption("xhigh");
	// Subagents: one added, the one it had given a thinking level.
	await dialog.getByTestId("new-agent").fill("reviewer");
	await dialog.getByTestId("add-agent").click();
	const agent = (name: string) => dialog.locator(`[data-testid="agent-row"][data-agent="${name}"]`);
	await expect(agent("reviewer")).toBeVisible();
	await agent("scout").getByTestId("agent-thinking").selectOption("low");
	await expect(dialog.getByTestId("edit-unsaved")).toBeVisible();

	await expect(save).toBeEnabled();
	await save.click();
	await expect(toast(page, "Saved preset “aaa”.")).toBeVisible();
	await expect(dialog).toHaveCount(0);

	const edited = await presetOf(request, "aaa");
	expect(edited).toMatchObject({
		defaultThinkingLevel: "xhigh",
		roles: { default: `${SONNET}:high`, smol: SONNET, slow: HAIKU, tiny: `${HAIKU}:low` },
		agentModelOverrides: { scout: `${HAIKU}:low`, reviewer: `${SONNET}:high` },
	});
	expect(edited.roles.commit).toBeUndefined();
	// One preset changed; the other, and the roles in use, did not.
	expect(await presetOf(request, "zzz")).toEqual(bystander);
	expect((await globalConfig(request)).roles.default).toBe(bystander.roles.default);
	await expect(row("aaa").getByTestId("preset-agents-summary")).toContainText("scout → ");

	// A preset may stop setting a thinking level and subagent models: both keys go.
	await row("aaa").getByTestId("edit-preset").click();
	await dialog.getByTestId("default-thinking").selectOption({ label: "Not set (keep the current level)" });
	for (const name of ["scout", "reviewer"]) await agent(name).getByTestId("agent-remove").click();
	await dialog.getByTestId("save-preset-edit").click();
	await expect(dialog).toHaveCount(0);
	const bare = await presetOf(request, "aaa");
	expect(bare.defaultThinkingLevel).toBeUndefined();
	expect(bare.agentModelOverrides).toBeUndefined();
	expect(bare.roles.smol).toBe(SONNET);
});

test("Settings › Presets: a preset's Edit dialog cannot be saved without a role, and presets a project defines have no Edit", async ({
	page,
	request,
}) => {
	await seed(request);
	mkdirSync(join(work, ".omp"), { recursive: true });
	writeFileSync(
		join(work, ".omp", "config.yml"),
		["modelPresets:", "  projonly:", "    modelRoles:", `      default: ${SONNET}:low`, ""].join("\n"),
	);
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), work);
	await page.goto("/#/settings/models");
	const section = page.getByTestId("model-presets");
	await expect(page.getByTestId("project-presets")).toBeVisible({ timeout: 30_000 });
	// Read-only: no buttons at all on a project preset's row, and the global list does not hold it.
	await expect(page.getByTestId("project-presets").locator('[data-preset="projonly"]').getByRole("button")).toHaveCount(
		0,
	);
	await expect(page.getByTestId("project-presets").getByTestId("edit-preset")).toHaveCount(0);
	await expect(section.locator('[data-testid="preset-row"][data-preset="projonly"]')).toHaveCount(0);

	// Taking every role away leaves nothing to save.
	await section.locator('[data-testid="preset-row"][data-preset="aaa"]').getByTestId("edit-preset").click();
	const dialog = page.getByTestId("preset-edit-dialog");
	for (const name of ["default", "smol", "slow", "tiny", "commit"]) {
		await dialog.locator(`[data-testid="role-row"][data-role="${name}"]`).getByTestId("role-remove").click();
	}
	await expect(dialog.getByTestId("save-preset-edit")).toBeDisabled();
	// And the server refuses a project's preset by name, so no request can change it.
	const refused = await request.post("/api/model-config/preset/edit", {
		headers: csrf,
		data: { name: "projonly", roles: { default: HAIKU }, defaultThinkingLevel: null, agentModelOverrides: {} },
	});
	expect(refused.status()).toBe(404);
});
