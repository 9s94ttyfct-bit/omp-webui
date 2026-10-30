import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { LoadedData } from "../../shared/loaded.ts";
import { FIXTURE_CWD, writeSimpleSession } from "../support/fixtures.ts";
import { openSidebar, sessionRow, startLive } from "../support/live.ts";
import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The Loaded dialog's MCP switches against the real omp and stdio MCP stubs, no model call. A switch is omp's own
 * `/mcp enable|disable`, which edits the config where the server is defined; the running omp connects its servers only
 * at startup, so the dialog offers a restart of the conversation's omp (a resume of the same session) when it is idle.
 */

let agentDir: string;
const stubMcp = join(import.meta.dirname, "..", "support", "stub-mcp.ts");
let userMcp: string;
let project: string;
let projectMcp: string;
const stub = (name: string) => ({ type: "stdio", command: "bun", args: [stubMcp, name] });
const readServers = (file: string): Record<string, { enabled?: boolean }> =>
	JSON.parse(readFileSync(file, "utf8")).mcpServers;

test.describe.configure({ mode: "serial" });

test.beforeAll(() => {
	agentDir = process.env.OMPW_E2E_AGENT_DIR as string;
	userMcp = join(agentDir, "mcp.json");
	project = join(process.env.OMPW_E2E_ROOT as string, "mcp-switch-project");
	projectMcp = join(project, ".omp", "mcp.json");
	writeFileSync(userMcp, JSON.stringify({ mcpServers: { "mcp-alpha": stub("alpha"), "mcp-beta": stub("beta") } }));
	mkdirSync(join(project, ".omp"), { recursive: true });
	writeFileSync(projectMcp, JSON.stringify({ mcpServers: { "mcp-proj": stub("proj") } }));
});
/** The conversations this spec wrote: removed at the end, so that the sidebar the next spec sees is the one it had. */
const written: string[] = [];
test.afterAll(() => {
	rmSync(userMcp, { force: true });
	for (const file of written) rmSync(file.replace(/\.jsonl$/, ""), { recursive: true, force: true });
	for (const file of written) rmSync(file, { force: true });
});

/** A conversation of the spec's own, in the folder with the project server. */
function ownConversation(n: number, title: string): void {
	const file = writeSimpleSession(agentDir, n, title);
	written.push(file);
	writeFileSync(file, readFileSync(file, "utf8").replace(FIXTURE_CWD, project));
}

