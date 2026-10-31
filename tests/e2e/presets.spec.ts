import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { holdState } from "../support/hold-state.ts";
import { ownSession, sessionRow, startLive } from "../support/live.ts";
import { choose } from "../support/select.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { type APIRequestContext, expect, type Page, test } from "./fixtures.ts";

/**
 * Model presets: the composer's preset menu (switch, save current, set as default, cycle with the keyboard) and the
 * Settings sections (model roles, preset management). Presets are omp's own, in the isolated config the E2E server
 * uses; switching makes no model call. The config file is put back after every test, so the other specs expect the
 * model the server started with even when a spec changed the default.
 */

let agentDir: string;
let work: string;
let configFile: string;

const HAIKU = "anthropic/claude-haiku-5-5";
const SONNET = "anthropic/claude-sonnet-5-5";
/** The test server's roles with the default role moved to Sonnet. */
const DEEP = {
	default: `${SONNET}:high`,
	smol: HAIKU,
	slow: HAIKU,
	tiny: `${HAIKU}:low`,
	commit: HAIKU,
};

/**
 * A preset switch applies to its conversation only: the server gives that conversation's omp an overlay with the
 * preset's roles and never writes config.yml. Only "Set as default" (and Settings) write the global config, and omp
 * saves that in the background, 100 ms after the change (`savedDefault` waits for it). The config file is also put
 * back before each spec, whatever the last one left.
 */
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

/** The default model of the global config as omp saved it. */
const savedDefault = (request: APIRequestContext) =>
	expect.poll(async () => (await (await request.get("/api/model-config")).json()).roles.default, { timeout: 15_000 });

/** The global config (roles, thinking level, presets, active preset) as `/api/model-config` reports it. */
const globalConfig = async (request: APIRequestContext) => (await request.get("/api/model-config")).json();

/**
 * The global config is still what it was (`before`, taken after `seed`). omp would save a change 100 ms after making
 * it, so a moment is given for one to show; the server's own reload of the config follows the file.
 */
async function expectGlobalUntouched(request: APIRequestContext, before: unknown) {
	await sleep(600);
	expect(await globalConfig(request)).toEqual(before);
}

const csrf = { "x-omp-webui": "1" };

/** `fast` is what the config is now (Haiku); `deep` is the same with Sonnet as the default model. */
async function seed(request: APIRequestContext) {
	await request.post("/api/model-config/preset/save", { headers: csrf, data: { name: "fast" } });
	await request.post("/api/model-config/preset/save", {
		headers: csrf,
		data: { name: "deep", roles: DEEP, defaultThinkingLevel: "high" },
	});
}

async function openNewChat(page: Page) {
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), work);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toContainText("Haiku 5.5", { timeout: 60_000 });
}

const toast = (page: Page, text: string) => page.getByTestId("toast").filter({ hasText: text });
const item = (page: Page, name: string) => page.getByTestId("preset-menu").locator(`[data-preset="${name}"]`);

test("switching presets in the composer changes this conversation's models only, without a model call", async ({
	page,
	request,
}) => {
	await seed(request);
	const before = await globalConfig(request);
	const tap = await tapSocket(page);
	await openNewChat(page);

	// The config is `fast`, so that is the active preset.
	await expect(page.getByTestId("preset-picker")).toContainText("fast");
	await page.getByTestId("preset-picker").click();
	await expect(item(page, "fast")).toHaveAttribute("aria-checked", "true");
	await expect(item(page, "deep")).toHaveAttribute("aria-checked", "false");
	// Each preset says what it sets (model names come from omp's model list).
	await expect(item(page, "deep")).toContainText("Claude Sonnet 5.5 · high");
	await expect(item(page, "fast")).toContainText("Claude Haiku 5.5 · low");

	await item(page, "deep").click();
	await expect(toast(page, "Switched to preset “deep”.")).toBeVisible();
	await expect(page.getByTestId("model-picker")).toContainText("Sonnet 5.5", { timeout: 30_000 });
	await expect(page.getByTestId("preset-picker")).toContainText("deep");

	await page.getByTestId("preset-picker").click();
	await expect(item(page, "deep")).toHaveAttribute("aria-checked", "true");
	await expect(item(page, "fast")).toHaveAttribute("aria-checked", "false");
	await page.keyboard.press("Escape");

	// The page asked the server to switch this conversation; no prompt (and so no `/modelpreset`) reached omp, and
	// the global roles, thinking level and presets are exactly what they were.
	expect(tap.sent.filter((m) => m.t === "model_preset").map((m) => m.name)).toEqual(["deep"]);
	expect(tap.commands("prompt")).toEqual([]);
	await expectGlobalUntouched(request, before);
});

