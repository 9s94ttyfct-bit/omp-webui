import type { LoadedData } from "../../shared/loaded.ts";
import { FIXTURE, writeSimpleSession } from "../support/fixtures.ts";
import { openSidebar, ownSession, sessionRow, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * "Loaded in this chat": the terminal's /status (Extension Control Center) as a dialog — a conversation's tools, MCP
 * servers, slash commands, skills, plugins and rules, read from its own omp. The first specs use the real server and
 * the real omp (a process is started with a `!command`; no model is called); the rest give the page answers
 * of every kind, because MCP servers, plugins and failures need a setup the shared server does not have.
 */

const tool = (name: string, state: "active" | "mounted" | "off" = "active", description?: string) => ({
	name,
	label: name,
	state,
	...(description ? { description } : {}),
});
const mcpTool = (server: string, label: string) => ({
	name: `mcp__${server}_${label}`,
	label,
	state: "mounted" as const,
});

const ANSWER: LoadedData = {
	mode: "full",
	cwd: "/work",
	tools: {
		builtin: [tool("read", "active", "Reads files."), tool("bash"), tool("lsp", "mounted"), tool("goal", "off")],
		servers: [
			{
				name: "alpha",
				transport: "stdio",
				enabled: true,
				target: "bun",
				scope: "user",
				tools: [mcpTool("alpha", "ping"), mcpTool("alpha", "echo")],
			},
			{
				name: "beta",
				transport: "http",
				enabled: false,
				target: "http://127.0.0.1:1/mcp",
				scope: "project",
				tools: [],
			},
			{ name: "gamma", transport: "stdio", enabled: true, target: "uvx", scope: "user", tools: [] },
		],
		otherMcp: [mcpTool("mystery", "do_it")],
	},
	commands: [
		{ name: "mcp", description: "Manage MCP servers", source: "builtin", aliases: [], subcommands: 17 },
		{ name: "model", description: "Show current model", source: "builtin", aliases: ["models"], subcommands: 0 },
		{ name: "review", description: "Launch code review", source: "custom", aliases: [], subcommands: 0 },
		{ name: "init", description: "Generate AGENTS.md", source: "file", aliases: [], subcommands: 0 },
	],
	skills: [{ name: "demo-skill", description: "A demo skill", enabled: true }],
	plugins: [
		{ name: "demo-plugin", version: "1.2.3", kind: "npm", scope: null, enabled: true, path: "/p/demo-plugin" },
		{ name: "quiet", version: "0.1.0", kind: "npm", scope: null, enabled: false, path: "/p/quiet" },
	],
	rules: [
		{
			name: "no-foo",
			description: "Stop writing foo",
			provider: "native",
			path: "/work/.omp/rules/no-foo.md",
			scope: ["tool:edit(*.ts)"],
			triggers: ["\\bfoo\\b"],
		},
	],
};

/** Open a conversation of the fixtures; the page's `/api/loaded` is answered with `answer` when given. */
async function openFixture(page: Page, answer?: LoadedData | { status: number; error: string }) {
	if (answer)
		await page.route("**/api/loaded?*", (route) =>
			"error" in answer
				? route.fulfill({ status: answer.status, json: { error: answer.error } })
				: route.fulfill({ json: answer }),
		);
	await page.goto("/");
	await openSidebar(page);
	await sessionRow(page, FIXTURE.gammaTitle).click();
	await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.gammaTitle);
}

const dialog = (page: Page) => page.getByRole("dialog", { name: "Loaded in this chat" });
const section = (page: Page, id: string) => page.getByTestId(`loaded-section-${id}`);
/** Open a group that starts folded. */
async function unfold(page: Page, id: string) {
	await section(page, id).getByRole("button").first().click();
	await expect(section(page, id)).toHaveAttribute("data-open", "true");
}

test("the dialog lists the tools and commands of the conversation's own omp, and asks the model nothing", async ({
	page,
}) => {
	ownSession(0xf1, "Loaded probe");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const live = await startLive(page, tap, "Loaded probe", "loaded-probe");
	const asked = page.waitForRequest((r) => r.url().includes("/api/loaded"));

	await page.getByTestId("open-loaded").click();
	// It asks about this conversation's process, by its id.
	expect(new URL((await asked).url()).searchParams.get("live")).toBe(live);
	await expect(dialog(page)).toBeVisible();
	const panel = page.getByTestId("loaded-panel");

	// Tools: what the model is offered directly.
	await expect(panel.locator('[data-testid="loaded-tool"][data-tool="read"]')).toHaveAttribute("data-state", "active");
	await expect(panel.locator('[data-testid="loaded-tool"][data-tool="bash"]')).toHaveAttribute("data-state", "active");
	await expect(page.getByTestId("loaded-not-running")).toHaveCount(0);
	// Slash commands with where they come from, once their group is open.
	await unfold(page, "commands");
	await expect(panel.locator('[data-testid="loaded-command"][data-command="mcp"]')).toHaveAttribute(
		"data-source",
		"builtin",
	);
	await expect(panel.locator('[data-testid="loaded-command"][data-command="context"]')).toBeVisible();
	// omp's CLI, run for this conversation's folder: the built-in stream rules are there.
	await unfold(page, "rules");
	await expect(panel.locator('[data-testid="loaded-rule"][data-rule="ts-no-any"]')).toContainText("builtin-defaults");

	// Looking is not a turn: no prompt was sent, and what /tools and /mcp list printed is not in the conversation.
	expect(tap.commands("prompt")).toHaveLength(0);
	await expect(page.getByTestId("command-output")).toHaveCount(0);
});

