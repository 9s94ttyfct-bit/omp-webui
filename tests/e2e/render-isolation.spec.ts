import { appendFileSync } from "node:fs";
import { basename } from "node:path";
import type { Page } from "@playwright/test";
import { apiInFlight } from "../support/api-in-flight.ts";
import { writeSimpleSession } from "../support/fixtures.ts";
import { ownSession, sessionRow, startLive } from "../support/live.ts";
import { endAllLives } from "../support/lives.ts";
import {
	COUNT_RENDERS,
	countRendersOf,
	type Of,
	painted,
	renderReasons,
	rendersCounted,
} from "../support/render-count.ts";
import { assistant } from "../support/session-entries.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, test } from "./fixtures.ts";

/**
 * A conversation that streams in the background (a goal run) writes the store once per animation frame. A screen that
 * reads the whole store renders again for every one of them, up to 60 times a second, whatever it shows (#364). With
 * New chat or Settings on screen, the tokens of another conversation must render that screen not at all.
 *
 * What is counted is the screen's own renders, not the page's commits (`render-count.ts`). Counting the commits of the
 * whole page would also count what the sidebar, a toast or a clock does, which is none of this screen's business, and a
 * test that fails for those is a test that fails at random (#484). So would React's mark alone: it stays on a screen
 * that later commits pass by, and a list of conversations that changes commits the sidebar. No test seam is needed in
 * the app, and no model is called.
 */

/**
 * The screen has stopped rendering: what it loads on its own is drawn. It is waited for on the screen's own count, so
 * that a load that takes longer than a moment (a process that starts slowly) does not land while the tokens are
 * counted (#484). The count has to hold still for a while, not for one poll: a load may come a moment after the one
 * before it. And nothing the page asked of the server is still unanswered: on CI New chat's model config for the
 * warm-up's folder (`/api/model-config?cwd=`) took 3.2 s, longer than the count held still, and its answer was the one
 * render counted during the tokens (the render's reasons: the hook of `useStartConfig`, from nothing to the config).
 */
async function quiet(page: Page, inFlight: () => number): Promise<void> {
	let last = -1;
	let still = 0;
	await expect
		.poll(
			async () => {
				const now = await rendersCounted(page);
				still = now === last && inFlight() === 0 ? still + 1 : 0;
				last = now;
				return still >= 3;
			},
			{ intervals: [1000], timeout: 60_000 },
		)
		.toBe(true);
}

const WORDS = Array.from({ length: 40 }, (_, i) => `w${i} `);

/**
 * An element the screen draws, which its component is found from. New chat opens on a new project, whose name field is
 * drawn by a part of its own: New chat is the component above it that is given the folder it was opened in (`cwd`).
 */
const SCREEN: Record<"New chat" | "Settings", Of> = {
	"New chat": { element: '[data-testid="new-project-name"]', props: ["cwd"] },
	Settings: { element: '[data-testid="settings-page"]' },
};

/** The screen's component is found, and from here on every render of it is counted. */
async function countRenders(page: Page, screen: keyof typeof SCREEN): Promise<void> {
	await expect(page.locator(SCREEN[screen].element)).toBeVisible();
	await countRendersOf(page, SCREEN[screen]);
}

/** Shows one of Settings' pages: its cards are the only ones visible, the others stay in the page but hidden. */
const settingsPageTab = (page: Page, id: "look" | "chats" | "models" | "safety" | "app") =>
	page.locator(`[data-testid="settings-page-tab"][data-page="${id}"]`).click();

/**
 * Every section of Settings shows what it loaded, and none of them is a spinner any more: each of them is a render of
 * the screen that has nothing to do with the conversation streaming elsewhere (#484).
 */
async function settingsLoaded(page: Page): Promise<void> {
	const main = page.locator("main");
	await settingsPageTab(page, "models");
	await expect(main.getByTestId("model-roles")).toBeVisible({ timeout: 60_000 });
	await expect(main.getByTestId("mode-settings")).toBeVisible({ timeout: 60_000 });
	await settingsPageTab(page, "look");
	await expect(main.getByTestId("palette-picker")).toBeVisible({ timeout: 60_000 });
	await expect(main.getByLabel("Loading")).toHaveCount(0, { timeout: 60_000 });
}

