import { ownSession, startLive } from "../support/live.ts";
import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * In the macOS app the UI runs in a WKWebView, whose `Notification` is present but of no use: `requestPermission()` answers
 * "denied" at once, without asking anyone (measured with a WKWebView loaded the way the app loads it). The app shows its
 * notifications itself, from what the server streams to it, and the page asks the shell only what macOS allows and for
 * permission, over a script message handler, `window.webkit.messageHandlers.ompwNotify`, answered from
 * UNUserNotificationCenter. Here the handler is a stand-in that records what the page sends and answers what a spec says
 * macOS allows, and `Notification` is the WKWebView one. Frames are injected, so no model call is made.
 */

type Message = Record<string, unknown>;

declare global {
	interface Window {
		__shell: { messages: Message[]; permission: string; grant: string; webAsked: number; webShown: number };
	}
}

/**
 * The shell, before `page.goto`. `permission` is what macOS allows (what it will have decided is kept across reloads, as
 * macOS keeps it); `grant` is what the person answers when macOS prompts them.
 */
async function appShell(page: Page, permission: string, grant = "granted") {
	await page.addInitScript(
		([initial, answer]) => {
			const shell = {
				messages: [] as Message[],
				permission: sessionStorage.getItem("shell-permission") ?? initial,
				grant: answer,
				webAsked: 0,
				webShown: 0,
			};
			window.__shell = shell;
			Object.assign(window, {
				webkit: {
					messageHandlers: {
						ompwNotify: {
							postMessage: async (message: Message) => {
								shell.messages.push(message);
								if (message.type === "request" && shell.permission === "default") shell.permission = shell.grant;
								sessionStorage.setItem("shell-permission", shell.permission);
								return { permission: shell.permission };
							},
						},
					},
				},
			});
			class WebViewNotification {
				static permission = "default";
				static requestPermission = async () => {
					shell.webAsked++;
					WebViewNotification.permission = "denied";
					return "denied";
				};
				constructor() {
					shell.webShown++;
				}
				close() {}
			}
			Object.defineProperty(window, "Notification", { value: WebViewNotification, configurable: true });
		},
		[permission, grant],
	);
}

/** What the shell was sent besides what the page shows: the questions to macOS, in order. */
const questions = (page: Page) => page.evaluate(() => window.__shell.messages.filter((m) => m.type !== "viewing"));
/** The conversation the page last told the shell it shows. */
const viewing = (page: Page) =>
	page.evaluate(() => {
		const seen = window.__shell.messages.filter((m) => m.type === "viewing");
		return seen.length === 0 ? undefined : seen[seen.length - 1];
	});

/** The shell says something on its own, as an event on `window`. */
const say = (page: Page, detail: Message) =>
	page.evaluate((d) => window.dispatchEvent(new CustomEvent("ompw-notification", { detail: d })), detail);

/** The window is the one in use, or another app's is: what `document.hasFocus()` says in the web view. */
const focus = (page: Page, on: boolean) =>
	page.evaluate((f) => Object.defineProperty(document, "hasFocus", { value: () => f, configurable: true }), on);

const dialog = (tap: SocketTap, liveId: string, id: string) =>
	tap.push({
		t: "frame",
		liveId,
		frame: { type: "extension_ui_request", id, method: "confirm", title: "Allow bash?", message: "echo hi" },
	});
const answered = (tap: SocketTap, liveId: string, id: string) =>
	tap.push({
		t: "frame",
		liveId,
		frame: { type: "extension_ui_request", id: `${id}-cancel`, method: "cancel", targetId: id },
	});

test("Settings asks the shell for permission, not the web view, and the toggle follows the answer", async ({
	page,
}) => {
	await appShell(page, "default");
	await page.goto("/#/settings/chats");
	const toggle = page.getByTestId("notifications");
	const hint = page.getByTestId("notifications-hint");
	await expect(toggle).toBeEnabled();
	await expect(toggle).not.toBeChecked();
	await expect(hint).toHaveText(
		/unless you are looking at that conversation: omp-webui is in front and shows it\. Clicking it opens the conversation\.$/,
	);
	// The page asked what macOS allows as soon as it started, and nothing else.
	await expect.poll(() => questions(page)).toEqual([{ type: "status" }]);

	await toggle.check();
	await expect(toggle).toBeChecked();
	expect(await questions(page)).toEqual([{ type: "status" }, { type: "request" }]);
	expect(await page.evaluate(() => [window.__shell.webAsked, window.__shell.webShown])).toEqual([0, 0]);

	// Still on after the page is loaded again: macOS remembers what the person allowed.
	await page.reload();
	await expect(page.getByTestId("notifications")).toBeChecked();
	await page.getByTestId("notifications").uncheck();
	await expect(page.getByTestId("notifications")).not.toBeChecked();
});