test("Set as default is what changes the global default, and nothing else in the conversation does", async ({
	page,
	request,
}) => {
	await seed(request);
	const before = await globalConfig(request);
	await openNewChat(page);
	await page.getByTestId("preset-picker").click();
	await item(page, "deep").click();
	await expect(page.getByTestId("model-picker")).toContainText("Sonnet 5.5", { timeout: 30_000 });
	await expectGlobalUntouched(request, before);

	await page.getByTestId("preset-picker").click();
	await expect(page.getByTestId("preset-set-default")).toBeEnabled();
	await page.getByTestId("preset-set-default").click();
	await expect(toast(page, "Default models set to")).toBeVisible();
	await savedDefault(request).toBe(`${SONNET}:high`);
	const config = await globalConfig(request);
	expect(config.roles).toEqual(DEEP);
	expect(config.defaultThinkingLevel).toBe("high");
	expect(config.active).toBe("deep");
	// The conversation itself is where it was.
	await expect(page.getByTestId("preset-picker")).toContainText("deep");
	await expect(page.getByTestId("model-picker")).toContainText("Sonnet 5.5");
});

/** A project that overrides `smol` and adds a role of its own; the global config has neither. */
function writeProjectOverrides() {
	mkdirSync(join(work, ".omp"), { recursive: true });
	writeFileSync(
		join(work, ".omp", "config.yml"),
		["modelRoles:", `  smol: ${SONNET}:low`, `  projectonly: ${SONNET}`, ""].join("\n"),
	);
}

test("Set as default writes what the conversation's preset sets, not the roles its project overrides", async ({
	page,
	request,
}) => {
	await seed(request);
	writeProjectOverrides();
	await openNewChat(page);
	await page.getByTestId("preset-picker").click();
	await item(page, "deep").click();
	await expect(page.getByTestId("model-picker")).toContainText("Sonnet 5.5", { timeout: 30_000 });

	await page.getByTestId("preset-picker").click();
	await page.getByTestId("preset-set-default").click();
	await expect(toast(page, "Default models set to")).toBeVisible();
	await savedDefault(request).toBe(`${SONNET}:high`);
	// The global config has the preset's roles: not the project's `smol`, and not its extra role.
	expect((await globalConfig(request)).roles).toEqual(DEEP);
});

test("Set as default in a conversation never switched keeps the project's role overrides out of the global config", async ({
	page,
	request,
}) => {
	await seed(request);
	const before = await globalConfig(request);
	writeProjectOverrides();
	await openNewChat(page);
	await page.getByTestId("preset-picker").click();
	await page.getByTestId("preset-set-default").click();
	await expect(toast(page, "Default models set to")).toBeVisible();
	await expectGlobalUntouched(request, before);
	expect((await globalConfig(request)).roles).toEqual(before.roles);
});

test("a conversation moved to another model by the model picker is Custom", async ({ page, request }) => {
	await seed(request);
	await openNewChat(page);
	await expect(page.getByTestId("preset-picker")).toContainText("fast");

	await page.getByTestId("model-picker").click();
	await page.getByPlaceholder("Search models…").fill("Opus 5.5");
	await page.getByRole("option", { name: /Claude Opus 5\.5/ }).click();
	await expect(page.getByTestId("model-picker")).toContainText("Opus 5.5", { timeout: 30_000 });
	await expect(page.getByTestId("preset-picker")).toContainText("Custom");

	// Back on a model a preset names, that preset is the active one again.
	await page.getByTestId("model-picker").click();
	await page.getByPlaceholder("Search models…").fill("Sonnet 5.5");
	await page.getByRole("option", { name: /Claude Sonnet 5\.5/ }).click();
	await expect(page.getByTestId("preset-picker")).toContainText("deep");
});

