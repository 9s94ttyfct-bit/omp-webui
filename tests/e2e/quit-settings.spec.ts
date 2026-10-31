import { PREF, type PrefsSnapshot } from "../../shared/prefs.ts";
import { choose } from "../support/select.ts";
import type { TestServer } from "../support/server.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * What quitting the macOS app does (#604): the app asks, with "Don't ask again" on the question, and Settings is where that
 * answer is undone. The shell (macos/quit.swift) reads the choice from the server when it is asked to quit, so the page keeps
 * it in the server's preferences like its others. The card is only in the app: here the shell is the stand-in the
 * notifications' spec uses (a page is "in the app" when the shell's handler is there).
 */

/** The page runs inside the app: the shell's message handler answers. */
async function appShell(page: Page) {
	await page.addInitScript(() => {
		Object.assign(window, {
			webkit: { messageHandlers: { ompwNotify: { postMessage: async () => ({ permission: "default" }) } } },
		});
	});
}

const api = (server: TestServer, path: string, init: RequestInit = {}) =>
	fetch(`${server.url}${path}`, {
		...init,
		headers: { "x-omp-webui-token": server.accessToken, "x-omp-webui": "1", "content-type": "application/json" },
	});

const saved = async (server: TestServer) =>
	((await (await api(server, "/api/prefs")).json()) as PrefsSnapshot).values[PREF.quitAction];

const forget = (server: TestServer) =>
	api(server, "/api/prefs", { method: "POST", body: JSON.stringify({ changes: { [PREF.quitAction]: null } }) });

test.afterEach(async ({ e2eServer }) => {
	await forget(e2eServer);
});

test("a browser has no card about quitting the app", async ({ page }) => {
	await page.goto("/#/settings/app");
	await expect(page.getByTestId("settings-page")).toBeVisible();
	await expect(page.getByTestId("quit-settings")).toHaveCount(0);
});

test("in the app, quitting asks until another answer is chosen, and the choice is kept by the server", async ({
	page,
	e2eServer,
}) => {
	await appShell(page);
	await page.goto("/#/settings/app");
	const card = page.getByTestId("quit-settings");
	await expect(card).toBeVisible();
	await expect(card.getByRole("group", { name: "When you quit the app" })).toBeVisible();
	// Nothing chosen yet: ask, which is what the shell does with a preference it does not find.
	await expect(page.getByTestId("quit-action-ask")).toBeChecked();
	expect(await saved(e2eServer)).toBeNull();

	await page.getByTestId("quit-action-background").check();
	await expect.poll(() => saved(e2eServer)).toBe("background");
	await expect(card).toContainText("The window closes and omp-webui keeps running");

	// Still the choice after the page is loaded again, and the way back to being asked is one click.
	await page.reload();
	await expect(page.getByTestId("quit-action-background")).toBeChecked();
	await page.getByTestId("quit-action-quit").check();
	await expect.poll(() => saved(e2eServer)).toBe("quit");
	await page.getByTestId("quit-action-ask").check();
	await expect.poll(() => saved(e2eServer)).toBe("ask");
});

test("what the app's question remembers shows in Settings at once, in the page that is open", async ({
	page,
	e2eServer,
}) => {
	await appShell(page);
	await page.goto("/#/settings/app");
	await expect(page.getByTestId("quit-action-ask")).toBeChecked();
	// "Don't ask again" in the app is this request, made by the shell (see the contract test of the preferences).
	const res = await api(e2eServer, "/api/prefs", {
		method: "POST",
		body: JSON.stringify({ changes: { [PREF.quitAction]: "background" } }),
	});
	expect(res.status).toBe(200);
	await expect(page.getByTestId("quit-action-background")).toBeChecked();
	await expect(page.getByTestId("quit-action-ask")).not.toBeChecked();
});

test("the card speaks the language of the page, and Chinese says 对话 where it names a conversation, never 会话", async ({
	page,
}) => {
	await appShell(page);
	await page.goto("/#/settings/look");
	try {
		await choose(page.getByTestId("language"), "zh-CN");
		await page.locator('[data-testid="settings-page-tab"][data-page="app"]').click();
		const card = page.getByTestId("quit-settings");
		await expect(card.getByRole("heading", { name: "退出应用" })).toBeVisible();
		await expect(card.getByRole("group", { name: "退出应用时" })).toBeVisible();
		await expect(card.getByTestId("quit-action-background")).toBeVisible();
		await expect(card).toContainText("在后台运行");
		await expect(card).toContainText("对话照常进行");
		await expect(card).not.toContainText("会话");
	} finally {
		await page.locator('[data-testid="settings-page-tab"][data-page="look"]').click();
		await choose(page.getByTestId("language"), "en");
	}
});
