import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { BrowserState } from "../../shared/browser.ts";
import { writeLongFakeOmp } from "../support/long-fake-omp-bin.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Settings › Browser against a stand-in for Chrome for Testing's download servers (`OMPW_BROWSER_DOWNLOAD_BASE`, a test-only
 * override of the server): a version list and a zip of a stand-in Chrome for every platform, served by the spec. The card
 * shows the engine and the version; Install shows its progress and Cancel stops it; Install again installs; Clear asks
 * first; a page that may not manage the browser sees no buttons; and the card speaks Chinese. Nothing reaches the network,
 * and no browser is started.
 */

const VERSION = "200.0.1.0";
const EXECUTABLES = [
	"chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
	"chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
	"chrome-linux64/chrome",
	"chrome-win64/chrome.exe",
];
const PLATFORMS = ["mac-arm64", "mac-x64", "linux64", "win64"];

let s: TestServer;
let downloads: Server;
let work: string;
let zip: Uint8Array;
/** The zip is held after its first bytes until the request ends (so the progress stays on screen until Cancel). */
let stall = false;
const held = new Set<ServerResponse>();

test.beforeAll(async () => {
	work = mkdtempSync(join(tmpdir(), "ompw-browser-settings-"));
	// A zip as Google serves it, with a Chrome stand-in for each platform and some bytes that do not compress.
	const src = join(work, "src");
	for (const exe of EXECUTABLES) {
		mkdirSync(join(src, dirname(exe)), { recursive: true });
		writeFileSync(join(src, exe), "#!/bin/sh\n");
		chmodSync(join(src, exe), 0o755);
	}
	writeFileSync(join(src, "chrome-linux64", "padding.bin"), randomBytes(256 * 1024));
	execFileSync("zip", ["-qr", join(work, "chrome.zip"), ...PLATFORMS.map((p) => `chrome-${p}`)], { cwd: src });
	zip = new Uint8Array(readFileSync(join(work, "chrome.zip")));
	const md5 = createHash("md5").update(zip).digest("base64");

	downloads = createServer((req, res) => {
		const base = `http://${req.headers.host}`;
		if (req.url === "/cft/versions.json") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(
				JSON.stringify({
					channels: {
						Stable: {
							version: VERSION,
							downloads: { chrome: PLATFORMS.map((platform) => ({ platform, url: `${base}/cft/chrome.zip` })) },
						},
					},
				}),
			);
			return;
		}
		if (req.url === "/cft/chrome.zip") {
			res.writeHead(200, {
				"content-type": "application/zip",
				"content-length": String(zip.length),
				"x-goog-hash": `crc32c=AAAAAA==, md5=${md5}`,
			});
			if (!stall) {
				res.end(Buffer.from(zip));
				return;
			}
			res.write(Buffer.from(zip.subarray(0, 64 * 1024)));
			held.add(res);
			res.on("close", () => held.delete(res));
			return;
		}
		res.writeHead(404);
		res.end();
	});
	const listening = Promise.withResolvers<void>();
	downloads.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	const base = `http://127.0.0.1:${(downloads.address() as AddressInfo).port}`;
	s = await startTestServer(0, { OMP_BIN: writeLongFakeOmp(work), OMPW_BROWSER_DOWNLOAD_BASE: base }, { login: false });
});
test.afterAll(async () => {
	await s?.stop();
	for (const res of held) res.destroy();
	const closed = Promise.withResolvers<void>();
	if (downloads) downloads.close(() => closed.resolve());
	else closed.resolve();
	await closed.promise;
	rmSync(work, { recursive: true, force: true });
});

async function openCard(page: Page): Promise<void> {
	await page.goto(`${s.url}/?token=${s.accessToken}#/settings/app`);
	await expect(page.getByTestId("browser-settings")).toBeVisible();
}

const card = (page: Page) => page.getByTestId("browser-settings");