test("Save current as… checks the name, saves what the conversation runs, and the new preset is the active one", async ({
	page,
	request,
}) => {
	await seed(request);
	await openNewChat(page);

	await page.getByTestId("preset-picker").click();
	await page.getByTestId("preset-save-current").click();
	const name = page.getByTestId("preset-name");
	const message = page.getByTestId("preset-name-message");
	const submit = page.getByTestId("preset-name-submit");
	await expect(name).toBeFocused();
	await expect(submit).toBeDisabled();

	await name.fill("1bad");
	await expect(message).toContainText("Start with a letter");
	await expect(submit).toBeDisabled();
	await name.fill("has space");
	await expect(submit).toBeDisabled();
	// A name in use is replaced only if the button says so.
	await name.fill("fast");
	await expect(message).toContainText("Saving replaces it");
	await expect(submit).toContainText("Replace");

	await name.fill("alpha");
	await expect(submit).toBeEnabled();
	await submit.click();
	await expect(toast(page, "Saved preset “alpha”.")).toBeVisible();
	await expect(name).toHaveCount(0);
	// Same models as `fast`, and `alpha` comes first by name: it is the active one.
	await expect(page.getByTestId("preset-picker")).toContainText("alpha");
	const config = await (await request.get("/api/model-config")).json();
	expect(config.presets.map((p: { name: string }) => p.name)).toEqual(["alpha", "deep", "fast"]);
	expect(config.presets[0].roles.default).toBe(`${HAIKU}:low`);
});

test("saving after the model picker moved the conversation keeps that model, and is active without touching the config", async ({
	page,
	request,
}) => {
	await seed(request);
	await openNewChat(page);
	await page.getByTestId("model-picker").click();
	await page.getByPlaceholder("Search models…").fill("Opus 5.5");
	await page.getByRole("option", { name: /Claude Opus 5\.5/ }).click();
	await expect(page.getByTestId("preset-picker")).toContainText("Custom", { timeout: 30_000 });

	await page.getByTestId("preset-picker").click();
	await page.getByTestId("preset-save-current").click();
	await page.getByTestId("preset-name").fill("opus");
	await page.getByTestId("preset-name-submit").click();
	await expect(toast(page, "Saved preset “opus”.")).toBeVisible();

	await expect(page.getByTestId("preset-picker")).toContainText("opus");
	const config = await (await request.get("/api/model-config")).json();
	const saved = config.presets.find((p: { name: string }) => p.name === "opus");
	expect(saved.roles.default).toMatch(/^anthropic\/claude-opus-5-5(:\w+)?$/);
	// The other roles are the configured ones; the config itself still has Haiku as its default.
	expect(saved.roles.smol).toBe(HAIKU);
	expect(config.roles.default).toBe(`${HAIKU}:low`);
});

test("the shortcut cycles through the presets, saying which one", async ({ page, request }) => {
	await seed(request);
	const before = await globalConfig(request);
	await openNewChat(page);
	await expect(page.getByTestId("preset-picker")).toContainText("fast");

	await page.keyboard.press("ControlOrMeta+Shift+M");
	await expect(toast(page, "Switched to preset “deep”.")).toBeVisible();
	await expect(page.getByTestId("preset-picker")).toContainText("deep");
	await expect(page.getByTestId("model-picker")).toContainText("Sonnet 5.5", { timeout: 30_000 });

	// Past the last one it starts again.
	await page.keyboard.press("ControlOrMeta+Shift+M");
	await expect(toast(page, "Switched to preset “fast”.")).toBeVisible();
	await expect(page.getByTestId("preset-picker")).toContainText("fast");
	await expect(page.getByTestId("model-picker")).toContainText("Haiku 5.5", { timeout: 30_000 });
	await expectGlobalUntouched(request, before);
});

for (const p of [
	{ name: "Windows", platform: "Win32", hint: "Ctrl+Shift+M" },
	{ name: "macOS", platform: "MacIntel", hint: "⌘⇧M" },
]) {
	test(`the menu shows the cycle shortcut with ${p.name} key names`, async ({ page, request }) => {
		await seed(request);
		await page.addInitScript(
			(platform) => Object.defineProperty(navigator, "platform", { get: () => platform }),
			p.platform,
		);
		await openNewChat(page);
		await page.getByTestId("preset-picker").click();
		await expect(page.getByTestId("preset-menu")).toContainText(p.hint);
		if (p.platform === "Win32") await expect(page.getByTestId("preset-menu")).not.toContainText(/[⌘⇧]/);
	});
}

