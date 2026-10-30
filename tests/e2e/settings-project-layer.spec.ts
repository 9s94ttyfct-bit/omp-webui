import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { type APIRequestContext, expect, type Page, test } from "./fixtures.ts";

/**
 * Settings edits the global omp config, but omp merges the project's own `.omp/config.yml` over it. The page is
 * used in the folder of the last conversation started from the new-chat page (`ompw.cwd`): Settings says which roles
 * and which thinking level that project overrides, where omp saves role changes (`modelRoleStorage`), and refuses a
 * preset name the project defines (#442). The project config is the real omp's; no model is called.
 */

const HAIKU = "anthropic/claude-haiku-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";

let agentDir: string;
let work: string;
let configFile: string;
let original = "";
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

const csrf = { "x-omp-webui": "1" };

async function projectConfig(page: Page, lines: string[]) {
	mkdirSync(join(work, ".omp"), { recursive: true });
	writeFileSync(join(work, ".omp", "config.yml"), `${lines.join("\n")}\n`);
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), work);
}

const globalConfig = async (request: APIRequestContext) => (await request.get("/api/model-config")).json();

test("Settings says which roles and thinking level the project overrides, and where omp saves role changes", async ({
	page,
	request,
}) => {
	const before = await globalConfig(request);
	await projectConfig(page, [
		"modelRoleStorage: project",
		"defaultThinkingLevel: medium",
		"modelRoles:",
		`  smol: ${SONNET}:high`,
		`  plan: ${SONNET}`,
	]);
	await page.goto("/#/settings/models");

	const layer = page.getByTestId("project-layer");
	await expect(layer).toBeVisible({ timeout: 30_000 });
	await expect(layer.locator('[data-role="smol"]')).toContainText("Claude Sonnet 5.5 · high", { timeout: 30_000 });
	await expect(layer.locator('[data-role="plan"]')).toContainText("Claude Sonnet 5.5");
	// The roles the project leaves alone are not listed.
	await expect(layer.getByTestId("project-role")).toHaveCount(2);
	await expect(layer.getByTestId("project-thinking")).toContainText("medium");
	await expect(page.getByTestId("role-storage")).toContainText("“project”");

	// The card is headed like every other card of the page: a 15px title and a 12px intro (#501).
	const heading = await layer.locator("h2").evaluate((el) => {
		const s = getComputedStyle(el);
		return { px: Number.parseFloat(s.fontSize), weight: Number(s.fontWeight) };
	});
	expect(heading, "the title of the project card").toMatchObject({ px: 15, weight: 600 });
	const hint = await layer
		.getByText("omp merges this project's config over the global one", { exact: false })
		.first()
		.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize));
	expect(hint, "the intro of the project card").toBe(12);

	// The editor is the global config's: Haiku for `smol`, and the role the project overrides is marked there.
	const roles = page.getByTestId("model-roles");
	await expect(roles.locator('[data-role="smol"]').getByTestId("role-model")).toContainText("Claude Haiku 5.5");
	await expect(roles.locator('[data-role="smol"]').getByTestId("role-overridden")).toBeVisible();
	await expect(roles.getByTestId("role-overridden")).toHaveCount(1);
	expect(await globalConfig(request)).toEqual(before);
});

test("a project that only defines presets overrides no role: no project section, no storage note", async ({ page }) => {
	await projectConfig(page, ["modelPresets:", "  projp:", "    modelRoles:", `      default: ${SONNET}`]);
	await page.goto("/#/settings/models");

	await expect(page.getByTestId("project-presets")).toBeVisible({ timeout: 30_000 });
	await expect(page.getByTestId("model-roles").getByTestId("role-row").first()).toBeVisible();
	await expect(page.getByTestId("project-layer")).toHaveCount(0);
	await expect(page.getByTestId("role-storage")).toHaveCount(0);
	await expect(page.getByTestId("role-overridden")).toHaveCount(0);
});

test("a preset name the project defines is refused when saving, renaming or copying, even over a global preset of it", async ({
	page,
	request,
}) => {
	await request.post("/api/model-config/preset/save", { headers: csrf, data: { name: "fast" } });
	await request.post("/api/model-config/preset/save", { headers: csrf, data: { name: "mine" } });
	const before = await globalConfig(request);
	await projectConfig(page, [
		"modelPresets:",
		"  projp:",
		"    modelRoles:",
		`      default: ${SONNET}`,
		"  fast:",
		"    modelRoles:",
		`      default: ${HAIKU}:high`,
	]);
	await page.goto("/#/settings/models");
	const section = page.getByTestId("model-presets");
	await expect(page.getByTestId("project-presets")).toBeVisible({ timeout: 30_000 });
	const name = page.getByTestId("preset-name");
	const message = page.getByTestId("preset-name-message");
	const submit = page.getByTestId("preset-name-submit");

	// Save current: a name only the project has, and one the global config has too (that would be a silent replace).
	await section.getByTestId("save-current-preset").click();
	for (const taken of ["projp", "fast"]) {
		await name.fill(taken);
		await expect(message).toContainText("The project defines a preset with this name");
		await expect(submit).toBeDisabled();
	}
	// A name nobody has is fine, and replacing a global preset the project does not define still says so.
	await name.fill("free");
	await expect(message).not.toContainText("project");
	await expect(submit).toBeEnabled();
	await name.fill("mine");
	await expect(message).toContainText("A preset named “mine” exists. Saving replaces it.");
	await expect(submit).toBeEnabled();
	await page.getByRole("button", { name: "Cancel" }).click();

	// Rename and copy never take it either.
	await section.locator('[data-testid="preset-row"][data-preset="mine"]').getByTestId("rename-preset").click();
	await name.fill("projp");
	await expect(message).toContainText("The project defines a preset with this name");
	await expect(submit).toBeDisabled();
	await page.getByRole("button", { name: "Cancel" }).click();
	await section.locator('[data-testid="preset-row"][data-preset="mine"]').getByTestId("duplicate-preset").click();
	await name.fill("fast");
	await expect(message).toContainText("The project defines a preset with this name");
	await expect(submit).toBeDisabled();
	await page.getByRole("button", { name: "Cancel" }).click();

	await sleep(300);
	expect(await globalConfig(request)).toEqual(before);
});
