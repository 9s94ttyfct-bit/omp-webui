import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type GuardConfig, type LiveGuard, parseGuardWord } from "../../shared/guard.ts";
import { en } from "../../web/src/i18n/guard.ts";
import { zh } from "../../web/src/i18n/zh-CN/guard.ts";
import { ownSession, sessionRow, startLive } from "../support/live.ts";
import type { TestServer } from "../support/server.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The guard's switch in a conversation's header (v0.12.2): Off for this conversation alone and back on to what it was under
 * before, in step with This session; red while off; what its process's gate is told (the word it reads before each tool
 * call: Off is a call nobody looks at); and the pages that may not switch it. No model is called.
 */

const POST = { "x-omp-webui": "1" };

const fill = (text: string, values: Record<string, string>): string =>
	text.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? "");

const setConfig = (page: Page, config: Partial<GuardConfig>) =>
	page.request.post("/api/guard", { data: config, headers: POST });

const guardOf = async (page: Page, liveId: string): Promise<LiveGuard | undefined> =>
	((await (await page.request.get("/api/lives")).json()) as { liveId: string; guard?: LiveGuard }[]).find(
		(l) => l.liveId === liveId,
	)?.guard;

/** The mode the gate of the conversation's process reads before each tool call (`<overlay>.risk`, see `Live.syncRisk`). */
function gateMode(server: TestServer, liveId: string): string | null {
	for (const dir of readdirSync(server.tmpDir)) {
		if (!dir.startsWith("ompw-live-")) continue;
		const file = join(server.tmpDir, dir, `${liveId}.yml.risk`);
		if (existsSync(file)) return parseGuardWord(JSON.parse(readFileSync(file, "utf8")).guard)?.mode ?? null;
	}
	return null;
}

test.beforeEach(async ({ page }) => {
	await setConfig(page, { mode: "reviewer", reviewer: "", askWhenUnavailable: true, askWhenDenied: true });
});
// A worker's server is shared by the specs that run after this one: the guard goes back to off, as the harness starts it.
test.afterEach(async ({ page }) => {
	await setConfig(page, { mode: "off", reviewer: "", askWhenUnavailable: true, askWhenDenied: true });
});

async function openChat(page: Page, n: number, title: string, lang = "en") {
	ownSession(n, title);
	await page.addInitScript((l) => {
		localStorage.setItem("ompw.autoTitle", "off");
		localStorage.setItem("ompw.lang", l);
	}, lang);
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, `guard-toggle-${n}`);
	await expect(page.getByTestId("guard-toggle")).toBeVisible({ timeout: 30_000 });
	return { liveId, tap };
}

/** The colour the palette calls danger, as the page computes it. */
const dangerColor = (page: Page) =>
	page.evaluate(() => {
		const probe = document.createElement("span");
		probe.style.color = "var(--danger)";
		document.body.append(probe);
		const color = getComputedStyle(probe).color;
		probe.remove();
		return color;
	});