test("without presets the menu invites saving one, and the shortcut says there is nothing to switch to", async ({
	page,
}) => {
	await openNewChat(page);
	await expect(page.getByTestId("preset-picker")).toContainText("Presets");
	await page.keyboard.press("ControlOrMeta+Shift+M");
	await expect(toast(page, "No presets to switch between")).toBeVisible();
	await page.getByTestId("preset-picker").click();
	await expect(page.getByTestId("preset-menu")).toContainText("No presets yet");
	await page.getByTestId("preset-manage").click();
	await expect(page.getByTestId("settings-page")).toBeVisible();
	// "Manage presets" shows the page that holds the presets, with the card in front.
	await expect(page.getByTestId("model-presets")).toBeVisible();
});

test("when the presets cannot be read the chip says so, and opening it reads them again", async ({ page }) => {
	let broken = true;
	await page.route(/\/api\/model-config(\?|$)/, (route) =>
		broken && route.request().method() === "GET"
			? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"config unreadable"}' })
			: route.continue(),
	);
	await openNewChat(page);
	const chip = page.getByTestId("preset-picker");
	await expect(chip).toHaveAttribute("data-failed", "");
	await expect(chip).toHaveAttribute("title", /Could not load presets/);
	broken = false;
	// Opening the menu reads the config again: the chip is a chip again once it has been read.
	await chip.click();
	await expect(chip).not.toHaveAttribute("data-failed");
	await expect(page.getByTestId("preset-menu")).not.toContainText("Could not load presets");
});

test("a conversation's menu switches that conversation only, and it keeps the preset when the page is reloaded", async ({
	page,
	request,
}) => {
	await seed(request);
	const before = await globalConfig(request);
	ownSession(0xd5, "Preset probe");
	const tap = await tapSocket(page);
	await page.goto("/");
	await startLive(page, tap, "Preset probe", "preset-probe");
	await expect(page.getByTestId("preset-picker")).toContainText("fast");

	await page.getByTestId("preset-picker").click();
	await item(page, "deep").click();
	await expect(toast(page, "Switched to preset “deep”.")).toBeVisible();
	await expect(page.getByTestId("model-picker")).toContainText("Sonnet 5.5", { timeout: 30_000 });
	await expect(page.getByTestId("preset-picker")).toContainText("deep");
	await expect(page.getByTestId("command-output")).toHaveCount(0);
	expect(tap.commands("prompt")).toEqual([]);
	await expectGlobalUntouched(request, before);

	// The page shows the saved conversation until it acts on it (its process is found again then): the preset is the one
	// the server remembers for the file, and the model is the one the transcript leaves, which names it by id.
	await page.reload();
	await expect(page.getByTestId("preset-picker")).toContainText("deep", { timeout: 30_000 });
	await expect(page.getByTestId("model-picker")).toContainText(/sonnet[- ]5[-.]5/i, { timeout: 30_000 });
	await page.getByTestId("preset-picker").click();
	await expect(item(page, "deep")).toHaveAttribute("aria-checked", "true");
	await expect(item(page, "fast")).toHaveAttribute("aria-checked", "false");
	await page.keyboard.press("Escape");
	await expectGlobalUntouched(request, before);
});

test("a switch in one conversation leaves another conversation, and the global default, as they were", async ({
	page,
	request,
}) => {
	await seed(request);
	const before = await globalConfig(request);
	ownSession(0xdb, "Preset first");
	ownSession(0xdc, "Preset second");
	const tap = await tapSocket(page);
	await page.goto("/");
	await startLive(page, tap, "Preset first", "preset-first");
	await page.getByTestId("preset-picker").click();
	await item(page, "deep").click();
	await expect(page.getByTestId("model-picker")).toContainText("Sonnet 5.5", { timeout: 30_000 });
	await expect(page.getByTestId("preset-picker")).toContainText("deep");

	// The second conversation was started after the switch and is still on the global default.
	await startLive(page, tap, "Preset second", "preset-second");
	await expect(page.getByTestId("preset-picker")).toContainText("fast");
	await expect(page.getByTestId("model-picker")).toContainText("Haiku 5.5", { timeout: 30_000 });

	// And the first one is where it was left.
	await sessionRow(page, "Preset first").click();
	await expect(page.getByTestId("preset-picker")).toContainText("deep");
	await expect(page.getByTestId("model-picker")).toContainText("Sonnet 5.5");
	await expectGlobalUntouched(request, before);
});

