import AxeBuilder from "@axe-core/playwright";
import type { GuardConfig, LiveGuard } from "../../shared/guard.ts";
import { en } from "../../web/src/i18n/guard.ts";
import { zh } from "../../web/src/i18n/zh-CN/guard.ts";
import { ownSession, sessionRow, startLive } from "../support/live.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * "Guard dangerous commands" for one conversation (#626), as the page shows it: the guard in This session (what it is
 * under, where that comes from, a choice that is the conversation's alone, and the settings it still follows), the picker of
 * a new chat, and a page that is not this computer's, which is shown it and cannot change it. No model is called. What the
 * gate then does, and what outlives the server, is tested with the real omp in `tests/contract/guard-conversation.test.ts`.
 */

const POST = { "x-omp-webui": "1" };

/** `{name}` in a string of the app's words, filled in. */
const fill = (text: string, values: Record<string, string>): string =>
	text.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? "");

const setConfig = (page: Page, config: Partial<GuardConfig>) =>
	page.request.post("/api/guard", { data: config, headers: POST });

interface Listed {
	liveId: string;
	cwd: string;
	exited: boolean;
	guard?: LiveGuard;
}
/** What the server says the conversations are under. */
const listed = async (page: Page): Promise<Listed[]> =>
	(await (await page.request.get("/api/lives")).json()) as Listed[];
const guardOf = async (page: Page, liveId: string): Promise<LiveGuard | undefined> =>
	(await listed(page)).find((l) => l.liveId === liveId)?.guard;

// A worker's server is shared by the specs that run after this one: the guard goes back to off, as the harness starts it.
test.beforeEach(async ({ page }) => {
	await setConfig(page, { mode: "reviewer", reviewer: "", askWhenUnavailable: true, askWhenDenied: true });
});
test.afterEach(async ({ page }) => {
	await setConfig(page, { mode: "off", reviewer: "", askWhenUnavailable: true, askWhenDenied: true });
});

/** A started conversation of the spec's own, on a page whose socket is tapped, with its This session panel open. */
async function openPanel(page: Page, n: number, title: string, options: { lang?: string } = {}) {
	ownSession(n, title);
	await page.addInitScript((lang) => {
		localStorage.setItem("ompw.autoTitle", "off");
		localStorage.setItem("ompw.lang", lang);
	}, options.lang ?? "en");
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, `guard-session-${n}`);
	await page.getByTestId("session-controls").click();
	await expect(page.getByTestId("session-guard")).toBeVisible({ timeout: 30_000 });
	return { liveId, tap };
}

const section = (page: Page) => page.getByTestId("session-guard");