test("the switch turns the guard off for this conversation alone and back on to what it was under, in step with This session and the gate", async ({
	page,
	e2eServer,
}) => {
	const { liveId } = await openChat(page, 0x6b10, "Guard toggle round trip");
	const toggle = page.getByTestId("guard-toggle");
	const danger = await dangerColor(page);

	// On, following Settings: plain, and it names the mode.
	await expect(toggle).toHaveAttribute("data-state", "on");
	await expect(toggle).toHaveAttribute("aria-checked", "true");
	await expect(toggle).toHaveAttribute("aria-label", fill(en.toggleStateOn, { mode: en.modeReviewer }));
	expect(await toggle.evaluate((el) => getComputedStyle(el).color)).not.toBe(danger);
	// Beside This session's button.
	const [a, b] = [await toggle.boundingBox(), await page.getByTestId("session-controls").boundingBox()];
	expect(a && b && Math.abs(b.x - (a.x + a.width)) < 16 && Math.abs(a.y - b.y) < 4).toBe(true);
	await toggle.hover();
	await expect(page.getByRole("tooltip")).toContainText(en.toggleTurnOff);
	expect(gateMode(e2eServer, liveId)).toBe("reviewer");

	// Off: red, says so, kept for this conversation alone, and the gate looks at nothing.
	await toggle.click();
	await expect(toggle).toHaveAttribute("data-state", "off");
	await expect(toggle).toHaveAttribute("data-off", "here");
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	await expect(toggle).toHaveAttribute("aria-label", en.toggleStateOff);
	await expect.poll(() => toggle.evaluate((el) => getComputedStyle(el).color)).toBe(danger);
	await expect.poll(async () => (await guardOf(page, liveId))?.own).toEqual({ mode: "off" });
	expect(((await (await page.request.get("/api/guard")).json()) as { config: GuardConfig }).config.mode).toBe(
		"reviewer",
	);
	await expect.poll(() => gateMode(e2eServer, liveId)).toBe("off");

	// This session says the same.
	await page.getByTestId("session-controls").click();
	const section = page.getByTestId("session-guard");
	await expect(section).toHaveAttribute("data-mode", "off", { timeout: 30_000 });
	await expect(page.getByTestId("session-guard-mode-off")).toBeChecked();

	// Chosen there: the switch follows.
	await page.getByTestId("session-guard-mode-ask").check();
	await expect(toggle).toHaveAttribute("data-state", "on");
	await expect(toggle).toHaveAttribute("data-mode", "ask");
	await page.keyboard.press("Escape");
	await expect(section).toHaveCount(0);
	await expect(page.getByTestId("session-controls")).toBeFocused();

	// Off by the keyboard (the switch is the stop before This session's button), then on again: Ask me, what it was under,
	// not Settings' Reviewer model.
	await page.keyboard.press("Shift+Tab");
	await expect(toggle).toBeFocused();
	await page.keyboard.press("Enter");
	await expect(toggle).toHaveAttribute("data-state", "off");
	await expect.poll(() => gateMode(e2eServer, liveId)).toBe("off");
	await expect(toggle).toBeFocused();
	await page.keyboard.press("Space");
	await expect(toggle).toHaveAttribute("data-state", "on");
	await expect(toggle).toHaveAttribute("data-mode", "ask");
	await expect.poll(async () => (await guardOf(page, liveId))?.own).toEqual({ mode: "ask" });
	await expect.poll(() => gateMode(e2eServer, liveId)).toBe("ask");

	// One that followed Settings follows them again: off in This session, on by the switch.
	await page.getByTestId("session-controls").click();
	await page.getByTestId("session-guard-mode-follow").check();
	await expect(toggle).toHaveAttribute("data-mode", "reviewer");
	await page.getByTestId("session-guard-mode-off").check();
	await expect(toggle).toHaveAttribute("data-state", "off");
	await page.keyboard.press("Escape");
	await toggle.click();
	await expect(toggle).toHaveAttribute("data-state", "on");
	await expect(toggle).toHaveAttribute("data-mode", "reviewer");
	await expect.poll(async () => (await guardOf(page, liveId))?.own).toBeUndefined();
	await expect.poll(() => gateMode(e2eServer, liveId)).toBe("reviewer");

	// What it was under is remembered across a reload of the page.
	await page.getByTestId("session-controls").click();
	await page.getByTestId("session-guard-mode-ask").check();
	await page.keyboard.press("Escape");
	await toggle.click();
	await expect(toggle).toHaveAttribute("data-state", "off");
	await page.reload();
	await sessionRow(page, "Guard toggle round trip").click();
	await expect(toggle).toHaveAttribute("data-state", "off", { timeout: 30_000 });
	await toggle.hover();
	await expect(page.getByRole("tooltip")).toContainText(fill(en.toggleTurnOnPrevious, { mode: en.modeAsk }));
	await toggle.click();
	await expect(toggle).toHaveAttribute("data-mode", "ask");
});

