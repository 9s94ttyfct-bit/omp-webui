import { mkdtempSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, devices } from "@playwright/test";
import type { BrowserState } from "../../shared/browser.ts";
import { DESKTOP_SIZE } from "../../shared/browser-protocol.ts";
import { writeChatSession } from "../support/chat-session.ts";
import { openSidebar } from "../support/live.ts";
import { writeLongFakeOmp } from "../support/long-fake-omp-bin.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The side panel's Browser tab against a real browser: the server runs Playwright's Chromium as its engine
 * (`OMPW_BROWSER_EXECUTABLE`, with a mock keychain like every Chrome it starts) and a small web server of the spec's own
 * serves the pages it opens. A conversation's pages are listed, an address opens and the screencast shows it (read back
 * from the canvas's pixels), back / forward / reload, a new page is the conversation's own, the size switch, the console
 * strip and Send to agent, a phone taps a button of a page laid out at 1280×800, the strings in Chinese, and the native
 * view's messages in the Mac app's window. A second server has no browser installed. No model is called.
 */

let s: TestServer;
let bare: TestServer;
let web: Server;
let site = "";
let binDir: string;
let loads = 0;
const TITLE_A = "Browser tab conversation A";
const TITLE_B = "Browser tab conversation B";
// Each test has a conversation of its own: a test that failed (and the fresh worker after it) leaves the next one alone.
const TITLE_NEW = "Browser tab new page";
const TITLE_SIZE = "Browser tab size";
const TITLE_CONSOLE = "Browser tab console";
const TITLE_PHONE = "Browser tab phone";
const TITLE_BRIDGE = "Browser tab native view";

const html = (title: string, body: string, head = "") =>
	`<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>${head}</head><body style="margin:0">${body}</body></html>`;

/** The pages the engine opens: a colour each, a page that counts its loads, a console error, and a button to tap. */
function pageFor(path: string): string | null {
	switch (path) {
		case "/red":
			return html("Red page", "", "<style>html,body{height:100%;background:#ff0000}</style>");
		case "/blue":
			loads++;
			return html("Blue page", "", "<style>html,body{height:100%;background:#0000ff}</style>");
		case "/console":
			return html("Console page", "<p>logged</p>", '<script>console.error("boom from page")</script>');
		case "/button":
			// Laid out for 1280×800: the button sits at (900, 480)–(1100, 640) of the page.
			return html(
				"Button page",
				'<button id="b" style="position:absolute;left:900px;top:480px;width:200px;height:160px" onclick="document.body.style.background=\'#00ff00\';document.title=\'Tapped\'">Tap</button>',
				"<style>html,body{height:100%;background:#ffffff}</style>",
			);
		default:
			return null;
	}
}