test("This session says what the conversation's guard is under and where it comes from; a choice there is its own, and what it did not choose follows Settings", async ({
	page,
}) => {
	const { liveId } = await openPanel(page, 0xf3, "Guard panel own");
	const guard = section(page);

	// A conversation that chose nothing follows the settings: its first choice says so, and no badge says it again (C7).
	await expect(guard).toHaveAttribute("data-own", "false");
	await expect(guard).toHaveAttribute("data-mode", "reviewer");
	await expect(page.getByTestId("session-guard-badge")).toHaveCount(0);
	await expect(page.getByTestId("session-guard-mode-follow")).toBeChecked();
	await expect(guard).toContainText(fill(en.sessionFollowNow, { mode: en.modeReviewer }));
	await expect(page.getByTestId("session-guard-reviewer-origin")).toHaveText(en.sessionFromSettings);
	await expect(page.getByTestId("session-guard-reviewer-origin")).toHaveAttribute("data-own", "false");
	await expect(page.getByTestId("session-guard-ask-origin")).toHaveText(en.sessionFromSettings);
	await expect(page.getByTestId("session-guard-reviewer-use-settings")).toHaveCount(0);
	expect((await guardOf(page, liveId))?.own).toBeUndefined();

	// Ask me, for this conversation: kept by the server for it alone, the settings are what they were.
	await page.getByTestId("session-guard-mode-ask").check();
	await expect(guard).toHaveAttribute("data-own", "true");
	await expect(guard).toHaveAttribute("data-mode", "ask");
	await expect(page.getByTestId("session-guard-badge")).toHaveText(en.sessionBadgeOwn);
	await expect(page.getByTestId("session-guard-reviewer-fields")).toHaveCount(0);
	await expect.poll(async () => (await guardOf(page, liveId))?.own).toEqual({ mode: "ask" });
	expect(((await (await page.request.get("/api/guard")).json()) as { config: GuardConfig }).config.mode).toBe(
		"reviewer",
	);

	// Reviewer model, with a field of its own: the switch says where it stands and gives itself back to Settings.
	await page.getByTestId("session-guard-mode-reviewer").check();
	await expect(page.getByTestId("session-guard-reviewer-fields")).toBeVisible();
	const ask = page.getByTestId("session-guard-ask-unavailable");
	await expect(ask).toHaveAttribute("aria-checked", "true");
	await expect(page.getByTestId("session-guard-ask-origin")).toHaveAttribute("data-own", "false");
	await ask.click();
	await expect(ask).toHaveAttribute("aria-checked", "false");
	await expect(page.getByTestId("session-guard-ask-origin")).toHaveAttribute("data-own", "true");
	await expect(page.getByTestId("session-guard-ask-origin")).toContainText(en.sessionSetHere);
	await expect
		.poll(async () => (await guardOf(page, liveId))?.own)
		.toEqual({ mode: "reviewer", askWhenUnavailable: false });
	await page.getByTestId("session-guard-ask-use-settings").click();
	await expect(ask).toHaveAttribute("aria-checked", "true");
	await expect(page.getByTestId("session-guard-ask-use-settings")).toHaveCount(0);
	await expect.poll(async () => (await guardOf(page, liveId))?.own).toEqual({ mode: "reviewer" });

	// The settings move: this conversation chose its mode, and takes the rest from them, live.
	await setConfig(page, { mode: "ask", reviewer: "a/b", askWhenUnavailable: false });
	await expect(ask).toHaveAttribute("aria-checked", "false");
	await expect(guard).toHaveAttribute("data-mode", "reviewer");
	await expect(page.getByTestId("session-guard-reviewer")).toContainText("a/b");

	// Back to following: the settings' mode is what it is under, and the label says what that is now.
	await page.getByTestId("session-guard-mode-follow").check();
	await expect(guard).toHaveAttribute("data-own", "false");
	await expect(guard).toHaveAttribute("data-mode", "ask");
	await expect(page.getByTestId("session-guard-badge")).toHaveCount(0);
	await expect(guard).toContainText(fill(en.sessionFollowNow, { mode: en.modeAsk }));
	await setConfig(page, { mode: "off", reviewer: "", askWhenUnavailable: true });
	await expect(guard).toHaveAttribute("data-mode", "off");
	await expect.poll(async () => (await guardOf(page, liveId))?.config.mode).toBe("off");
	expect((await guardOf(page, liveId))?.own).toBeUndefined();

	// Off for this conversation alone, whatever the settings are: kept across a reload of the page.
	await setConfig(page, { mode: "reviewer", reviewer: "", askWhenUnavailable: true });
	await page.getByTestId("session-guard-mode-off").check();
	await expect(guard).toHaveAttribute("data-mode", "off");
	await expect.poll(async () => (await guardOf(page, liveId))?.own).toEqual({ mode: "off" });
	await page.reload();
	await sessionRow(page, "Guard panel own").click();
	await page.getByTestId("session-controls").click();
	await expect(section(page)).toHaveAttribute("data-mode", "off", { timeout: 30_000 });
	await expect(section(page)).toHaveAttribute("data-own", "true");
	await expect(page.getByTestId("session-guard-mode-off")).toBeChecked();

	const results = await new AxeBuilder({ page }).include('[data-testid="session-guard"]').analyze();
	expect(results.violations).toEqual([]);
});

test("a page that is not this computer's is shown the conversation's guard and cannot change it", async ({ page }) => {
	// Started as the page of this computer, which is the page that can run a command to start the process: the page then
	// comes back as one that is not, as it would through the tunnel.
	const { liveId } = await openPanel(page, 0xf4, "Guard panel remote");
	const asked: string[] = [];
	page.on("request", (r) => {
		if (r.method() !== "GET" && new URL(r.url()).pathname.startsWith("/api/guard")) asked.push(r.url());
	});
	await page.route("**/api/meta", async (route) => {
		const real = await (await route.fetch()).json();
		return route.fulfill({ json: { ...real, remote: true, local: false } });
	});
	await page.reload();
	await sessionRow(page, "Guard panel remote").click();
	await page.getByTestId("session-controls").click();
	await expect(section(page)).toBeVisible({ timeout: 30_000 });
	// Chosen on the computer the server runs on, as this page's own request: the page itself has no way to.
	const changed = await page.request.post("/api/guard/live", {
		data: { liveId, guard: { mode: "ask", reviewer: "a/b" } },
		headers: POST,
	});
	expect(changed.status()).toBe(200);

	const guard = section(page);
	await expect(guard).toHaveAttribute("data-own", "true");
	await expect(page.getByTestId("session-guard-badge")).toHaveText(en.sessionBadgeOwn);
	await expect(page.getByTestId("session-guard-effective")).toHaveAttribute("data-mode", "ask");
	await expect(page.getByTestId("session-guard-readonly")).toHaveText(en.sessionReadOnly);
	await expect(page.getByTestId("session-guard-modes")).toHaveCount(0);
	await expect(guard.getByRole("radio")).toHaveCount(0);

	// In Reviewer mode what it has more to say is words, not controls.
	await page.request.post("/api/guard/live", { data: { liveId, guard: { mode: "reviewer" } }, headers: POST });
	await expect(page.getByTestId("session-guard-effective")).toHaveAttribute("data-mode", "reviewer");
	await expect(page.getByTestId("session-guard-reviewer")).toHaveText("a/b");
	await expect(page.getByTestId("session-guard-ask-unavailable")).toHaveAttribute("data-on", "true");
	await expect(guard.getByRole("switch")).toHaveCount(0);
	await expect(guard.getByRole("combobox")).toHaveCount(0);
	await expect(page.getByTestId("session-guard-reviewer-use-settings")).toHaveCount(0);
	// Nothing was sent by the page itself.
	expect(asked).toEqual([]);
});