test("/status, /extensions and /skills open the dialog instead of being held back or sent", async ({ page }) => {
	ownSession(0xf2, "Loaded slash probe");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	await startLive(page, tap, "Loaded slash probe", "loaded-slash-probe");

	const composer = page.getByTestId("composer");
	for (const command of ["/status", "/extensions", "/skills", "/Status now"]) {
		await composer.fill(command);
		await composer.press("Enter");
		await expect(dialog(page)).toBeVisible();
		await expect(page.getByTestId("loaded-panel")).toBeVisible();
		await expect(composer).toHaveValue("");
		await expect(page.getByTestId("slash-unknown")).toHaveCount(0);
		// Escape closes it, and the draft's field has the focus back.
		await page.keyboard.press("Escape");
		await expect(dialog(page)).toHaveCount(0);
		await expect(composer).toBeFocused();
	}
	expect(tap.commands("prompt")).toHaveLength(0);

	// They are offered as the terminal offers them.
	await composer.fill("/exten");
	await expect(page.getByRole("option", { name: /\/extensions.*Show what is loaded in this chat/ })).toBeVisible();
});

test("a conversation without a process opens it too: its folder's plugins and rules, and a note instead of tools", async ({
	page,
}) => {
	// A conversation of its own, opened straight from its URL: the new-chat page at `/` starts a process of its own,
	// whose first requests could still be on their way when this one is measured.
	const file = writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, 0xf3, "Loaded no-process probe");
	const tap = await tapSocket(page);
	await page.goto(`/#/s/${encodeURIComponent(file)}`);
	await expect(page.getByTestId("msg-user")).toHaveCount(1);
	expect(tap.sent.filter((m) => m.t === "open")).toHaveLength(0);
	const before = tap.sent.length;

	const composer = page.getByTestId("composer");
	await composer.fill("/status");
	await composer.press("Enter");
	await expect(dialog(page)).toBeVisible();
	// Plugins and rules need no process; tools, commands and skills are the process's, so there are none to list.
	await expect(page.getByTestId("loaded-count-rules")).toHaveText(/^[1-9]\d*$/);
	// One note says so, and the groups that would need the process are not there to be empty.
	await expect(page.getByTestId("loaded-not-running")).toBeVisible();
	for (const id of ["tools", "mcp", "commands", "skills"]) await expect(section(page, id)).toHaveCount(0);
	await unfold(page, "rules");
	await expect(page.getByTestId("loaded-rule").first()).toBeVisible();
	// Nothing was started or asked of omp to say so.
	expect(tap.sent.slice(before).filter((m) => m.t === "open" || m.t === "rpc")).toHaveLength(0);
});

test("on the new-chat page, where no conversation is open, they say where to look", async ({ page }) => {
	await page.goto("/");
	const composer = page.getByTestId("composer");
	await composer.fill("/skills");
	await composer.press("Enter");
	await expect(page.getByTestId("slash-unknown")).toContainText("Loaded in this chat");
	await expect(dialog(page)).toHaveCount(0);
});

