import { rmSync } from "node:fs";
import { join } from "node:path";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * A first run: omp's agent dir holds no conversations. The new-chat page waits for a folder to be chosen
 * (omp is not started in `~` on the user's behalf), the sidebar says how to start instead of offering
 * filters, and the usage page greets instead of showing a page of zeros (no model call).
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

test("the new-chat page asks for a folder and starts no omp until one is chosen", async ({ page }) => {
	const tap = await tapSocket(page);
	await start(page);
	const chip = page.getByTestId("cwd-picker");
	await expect(chip).toContainText("Choose a folder");
	await expect(page.getByText("Choose a folder to start omp")).toBeVisible();
	// The chip is the call to action: accent, unlike the folder chip of a chat that has a folder.
	const accent = await page.evaluate(() => {
		const probe = document.createElement("i");
		probe.style.color = "var(--accent)";
		document.body.append(probe);
		const color = getComputedStyle(probe).color;
		probe.remove();
		return color;
	});
	await expect(chip).toHaveCSS("color", accent);
	// A folder defaulted to `~` would start omp after the 250 ms start-up debounce.
	await page.waitForTimeout(800);
	expect(startedIn(tap)).toEqual([]);

	// Sending without a folder asks for one and keeps the draft.
	await page.getByTestId("composer").fill("hello");
	await page.getByTestId("composer").press("Enter");
	await expect(page.getByRole("dialog", { name: "Choose a working folder" })).toBeVisible();
	await expect(page.getByTestId("composer")).toHaveValue("hello");
	expect(startedIn(tap)).toEqual([]);

	// Choosing a folder starts omp there.
	const dialog = page.getByRole("dialog", { name: "Choose a working folder" });
	// The dialog lists the home folder first and overwrites the path field when that arrives.
	await expect(dialog.getByTestId("dir-up")).toBeVisible();
	const path = dialog.getByRole("textbox", { name: "Path" });
	await path.fill(`${s.work}/`);
	await page.getByRole("button", { name: "Go", exact: true }).click();
	// The listing has arrived once the server has normalized the path (it drops the trailing slash).
	await expect(path).toHaveValue(s.work);
	await page.getByRole("button", { name: "Use this folder" }).click();
	await expect(chip).toContainText("work");
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
	const started = startedIn(tap);
	expect(started).toHaveLength(1);
	expect(started[0]?.endsWith("/work")).toBe(true);
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
	await expect(page.getByTestId("cwd-picker")).toBeVisible();
});
