import { ownSession, startLive } from "../support/live.ts";
import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Someone in another tab must be able to tell that a conversation needs them (a dialog omp waits on) or finished its
 * reply: by the tab's title, and by a system notification when Settings has them on. Frames are injected, so no model
 * call is made; the page is made to look hidden by what it reads, as the browser would report.
 */

interface Note {
	title: string;
	body?: string;
	tag?: string;
}

declare global {
	interface Window {
		/** The notifications the page asked the system to show (see `fakeNotifications`). */
		__notes: Note[];
	}
}

/** Notifications the page can ask for without a permission prompt: they are collected in `window.__notes`. */
async function fakeNotifications(page: Page, permission: "granted" | "unsupported") {
	await page.addInitScript((allowed) => {
		window.__notes = [];
		if (allowed === "unsupported") {
			Object.defineProperty(window, "Notification", { value: undefined, configurable: true });
			return;
		}
		class FakeNotification {
			static permission = "granted";
			static requestPermission = async () => "granted";
			onclick: (() => void) | null = null;
			constructor(title: string, options?: NotificationOptions) {
				window.__notes.push({ title, body: options?.body, tag: options?.tag });
			}
			close() {}
		}
		Object.defineProperty(window, "Notification", { value: FakeNotification, configurable: true });
	}, permission);
}

/** The tab goes to the background, or comes back: the page reads `document.visibilityState`. */
const visibility = (page: Page, state: "hidden" | "visible") =>
	page.evaluate((s) => {
		Object.defineProperty(document, "visibilityState", { value: s, configurable: true });
		document.dispatchEvent(new Event("visibilitychange"));
	}, state);

/** The window is the one in use, or another application has the focus: what `document.hasFocus()` answers. */
const focus = (page: Page, on: boolean) =>
	page.evaluate((f) => {
		Object.defineProperty(document, "hasFocus", { value: () => f, configurable: true });
		window.dispatchEvent(new Event(f ? "focus" : "blur"));
	}, on);

/** The conversation open on a page, by the file in its address. */
const openConversation = async (page: Page, file: string) => {
	await page.goto(`/#/s/${encodeURIComponent(file)}`);
	await expect(page.getByTestId("composer")).toBeVisible();
};

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

test("the tab title counts the conversations waiting for an answer and marks a reply that finished while hidden", async ({
	page,
}) => {
	const title = "Tab title probe";
	ownSession(0x80, title);
	// Auto-titling would send a prompt to the model when a pushed turn ends.
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	await expect(page).toHaveTitle("omp");
	const liveId = await startLive(page, tap, title, "tab-title-probe");
	await page.getByTestId("new-chat").click();
	await expect(page).toHaveTitle("omp");

	dialog(tap, liveId, "ui-1");
	await expect(page).toHaveTitle("(1) omp");
	answered(tap, liveId, "ui-1");
	await expect(page).toHaveTitle("omp");

	// A reply that ends in view is seen: no mark. (Frames arrive in order: once the dialog behind them shows, they were handled.)
	tap.push({ t: "frame", liveId, frame: { type: "agent_start" } });
	tap.push({ t: "frame", liveId, frame: { type: "agent_end" } });
	dialog(tap, liveId, "ui-seen");
	await expect(page).toHaveTitle("(1) omp");
	answered(tap, liveId, "ui-seen");
	await expect(page).toHaveTitle("omp");

	// One that ends while the tab is hidden is marked until the tab is shown.
	await visibility(page, "hidden");
	tap.push({ t: "frame", liveId, frame: { type: "agent_start" } });
	tap.push({ t: "frame", liveId, frame: { type: "agent_end" } });
	await expect(page).toHaveTitle("✓ omp");
	dialog(tap, liveId, "ui-2");
	await expect(page).toHaveTitle("(1) ✓ omp");
	await visibility(page, "visible");
	await expect(page).toHaveTitle("(1) omp");
	answered(tap, liveId, "ui-2");
	await expect(page).toHaveTitle("omp");
});