test("Settings › Browser shows the engine and version; Install shows its progress and Cancel stops it; Install again installs", async ({
	page,
}) => {
	await openCard(page);
	await expect(page.getByTestId("browser-engine")).toHaveAttribute("data-engine", "cft");
	await expect(page.getByTestId("browser-engine")).toHaveText("Chrome for Testing (this server runs it)");
	await expect(page.getByTestId("browser-installed")).toHaveText("Not installed");
	await expect(page.getByTestId("browser-latest")).toHaveText("Not looked up yet");

	stall = true;
	await page.getByTestId("browser-install").click();
	const progress = page.getByTestId("browser-progress");
	await expect(progress).toHaveAttribute("data-kind", "install");
	await expect(progress.getByRole("progressbar")).toHaveAttribute("aria-valuenow", /^\d+$/);
	await expect(page.getByTestId("browser-progress-text")).toContainText("/");
	await page.getByTestId("browser-cancel").click();
	await expect(progress).toHaveCount(0);
	await expect(page.getByTestId("browser-installed")).toHaveText("Not installed");
	await expect(page.getByTestId("browser-error")).toHaveCount(0);

	stall = false;
	await page.getByTestId("browser-install").click();
	await expect(page.getByTestId("browser-installed")).toHaveText(VERSION, { timeout: 30_000 });
	await expect(page.getByTestId("browser-latest")).toHaveText(VERSION);
	await expect(page.getByTestId("browser-up-to-date")).toBeVisible();
	await expect(page.getByTestId("browser-install")).toHaveCount(0);
	await page.getByTestId("browser-check").click();
	await expect(page.getByTestId("browser-up-to-date")).toBeVisible();
});

test("Clear browser data asks first: Cancel clears nothing, Clear clears", async ({ page }) => {
	await openCard(page);
	const cleared: string[] = [];
	page.on("request", (r) => {
		if (new URL(r.url()).pathname === "/api/browser/clear") cleared.push(r.method());
	});
	await page.getByTestId("browser-clear").click();
	const dialog = page.getByTestId("browser-clear-confirm");
	await expect(dialog).toContainText("The browser restarts, and its pages close.");
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toHaveCount(0);
	expect(cleared).toEqual([]);

	await page.getByTestId("browser-clear").click();
	await page.getByTestId("browser-clear-go").click();
	await expect.poll(() => cleared).toEqual(["POST"]);
	await expect(page.getByTestId("browser-progress")).toHaveCount(0);
	await expect(page.getByTestId("browser-error")).toHaveCount(0);
});

test("Uninstall asks first: Cancel keeps the browser, Uninstall removes it, and Install installs it again", async ({
	page,
}) => {
	await openCard(page);
	await expect(page.getByTestId("browser-installed")).toHaveText(VERSION);
	await page.getByTestId("browser-uninstall").click();
	const dialog = page.getByTestId("browser-uninstall-confirm");
	await expect(dialog).toContainText("its pages close");
	await dialog.getByRole("button", { name: "Cancel" }).click();
	await expect(dialog).toHaveCount(0);
	await expect(page.getByTestId("browser-installed")).toHaveText(VERSION);

	await page.getByTestId("browser-uninstall").click();
	await page.getByTestId("browser-uninstall-go").click();
	await expect(page.getByTestId("browser-installed")).toHaveText("Not installed");
	await expect(page.getByTestId("browser-uninstall")).toHaveCount(0);
	await expect(page.getByTestId("browser-error")).toHaveCount(0);

	await page.getByTestId("browser-install").click();
	await expect(page.getByTestId("browser-installed")).toHaveText(VERSION, { timeout: 30_000 });
});

test("the browser can be turned off and on again, which is the synced preference", async ({ page }) => {
	await openCard(page);
	const stored = () =>
		page.evaluate(() =>
			fetch("/api/prefs")
				.then((r) => r.json())
				.then((p) => p.values["ompw.browser"]),
		);
	const enabled = page.getByTestId("browser-enabled");
	await expect(enabled).toBeChecked();
	await expect(page.getByTestId("browser-off")).toHaveCount(0);
	await enabled.uncheck();
	await expect(page.getByTestId("browser-off")).toHaveText("The built-in browser is off. Agents have no browser tool.");
	await expect.poll(stored).toBe("off");
	await page.reload();
	await expect(page.getByTestId("browser-enabled")).not.toBeChecked();
	await page.getByTestId("browser-enabled").check();
	await expect.poll(stored).toBeNull();
	await expect(page.getByTestId("browser-off")).toHaveCount(0);
});