for (const screen of ["New chat", "Settings"] as const) {
	test(`${screen} does not render for the tokens of a conversation that streams elsewhere`, async ({ page }) => {
		const title = `Render isolation ${screen}`;
		ownSession(screen === "Settings" ? 0xe7 : 0xe6, title);
		await page.addInitScript(COUNT_RENDERS);
		await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
		const tap = await tapSocket(page);
		const inFlight = apiInFlight(page);
		await page.goto("/");
		const liveId = await startLive(page, tap, title, `render-isolation-${screen === "Settings" ? "s" : "n"}`);
		const frame = (f: Record<string, unknown>) => tap.push({ t: "frame", liveId, frame: f });
		const event = (type: string, extra: Record<string, unknown> = {}) =>
			frame({
				type: "message_update",
				messageId: "m1",
				message: { role: "assistant" },
				assistantMessageEvent: { type, contentIndex: 0, ...extra },
			});

		// A turn is running when the user goes to the other screen: the conversation stays attached, and its reply goes on.
		frame({ type: "agent_start" });
		const main = page.locator("main");
		if (screen === "Settings") {
			await page.getByRole("button", { name: "Settings", exact: true }).click();
			await expect(page.getByTestId("settings-page")).toBeVisible();
			await settingsPageTab(page, "app");
			// Settings lists every process the server runs, the previous test's idle one too (#592): this one is found by
			// its conversation's title, which the list reads without reading the whole list.
			const row = page.getByTestId("running-session").filter({ hasText: title });
			await expect(row.getByTestId("running-status")).toHaveText("working");
			await settingsLoaded(page);
		} else {
			await page.getByTestId("new-chat").click();
			// The warm-up process of New chat is up when it says which model it uses: its own loads (its state, its
			// models) come after that, and each of them is a render of the screen that has nothing to do with the
			// conversation streaming elsewhere (#484). Until then the picker shows the fallback label, in the
			// language of the page ("Model", "模型").
			await expect(main.getByTestId("model-picker")).not.toHaveText(/^(Model|模型)$/, { timeout: 60_000 });
		}
		// The reply is written while the other screen is on: the message starts there, so the page holds it.
		frame({ type: "message_start", messageId: "m1", message: { role: "assistant", content: [], timestamp: 5 } });
		event("text_start");
		await painted(page);

		await countRenders(page, screen);
		// The screen is given time to finish what it loads on its own (the warm-up process, its sections): each of
		// those is a render of the screen that has nothing to do with the conversation streaming elsewhere, and a
		// screen that is still starting up would be measured as rendering for it (#484). What is waited for is the
		// screen itself falling quiet, so it does not matter how long any of it takes.
		await quiet(page, inFlight);

		// The screen is measured over the tokens: what it renders for itself (a clock, a toast) is not the screen
		// rendering for the conversation, and is not counted as such.
		const before = await rendersCounted(page);
		for (const word of WORDS) {
			event("text_delta", { delta: word });
			await painted(page);
		}
		await painted(page);
		await painted(page);
		// New chat rendered once here in 5 of some 100 CI runs and never on a Mac: nothing reached the page meanwhile
		// (the traces' socket and network), so the message says what of the screen had changed.
		expect(await rendersCounted(page), `${screen}'s renders:\n${await renderReasons(page)}`).toBe(before);

		// Every token did reach the store: the conversation shows the whole reply when the page goes back to it.
		await sessionRow(page, title).click();
		await expect(page.getByText(WORDS.join("").trim())).toBeVisible();
	});
}

/**
 * Every conversation of the server writes its file, and the server tells every page (`sessions_changed`): in a worker
 * that runs one spec after another, the conversations an earlier spec left behind are still doing it while this one
 * runs. The list of conversations changes, and Settings, which only names the processes it lists by their titles, must
 * not render for a conversation it does not show (#520).
 *
 * What Settings does show must hold still meanwhile, or its renders are not this test's (#6): the processes the tests
 * above left are ended first (one that ends is a row Settings takes away), and the page opens on Settings itself: on
 * New chat it would start a warm-up process, which on a loaded machine came up while the list was measured, a row that
 * Settings lists, three renders that were right.
 */
test("Settings does not render when the list of conversations changes for another conversation", async ({
	page,
	e2eServer,
}) => {
	await endAllLives(e2eServer);
	ownSession(0xe8, "Render isolation Settings list");
	const other = writeSimpleSession(process.env.OMPW_E2E_AGENT_DIR as string, 0xe9, "Render isolation other");
	await page.addInitScript(COUNT_RENDERS);
	const inFlight = apiInFlight(page);
	await page.goto("/#/settings/look");
	await expect(sessionRow(page, "Render isolation other")).toHaveCount(1, { timeout: 15_000 });
	await expect(page.getByTestId("settings-page")).toBeVisible();
	await settingsLoaded(page);
	await countRenders(page, "Settings");
	await quiet(page, inFlight);

	const before = await rendersCounted(page);
	// The other conversation is written to, and the page has the changed list: the server's answer names its row.
	const answered = page.waitForResponse(async (r) => {
		if (!r.url().includes("/api/sessions")) return false;
		const body = (await r.json()) as { file: string }[] | { changed?: { file: string }[] };
		// The server names files by their real path (`/private/var` for `/var` on macOS): the file's own name is what is compared.
		return (Array.isArray(body) ? body : (body.changed ?? [])).some((s) => s.file.endsWith(basename(other)));
	});
	appendFileSync(other, `${JSON.stringify(assistant("se9000003", "se9000002", 400, { text: "And more." }))}\n`);
	await answered;
	await painted(page);
	await painted(page);
	await painted(page);
	expect(await rendersCounted(page)).toBe(before);
});