test("notifications are off until Settings turns them on, then show for a background conversation", async ({
	page,
}) => {
	const title = "Notify probe";
	ownSession(0x81, title);
	await fakeNotifications(page, "granted");
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, "notify-probe");
	const file = decodeURIComponent(await page.evaluate(() => location.hash.slice("#/s/".length)));
	await page.getByTestId("new-chat").click();
	await visibility(page, "hidden");

	dialog(tap, liveId, "n-1");
	await expect(page).toHaveTitle("(1) omp");
	expect(await page.evaluate(() => window.__notes)).toEqual([]);
	answered(tap, liveId, "n-1");

	await visibility(page, "visible");
	await page.goto("/#/settings/chats");
	const toggle = page.getByTestId("notifications");
	await expect(toggle).not.toBeChecked();
	await toggle.check();
	await expect(toggle).toBeChecked();
	await page.getByTestId("new-chat").click();
	await visibility(page, "hidden");

	dialog(tap, liveId, "n-2");
	await expect
		.poll(() => page.evaluate(() => window.__notes))
		.toEqual([{ title, body: "Needs your input", tag: liveId }]);
	answered(tap, liveId, "n-2");
	tap.push({ t: "frame", liveId, frame: { type: "agent_start" } });
	tap.push({ t: "frame", liveId, frame: { type: "agent_end" } });
	await expect
		.poll(() => page.evaluate(() => window.__notes.map((n) => n.body)))
		.toEqual(["Needs your input", "Finished"]);

	// Seen: the conversation is on screen in a window that is in use, and nothing more is shown.
	await visibility(page, "visible");
	await openConversation(page, file);
	dialog(tap, liveId, "n-3");
	await expect(page).toHaveTitle("(1) omp");
	answered(tap, liveId, "n-3");
	await expect(page).toHaveTitle("omp");
	tap.push({ t: "frame", liveId, frame: { type: "agent_start" } });
	tap.push({ t: "frame", liveId, frame: { type: "agent_end" } });
	dialog(tap, liveId, "n-3b");
	await expect(page).toHaveTitle("(1) omp");
	answered(tap, liveId, "n-3b");
	expect(await page.evaluate(() => window.__notes.length)).toBe(2);

	// Off again: nothing more either.
	await page.goto("/#/settings/chats");
	await page.getByTestId("notifications").uncheck();
	await visibility(page, "hidden");
	dialog(tap, liveId, "n-4");
	await expect(page).toHaveTitle("(1) omp");
	expect(await page.evaluate(() => window.__notes.length)).toBe(2);
});

test("a notification is shown for a conversation you are not looking at, even in a tab that is in front, and for none you are (#655)", async ({
	page,
}) => {
	const title = "Looking probe";
	ownSession(0x82, title);
	await fakeNotifications(page, "granted");
	await page.addInitScript(() => {
		localStorage.setItem("ompw.autoTitle", "off");
		localStorage.setItem("ompw.notify", "on");
	});
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, "looking-probe");
	const file = decodeURIComponent(await page.evaluate(() => location.hash.slice("#/s/".length)));
	const notes = () => page.evaluate(() => window.__notes.map((n) => n.body));
	/** A dialog is raised and answered, a reply ends; the title says when the page has handled them all. */
	const needsYouAndFinishes = async (n: string) => {
		dialog(tap, liveId, n);
		await expect(page).toHaveTitle("(1) omp");
		answered(tap, liveId, n);
		await expect(page).toHaveTitle("omp");
		tap.push({ t: "frame", liveId, frame: { type: "agent_start" } });
		tap.push({ t: "frame", liveId, frame: { type: "agent_end" } });
	};

	// On screen, in a tab that is shown and focused: not a notification.
	await needsYouAndFinishes("l-1");
	dialog(tap, liveId, "l-1-end");
	await expect(page).toHaveTitle("(1) omp");
	answered(tap, liveId, "l-1-end");
	expect(await notes()).toEqual([]);

	// The tab is in front but another page of the app is on screen (the start page, Usage, Settings): it is told.
	await page.getByTestId("new-chat").click();
	await expect(page).toHaveURL(/#\/$/);
	await needsYouAndFinishes("l-2");
	await expect.poll(notes).toEqual(["Needs your input", "Finished"]);
	await page.goto("/#/settings");
	dialog(tap, liveId, "l-3");
	await expect.poll(notes).toEqual(["Needs your input", "Finished", "Needs your input"]);
	answered(tap, liveId, "l-3");

	// On screen again, but another application has the focus: told.
	await openConversation(page, file);
	await focus(page, false);
	dialog(tap, liveId, "l-4");
	await expect.poll(notes).toHaveLength(4);
	answered(tap, liveId, "l-4");
	await expect(page).toHaveTitle("omp");
	// ... and once the window is in use again, not.
	await focus(page, true);
	dialog(tap, liveId, "l-5");
	await expect(page).toHaveTitle("(1) omp");
	answered(tap, liveId, "l-5");
	await expect(page).toHaveTitle("omp");
	expect(await notes()).toHaveLength(4);
	// One notification per conversation: the browser replaces the older by the tag.
	expect(await page.evaluate(() => [...new Set(window.__notes.map((n) => n.tag))])).toEqual([liveId]);
});

test("Settings says so when the browser cannot show notifications", async ({ page }) => {
	await fakeNotifications(page, "unsupported");
	await page.goto("/#/settings/chats");
	await expect(page.getByTestId("notifications")).toBeDisabled();
	await expect(page.getByTestId("notifications-hint")).toHaveText("This browser cannot show notifications.");
});