test("New chat lets the guard be picked before the first message, and the process warming up is under it", async ({
	page,
}) => {
	const work = process.env.OMPW_E2E_WORK as string;
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), work);
	await page.goto("/");
	const picker = page.getByTestId("guard-picker");
	await expect(picker).toBeVisible({ timeout: 60_000 });
	await expect(picker).toHaveAttribute("data-mode", "reviewer");
	await expect(picker).toHaveAttribute("data-own", "false");
	await expect(picker).toContainText(fill(en.pickerLabel, { mode: en.modeReviewer }));

	await picker.click();
	const panel = page.getByTestId("guard-picker-panel");
	await expect(panel).toBeVisible();
	await panel.getByTestId("session-guard-mode-off").check();
	await expect(picker).toHaveAttribute("data-mode", "off");
	await expect(picker).toHaveAttribute("data-own", "true");
	await expect(picker).toContainText(fill(en.pickerLabel, { mode: en.modeOff }));
	// The process warming up is the one that is under it; the settings are as they were.
	await expect
		.poll(
			async () =>
				(await listed(page)).filter((l) => !l.exited && l.cwd === work && l.guard?.own?.mode === "off").length,
		)
		.toBe(1);
	expect(((await (await page.request.get("/api/guard")).json()) as { config: GuardConfig }).config.mode).toBe(
		"reviewer",
	);

	// Ask me, with a reviewer of its own would be Reviewer mode: it is chosen, kept, and given back.
	await panel.getByTestId("session-guard-mode-ask").check();
	await expect(picker).toHaveAttribute("data-mode", "ask");
	await panel.getByTestId("session-guard-mode-follow").check();
	await expect(picker).toHaveAttribute("data-mode", "reviewer");
	await expect(picker).toHaveAttribute("data-own", "false");
	await expect
		.poll(
			async () => (await listed(page)).filter((l) => !l.exited && l.cwd === work && l.guard?.own !== undefined).length,
		)
		.toBe(0);
});

test("zh-CN: the guard of a conversation is in Chinese", async ({ page }) => {
	await openPanel(page, 0xf5, "Guard panel zh", { lang: "zh-CN" });
	const guard = section(page);
	await expect(page.getByTestId("session-guard-badge")).toHaveCount(0);
	await expect(guard).toContainText(zh.guardTitle);
	// What the section is for is under its info button in the session panel (#716).
	await page.getByTestId("session-guard-info").click();
	await expect(page.getByTestId("session-guard-help")).toContainText(zh.sessionIntro);
	await expect(guard).toContainText(fill(zh.sessionFollowNow, { mode: zh.modeReviewer }));
	await expect(page.getByTestId("session-guard-reviewer-origin")).toHaveText(zh.sessionFromSettings);
	await page.getByTestId("session-guard-mode-ask").check();
	await expect(page.getByTestId("session-guard-badge")).toHaveText(zh.sessionBadgeOwn);
});

test("Settings › Safety says the settings are the default that a conversation can override", async ({ page }) => {
	await page.goto("/#/settings/safety");
	await expect(page.getByTestId("guard-per-conversation")).toHaveText(en.perConversation);
});

test("a conversation whose kept guard was damaged says so, and none of the modes is shown as the one it is under", async ({
	page,
}) => {
	const { liveId, tap } = await openPanel(page, 0xc1, "Guard panel damaged");
	await expect(page.getByTestId("session-guard-damaged")).toHaveCount(0);
	await expect(page.getByTestId("session-guard-mode-follow")).toBeChecked();
	// What the server tells every page of a conversation under the stricter of the settings and the default.
	const listing = (await (await page.request.get("/api/lives")).json()) as { liveId: string }[];
	const info = listing.find((l) => l.liveId === liveId);
	tap.push({
		t: "live",
		info: { ...info, guard: { config: { mode: "reviewer", reviewer: "", askWhenUnavailable: true }, damaged: true } },
	});
	await expect(page.getByTestId("session-guard-damaged")).toHaveText(en.sessionDamaged);
	await expect(page.getByTestId("session-guard")).toHaveAttribute("data-mode", "reviewer");
	await expect(page.getByTestId("session-guard-modes").getByRole("radio", { checked: true })).toHaveCount(0);
});