test("Off by following Settings is muted, Off chosen here is red; with nothing remembered, on is the shipped default", async ({
	page,
	e2eServer,
}) => {
	await setConfig(page, { mode: "off" });
	const { liveId } = await openChat(page, 0x6b11, "Guard toggle default");
	const toggle = page.getByTestId("guard-toggle");
	const danger = await dangerColor(page);
	// Off because it follows Settings' Off: muted, not red, and it says so; a click turns it on for this conversation.
	await expect(toggle).toHaveAttribute("data-state", "off");
	await expect(toggle).toHaveAttribute("data-off", "settings");
	await expect(toggle).toHaveAttribute("aria-checked", "false");
	await expect(toggle).toHaveAttribute("aria-label", en.toggleStateOffSettings);
	expect(await toggle.evaluate((el) => getComputedStyle(el).color)).not.toBe(danger);
	await toggle.hover();
	await expect(page.getByRole("tooltip")).toContainText(en.toggleStateOffSettings);
	await expect(page.getByRole("tooltip")).toContainText(fill(en.toggleTurnOnHere, { mode: en.modeReviewer }));
	await toggle.click();
	await expect(toggle).toHaveAttribute("data-state", "on");
	await expect.poll(async () => (await guardOf(page, liveId))?.own).toEqual({ mode: "reviewer" });
	await expect.poll(() => gateMode(e2eServer, liveId)).toBe("reviewer");

	// Off for this conversation, with Settings at Off too: its own choice, so red.
	await toggle.click();
	await expect(toggle).toHaveAttribute("data-off", "here");
	await expect(toggle).toHaveAttribute("aria-label", en.toggleStateOff);
	await expect.poll(() => toggle.evaluate((el) => getComputedStyle(el).color)).toBe(danger);
	await expect.poll(async () => (await guardOf(page, liveId))?.own).toEqual({ mode: "off" });

	// Given back to Settings in This session: muted again.
	await page.getByTestId("session-controls").click();
	await page.getByTestId("session-guard-mode-follow").check();
	await expect(toggle).toHaveAttribute("data-off", "settings");
	await expect.poll(() => toggle.evaluate((el) => getComputedStyle(el).color)).not.toBe(danger);
});

test("a page that is not this computer's has the switch shown and not usable, says why, and sends nothing", async ({
	page,
}) => {
	const { liveId } = await openChat(page, 0x6b12, "Guard toggle blocked");
	const toggle = page.getByTestId("guard-toggle");
	await expect(toggle).not.toHaveAttribute("aria-disabled", "true");

	// Not this computer's page: shown, not usable, and nothing is sent.
	const asked: string[] = [];
	page.on("request", (r) => {
		if (r.method() !== "GET" && new URL(r.url()).pathname.startsWith("/api/guard")) asked.push(r.url());
	});
	await page.route("**/api/meta", async (route) => {
		const real = await (await route.fetch()).json();
		return route.fulfill({ json: { ...real, remote: true, local: false } });
	});
	await page.reload();
	await sessionRow(page, "Guard toggle blocked").click();
	await expect(toggle).toHaveAttribute("data-block", "remote", { timeout: 30_000 });
	await expect(toggle).toHaveAttribute("aria-disabled", "true");
	await expect(toggle).toHaveAttribute("data-state", "on");
	await toggle.hover();
	await expect(page.getByRole("tooltip")).toContainText(en.toggleRemote);
	// Still focusable, so the keyboard reaches it and a tap (no tooltip on a phone) is told why.
	await toggle.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("toast-text").filter({ hasText: en.toggleRemote })).toBeVisible();
	await expect(toggle).toHaveAttribute("data-state", "on");
	// Changed on this computer: the page that cannot change it shows it.
	await page.request.post("/api/guard/live", { data: { liveId, guard: { mode: "off" } }, headers: POST });
	await expect(toggle).toHaveAttribute("data-state", "off");
	expect(asked).toEqual([]);
});

test("a narrow window keeps the switch in the header beside the menu, and nothing spills out; in Chinese", async ({
	page,
}) => {
	await openChat(page, 0x6b13, "Guard toggle narrow", "zh-CN");
	const toggle = page.getByTestId("guard-toggle");
	await expect(toggle).toHaveAttribute("aria-label", fill(zh.toggleStateOn, { mode: zh.modeReviewer }));
	await toggle.click();
	await expect(toggle).toHaveAttribute("aria-label", zh.toggleStateOff);
	for (const width of [600, 390, 320]) {
		await page.setViewportSize({ width, height: 800 });
		await expect(page.getByTestId("chat-more")).toBeVisible();
		await expect(toggle).toBeVisible();
		const header = page.locator("header").filter({ has: page.getByTestId("chat-title") });
		const spill = await header.evaluate((el) => el.scrollWidth - el.clientWidth);
		expect(spill, `header at ${width}px`).toBeLessThanOrEqual(0);
		const [box, menu] = [await toggle.boundingBox(), await page.getByTestId("chat-more").boundingBox()];
		// Inside the window, and beside the menu that holds This session.
		expect(box && menu && box.x >= 0 && box.x + box.width <= width && menu.x - (box.x + box.width) < 48).toBe(true);
	}
});