/** A conversation of the spec's own, in the folder with the project server, with its omp started and the dialog open. */
async function openDialog(page: Page, n: number, probe: string): Promise<{ tap: SocketTap; title: string }> {
	const title = `MCP switch probe ${probe}`;
	ownConversation(n, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const reveal = page.getByRole("button", { name: "Show sidebar" });
	if (await reveal.isVisible()) await reveal.click();
	await startLive(page, tap, title, `mcp-switch-${probe}`);
	await page.getByTestId("open-loaded").click();
	await expect(page.getByRole("dialog", { name: "Loaded in this chat" })).toBeVisible();
	return { tap, title };
}

const server = (page: Page, name: string) => page.locator(`[data-testid="loaded-server"][data-server="${name}"]`);
const status = (page: Page, name: string) => server(page, name).getByTestId("loaded-server-status");
const flip = (page: Page, name: string) => server(page, name).getByTestId("loaded-server-switch");
const note = (page: Page) => page.getByTestId("loaded-mcp-restart");
const opens = (tap: SocketTap) => tap.sent.filter((m) => m.t === "open").length;

/** omp starts its MCP servers a moment after the conversation: refresh until the servers have their tools. */
async function waitForServers(page: Page, names: string[]) {
	await expect(async () => {
		await page.getByTestId("loaded-refresh").click();
		for (const name of names) await expect(status(page, name)).toHaveText("1 tool", { timeout: 1500 });
	}).toPass({ timeout: 60_000 });
}

test("a switch edits the config where the server is defined, offers the restart, and the restart applies it", async ({
	page,
}) => {
	const { tap, title } = await openDialog(page, 0xf8, "restart");
	await waitForServers(page, ["mcp-alpha", "mcp-beta", "mcp-proj"]);
	await expect(page.getByTestId("loaded-section-mcp")).toContainText("omp connects its servers only when it starts");
	await expect(note(page)).toHaveCount(0);
	const alpha = flip(page, "mcp-alpha");
	await expect(alpha).toBeChecked();
	await expect(alpha).toHaveAccessibleName("Use the MCP server mcp-alpha");
	await expect(server(page, "mcp-proj")).toContainText("[project]");

	// A user server: off in the user's mcp.json, and the other servers left alone.
	await alpha.click();
	await expect(server(page, "mcp-alpha")).toHaveAttribute("data-enabled", "false");
	await expect(alpha).not.toBeChecked();
	await expect(alpha).toBeEnabled();
	expect(readServers(userMcp)["mcp-alpha"].enabled).toBe(false);
	expect(readServers(userMcp)["mcp-beta"].enabled).toBeUndefined();
	// The running omp keeps its tools: the row says it is off but still running, and a restart is on offer.
	await expect(status(page, "mcp-alpha")).toHaveText("off · still running");
	await expect(note(page)).toContainText("Changed in omp’s config: mcp-alpha");
	await expect(note(page)).toHaveAttribute("data-working", "false");

	// A project server goes to the folder's own file.
	await flip(page, "mcp-proj").click();
	await expect(server(page, "mcp-proj")).toHaveAttribute("data-enabled", "false");
	expect(readServers(projectMcp)["mcp-proj"].enabled).toBe(false);
	expect(readServers(userMcp)["mcp-proj"]).toBeUndefined();
	await expect(note(page)).toContainText("mcp-alpha, mcp-proj");
	// Back to what the process runs: nothing is owed for it.
	await flip(page, "mcp-proj").click();
	await expect(server(page, "mcp-proj")).toHaveAttribute("data-enabled", "true");
	await expect(note(page)).not.toContainText("mcp-proj");

	// Restart: the same conversation is resumed in a new omp, which loads what the config says.
	const before = opens(tap);
	await page.getByTestId("loaded-mcp-restart-now").click();
	await expect(note(page)).toHaveCount(0, { timeout: 60_000 });
	expect(opens(tap)).toBe(before + 1);
	expect(tap.sent.findLast((m) => m.t === "open")?.target?.kind).toBe("resume");
	await expect(async () => {
		await page.getByTestId("loaded-refresh").click();
		await expect(status(page, "mcp-alpha")).toHaveText("disabled", { timeout: 1500 });
		await expect(status(page, "mcp-beta")).toHaveText("1 tool", { timeout: 1500 });
		await expect(status(page, "mcp-proj")).toHaveText("1 tool", { timeout: 1500 });
	}).toPass({ timeout: 60_000 });
	await expect(flip(page, "mcp-alpha")).not.toBeChecked();

	// Back on, and applied by a second restart (the process it asks about is the new one).
	await flip(page, "mcp-alpha").click();
	await expect(note(page)).toContainText("Changed in omp’s config: mcp-alpha");
	await page.getByTestId("loaded-mcp-restart-now").click();
	await expect(note(page)).toHaveCount(0, { timeout: 60_000 });
	expect(readServers(userMcp)["mcp-alpha"].enabled).toBe(true);
	await expect(async () => {
		await page.getByTestId("loaded-refresh").click();
		await expect(status(page, "mcp-alpha")).toHaveText("1 tool", { timeout: 1500 });
	}).toPass({ timeout: 60_000 });

	// The conversation is the same one: its transcript is there.
	await page.keyboard.press("Escape");
	await expect(page.getByText(`${title}.`, { exact: true })).toBeVisible();
	await page.getByTestId("composer").fill("!echo after-restart");
	await page.getByTestId("composer").press("Enter");
	await expect(page.getByText("after-restart", { exact: true })).toBeVisible({ timeout: 30_000 });
});

test("while the conversation is busy the change waits for the next start; once it is idle the restart is offered", async ({
	page,
}) => {
	await openDialog(page, 0xf9, "busy");
	await waitForServers(page, ["mcp-beta"]);
	await page.keyboard.press("Escape");
	// A command that runs until this test lets it end: omp is working, and ending it would cut it off. It is not a timed
	// one: what the switch takes (omp's `/mcp disable`, then the dialog asking omp and its CLI again) has no bound on a
	// slow machine, and a command that ended first would leave nothing busy to see.
	const gate = join(process.env.OMPW_E2E_ROOT as string, "mcp-switch-busy-gate");
	rmSync(gate, { force: true });
	try {
		const composer = page.getByTestId("composer");
		await composer.fill(`!while [ ! -e "${gate}" ]; do sleep 0.2; done; echo done-busy`);
		await composer.press("Enter");
		await expect(page.getByTestId("pending-command")).toHaveCount(1);
		await page.getByTestId("open-loaded").click();
		await flip(page, "mcp-beta").click();
		await expect(server(page, "mcp-beta")).toHaveAttribute("data-enabled", "false");
		await expect(note(page)).toHaveAttribute("data-working", "true");
		await expect(note(page)).toContainText("This conversation is busy");
		await expect(page.getByTestId("loaded-mcp-restart-now")).toHaveCount(0);

		// The command ends; nothing needs to be refreshed for the dialog to offer the restart.
		writeFileSync(gate, "");
		await expect(page.getByTestId("pending-command")).toHaveCount(0, { timeout: 30_000 });
		await expect(note(page)).toHaveAttribute("data-working", "false");
		await expect(page.getByTestId("loaded-mcp-restart-now")).toBeVisible();
	} finally {
		writeFileSync(gate, "");
	}
	// Put it back, as the next spec expects.
	await flip(page, "mcp-beta").click();
	await expect(note(page)).toHaveCount(0);
});

test("a switch that fails says why and goes back; a restart the server refuses says so and stays on offer", async ({
	page,
}) => {
	await openDialog(page, 0xfa, "fail");
	await waitForServers(page, ["mcp-beta"]);
	// A toast sits outside the dialog: clicking it would close the dialog, so each is read, not dismissed.
	const toast = (text: string) => page.getByTestId("toast").filter({ hasText: text });

	await page.route("**/api/controls/mcp", (route) => route.fulfill({ status: 500, json: { error: "boom" } }));
	await flip(page, "mcp-beta").click();
	await expect(toast("Couldn’t change the MCP server mcp-beta: boom")).toBeVisible();
	await expect(server(page, "mcp-beta")).toHaveAttribute("data-enabled", "true");
	await expect(flip(page, "mcp-beta")).toBeEnabled();
	await expect(note(page)).toHaveCount(0);
	await page.unroute("**/api/controls/mcp");

	await flip(page, "mcp-beta").click();
	await expect(note(page)).toBeVisible();
	await page.route("**/api/controls/restart", (route) =>
		route.fulfill({ status: 409, json: { error: "omp is working or waiting for an answer" } }),
	);
	await page.getByTestId("loaded-mcp-restart-now").click();
	await expect(toast("Restart failed: omp is working or waiting for an answer")).toBeVisible();
	await expect(page.getByTestId("loaded-mcp-restart-now")).toBeEnabled();
	await page.unroute("**/api/controls/restart");
	await flip(page, "mcp-beta").click();
	await expect(note(page)).toHaveCount(0);
});

/** What `/api/loaded` says for a conversation with one MCP server called `name`. */
const loadedWith = (mode: "full" | "light", name: string): LoadedData => ({
	mode,
	cwd: project,
	tools: {
		builtin: [],
		servers: [{ name, transport: "stdio", enabled: true, target: "bun", scope: "user", tools: [] }],
		otherMcp: [],
	},
	commands: [],
	skills: [],
	plugins: [],
	rules: [],
});

async function openStubbed(page: Page, n: number, probe: string, answer: LoadedData) {
	await page.route("**/api/loaded?*", (route) => route.fulfill({ json: answer }));
	ownConversation(n, `MCP switch probe ${probe}`);
	await page.goto("/");
	const reveal = page.getByRole("button", { name: /显示侧边栏|Show sidebar/ });
	if (await reveal.isVisible()) await reveal.click();
	const row = page.locator('[data-testid="session-item"]', { hasText: `MCP switch probe ${probe}` });
	await expect(row).toHaveCount(1, { timeout: 15_000 });
	await row.click();
	await page.getByTestId("open-loaded").click();
}

test("a Light conversation's switch is off and says where the choice is made; the dialog speaks Chinese too", async ({
	page,
}) => {
	await page.addInitScript(() => localStorage.setItem("ompw.lang", "zh-CN"));
	await openStubbed(page, 0xfb, "light", loadedWith("light", "mcp-alpha"));
	const toggle = flip(page, "mcp-alpha");
	await expect(toggle).toBeDisabled();
	await expect(toggle).toHaveAttribute("title", "轻量对话加载的是在“设置 › 完整 / 轻量”里选定的 MCP 服务器");
	await expect(toggle).toHaveAccessibleName("使用 MCP 服务器 mcp-alpha");
	await expect(page.getByTestId("loaded-section-mcp")).toContainText("改动要等这个对话的 omp 重启后才生效");
});

test("a server whose name has a space cannot be switched from here: omp's command takes one word", async ({ page }) => {
	await openStubbed(page, 0xfc, "spaced", loadedWith("full", "two words"));
	const toggle = flip(page, "two words");
	await expect(toggle).toBeDisabled();
	await expect(toggle).toHaveAttribute("title", /can only be switched in mcp\.json/);
});

test("Settings › Full / Light says which servers omp has switched off: Light loads none of those, checked or not", async ({
	page,
}) => {
	const original = readFileSync(userMcp, "utf8");
	writeFileSync(
		userMcp,
		JSON.stringify({ mcpServers: { "mcp-alpha": stub("alpha"), "mcp-beta": { ...stub("beta"), enabled: false } } }),
	);
	try {
		await page.goto("/#/settings/models");
		await expect(page.getByTestId("offline-mcp-mcp-beta")).toBeVisible();
		await expect(page.getByTestId("offline-mcp-off-mcp-beta")).toHaveText("switched off in omp");
		await expect(page.getByTestId("offline-mcp-off-mcp-alpha")).toHaveCount(0);
	} finally {
		writeFileSync(userMcp, original);
	}
});

test("a server both configs define is not switchable here: the switch is off and says to edit it in the terminal", async ({
	page,
}) => {
	const answer = loadedWith("full", "mcp-alpha");
	(answer.tools as { servers: { inBoth?: true }[] }).servers[0].inBoth = true;
	await openStubbed(page, 0xfd, "both", answer);
	const toggle = flip(page, "mcp-alpha");
	await expect(toggle).toBeDisabled();
	await expect(toggle).toHaveAttribute("title", /defined in your config and in this folder’s.*edit it in the terminal/);
});

test("the restart hint is the server's word, so it is there after a reload, before any click", async ({ page }) => {
	const answer = loadedWith("full", "mcp-alpha");
	const server = (answer.tools as { servers: { enabled: boolean; restartOwed?: true }[] }).servers[0];
	server.restartOwed = true;
	await openStubbed(page, 0xfe, "owed", answer);
	await expect(note(page)).toContainText("Changed in omp’s config: mcp-alpha");
	await page.reload();
	await openSidebar(page);
	await sessionRow(page, "MCP switch probe owed").click();
	await page.getByTestId("open-loaded").click();
	await expect(note(page)).toContainText("Changed in omp’s config: mcp-alpha");
	// What the server no longer says is not shown.
	delete server.restartOwed;
	await page.getByTestId("loaded-refresh").click();
	await expect(note(page)).toHaveCount(0);
});