test("Settings: model roles are edited as a draft, saved to omp's config, and can be discarded", async ({
	page,
	request,
}) => {
	await page.goto("/#/settings/models");
	const roles = page.getByTestId("model-roles");
	await expect(roles).toBeVisible();
	const rows = roles.getByTestId("role-row");
	await expect(rows).toHaveCount(5, { timeout: 30_000 });
	await expect(rows.evaluateAll((els) => els.map((el) => el.getAttribute("data-role")))).resolves.toEqual([
		"default",
		"smol",
		"slow",
		"commit",
		"tiny",
	]);
	const row = (role: string) => roles.locator(`[data-role="${role}"]`);
	await expect(row("default").getByTestId("role-model")).toContainText("Claude Haiku 5.5", { timeout: 30_000 });
	// The button's accessible name carries the chosen model, not only the role (WCAG 2.5.3).
	await expect(roles.getByRole("button", { name: "Model for Default: Claude Haiku 5.5" })).toBeVisible();
	await expect(row("default").getByTestId("role-thinking")).toHaveAttribute("data-value", "low");
	const save = roles.getByTestId("save-roles");
	await expect(save).toBeDisabled();

	// Discard puts the draft back.
	await choose(roles.getByTestId("default-thinking"), "low");
	await expect(roles.getByTestId("roles-unsaved")).toBeVisible();
	await roles.getByTestId("discard-roles").click();
	await expect(roles.getByTestId("roles-unsaved")).toHaveCount(0);

	// Another model with its own level, a new role, a removed one, and a new default thinking level.
	await row("default").getByTestId("role-model").click();
	await page.getByPlaceholder("Search models…").fill("Sonnet 5.5");
	await page.getByRole("option", { name: /Claude Sonnet 5\.5/ }).click();
	await choose(row("default").getByTestId("role-thinking"), "high");
	await row("commit").getByTestId("role-remove").click();
	await roles.getByTestId("new-role").fill("1x");
	await roles.getByTestId("add-role").click();
	await expect(roles).toContainText("A role name starts with a letter");
	await roles.getByTestId("new-role").fill("plan");
	await roles.getByTestId("add-role").click();
	await expect(row("plan")).toBeVisible();
	await choose(roles.getByTestId("default-thinking"), "medium");
	await expect(roles.getByTestId("roles-unsaved")).toBeVisible();
	await expect(save).toBeEnabled();
	await save.click();
	await expect(toast(page, "Model roles saved.")).toBeVisible();
	await expect(roles.getByTestId("roles-unsaved")).toHaveCount(0);

	const config = await (await request.get("/api/model-config")).json();
	expect(config.roles).toEqual({
		default: `${SONNET}:high`,
		smol: HAIKU,
		slow: HAIKU,
		plan: `${SONNET}:high`,
		tiny: `${HAIKU}:low`,
	});
	expect(config.defaultThinkingLevel).toBe("medium");
});

test("Settings: presets can be applied, renamed, duplicated and deleted, with a confirmation for the last", async ({
	page,
	request,
}) => {
	await seed(request);
	await page.goto("/#/settings/models");
	const section = page.getByTestId("model-presets");
	const row = (name: string) => section.locator(`[data-testid="preset-row"][data-preset="${name}"]`);
	await expect(section.getByTestId("preset-row")).toHaveCount(2, { timeout: 30_000 });
	await expect(row("fast")).toContainText("Active");
	await expect(row("deep")).not.toContainText("Active");
	await expect(row("deep")).toContainText("Claude Sonnet 5.5 · high", { timeout: 30_000 });

	// Apply: the roles editor and the active badge follow.
	await row("deep").getByTestId("apply-preset").click();
	await expect(toast(page, "Applied preset “deep”")).toBeVisible();
	await expect(row("deep")).toContainText("Active");
	await expect(row("fast")).not.toContainText("Active");
	await expect(
		page.getByTestId("model-roles").locator('[data-role="default"]').getByTestId("role-model"),
	).toContainText("Claude Sonnet 5.5");

	// Rename keeps the preset, refuses a name in use or one omp would refuse.
	await row("deep").getByTestId("rename-preset").click();
	const name = page.getByTestId("preset-name");
	await expect(name).toHaveValue("deep");
	await name.fill("fast");
	await expect(page.getByTestId("preset-name-message")).toContainText("already exists");
	await expect(page.getByTestId("preset-name-submit")).toBeDisabled();
	await name.fill("-nope");
	await expect(page.getByTestId("preset-name-submit")).toBeDisabled();
	await name.fill("deeper");
	await page.getByTestId("preset-name-submit").click();
	await expect(toast(page, "Renamed to “deeper”.")).toBeVisible();
	await expect(row("deeper")).toContainText("Active");
	await expect(row("deep")).toHaveCount(0);

	// Duplicate suggests a free name.
	await row("deeper").getByTestId("duplicate-preset").click();
	await expect(page.getByTestId("preset-name")).toHaveValue("deeper-copy");
	await page.getByTestId("preset-name-submit").click();
	await expect(toast(page, "Created preset “deeper-copy”.")).toBeVisible();
	await expect(section.getByTestId("preset-row")).toHaveCount(3);

	// Delete asks first; cancelling keeps it.
	await row("deeper-copy").getByTestId("delete-preset").click();
	await expect(page.getByRole("dialog")).toContainText("Delete preset “deeper-copy”?");
	await page.getByRole("button", { name: "Cancel" }).click();
	await expect(row("deeper-copy")).toHaveCount(1);
	await row("deeper-copy").getByTestId("delete-preset").click();
	await page.getByTestId("confirm-delete-preset").click();
	await expect(toast(page, "Deleted preset “deeper-copy”.")).toBeVisible();
	await expect(row("deeper-copy")).toHaveCount(0);

	// Saved from Settings, under a name omp accepts.
	await section.getByTestId("save-current-preset").click();
	await page.getByTestId("preset-name").fill("kept");
	await page.getByTestId("preset-name-submit").click();
	await expect(toast(page, "Saved preset “kept”.")).toBeVisible();
	await expect(row("kept")).toHaveCount(1);

	const config = await (await request.get("/api/model-config")).json();
	expect(config.presets.map((p: { name: string }) => p.name)).toEqual(["deeper", "fast", "kept"]);
});

