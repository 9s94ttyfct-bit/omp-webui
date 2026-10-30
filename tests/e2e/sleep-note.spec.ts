import type { LiveInfo } from "@shared/protocol.ts";
import { ownSession, startLive } from "../support/live.ts";
import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * What a conversation says when the Mac slept while it worked (#647): the line the process carries (`LiveInfo.slept`) and
 * the line under it once the server saw what followed.
 *
 * The server's own `/api/lives` is what is pushed as the `live` frame, with the note added: a made-up `LiveInfo` would
 * change the session file and make the page read the conversation again, and a `frame` is not what tells a page its
 * process's info. The sleep itself is `tests/unit/sleep-decision.test.ts`'s and the server's own note is
 * `tests/unit/sleep-note.test.ts`'s, so no model is called and nothing waits for a machine to sleep.
 */

const FROM = new Date(2026, 9, 26, 14, 2).getTime();
const TO = new Date(2026, 9, 26, 15, 40).getTime();

async function chat(page: Page, title: string, n: number) {
	ownSession(n, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, `sleep-${n}`);
	return { tap, liveId };
}

/** The server's own info for `liveId`, as every page is told it. */
async function infoOf(page: Page, liveId: string): Promise<LiveInfo> {
	const lives = (await (await page.request.get("/api/lives")).json()) as LiveInfo[];
	const found = lives.find((l) => l.liveId === liveId);
	if (!found) throw new Error(`the server does not list ${liveId}`);
	return found;
}

/** What the server sends when a process's info changes, with the sleep note on it. */
async function saySlept(page: Page, tap: SocketTap, liveId: string, note: LiveInfo["slept"]): Promise<void> {
	tap.push({ t: "live", info: { ...(await infoOf(page, liveId)), ...(note ? { slept: note } : {}) } });
}

const note = (page: Page) => page.getByTestId("slept-note");
const title = (page: Page) => page.getByTestId("slept-note-title");
const then = (page: Page) => page.getByTestId("slept-note-then");

test("a sleep that cut a turn shows in the conversation, with no second line until there is one", async ({ page }) => {
	const { tap, liveId } = await chat(page, "Sleep notice probe", 0xe1);
	await saySlept(page, tap, liveId, { from: FROM, to: TO });
	await expect(note(page)).toBeVisible();
	await expect(title(page)).toHaveText("Interrupted while the Mac slept (14:02–15:40)");
	// Nothing is said of what followed until the server knows.
	await expect(then(page)).toHaveCount(0);
	await expect(note(page)).toHaveAttribute("data-then", "");
});

test("omp retrying by itself, the turn ending with an error, and a tool out of time are the three lines that follow", async ({
	page,
}) => {
	const { tap, liveId } = await chat(page, "Sleep aftermath probe", 0xe2);
	await saySlept(page, tap, liveId, { from: FROM, to: TO, followed: "retried" });
	await expect(then(page)).toHaveText("omp retried the turn by itself when the Mac woke.");
	await expect(note(page)).toHaveAttribute("data-then", "retried");

	// The server says the note again as what came of it changes: one row, not a second.
	await saySlept(page, tap, liveId, { from: FROM, to: TO, followed: "error" });
	await expect(then(page)).toHaveText("The turn ended with an error. Retry it when you are ready.");
	await expect(note(page)).toHaveCount(1);
});

test("the note is in the interface's language: 简体中文", async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("ompw.lang", "zh-CN"));
	const { tap, liveId } = await chat(page, "休眠提示测试", 0xe3);
	await saySlept(page, tap, liveId, { from: FROM, to: TO, followed: "toolTimeout" });
	await expect(title(page)).toHaveText("Mac 休眠期间被中断（14:02–15:40）");
	await expect(then(page)).toHaveText("Mac 唤醒时，有个工具已超时。");
});

test("Settings finds the Sleep card by its name, its sentence and the words people use for it, and opens it", async ({
	page,
}) => {
	await page.goto("/#/settings");
	const field = page.getByTestId("settings-search-input");
	await expect(field).toBeVisible();
	// The catalogue entry (`lib/settings-search.ts`): its label, then an alias that is in neither the label nor the sentence.
	await field.fill("keep the mac awake");
	await expect(page.getByTestId("settings-search-result").first()).toContainText("Keep the Mac awake");
	await field.fill("caffeinate");
	await field.press("Enter");
	await expect(page.locator('[data-marked="true"]')).toHaveCount(1);
	await expect(page.getByTestId("sleep-settings")).toBeVisible();
	if (process.platform !== "darwin") {
		// A server that is not on a Mac has no `caffeinate` (`keepAwakeAvailable`): the card says so, with no switch to turn.
		await expect(page.getByTestId("keep-awake")).toBeDisabled();
		await expect(page.getByTestId("keep-awake")).not.toBeChecked();
		await expect(page.getByTestId("keep-awake-hint")).toHaveText(
			"This server cannot hold sleep off: it runs on a machine that is not a Mac (macOS's caffeinate is what does it).",
		);
		return;
	}
	await expect(page.getByTestId("keep-awake")).toBeChecked();

	// Its switch is the preference, and turning it off is what the server reads (`ompw.keepAwake`).
	await page.getByTestId("keep-awake").click();
	await expect(page.getByTestId("keep-awake")).not.toBeChecked();
	await expect.poll(() => page.evaluate(() => localStorage.getItem("ompw.keepAwake"))).toBe("off");
});

test("a page that is not on this computer reads the Sleep card and cannot change it", async ({ page }) => {
	// What the server says of a page through the tunnel: `remote` (`/api/meta`), and `/api/prefs` refuses the one key.
	await page.route("**/api/meta", async (route) => {
		const real = await (await route.fetch()).json();
		return route.fulfill({ json: { ...real, remote: true, local: false } });
	});
	await page.goto("/#/settings/app");
	await expect(page.getByTestId("sleep-settings")).toBeVisible();
	await expect(page.getByTestId("keep-awake")).toBeDisabled();
	await expect(page.getByTestId("keep-awake-hint")).toHaveText(
		"This is changed on the computer omp-webui runs on: a page that came in through the tunnel or the network cannot turn off the protection of the conversations it is driving.",
	);
});