test("every kind of answer is shown: grouped MCP tools, states, counts, and the filter", async ({ page }) => {
	await openFixture(page, ANSWER);
	await page.getByTestId("open-loaded").click();
	const panel = page.getByTestId("loaded-panel");

	// Counts are of what each group lists; "Other MCP tools" is not a server.
	await expect(page.getByTestId("loaded-count-tools")).toHaveText("4");
	await expect(page.getByTestId("loaded-count-mcp")).toHaveText("3");
	await expect(panel.locator('[data-tool="lsp"]')).toContainText("xd://");
	await expect(panel.locator('[data-tool="goal"]')).toContainText("off");
	await expect(panel.locator('[data-server="alpha"]')).toContainText("2 tools");
	await expect(panel.locator('[data-server="beta"]')).toContainText("disabled");
	await expect(panel.locator('[data-server="gamma"]')).toContainText("no tools loaded");
	// A server's tools are listed when asked for.
	await expect(panel.locator('[data-tool="mcp__alpha_ping"]')).toHaveCount(0);
	await panel.locator('[data-server="alpha"]').getByRole("button", { name: "Show the tools of alpha" }).click();
	await expect(panel.locator('[data-tool="mcp__alpha_ping"]')).toBeVisible();
	await expect(panel.locator('[data-tool="mcp__alpha_echo"]')).toBeVisible();
	// The tools no listed server claims are shown apart; their group can be opened too.
	await panel.getByRole("button", { name: "Show the tools of Other MCP tools" }).click();
	await expect(panel.locator('[data-tool="mcp__mystery_do_it"]')).toBeVisible();

	// Folded groups say how many they hold.
	for (const [id, count] of [
		["commands", "4"],
		["skills", "1"],
		["plugins", "2"],
		["rules", "1"],
	])
		await expect(page.getByTestId(`loaded-count-${id}`)).toHaveText(count);
	await unfold(page, "commands");
	await expect(panel.getByTestId("loaded-command-group")).toHaveText([
		/Built-in.*\/mcp.*17 subcommands.*\/model.*also \/models/s,
		/Custom.*\/review/s,
		/Prompt templates.*\/init/s,
	]);
	await unfold(page, "plugins");
	await expect(panel.locator('[data-plugin="quiet"]')).toContainText("disabled");
	await expect(panel.locator('[data-plugin="demo-plugin"]')).not.toContainText("disabled");

	// The filter looks through names and descriptions, and opens what matches.
	const search = page.getByTestId("loaded-search");
	await search.fill("foo");
	await expect(panel.getByTestId("loaded-rule")).toHaveCount(1);
	await expect(section(page, "tools")).toHaveCount(0);
	await search.fill("echo");
	await expect(panel.locator('[data-tool="mcp__alpha_echo"]')).toBeVisible();
	await expect(panel.locator('[data-tool="mcp__alpha_ping"]')).toHaveCount(0);
	await search.fill("zzz-nothing");
	await expect(page.getByTestId("loaded-no-match")).toContainText("zzz-nothing");
	await search.fill("");
	await expect(section(page, "tools")).toBeVisible();
});

test("a conversation started in Light says what Light mode leaves out", async ({ page }) => {
	await openFixture(page, { ...ANSWER, mode: "light" });
	await page.getByTestId("open-loaded").click();
	await expect(page.getByTestId("loaded-light")).toContainText("Light mode");
	await unfold(page, "plugins");
	await expect(page.locator('[data-plugin="demo-plugin"]')).toContainText("not loaded in Light mode");
	// A plugin that is off anyway says that, not both.
	await expect(page.locator('[data-plugin="quiet"]')).toContainText("disabled");
	await expect(page.locator('[data-plugin="quiet"]')).not.toContainText("Light mode");
});

test("a group omp could not fill says why, while the others are shown; and a failed request can be retried", async ({
	page,
}) => {
	await openFixture(page, {
		...ANSWER,
		commands: { error: "omp did not list its commands" },
		rules: { error: "ttsr broke" },
	});
	await page.getByTestId("open-loaded").click();
	await unfold(page, "commands");
	await expect(section(page, "commands").getByTestId("loaded-failed")).toContainText("omp did not list its commands");
	await unfold(page, "rules");
	await expect(section(page, "rules").getByTestId("loaded-failed")).toContainText("ttsr broke");
	await expect(page.locator('[data-tool="read"]')).toBeVisible();
	// A failed group has no count to show, and a filter does not list it.
	await expect(page.getByTestId("loaded-count-commands")).toHaveCount(0);
	await page.getByTestId("loaded-search").fill("read");
	await expect(section(page, "commands")).toHaveCount(0);
});

test("when the server cannot answer, the dialog says so and Refresh asks again", async ({ page }) => {
	let healthy = false;
	await page.route("**/api/loaded?*", (route) =>
		healthy ? route.fulfill({ json: ANSWER }) : route.fulfill({ status: 500, json: { error: "omp is down" } }),
	);
	await page.goto("/");
	await sessionRow(page, FIXTURE.gammaTitle).click();
	await page.getByTestId("open-loaded").click();
	await expect(dialog(page)).toContainText("Could not read what is loaded: omp is down");
	healthy = true;
	await dialog(page).getByRole("button", { name: "Refresh" }).first().click();
	await expect(page.locator('[data-tool="read"]')).toBeVisible();
});

