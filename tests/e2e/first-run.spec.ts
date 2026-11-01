import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * A first run: omp's agent dir holds no conversations. The new-chat page offers a new project, warms omp up in the home
 * folder while the projects folder (`~/omp`) is not there yet, and makes nothing before the first message; the sidebar
 * says how to start instead of offering filters, and the usage page greets instead of showing a page of zeros (no model
 * call).
 */

let s: TestServer;

test.beforeAll(async () => {
	s = await startTestServer(0);
	// The helper seeds the fixture conversations; a first run has none.
	rmSync(join(s.agentDir, "sessions"), { recursive: true, force: true });
	await s.restart();
});
test.afterAll(async () => {
	await s?.stop();
});

/** The folders of the `open` requests the page sent: each one starts an omp process. */
const startedIn = (tap: SocketTap) => tap.sent.filter((m) => m.t === "open").map((m) => m.target?.cwd);

const start = (page: Page, hash = "") => page.goto(`${s.url}/?token=${s.accessToken}${hash}`);

test("the new-chat page offers a new project, warms omp up in the home folder, and makes nothing before the first message", async ({
	page,
}) => {
	const before = readdirSync(s.home).sort();
	const tap = await tapSocket(page);
	await start(page);
	const name = page.getByTestId("new-project-name");
	await expect(name).toBeVisible();
	await expect(name).toBeFocused();
	await expect(name).toHaveValue("");
	await expect(page.getByTestId("cwd-picker")).toHaveCount(0);
	// `~/omp` is not there before its first project: omp is warmed up in the home folder, for the pickers only.
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	expect(startedIn(tap)).toEqual([s.home]);
	await page.waitForTimeout(500);
	expect(existsSync(join(s.home, "omp"))).toBe(false);
	expect(readdirSync(s.home).sort()).toEqual(before);
});

test("the sidebar says how to start instead of offering filters", async ({ page }) => {
	await start(page);
	const side = page.getByRole("complementary");
	await expect(side.getByTestId("sidebar-onboarding")).toContainText("No conversations yet");
	await expect(side.getByTestId("new-chat")).toBeVisible();
	await expect(side.getByTestId("session-filter")).toBeHidden();
	await expect(side.getByRole("combobox", { name: "Project" })).toBeHidden();
	await expect(side.getByTestId("select-sessions")).toBeHidden();
	await expect(side.getByText("No conversations", { exact: true })).toHaveCount(0);
});

test("the usage page shows one welcome with a way to start", async ({ page }) => {
	await start(page, "#/usage");
	const welcome = page.getByTestId("usage-fresh");
	await expect(welcome).toContainText("No usage recorded yet");
	await expect(page.locator("[data-stat]")).toHaveCount(0);
	await expect(page.locator("table")).toHaveCount(0);
	await expect(page.getByRole("heading", { name: "Most expensive conversations" })).toHaveCount(0);
	await welcome.getByRole("button", { name: "Start a conversation" }).click();
	await expect(page.getByTestId("new-project-name")).toBeVisible();
});
