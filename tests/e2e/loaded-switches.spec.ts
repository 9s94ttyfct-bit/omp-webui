import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FIXTURE_CWD, writeSimpleSession } from "../support/fixtures.ts";
import { openSidebar, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The Loaded dialog's switches for skills and plugins, against the real omp and no model call: a switch asks the
 * server, which has omp carry it out; the dialog then shows what omp reports. The folder the conversation runs in has
 * a skill of its own, and the user's omp has one linked plugin (both removed again at the end).
 */

let agentDir: string;
let project: string;
let plugin: string;
let sessionTitle = "";

const omp = (...args: string[]) =>
	spawnSync(process.env.OMP_BIN ?? "omp", args, {
		cwd: project,
		env: { ...process.env, HOME: process.env.OMPW_E2E_HOME, PI_CODING_AGENT_DIR: agentDir },
		encoding: "utf8",
	});
const config = () => readFileSync(join(agentDir, "config.yml"), "utf8");

test.beforeAll(() => {
	agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
	const root = process.env.OMPW_E2E_ROOT as string;
	project = join(root, "switch-project");
	plugin = join(root, "switch-plugin");
	mkdirSync(join(project, ".omp", "skills", "switch-skill"), { recursive: true });
	writeFileSync(
		join(project, ".omp", "skills", "switch-skill", "SKILL.md"),
		"---\nname: switch-skill\ndescription: A skill for the switch spec\n---\nSay hi.\n",
	);
	mkdirSync(plugin, { recursive: true });
	writeFileSync(join(plugin, "package.json"), JSON.stringify({ name: "switch-plugin", version: "1.0.0", omp: {} }));
	const linked = omp("plugin", "link", plugin);
	if (linked.status !== 0) throw new Error(`omp plugin link failed: ${linked.stderr}`);
});
test.afterAll(() => {
	omp("plugin", "uninstall", "switch-plugin");
});

/** A conversation of the spec's own, in the folder with the skill, with its omp started and the dialog open. */
async function openDialog(page: Page, n: number, probe: string) {
	sessionTitle = `Loaded switch probe ${probe}`;
	const file = writeSimpleSession(agentDir, n, sessionTitle);
	writeFileSync(file, readFileSync(file, "utf8").replace(FIXTURE_CWD, project));
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	await openSidebar(page);
	await startLive(page, tap, sessionTitle, `loaded-switch-${probe}`);
	await page.getByTestId("open-loaded").click();
	await expect(page.getByRole("dialog", { name: "Loaded in this chat" })).toBeVisible();
	return tap;
}

const section = (page: Page, id: string) => page.getByTestId(`loaded-section-${id}`);
async function unfold(page: Page, id: string) {
	await section(page, id).getByRole("button").first().click();
	await expect(section(page, id)).toHaveAttribute("data-open", "true");
}
const skill = (page: Page) => page.locator('[data-testid="loaded-skill"][data-skill="switch-skill"]');
const plugin_ = (page: Page) => page.locator('[data-testid="loaded-plugin"][data-plugin="switch-plugin"]');

/** What the composer's slash menu offers for `text`: omp's own command list, which it updates when a skill goes. */
async function offered(page: Page, text: string): Promise<string> {
	const composer = page.getByTestId("composer");
	await composer.fill(text);
	const menu = page.getByTestId("slash-menu");
	const shown = (await menu.count()) ? await menu.innerText() : "";
	await composer.fill("");
	return shown;
}

test("a skill's switch turns it off in every conversation and omp stops offering it; on again brings it back", async ({
	page,
}) => {
	await openDialog(page, 0x7d, "skill");
	await unfold(page, "skills");
	await expect(section(page, "skills")).toContainText("Skills are switched off in omp’s settings");
	const row = skill(page);
	const toggle = row.getByTestId("loaded-skill-switch");
	await expect(row).toHaveAttribute("data-enabled", "true");
	await expect(toggle).toBeChecked();
	await expect(toggle).toHaveAccessibleName("Use the skill switch-skill");
	await expect(row).toContainText("A skill for the switch spec");

	await toggle.click();
	// The dialog shows what omp then reports: the skill is off, and the setting says so.
	await expect(row).toHaveAttribute("data-enabled", "false");
	await expect(row).toContainText("off");
	await expect(toggle).not.toBeChecked();
	await expect(toggle).toBeEnabled();
	expect(config()).toContain("skill:switch-skill");

	// omp itself stopped offering it: its command list, as the composer's menu shows it.
	await page.keyboard.press("Escape");
	await expect.poll(() => offered(page, "/skill:switch")).not.toContain("switch-skill");

	// Back on, with the keyboard.
	await page.getByTestId("open-loaded").click();
	await unfold(page, "skills");
	await toggle.focus();
	await page.keyboard.press("Space");
	await expect(row).toHaveAttribute("data-enabled", "true");
	await expect(row).toContainText("A skill for the switch spec");
	expect(config()).not.toContain("skill:switch-skill");
	await page.keyboard.press("Escape");
	await expect.poll(() => offered(page, "/skill:switch")).toContain("switch-skill");
});

test("a plugin's switch runs omp's own enable and disable, and the dialog shows the result", async ({ page }) => {
	await openDialog(page, 0x7e, "plugin");
	await unfold(page, "plugins");
	await expect(section(page, "plugins")).toContainText("reloads this conversation’s skills and commands at once");
	const row = plugin_(page);
	const toggle = row.getByTestId("loaded-plugin-switch");
	await expect(row).toHaveAttribute("data-enabled", "true");
	await expect(toggle).toBeChecked();
	await expect(toggle).toHaveAccessibleName("Use the plugin switch-plugin");

	await toggle.click();
	await expect(row).toHaveAttribute("data-enabled", "false");
	await expect(row).toContainText("disabled");
	await expect(toggle).not.toBeChecked();
	const off = JSON.parse(omp("plugin", "list", "--json").stdout) as { npm: { name: string; enabled: boolean }[] };
	expect(off.npm.find((p) => p.name === "switch-plugin")?.enabled).toBe(false);

	await toggle.click();
	await expect(row).toHaveAttribute("data-enabled", "true");
	const on = JSON.parse(omp("plugin", "list", "--json").stdout) as { npm: { name: string; enabled: boolean }[] };
	expect(on.npm.find((p) => p.name === "switch-plugin")?.enabled).toBe(true);
});

test("a switch that fails says why and goes back; one that the folder's settings override says so", async ({
	page,
}) => {
	await openDialog(page, 0x7f, "fail");
	await unfold(page, "skills");
	await unfold(page, "plugins");
	// A toast sits outside the dialog: clicking it would close the dialog, so each is read, not dismissed.
	const toast = (text: string) => page.getByTestId("toast").filter({ hasText: text });

	await page.route("**/api/controls/skill", (route) => route.fulfill({ status: 500, json: { error: "boom" } }));
	await skill(page).getByTestId("loaded-skill-switch").click();
	await expect(toast("Couldn’t change the skill switch-skill: boom")).toBeVisible();
	await expect(skill(page)).toHaveAttribute("data-enabled", "true");
	await expect(skill(page).getByTestId("loaded-skill-switch")).toBeEnabled();

	await page.unroute("**/api/controls/skill");
	await page.route("**/api/controls/skill", (route) => route.fulfill({ json: { ok: true, overridden: "project" } }));
	await skill(page).getByTestId("loaded-skill-switch").click();
	await expect(
		toast(
			"Saved, but the project settings of this folder decide which extensions are off, so switch-skill is unchanged here.",
		),
	).toBeVisible();
	await expect(skill(page)).toHaveAttribute("data-enabled", "true");

	await page.route("**/api/controls/plugin", (route) =>
		route.fulfill({ status: 500, json: { error: "✘ Failed to disable switch-plugin: nope" } }),
	);
	await plugin_(page).getByTestId("loaded-plugin-switch").click();
	await expect(toast("Couldn’t change the plugin switch-plugin: ✘ Failed to disable")).toBeVisible();
	await expect(plugin_(page)).toHaveAttribute("data-enabled", "true");
	await page.unroute("**/api/controls/plugin");

	// An omp that could not reload plugins: said, and the plugin is still switched.
	await page.route("**/api/controls/plugin", (route) => route.fulfill({ json: { ok: true, reloaded: false } }));
	await plugin_(page).getByTestId("loaded-plugin-switch").click();
	await expect(toast("switch-plugin was switched, but this conversation’s omp could not reload plugins")).toBeVisible();
});

test("in Light mode, where omp loads no plugins, the plugin switch is off and says why; the dialog speaks Chinese too", async ({
	page,
}) => {
	await page.addInitScript(() => localStorage.setItem("ompw.lang", "zh-CN"));
	await page.route("**/api/loaded?*", (route) =>
		route.fulfill({
			json: {
				mode: "light",
				cwd: project,
				tools: null,
				commands: null,
				skills: null,
				plugins: [
					{
						name: "switch-plugin",
						version: "1.0.0",
						kind: "npm",
						scope: null,
						enabled: true,
						path: "/p/switch-plugin",
					},
				],
				rules: [],
			},
		}),
	);
	const file = writeSimpleSession(agentDir, 0x7c, "Loaded switch probe offline");
	writeFileSync(file, readFileSync(file, "utf8").replace(FIXTURE_CWD, project));
	await page.goto("/");
	await openSidebar(page);
	const row = page.locator('[data-testid="session-item"]', { hasText: "Loaded switch probe offline" });
	await expect(row).toHaveCount(1, { timeout: 15_000 });
	await row.click();
	await page.getByTestId("open-loaded").click();
	await unfold(page, "plugins");
	const toggle = plugin_(page).getByTestId("loaded-plugin-switch");
	await expect(toggle).toBeDisabled();
	await expect(toggle).toHaveAttribute("title", "轻量模式下 omp 不加载插件");
	await expect(toggle).toHaveAccessibleName("使用插件 switch-plugin");
	await expect(section(page, "plugins")).toContainText("切换插件后，这个对话的技能和命令会立刻重新加载");
});

test("a plugin in both scopes is two rows with a switch each: one click busies and switches its own scope only", async ({
	page,
}) => {
	const row = (scope: string) =>
		page.locator(`[data-testid="loaded-plugin"][data-plugin="both-plugin@market"][data-scope="${scope}"]`);
	const base = { name: "both-plugin@market", version: "1.0.0", kind: "marketplace", enabled: true };
	await page.route("**/api/loaded?*", (route) =>
		route.fulfill({
			json: {
				mode: "full",
				cwd: project,
				tools: null,
				commands: null,
				skills: null,
				plugins: [
					{ ...base, scope: "project", path: "/p/project/both-plugin" },
					{ ...base, scope: "user", path: "/p/user/both-plugin", shadowedBy: "project" },
				],
				rules: [],
			},
		}),
	);
	let release: () => void = () => {};
	const held = new Promise<void>((resolve) => {
		release = resolve;
	});
	const asked: unknown[] = [];
	await page.route("**/api/controls/plugin", async (route) => {
		asked.push(route.request().postDataJSON());
		await held;
		await route.fulfill({ json: { ok: true, reloaded: true } });
	});
	const file = writeSimpleSession(agentDir, 0x7b, "Loaded switch probe scopes");
	writeFileSync(file, readFileSync(file, "utf8").replace(FIXTURE_CWD, project));
	await page.goto("/");
	await openSidebar(page);
	const entry = page.locator('[data-testid="session-item"]', { hasText: "Loaded switch probe scopes" });
	await expect(entry).toHaveCount(1, { timeout: 15_000 });
	await entry.click();
	await page.getByTestId("open-loaded").click();
	await unfold(page, "plugins");

	await expect(row("user")).toContainText("overridden by this folder’s copy");
	await expect(row("project")).not.toContainText("overridden by this folder’s copy");
	await row("user").getByTestId("loaded-plugin-switch").click();
	await expect(row("user").getByTestId("loaded-plugin-switch")).toHaveAttribute("aria-busy", "true");
	// The other scope's switch is not in flight: one key for both would have busied (and locked) it too.
	await expect(row("project").getByTestId("loaded-plugin-switch")).not.toHaveAttribute("aria-busy", "true");
	await expect(row("project").getByTestId("loaded-plugin-switch")).toBeEnabled();
	expect(asked).toEqual([expect.objectContaining({ name: "both-plugin@market", enabled: false, scope: "user" })]);
	release();
	await expect(row("user").getByTestId("loaded-plugin-switch")).not.toHaveAttribute("aria-busy", "true");
});