test("a person who refuses the system prompt keeps notifications off, and is told where to allow them", async ({
	page,
}) => {
	await appShell(page, "default", "denied");
	await page.goto("/#/settings/chats");
	const toggle = page.getByTestId("notifications");
	await expect(toggle).toBeEnabled();
	// `click`: `check()` would insist on the box ending up checked.
	await toggle.click();
	await expect(toggle).not.toBeChecked();
	await expect(toggle).toBeDisabled();
	await expect(page.getByTestId("notifications-hint")).toHaveText(
		"macOS blocks notifications for omp-webui. Open System Settings › Notifications › omp-webui and allow them, then come back and turn this on.",
	);
});

test("denied in System Settings: the toggle says where to allow them, and works again once the app is told it changed", async ({
	page,
}) => {
	await appShell(page, "denied");
	await page.goto("/#/settings/chats");
	const toggle = page.getByTestId("notifications");
	await expect(toggle).toBeDisabled();
	await expect(toggle).not.toBeChecked();
	await expect(page.getByTestId("notifications-hint")).toContainText("System Settings › Notifications › omp-webui");

	// The person allowed them there and came back to the app: the shell says so.
	await page.evaluate(() => {
		window.__shell.permission = "granted";
	});
	await say(page, { type: "permission", permission: "granted" });
	await expect(toggle).toBeEnabled();
	await expect(page.getByTestId("notifications-hint")).not.toContainText("System Settings");
	await toggle.check();
	await expect(toggle).toBeChecked();
});

test("a shell that cannot show notifications says so", async ({ page }) => {
	await appShell(page, "unsupported");
	await page.goto("/#/settings/chats");
	await expect(page.getByTestId("notifications")).toBeDisabled();
	await expect(page.getByTestId("notifications-hint")).toHaveText(
		"This copy of omp-webui cannot show notifications: it is not running as an app.",
	);
});

test("in the app the page posts no notification when a conversation needs the person or finishes; a click on one the app showed opens the conversation", async ({
	page,
}) => {
	const title = "Shell notify probe";
	ownSession(0x83, title);
	await appShell(page, "granted");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, "notify-shell-probe");
	const file = decodeURIComponent(await page.evaluate(() => location.hash.slice("#/s/".length)));
	expect(file).toMatch(/\.jsonl$/);
	await page.goto("/#/settings/chats");
	await page.getByTestId("notifications").check();
	await expect(page.getByTestId("notifications")).toBeChecked();
	await page.getByTestId("new-chat").click();

	// Notifications are on and macOS allows them, and whichever app is in front, the page shows the tab's title and posts
	// nothing: the app shows its notifications itself, from what the server streams to it.
	for (const [n, inFront] of [
		[1, true],
		[2, false],
	] as const) {
		await focus(page, inFront);
		dialog(tap, liveId, `s-${n}`);
		await expect(page).toHaveTitle("(1) omp");
		answered(tap, liveId, `s-${n}`);
		await expect(page).toHaveTitle("omp");
		tap.push({ t: "frame", liveId, frame: { type: "agent_start" } });
		tap.push({ t: "frame", liveId, frame: { type: "agent_end" } });
	}
	// The frames arrive in order: once a later dialog shows in the title, the replies before it have ended.
	dialog(tap, liveId, "s-3");
	await expect(page).toHaveTitle("(1) omp");
	expect(await questions(page)).toEqual([{ type: "status" }, { type: "request" }]);
	// The web view's own `Notification` was never asked and never used.
	expect(await page.evaluate(() => [window.__shell.webAsked, window.__shell.webShown])).toEqual([0, 0]);

	// The click: the shell brings the window forward and tells the page which conversation. The page is somewhere else.
	await expect(page).toHaveURL(/#\/$/);
	await say(page, { type: "open", liveId, file });
	await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#/s/${encodeURIComponent(file)}`);
	await expect(page.getByTestId("composer")).toBeVisible();

	// The app started again since: the process is gone, the conversation is not.
	await page.getByTestId("new-chat").click();
	await expect(page).toHaveURL(/#\/$/);
	await say(page, { type: "open", liveId: "gone-live", file });
	await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#/s/${encodeURIComponent(file)}`);
});

test("the page tells the app which conversation it shows, and what changes it", async ({ page }) => {
	const title = "Shell viewing probe";
	ownSession(0x84, title);
	await appShell(page, "granted");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	// The start page shows no conversation.
	await expect.poll(() => viewing(page)).toEqual({ type: "viewing", liveId: null, file: null });

	const liveId = await startLive(page, tap, title, "notify-shell-viewing");
	const file = decodeURIComponent(await page.evaluate(() => location.hash.slice("#/s/".length)));
	await expect.poll(() => viewing(page)).toEqual({ type: "viewing", liveId, file });

	// Another page of the app: nothing is on screen, whichever conversation asks.
	await page.goto("/#/settings");
	await expect.poll(() => viewing(page)).toEqual({ type: "viewing", liveId: null, file: null });

	// A click opens it again, and the app is told.
	await say(page, { type: "open", liveId, file });
	await expect.poll(() => viewing(page)).toEqual({ type: "viewing", liveId, file });
});