test("automatic updates are on by default and their switch is the synced preference; a failed check shows in the card, not as an error", async ({
	page,
}) => {
	const failed = (state: BrowserState): BrowserState => ({
		...state,
		autoCheck: { at: Date.UTC(2026, 10, 3, 9, 30), result: "failed", version: null, error: "The download stalled" },
	});
	await page.route("**/api/browser", async (route) =>
		route.fulfill({ json: failed((await (await route.fetch()).json()) as BrowserState) }),
	);
	const tap = await tapSocket(page);
	tap.rewrite((msg) => (msg.t === "browser_state" ? { ...msg, state: failed(msg.state as BrowserState) } : msg));
	await openCard(page);
	const stored = () =>
		page.evaluate(() =>
			fetch("/api/prefs")
				.then((r) => r.json())
				.then((p) => p.values["ompw.browserAutoUpdate"]),
		);
	const auto = page.getByTestId("browser-auto-update");
	await expect(auto).toBeChecked();
	const line = page.getByTestId("browser-auto-check");
	await expect(line).toHaveAttribute("data-result", "failed");
	await expect(line).toContainText("Last check failed");
	await expect(line).toContainText("The download stalled. It is tried again at the next check.");
	await expect(page.getByTestId("browser-error")).toHaveCount(0);
	await auto.uncheck();
	await expect.poll(stored).toBe("off");
	await expect(line).toHaveCount(0);
	await page.reload();
	await expect(page.getByTestId("browser-auto-update")).not.toBeChecked();
	await page.getByTestId("browser-auto-update").check();
	await expect.poll(stored).toBeNull();
	await expect(page.getByTestId("browser-auto-check")).toHaveAttribute("data-result", "failed");
});

test("the size of new pages is kept as the synced preference, within bounds", async ({ page }) => {
	await openCard(page);
	await page.getByTestId("browser-size-width").fill("1440");
	await page.getByTestId("browser-size-height").fill("900");
	await page.getByTestId("browser-size-height").press("Enter");
	const stored = () =>
		page.evaluate(() =>
			fetch("/api/prefs")
				.then((r) => r.json())
				.then((p) => p.values["ompw.browserSize"]),
		);
	await expect.poll(stored).toBe("1440x900");
	// Out of bounds: not kept.
	await page.getByTestId("browser-size-width").fill("90");
	await page.getByTestId("browser-size-width").press("Enter");
	await page.waitForTimeout(300);
	expect(await stored()).toBe("1440x900");
	await page.getByRole("button", { name: "Default (1280×800)" }).click();
	await expect.poll(stored).toBeNull();
});

test("a page that may not manage the browser sees the versions and no buttons", async ({ page }) => {
	const notHere = (state: BrowserState): BrowserState => ({ ...state, canManage: false });
	await page.route("**/api/browser", async (route) =>
		route.fulfill({ json: notHere((await (await route.fetch()).json()) as BrowserState) }),
	);
	const tap = await tapSocket(page);
	tap.rewrite((msg) => (msg.t === "browser_state" ? { ...msg, state: notHere(msg.state as BrowserState) } : msg));
	await openCard(page);
	await expect(page.getByTestId("browser-cannot-manage")).toHaveText(
		"The browser is installed, updated, cleared, uninstalled and turned on or off from this computer, or from a page signed in with your account.",
	);
	await expect(page.getByTestId("browser-installed")).toBeVisible();
	await expect(page.getByTestId("browser-enabled")).toBeDisabled();
	await expect(page.getByTestId("browser-auto-update")).toBeDisabled();
	for (const id of ["browser-install", "browser-update", "browser-check", "browser-clear", "browser-uninstall"])
		await expect(card(page).getByTestId(id)).toHaveCount(0);
});

test("the card speaks Chinese, and Settings' search finds it by its name", async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("ompw.lang", "zh-CN"));
	await openCard(page);
	await expect(card(page).getByRole("heading", { name: "浏览器" })).toBeVisible();
	await expect(page.getByTestId("browser-clear")).toHaveText("清除浏览器数据");
	await expect(page.getByTestId("browser-check")).toHaveText("检查新版本");
	const field = page.getByTestId("settings-search-input");
	await field.fill("清除浏览器数据");
	await expect(page.locator('[data-testid="settings-search-result"][data-entry="browser"]')).toBeVisible();
	await field.press("Enter");
	await expect(page.getByTestId("browser-settings")).toHaveAttribute("data-marked", "true");
});