test("on a phone the ⋯ menu opens it, and the dialog stays inside the screen", async ({ page }) => {
	await page.setViewportSize({ width: 390, height: 844 });
	await openFixture(page, ANSWER);
	await page.getByTestId("chat-more").click();
	await page.getByTestId("open-loaded").click();
	await expect(dialog(page)).toBeVisible();
	await expect(page.locator('[data-tool="read"]')).toBeVisible();
	const box = await dialog(page).boundingBox();
	expect(box?.x).toBeGreaterThanOrEqual(0);
	expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390);
	expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
	await page.keyboard.press("Escape");
	await expect(dialog(page)).toHaveCount(0);
});

test("a refresh that fails keeps the older answer on screen under a warning, and Retry asks again", async ({
	page,
}) => {
	let healthy = true;
	await page.route("**/api/loaded?*", (route) =>
		healthy ? route.fulfill({ json: ANSWER }) : route.fulfill({ status: 500, json: { error: "omp is down" } }),
	);
	await page.goto("/");
	await sessionRow(page, FIXTURE.gammaTitle).click();
	await page.getByTestId("open-loaded").click();
	await expect(page.locator('[data-tool="read"]')).toBeVisible();
	const strip = page.getByTestId("loaded-refresh-failed");
	await expect(strip).toHaveCount(0);

	healthy = false;
	await dialog(page).getByRole("button", { name: "Refresh" }).first().click();
	await expect(strip).toContainText("Couldn’t refresh: omp is down");
	// What was known stays, with its groups.
	await expect(page.locator('[data-tool="read"]')).toBeVisible();
	await expect(page.getByTestId("loaded-count-commands")).toHaveText("4");

	healthy = true;
	await strip.getByRole("button", { name: "Retry" }).click();
	await expect(strip).toHaveCount(0);
	await expect(page.locator('[data-tool="read"]')).toBeVisible();
});

test("a long description opens on a click or on keyboard focus; one that fits is plain text", async ({ page }) => {
	const long = "Launch the code review flow over the changes of this branch, one file at a time. ".repeat(6).trim();
	await openFixture(page, {
		...ANSWER,
		commands: [
			{ name: "mcp", description: "Manage MCP servers", source: "builtin", aliases: [], subcommands: 0 },
			{ name: "review", description: long, source: "custom", aliases: [], subcommands: 0 },
			{ name: "audit", description: long, source: "custom", aliases: [], subcommands: 0 },
		],
	});
	await page.getByTestId("open-loaded").click();
	await unfold(page, "commands");
	const description = (name: string) => page.locator(`[data-command="${name}"]`).getByTestId("loaded-description");
	const clipped = (name: string) => description(name).evaluate((el) => el.scrollWidth > el.clientWidth + 1);

	await expect(description("mcp")).toBeDisabled();
	await expect(description("review")).toBeEnabled();
	await expect(description("review")).toHaveAttribute("aria-expanded", "false");
	expect(await clipped("review")).toBe(true);

	await description("review").click();
	await expect(description("review")).toHaveAttribute("aria-expanded", "true");
	expect(await clipped("review")).toBe(false);

	// Keyboard focus opens one, and leaving it closes it again.
	await description("audit").focus();
	await expect(description("audit")).toHaveAttribute("aria-expanded", "true");
	await expect(description("review")).toHaveAttribute("aria-expanded", "false");
	await page.keyboard.press("Tab");
	await expect(description("audit")).toHaveAttribute("aria-expanded", "false");
});

test("prompts from MCP servers have a label of their own, in English and in Chinese", async ({ page }) => {
	const answer: LoadedData = {
		...ANSWER,
		commands: [
			{ name: "deploy", description: "Run a deploy", source: "mcp_prompt", aliases: [], subcommands: 0 },
			{ name: "mcp", description: "Manage MCP servers", source: "builtin", aliases: [], subcommands: 0 },
		],
	};
	await openFixture(page, answer);
	await page.getByTestId("open-loaded").click();
	await unfold(page, "commands");
	const group = page.locator('[data-testid="loaded-command-group"][data-source="mcp_prompt"]');
	await expect(group).toContainText("MCP prompts");
	await expect(group).not.toContainText("mcp_prompt");
});

test.describe("in Chinese", () => {
	test.use({ locale: "zh-CN" });

	test("the label of MCP prompts is translated", async ({ page }) => {
		await openFixture(page, {
			...ANSWER,
			commands: [{ name: "deploy", description: "Run a deploy", source: "mcp_prompt", aliases: [], subcommands: 0 }],
		});
		await page.getByTestId("open-loaded").click();
		await section(page, "commands").getByRole("button").first().click();
		const group = page.locator('[data-testid="loaded-command-group"][data-source="mcp_prompt"]');
		await expect(group).toContainText("MCP 提示词");
		await expect(group).not.toContainText("mcp_prompt");
	});
});