test("presets a project defines are read-only in Settings, and still switch in that project's composer", async ({
	page,
	request,
}) => {
	await seed(request);
	const before = await globalConfig(request);
	mkdirSync(join(work, ".omp"), { recursive: true });
	writeFileSync(
		join(work, ".omp", "config.yml"),
		[
			"modelPresets:",
			"  projonly:",
			"    modelRoles:",
			`      default: ${SONNET}:low`,
			"    defaultThinkingLevel: low",
			"",
		].join("\n"),
	);
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), work);

	await page.goto("/#/settings/models");
	const projects = page.getByTestId("project-presets");
	await expect(projects).toBeVisible({ timeout: 30_000 });
	const row = projects.locator('[data-preset="projonly"]');
	await expect(row).toContainText("Project");
	await expect(row.getByRole("button")).toHaveCount(0);
	// The global list does not have it, so there is nothing to apply, rename or delete.
	await expect(
		page.getByTestId("model-presets").locator('[data-testid="preset-row"][data-preset="projonly"]'),
	).toHaveCount(0);

	await page.goto("/#/");
	await expect(page.getByTestId("model-picker")).toContainText("Haiku 5.5", { timeout: 60_000 });
	await page.getByTestId("preset-picker").click();
	await expect(item(page, "projonly")).toContainText("Project");
	await item(page, "projonly").click();
	await expect(toast(page, "Switched to preset “projonly”.")).toBeVisible();
	await expect(page.getByTestId("model-picker")).toContainText("Sonnet 5.5", { timeout: 30_000 });
	await expect(page.getByTestId("preset-picker")).toContainText("projonly");
	await expectGlobalUntouched(request, before);
});

test("a preset just picked is named at once, while omp's state still says the model it had before", async ({
	page,
	request,
}) => {
	// Only `deep`: nothing else can stand in for it, so a label that does not name it reads Custom.
	await request.post("/api/model-config/preset/save", {
		headers: csrf,
		data: { name: "deep", roles: DEEP, defaultThinkingLevel: "high" },
	});
	const state = await holdState(page);
	await openNewChat(page);
	await expect(page.getByTestId("preset-picker")).toContainText("Custom");

	// The answer to `get_state` is late (a slow connection): the switch itself is done and told.
	state.hold();
	await page.getByTestId("preset-picker").click();
	await item(page, "deep").click();
	await expect(toast(page, "Switched to preset “deep”.")).toBeVisible();
	await expect(page.getByTestId("preset-picker")).toContainText("deep");
	await expect(page.getByTestId("preset-picker")).not.toContainText("Custom");
	state.release();
	await expect(page.getByTestId("model-picker")).toContainText("Sonnet 5.5", { timeout: 30_000 });
	await expect(page.getByTestId("preset-picker")).toContainText("deep");
});
