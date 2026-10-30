import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeChatSession } from "../support/chat-session.ts";
import { writeLongFakeOmp } from "../support/long-fake-omp-bin.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { boxOf } from "../support/style.ts";
import { devices, expect, type Page, test } from "./fixtures.ts";

/**
 * The panel's Terminal tab (v0.11.18 §8): a login shell in the conversation's folder. It keeps running while another tab is
 * shown and is drawn again with what it printed; Restart gives a new one; a page told that shells are off for it (a remote
 * page, `meta.shell: false`) says so and opens none. The server's gate is `tests/contract/remote-shell.test.ts`.
 */

let s: TestServer;
let binDir: string;
let proj: string;
const TITLE = "Shell tab conversation";

test.beforeAll(async () => {
	binDir = mkdtempSync(join(tmpdir(), "ompw-shell-bin-"));
	s = await startTestServer(0, { OMP_BIN: writeLongFakeOmp(binDir) }, { login: false });
	proj = join(realpathSync(s.work), "shell-proj");
	mkdirSync(proj);
	writeChatSession(s.agentDir, { n: 0x71, title: TITLE, cwd: proj, turns: [{ prompt: "hello", reply: "hi" }] });
});
test.afterAll(async () => {
	await s?.stop();
	rmSync(binDir, { recursive: true, force: true });
});

const panel = (page: Page) => page.getByTestId("right-panel");
const tab = (page: Page, name: RegExp) =>
	panel(page).locator('[data-testid^="panel-pane-"]').getByRole("tab", { name });
const screen = (page: Page) => page.getByTestId("shell-screen");

async function openTerminal(page: Page, shown = "shell-tab"): Promise<void> {
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.goto(`${s.url}/?token=${s.accessToken}`);
	const item = page.locator('[data-testid="session-item"]', { hasText: TITLE });
	await expect(item).toHaveCount(1, { timeout: 30_000 });
	await item.click();
	await expect(page.getByTestId("composer")).toBeVisible();
	await page.getByTestId("toggle-panel").click();
	await tab(page, /^Terminal/).click();
	await expect(page.getByTestId(shown)).toBeVisible();
}

/** Type a line into the shell, as a person does: the screen has the keyboard. */
async function typeLine(page: Page, line: string): Promise<void> {
	await screen(page).click();
	await page.keyboard.type(line);
	await page.keyboard.press("Enter");
}

test("a shell in the conversation's folder; it keeps running behind another tab, and Restart starts a new one", async ({
	page,
}) => {
	await openTerminal(page);
	await expect(page.getByTestId("shell-status")).toHaveText("running", { timeout: 15_000 });
	await typeLine(page, "echo AT=$PWD; X=kept");
	await expect(screen(page)).toContainText(`AT=${proj}`);

	// Another tab, then back: the same shell (its variable is still set), with what it printed.
	await tab(page, /^Files/).click();
	await tab(page, /^Terminal/).click();
	await expect(screen(page)).toContainText(`AT=${proj}`);
	await typeLine(page, "echo X=$X");
	await expect(screen(page)).toContainText("X=kept");

	// Restart: a new shell, which has not the old one's variable.
	await page.getByTestId("shell-restart").click();
	await expect(page.getByTestId("shell-status")).toHaveText("running");
	await typeLine(page, "echo Y=$X.");
	await expect(screen(page)).toContainText("Y=.");

	// `exit` ends it, and the screen says so.
	await typeLine(page, "exit");
	await expect(page.getByTestId("shell-status")).toHaveText(/^exited/);
});

test("Clear, and ⌘K, empty the screen and its scrollback; what the shell prints next still shows (#696)", async ({
	page,
}) => {
	await openTerminal(page);
	await expect(page.getByTestId("shell-status")).toHaveText("running", { timeout: 15_000 });
	await typeLine(page, "echo OLD-ONE=$((40+2))");
	await expect(screen(page)).toContainText("OLD-ONE=42");

	await page.getByTestId("shell-clear").click();
	await expect(screen(page)).not.toContainText("OLD-ONE=42");
	// The shell is the same one and the screen has the keyboard again.
	await typeLine(page, "echo NEW-ONE=$((50+5))");
	await expect(screen(page)).toContainText("NEW-ONE=55");
	await expect(screen(page)).not.toContainText("OLD-ONE=42");

	// Drawn again (another tab, then back) it is not given what was cleared either.
	await tab(page, /^Files/).click();
	await tab(page, /^Terminal/).click();
	await expect(screen(page)).toContainText("NEW-ONE=55");
	await expect(screen(page)).not.toContainText("OLD-ONE=42");

	// ⌘K does the same, and is not the page's search while the screen has the keyboard.
	await screen(page).click();
	await page.keyboard.press("Meta+k");
	await expect(screen(page)).not.toContainText("NEW-ONE=55");
	await expect(page.getByTestId("palette-input")).toHaveCount(0);
	await typeLine(page, "echo LAST-ONE=$((60+6))");
	await expect(screen(page)).toContainText("LAST-ONE=66");
});

test("a page that may not open shells says so and asks for none", async ({ page }) => {
	const opened: string[] = [];
	page.on("websocket", (ws) =>
		ws.on("framesent", (f) => {
			const text = String(f.payload);
			if (text.includes('"pty_open"')) opened.push(text);
		}),
	);
	await page.route("**/api/meta", async (route) => {
		const res = await route.fetch();
		const meta = await res.json();
		return route.fulfill({ response: res, json: { ...meta, shell: false } });
	});
	await openTerminal(page, "shell-tab-off");
	await expect(page.getByTestId("shell-tab-off")).toContainText(
		"Shells are off for pages that are not on this computer",
	);
	expect(opened).toEqual([]);
});

test.describe("on a phone", () => {
	const { defaultBrowserType: _browser, ...pixel } = devices["Pixel 5"];
	test.use({ ...pixel, viewport: { width: 390, height: 844 } });

	test("the toolbar's buttons keep their labels inside them and inside the panel", async ({ page }) => {
		await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
		await page.goto(`${s.url}/?token=${s.accessToken}`);
		await page.getByRole("button", { name: "Show sidebar" }).click();
		const item = page.locator('[data-testid="session-item"]', { hasText: TITLE });
		await expect(item).toHaveCount(1, { timeout: 30_000 });
		await item.click();
		await page.getByTestId("toggle-panel").click();
		await tab(page, /^Terminal/).click();
		const shell = page.getByTestId("shell-tab");
		await expect(shell).toBeVisible();
		const edge = await boxOf(shell);
		for (const id of ["shell-restart", "shell-clear", "shell-copy"]) {
			const button = shell.getByTestId(id);
			// A label that wraps spills out of the fixed-height button; one on a single line ran past the panel's edge.
			expect(
				await button.evaluate((n) => n.scrollHeight > n.clientHeight + 1 || n.scrollWidth > n.clientWidth + 1),
				`${id} spills`,
			).toBe(false);
			const b = await boxOf(button);
			expect(b.x + b.width, `${id} is inside the panel`).toBeLessThanOrEqual(edge.x + edge.width);
		}
	});
});
