import { rmSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { zh as pagesZh } from "../../web/src/i18n/zh-CN/pages.ts";
import { PALETTES } from "../../web/src/lib/theme.ts";
import { pagesEn } from "../support/i18n-en.ts";
import { SHOWCASE_PROMPT, writeFillerSessions, writeShowcaseSession } from "../support/palette-fixtures.ts";
import { effective, hex, parseHex, readPalettes, resolve } from "../support/palettes.ts";
import { distance, pixelsAt } from "../support/pixels.ts";
import { NOTES_PROMPT, writeNotesSession } from "../support/render-fixtures.ts";
import { choose } from "../support/select.ts";
import type { Rgb } from "../support/style.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Palettes (Settings › Appearance): each of the five looks, in light and in dark, is chosen apart from the mode,
 * remembered, painted before the app starts, and really on the screen — and readable. The per-palette checks run on a
 * synthetic conversation that carries every kind of surface (see support/palette-fixtures.ts), on Settings, in the
 * search dialog and in a menu:
 *
 * - Screenshot check. Flat areas of a real screenshot (the page, the sidebar, a card, the accent bar, the user's bubble)
 *   are compared with the stylesheet's colours for that palette and mode, within 3 per channel. Not a committed
 *   baseline image: those differ between the macOS and Linux runners (fonts, anti-aliasing), and one pixel of text
 *   shifting would fail the suite on every OS update. Flat colour does not move, and it is what a palette is made of.
 *   The screenshots of every combination are attached to the report for a human to look at.
 * - axe colour-contrast with no violations, on the page and after scrolling the transcript through, in every
 *   combination (animations off: axe would otherwise measure a card half-way through its fade-in).
 *
 * No model call.
 */

const palettes = readPalettes();
const MODES = ["light", "dark"] as const;
const COMBOS = PALETTES.flatMap((id) => MODES.map((mode) => ({ id, mode })));
const agentDir = () => process.env.OMPW_E2E_AGENT_DIR as string;

// The sidebar lists these along with whatever the specs before this one left behind. Fillers make the list long
// whatever that was (alone it is short, so a probe over the list's rows would only fail after some other specs).
let files: string[] = [];
test.beforeAll(() => {
	files = [writeShowcaseSession(agentDir()), writeNotesSession(agentDir()), ...writeFillerSessions(agentDir())];
});
test.afterAll(() => {
	for (const file of files) rmSync(file, { force: true });
});

// Animations off: axe measures colours as they are on screen at that moment, and a card still fading in is not final.
test.use({ reducedMotion: "reduce" });

const tokens = (id: string, mode: (typeof MODES)[number]) => effective(palettes[id], mode === "dark");
const token = (id: string, mode: (typeof MODES)[number], name: string) => parseHex(resolve(tokens(id, mode), name));
/** A CSS colour as #rrggbb: the production build shortens #ffffff to #fff, and the browser chrome may be either. */
const canon = (css: string | null) => hex(parseHex(css ?? ""));
/** The page background a palette promises in a mode, as #rrggbb. */
const bgOf = (id: string, mode: (typeof MODES)[number]) => hex(token(id, mode, "bg"));

/** Opens the app with `palette` and `mode` stored, as a returning visitor would have them. */
async function open(page: Page, id: string, mode: string, lang = "en") {
	await page.addInitScript(
		([p, m, l]) => {
			localStorage.setItem("ompw.palette", p);
			localStorage.setItem("ompw.theme", m);
			localStorage.setItem("ompw.lang", l);
		},
		[id, mode, lang],
	);
}

/** Scrolls every large scroll area of the page (the transcript, Settings) to `top`. */
async function scrollTo(page: Page, top: number) {
	await page.evaluate((y) => {
		for (const el of document.querySelectorAll<HTMLElement>("*"))
			if (
				el.clientWidth > 500 &&
				el.scrollHeight > el.clientHeight + 50 &&
				/auto|scroll/.test(getComputedStyle(el).overflowY)
			)
				el.scrollTop = y;
	}, top);
	await page.waitForTimeout(250);
}

/** axe's colour-contrast over what is on the page now; each violating element, in words. */
async function lowContrast(page: Page, where: string): Promise<string[]> {
	const { violations } = await new AxeBuilder({ page }).withRules(["color-contrast"]).analyze();
	return violations.flatMap((v) =>
		v.nodes.map((n) => `${where}: ${n.target.join(" ")} — ${(n.any[0]?.message ?? v.help).replace(/\s+/g, " ")}`),
	);
}

for (const { id, mode } of COMBOS) {
	test(`${id} ${mode}: painted as the palette says, and readable everywhere`, async ({ page }, testInfo) => {
		await open(page, id, mode);
		const bad: string[] = [];
		const painted = (what: string, got: Rgb, want: string) => {
			const d = distance(got, token(id, mode, want));
			if (d > 3) bad.push(`${what}: painted ${hex(got)}, ${want} is ${resolve(tokens(id, mode), want)}`);
		};

		// --- Settings: the page, the sidebar, a card, the accent bar of the current page, the browser chrome.
		// The sidebar's own colour is read in the left margin of its list: rows, badges and text start after it, however
		// many conversations are listed (a point over the list lands on a row's text as soon as the list is long).
		await page.goto("/#/settings");
		const settings = page.getByTestId("settings-page");
		await expect(settings).toBeVisible();
		await expect(page.locator("html")).toHaveAttribute("data-palette", id);
		await expect(page.locator("html")).toHaveClass(mode === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/);
		const current = page.getByRole("button", { name: "Settings", exact: true });
		await expect(current).toHaveAttribute("aria-current", "page");
		await page.mouse.move(700, 880); // off every control
		const card = await settings.locator("section").first().boundingBox();
		const bar = await current.boundingBox();
		const list = await page.getByTestId("session-list").boundingBox();
		if (!card || !bar || !list) throw new Error("no layout");
		const shot = await page.screenshot({ animations: "disabled" });
		await testInfo.attach(`settings-${id}-${mode}.png`, { body: shot, contentType: "image/png" });
		const [page_, side, cardPixel, accent] = await pixelsAt(page, shot, [
			{ x: 1360, y: 450 },
			{ x: list.x + 3, y: list.y + list.height / 2 },
			{ x: card.x + card.width / 2, y: card.y + card.height - 8 },
			{ x: bar.x + 1, y: bar.y + bar.height / 2 },
		]);
		await painted("page background", page_, "bg");
		await painted("sidebar", side, "bg-soft");
		await painted("card", cardPixel, "surface");
		await painted("accent bar of the current page", accent, "accent");
		const chrome = await page.locator('meta[name="theme-color"]').getAttribute("content");
		expect(canon(chrome), "the browser chrome takes the page background").toBe(bgOf(id, mode));
		// Every page of Settings, from its top to its end (only the shown page is on the screen).
		for (const p of ["look", "chats", "models", "safety", "app"]) {
			await page.goto(`/#/settings/${p}`);
			await expect(page.locator(`[data-settings-page="${p}"]`)).toBeVisible();
			await scrollTo(page, 0);
			bad.push(...(await lowContrast(page, `settings ${p}`)));
			await scrollTo(page, 100000);
			bad.push(...(await lowContrast(page, `settings ${p} (end)`)));
		}

		// --- The synthetic conversation: markdown, code in five languages, a diff, a failed tool, thinking.
		await page.goto("/");
		await page.locator('[data-testid="session-item"]', { hasText: SHOWCASE_PROMPT }).click();
		await expect(page.getByTestId("work-summary").first()).toBeVisible();
		await page.getByTestId("work-summary").first().click();
		await expect(page.getByTestId("tool-card").first()).toBeVisible();
		await page.mouse.move(700, 880);
		const bubbleBox = await page.getByTestId("msg-user").first().locator("div").first().boundingBox();
		await scrollTo(page, 0);
		await expect(page.getByTestId("msg-user").first()).toBeVisible();
		const bubbleNow = await page.getByTestId("msg-user").first().locator("div").first().boundingBox();
		if (!bubbleNow || !bubbleBox) throw new Error("no bubble");
		const convo = await page.screenshot({ animations: "disabled" });
		await testInfo.attach(`conversation-${id}-${mode}.png`, { body: convo, contentType: "image/png" });
		const [bubble] = await pixelsAt(page, convo, [{ x: bubbleNow.x + 6, y: bubbleNow.y + bubbleNow.height / 2 }]);
		await painted("user's bubble", bubble, "user-bubble");
		bad.push(...(await lowContrast(page, "conversation (top)")));
		for (const y of [700, 1400, 2200, 100000]) {
			await scrollTo(page, y);
			bad.push(...(await lowContrast(page, `conversation (${y})`)));
		}

		// Code on the page wears this palette's code colours.
		await scrollTo(page, 0);
		const keyword = page.locator('pre.shiki span[style*="--shiki-token-keyword"]').first();
		await keyword.scrollIntoViewIfNeeded();
		const colour = await keyword.evaluate((el) => getComputedStyle(el).color);
		const want = token(id, mode, "shiki-token-keyword");
		expect(colour, "keyword colour").toBe(`rgb(${want.r}, ${want.g}, ${want.b})`);

		// --- What omp writes about itself: advisor cards, rules, jobs, IRC; and the tool cards of a folded turn.
		await page.locator('[data-testid="session-item"]', { hasText: NOTES_PROMPT }).click();
		await page.getByTestId("work-summary").first().click();
		await expect(page.getByTestId("advisor-card")).toBeVisible();
		await page.getByTestId("tool-card").first().waitFor();
		bad.push(...(await lowContrast(page, "notes")));

		// --- The permission switcher's menu: Auto-approve's hint is drawn in the warning colour on the menu's surface.
		await page.getByTestId("approval-picker").click({ timeout: 30_000 });
		await expect(page.getByTestId("approval-yolo")).toBeVisible();
		bad.push(...(await lowContrast(page, "approval menu")));
		await page.keyboard.press("Escape");

		// --- Search, and a menu (both are portals, outside the page's own surfaces).
		await page.keyboard.press("ControlOrMeta+k");
		await expect(page.getByTestId("palette-input")).toBeVisible();
		bad.push(...(await lowContrast(page, "search")));
		await page.keyboard.press("Escape");
		const row = page.locator('[data-testid="session-item"]', { hasText: NOTES_PROMPT });
		await row.hover();
		await page.getByRole("button", { name: `Actions for ${NOTES_PROMPT}` }).click();
		await page.getByRole("menuitem", { name: "Rename" }).hover();
		bad.push(...(await lowContrast(page, "session menu")));
		await page.keyboard.press("Escape");

		expect(bad, `${id} ${mode}`).toEqual([]);
	});
}

test("the choice is independent of light, dark and system, remembered, and shown by every option's own preview", async ({
	page,
}) => {
	await page.emulateMedia({ colorScheme: "dark" });
	await page.goto("/#/settings");
	const html = page.locator("html");
	const chosen = (id: string) => page.getByTestId(`palette-${id}`);
	await expect(page.getByTestId("palette-picker").getByRole("radio")).toHaveCount(PALETTES.length);
	// Nothing stored: the original Claude look, dark.
	await expect(html).toHaveAttribute("data-palette", "claude");
	await expect(chosen("claude").getByRole("radio")).toBeChecked();

	await chosen("chatgpt").click();
	await expect(html).toHaveAttribute("data-palette", "chatgpt");
	await expect(html).toHaveClass(/\bdark\b/);
	expect(await page.evaluate(() => localStorage.getItem("ompw.palette"))).toBe("chatgpt");

	// The mode buttons change the mode and nothing else, whichever palette is on.
	await page.locator("label", { has: page.locator('input[name="theme"]'), hasText: "Light" }).click();
	await expect(html).not.toHaveClass(/\bdark\b/);
	await expect(html).toHaveAttribute("data-palette", "chatgpt");
	expect(canon(await html.evaluate((el) => getComputedStyle(el).getPropertyValue("--bg")))).toBe(
		bgOf("chatgpt", "light"),
	);
	await chosen("terminal").click();
	await expect(html).not.toHaveClass(/\bdark\b/);
	await page.locator("label", { hasText: "System" }).click();
	await expect(html).toHaveClass(/\bdark\b/);
	await expect(html).toHaveAttribute("data-palette", "terminal");
	expect(canon(await html.evaluate((el) => getComputedStyle(el).getPropertyValue("--bg")))).toBe(
		bgOf("terminal", "dark"),
	);
	await page.emulateMedia({ colorScheme: "light" });
	await expect(html).not.toHaveClass(/\bdark\b/);
	await expect(html).toHaveAttribute("data-palette", "terminal");
	expect(canon(await page.locator('meta[name="theme-color"]').getAttribute("content"))).toBe(bgOf("terminal", "light"));

	// Remembered across a reload; the stored mode (system) and palette both come back.
	await page.reload();
	await expect(html).toHaveAttribute("data-palette", "terminal");
	await expect(chosen("terminal").getByRole("radio")).toBeChecked();
	await page.emulateMedia({ colorScheme: "dark" });
	await expect(html).toHaveClass(/\bdark\b/);

	// Each option previews itself in both modes, in its own colours, whatever the page around it is showing.
	for (const id of PALETTES)
		for (const mode of MODES) {
			const tile = chosen(id).locator(`[data-palette="${id}"][data-mode="${mode}"]`);
			expect(await tile.evaluate((el) => getComputedStyle(el).backgroundColor), `${id} ${mode} tile`).toBe(
				(({ r, g, b }) => `rgb(${r}, ${g}, ${b})`)(token(id, mode, "bg")),
			);
		}
});

test("the palette is on <html> before the app's scripts run: no flash", async ({ page }) => {
	// Without any of the app's own scripts, only index.html's inline script and the stylesheet are there.
	await page.route(/\/assets\/[^?]*\.js(\?.*)?$/, (route) => route.abort());
	await page.goto("/");
	for (const { id, mode } of COMBOS) {
		await page.evaluate(
			([p, m]) => {
				localStorage.setItem("ompw.palette", p);
				localStorage.setItem("ompw.theme", m);
			},
			[id, mode],
		);
		await page.reload();
		const state = await page.evaluate(() => ({
			palette: document.documentElement.dataset.palette,
			dark: document.documentElement.classList.contains("dark"),
			background: getComputedStyle(document.body).backgroundColor,
			booted: (document.getElementById("root")?.childElementCount ?? 0) > 0,
		}));
		const { r, g, b } = token(id, mode, "bg");
		expect(state, `${id} ${mode}`).toEqual({
			palette: id,
			dark: mode === "dark",
			background: `rgb(${r}, ${g}, ${b})`,
			booted: false,
		});
	}
});

test("the palette picker is named in English and in Chinese", async ({ page }) => {
	await open(page, "claude", "light", "zh-CN");
	await page.goto("/#/settings");
	await expect(page.getByRole("heading", { name: pagesZh.settingsPalette })).toBeVisible();
	await expect(page.getByText(pagesZh.settingsPaletteHint)).toBeVisible();
	const picker = page.getByTestId("palette-picker");
	await expect(picker).toHaveAccessibleName(pagesZh.settingsPalette);
	for (const id of PALETTES) {
		const key = `settingsPalette${id[0].toUpperCase()}${id.slice(1)}` as keyof typeof pagesZh;
		await expect(page.getByTestId(`palette-${id}`)).toContainText(pagesZh[key]);
		await expect(page.getByTestId(`palette-${id}`)).toContainText(pagesZh[`${key}Desc` as keyof typeof pagesZh]);
	}
	await expect(picker.getByRole("radio", { name: pagesZh.settingsPaletteTerminal })).toBeVisible();

	await choose(page.getByTestId("language"), "en");
	await expect(page.getByRole("heading", { name: pagesEn.settingsPalette })).toBeVisible();
	await expect(picker.getByRole("radio", { name: pagesEn.settingsPaletteTerminal })).toBeVisible();
});