test.beforeAll(async () => {
	web = createServer((req, res) => {
		const body = pageFor(new URL(req.url ?? "/", "http://x").pathname);
		res.writeHead(body ? 200 : 404, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
		res.end(body ?? "not found");
	});
	const listening = Promise.withResolvers<void>();
	web.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	site = `http://127.0.0.1:${(web.address() as AddressInfo).port}`;
	binDir = mkdtempSync(join(tmpdir(), "ompw-browser-tab-"));
	const omp = writeLongFakeOmp(binDir);
	s = await startTestServer(0, { OMP_BIN: omp, OMPW_BROWSER_EXECUTABLE: chromium.executablePath() }, { login: false });
	bare = await startTestServer(0, { OMP_BIN: omp }, { login: false });
	for (const server of [s, bare])
		[TITLE_A, TITLE_B, TITLE_NEW, TITLE_SIZE, TITLE_CONSOLE, TITLE_PHONE, TITLE_BRIDGE].forEach((title, i) => {
			writeChatSession(server.agentDir, { n: 0xb1 + i, title, turns: [{ prompt: "hello", reply: "hi" }] });
		});
});
test.afterAll(async () => {
	await s?.stop();
	await bare?.stop();
	const closed = Promise.withResolvers<void>();
	if (web) web.close(() => closed.resolve());
	else closed.resolve();
	await closed.promise;
	rmSync(binDir, { recursive: true, force: true });
});

/** Open a conversation and its side panel's Browser tab. */
async function openTab(page: Page, title = TITLE_A, server = s): Promise<void> {
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	await page.goto(`${server.url}/?token=${server.accessToken}`);
	await openSidebar(page);
	await page.locator('[data-testid="session-item"]', { hasText: title }).click();
	await expect(page.getByTestId("composer")).toBeVisible();
	if (!(await page.getByTestId("right-panel").isVisible())) await page.getByTestId("toggle-panel").click();
	await page.getByTestId("pane-tab-browser").click();
	await expect(page.getByTestId("browser-tab")).toBeVisible();
}

/** Another conversation of the same page, its Browser tab shown (the panel stays open and on the tab). */
async function switchTo(page: Page, title: string): Promise<void> {
	await openSidebar(page);
	await page.locator('[data-testid="session-item"]', { hasText: title }).click();
	await expect(page.getByTestId("chat-title")).toHaveText(title);
	await expect(page.getByTestId("browser-tab")).toBeVisible();
}

const tabs = (page: Page) => page.getByTestId("browser-page-tab");
const selectedTab = (page: Page) => page.locator('[data-testid="browser-page-tab"][aria-selected="true"]');
/** The page shown is at `path` of the spec's site (a page tab's tooltip is its address). */
const showing = (page: Page, path: string) => expect(selectedTab(page)).toHaveAttribute("title", `${site}${path}`);

async function go(page: Page, path: string): Promise<void> {
	await page.getByTestId("browser-address").fill(`${site}${path}`);
	await page.getByTestId("browser-address").press("Enter");
}

/** Open a conversation's Browser tab with one page (the red one) shown, opening it when the conversation has none. */
async function withPage(page: Page, title: string): Promise<void> {
	await openTab(page, title);
	await expect(page.getByTestId("browser-empty").or(selectedTab(page))).toBeVisible({ timeout: 30_000 });
	if ((await tabs(page).count()) === 0) await go(page, "/red");
	await expect(tabs(page)).toHaveCount(1, { timeout: 30_000 });
}

/** The colour the screencast shows in the middle of the canvas (always inside the page, whatever the letterbox). */
const centre = (page: Page) =>
	page.getByTestId("browser-screen").evaluate((el) => {
		const c = el as HTMLCanvasElement;
		const d = c.getContext("2d")?.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
		return d ? [d[0], d[1], d[2]] : [];
	});
/** Whether `rgb` is near `want` (JPEG moves colours a little). */
const near = (rgb: number[], want: [number, number, number]) =>
	rgb.length === 3 && rgb.every((v, i) => Math.abs(v - want[i]) < 40);

const RED: [number, number, number] = [255, 0, 0];
const BLUE: [number, number, number] = [0, 0, 255];
const GREEN: [number, number, number] = [0, 255, 0];

/** A picture of the page for a person to look at, when `OMPW_BROWSER_SHOTS` names a folder for it (never in CI). */
async function shot(page: Page, name: string): Promise<void> {
	const dir = process.env.OMPW_BROWSER_SHOTS;
	if (dir) await page.screenshot({ path: join(dir, `${name}.png`) });
}

test("the tab lists the conversation's pages; an address opens one and the frame shows it; back, forward and reload", async ({
	page,
}) => {
	await openTab(page);
	await expect(page.getByTestId("browser-empty")).toBeVisible({ timeout: 30_000 });
	await expect(tabs(page)).toHaveCount(0);

	await go(page, "/red");
	await expect(selectedTab(page)).toHaveAttribute("title", `${site}/red`, { timeout: 30_000 });
	await expect.poll(async () => near(await centre(page), RED), { timeout: 20_000 }).toBe(true);
	await expect(page.getByTestId("browser-address")).toHaveValue(`${site}/red`);
	await expect(page.getByTestId("browser-back")).toBeDisabled();

	await go(page, "/blue");
	await showing(page, "/blue");
	await expect.poll(async () => near(await centre(page), BLUE)).toBe(true);
	await expect(tabs(page)).toHaveCount(1);

	await expect(page.getByTestId("browser-back")).toBeEnabled();
	await page.getByTestId("browser-back").click();
	await showing(page, "/red");
	await expect.poll(async () => near(await centre(page), RED)).toBe(true);
	await expect(page.getByTestId("browser-forward")).toBeEnabled();
	await page.getByTestId("browser-forward").click();
	await showing(page, "/blue");
	await expect.poll(async () => near(await centre(page), BLUE)).toBe(true);

	const before = loads;
	await page.getByTestId("browser-reload").click();
	await expect.poll(() => loads).toBe(before + 1);
	await expect.poll(async () => near(await centre(page), BLUE)).toBe(true);
	// The address field never took the keyboard from where the person was: the message box is still theirs to focus.
	await expect(page.getByTestId("browser-keys")).not.toBeFocused();
});

test("New page adds a page of this conversation, which another conversation's Browser tab does not show", async ({
	page,
}) => {
	await withPage(page, TITLE_NEW);
	await page.getByTestId("browser-new").click();
	await expect(tabs(page)).toHaveCount(2);
	await expect(selectedTab(page)).toHaveText("New page");
	await expect(page.getByTestId("browser-address")).toHaveValue("");
	await expect(page.getByTestId("browser-address")).toBeFocused();

	await switchTo(page, TITLE_B);
	await expect(page.getByTestId("browser-empty")).toBeVisible();
	await expect(tabs(page)).toHaveCount(0);

	await switchTo(page, TITLE_NEW);
	await expect(tabs(page)).toHaveCount(2);
	// Closed from its tab: the conversation has the first page left.
	await page.getByTestId("browser-page-close").nth(1).click();
	await expect(tabs(page)).toHaveCount(1);
});

test("the size switch lays the page out as a desktop, the panel or a phone", async ({ page }) => {
	await withPage(page, TITLE_SIZE);
	const size = page.getByTestId("browser-page-size");
	await expect(page.getByTestId("browser-size-desktop")).toHaveText("Desktop");
	await expect(page.getByTestId("browser-size-panel")).toHaveText("Panel");
	await expect(page.getByTestId("browser-size-phone")).toHaveText("Phone");
	await expect(page.getByTestId("browser-size-desktop")).toHaveAttribute("aria-pressed", "true");
	await expect(size).toHaveText("1280×800");

	await page.getByTestId("browser-size-phone").click();
	await expect(page.getByTestId("browser-size-phone")).toHaveAttribute("aria-pressed", "true");
	await expect(size).toHaveText("390×844");

	await page.getByTestId("browser-size-panel").click();
	await expect(page.getByTestId("browser-size-panel")).toHaveAttribute("aria-pressed", "true");
	const frame = await page.getByTestId("browser-frame").evaluate((el) => `${el.clientWidth}×${el.clientHeight}`);
	await expect(size).toHaveText(frame);

	await page.getByTestId("browser-size-desktop").click();
	await expect(size).toHaveText("1280×800");
});

test("the console strip lists the page's console error, and Send to agent puts it into the message box", async ({
	page,
}) => {
	await withPage(page, TITLE_CONSOLE);
	await go(page, "/console");
	await showing(page, "/console");
	const entry = page.getByTestId("browser-console-entry").filter({ hasText: "boom from page" });
	await expect(entry).toHaveAttribute("data-level", "error");
	await entry.getByTestId("browser-console-send").click();
	await expect(page.getByTestId("composer")).toHaveValue(`Console error on ${site}/console: boom from page `);
	await expect(page.getByTestId("composer")).toBeFocused();
	await shot(page, "browser-tab-desktop");
});

test("on a phone (iPhone 13) a tap lands on the button of a page laid out at 1280×800", async ({ browser }) => {
	const { defaultBrowserType: _type, ...iphone } = devices["iPhone 13"];
	const context = await browser.newContext({ ...iphone, locale: "en-US" });
	const page = await context.newPage();
	try {
		await withPage(page, TITLE_PHONE);
		await page.getByTestId("browser-size-desktop").click();
		await go(page, "/button");
		await showing(page, "/button");
		await expect(page.getByTestId("browser-page-size")).toHaveText("1280×800");
		const canvas = page.getByTestId("browser-screen");
		await expect(canvas).toHaveAttribute("data-page", "1280x800");
		await expect.poll(async () => near(await centre(page), [255, 255, 255])).toBe(true);
		// Where the button's middle (1000, 560) is drawn: the page fitted into the canvas, letterboxed.
		const box = await canvas.boundingBox();
		if (!box) throw new Error("no canvas");
		const scale = Math.min(box.width / 1280, box.height / 800);
		const left = box.x + (box.width - 1280 * scale) / 2;
		const top = box.y + (box.height - 800 * scale) / 2;
		await page.touchscreen.tap(left + 1000 * scale, top + 560 * scale);
		// The button's click turns the page green: the tap landed on it.
		await expect.poll(async () => near(await centre(page), GREEN)).toBe(true);
		await shot(page, "browser-tab-phone");
	} finally {
		await context.close();
	}
});

test("in Chinese the tab, its size switch and its empty state are named in Chinese", async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("ompw.lang", "zh-CN"));
	await openTab(page, TITLE_B);
	await expect(page.getByTestId("pane-tab-browser")).toContainText("浏览器");
	await expect(page.getByTestId("browser-empty")).toContainText("还没有页面", { timeout: 30_000 });
	await expect(page.getByTestId("browser-size-desktop")).toHaveText("桌面");
	await expect(page.getByTestId("browser-size-panel")).toHaveText("面板");
	await expect(page.getByTestId("browser-size-phone")).toHaveText("手机");
	await expect(page.getByTestId("browser-address")).toHaveAttribute("placeholder", "输入地址后按 Enter");
});

test("turned off in another window, the Browser tab goes from the panel, and comes back where it was when turned on", async ({
	page,
}) => {
	await openTab(page, TITLE_B);
	const showing = page.locator('[data-testid^="panel-pane-"][data-tab="browser"]');
	await expect(showing).toHaveCount(1);
	/** The preference as another window sets it: through the server, which tells every page. */
	const set = (value: string | null) =>
		page.evaluate(
			(v) =>
				fetch("/api/prefs", {
					method: "POST",
					headers: { "content-type": "application/json", "x-omp-webui": "1" },
					body: JSON.stringify({ changes: { "ompw.browser": v } }),
				}).then((r) => r.status),
			value,
		);
	try {
		expect(await set("off")).toBe(200);
		await expect(page.getByTestId("pane-tab-browser")).toHaveCount(0);
		await expect(page.getByTestId("browser-tab")).toHaveCount(0);
		await expect(showing).toHaveCount(0);
	} finally {
		expect(await set(null)).toBe(200);
	}
	await expect(page.getByTestId("pane-tab-browser")).toBeVisible();
	await expect(showing).toHaveCount(1);
	await expect(page.getByTestId("browser-tab")).toBeVisible();
});

test("in the Mac app's window the tab places the native view instead of drawing the page, and hides it when not shown", async ({
	page,
}) => {
	// The Mac app's window: a script message handler named `ompwBrowser`, here one that keeps what it is told.
	await page.addInitScript(() => {
		const posts: unknown[] = [];
		const postMessage = (m: unknown) => {
			posts.push(m);
			return Promise.resolve(null);
		};
		Object.assign(window, { __posts: posts, webkit: { messageHandlers: { ompwBrowser: { postMessage } } } });
	});
	await withPage(page, TITLE_BRIDGE);
	await expect(page.getByTestId("browser-native")).toBeVisible();
	await expect(page.getByTestId("browser-screen")).toHaveCount(0);
	type Post = { type: string; targetId?: string; rect?: { x: number; y: number; w: number; h: number } };
	const posts = () => page.evaluate(() => Reflect.get(window, "__posts") as Post[]);
	const targetId = await selectedTab(page).getAttribute("data-target");
	const frame = await page.getByTestId("browser-frame").boundingBox();
	await expect
		.poll(async () => (await posts()).findLast((p) => p.type === "place"))
		.toMatchObject({
			type: "place",
			targetId,
			mode: "desktop",
			// The page's own layout size, which the window scales down to fit the frame area.
			size: DESKTOP_SIZE,
			rect: { x: Math.round(frame?.x ?? 0), y: Math.round(frame?.y ?? 0), w: Math.round(frame?.width ?? 0) },
		});
	expect((await posts()).find((p) => p.type === "cover")).toEqual({ type: "cover", covered: false });
	await page.getByTestId("browser-devtools").click();
	await expect
		.poll(async () => (await posts()).findLast((p) => p.type === "devtools"))
		.toEqual({ type: "devtools", targetId });
	// Another tab of the pane: the native view is put away.
	await page.getByTestId("pane-tab-files").click();
	await expect.poll(async () => (await posts()).at(-1)).toEqual({ type: "hide" });
});

test("with no browser installed the tab says so, and offers Install only to a page that may install it", async ({
	page,
}) => {
	await openTab(page, TITLE_A, bare);
	await expect(page.getByTestId("browser-not-installed")).toBeVisible({ timeout: 30_000 });
	await expect(page.getByTestId("browser-not-installed")).toContainText("The browser is not installed");
	await expect(page.getByTestId("browser-install")).toBeVisible();

	// A page that may not manage the browser (the server says so): no Install, and where it can be installed.
	const notHere = (state: BrowserState): BrowserState => ({ ...state, canManage: false });
	await page.route("**/api/browser", async (route) =>
		route.fulfill({ json: notHere((await (await route.fetch()).json()) as BrowserState) }),
	);
	const tap = await tapSocket(page);
	tap.rewrite((msg) => (msg.t === "browser_state" ? { ...msg, state: notHere(msg.state as BrowserState) } : msg));
	await openTab(page, TITLE_A, bare);
	await expect(page.getByTestId("browser-not-installed")).toContainText(
		"It is installed from this computer, or from a page signed in with your account",
		{ timeout: 30_000 },
	);
	await expect(page.getByTestId("browser-install")).toHaveCount(0);
	await expect(page.getByTestId("browser-open-settings")).toBeVisible();
});
