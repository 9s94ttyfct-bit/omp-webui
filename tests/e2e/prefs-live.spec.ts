import { PREF } from "../../shared/prefs.ts";
import { FIXTURE } from "../support/fixtures.ts";
import { boxOf } from "../support/geometry.ts";
import { sessionRow } from "../support/live.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { type Browser, expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * A preference chosen in one page shows in the others that are already open, with no reload: the server tells every
 * page (`prefs` on the socket), and tabs of one origin also hear the storage event. Theme, palette, language and the
 * panel widths. And dragging a panel's edge writes the width once, where the drag ends (no model call).
 */

const SIDEBAR_DEFAULT = 288;

let s: TestServer;
test.beforeAll(async () => {
	s = await startTestServer(0);
});
test.afterAll(async () => {
	await s?.stop();
});

async function open(page: Page): Promise<void> {
	await page.goto(`${s.url}/?token=${s.accessToken}#/settings`);
	await expect(page.getByTestId("resize-sidebar")).toBeVisible();
	await expect(page.getByTestId("language")).toBeVisible();
}

/** Press on the handle, move the pointer by `dx` in steps, release; `during` runs before the release. */
async function drag(page: Page, el: Locator, dx: number, during?: () => Promise<void>) {
	const box = await boxOf(el);
	const x = box.x + box.width / 2;
	const y = box.y + box.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	for (let i = 1; i <= 24; i++) {
		await page.mouse.move(x + (dx * i) / 24, y);
		await page.waitForTimeout(60);
	}
	await during?.();
	await page.mouse.up();
}

const mode = (page: Page) =>
	page.evaluate(() => ({
		dark: document.documentElement.classList.contains("dark"),
		palette: document.documentElement.dataset.palette,
	}));

async function chooseEverything(page: Page, light: boolean, palette: string, lang: string, sidebarDx: number) {
	await page
		.locator("label", { hasText: light ? "Light" : "Dark" })
		.first()
		.click();
	await page.getByTestId(`palette-${palette}`).click();
	await page.getByTestId("language").selectOption(lang);
	await drag(page, page.getByTestId("resize-sidebar"), sidebarDx);
}

async function expectEverything(page: Page, light: boolean, palette: string, lang: string, sidebar: number) {
	await expect(page.locator("html")).toHaveAttribute("data-palette", palette);
	if (light) await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
	else await expect(page.locator("html")).toHaveClass(/\bdark\b/);
	await expect(
		page.locator('input[name="theme"]').and(page.locator(`[value="${light ? "light" : "dark"}"]`)),
	).toBeChecked();
	await expect(page.getByTestId(`palette-${palette}`).getByRole("radio")).toBeChecked();
	await expect(page.getByTestId("language")).toHaveValue(lang);
	await expect(page.locator("html")).toHaveAttribute("lang", lang);
	await expect(page.getByTestId("resize-sidebar")).toHaveAttribute("aria-valuenow", String(sidebar));
}

async function twoPages(browser: Browser, sameOrigin: boolean): Promise<[Page, Page, () => Promise<void>]> {
	const a = await browser.newContext();
	const b = sameOrigin ? a : await browser.newContext();
	const pa = await a.newPage();
	const pb = await b.newPage();
	await open(pa);
	await open(pb);
	return [pa, pb, async () => void (await Promise.all([a.close(), sameOrigin ? undefined : b.close()]))];
}

test("a browser with its own storage (the macOS window beside a browser tab) shows what the other chose, live", async ({
	browser,
}) => {
	const [a, b, close] = await twoPages(browser, false);
	try {
		await chooseEverything(a, true, "terminal", "zh-CN", 100);
		await expectEverything(b, true, "terminal", "zh-CN", SIDEBAR_DEFAULT + 100);
		expect(await mode(b)).toEqual({ dark: false, palette: "terminal" });

		// And back, from the other side, for a change that forgets a key: the reset layout button.
		await b.getByTestId("language").selectOption("en");
		await b.locator("label", { hasText: "Dark" }).first().click();
		await b.getByTestId("palette-omp").click();
		await b.getByTestId("reset-layout").click();
		await expectEverything(a, false, "omp", "en", SIDEBAR_DEFAULT);
	} finally {
		await close();
	}
});

test("tabs of one origin show it too", async ({ browser }) => {
	const [a, b, close] = await twoPages(browser, true);
	try {
		await chooseEverything(a, true, "hermes", "zh-CN", -60);
		await expectEverything(b, true, "hermes", "zh-CN", SIDEBAR_DEFAULT - 60);
	} finally {
		await close();
	}
});

test("a drag writes the width once, where it ends, and the rest of the page shows every width on the way", async ({
	page,
}) => {
	await open(page);
	const posts: string[] = [];
	page.on("request", (r) => {
		if (r.method() === "POST" && new URL(r.url()).pathname === "/api/prefs") posts.push(r.postData() ?? "");
	});
	const handle = page.getByTestId("resize-sidebar");
	// Wherever the earlier tests left the width (the server is shared).
	const start = Number(await handle.getAttribute("aria-valuenow"));
	const storedBefore = await page.evaluate((k) => localStorage.getItem(k), PREF.sidebarWidth);
	let during = 0;
	let storedDuring: string | null = "unset";
	await drag(page, handle, 120, async () => {
		during = posts.length;
		storedDuring = await page.evaluate((k) => localStorage.getItem(k), PREF.sidebarWidth);
		// It followed the pointer all the way.
		await expect(handle).toHaveAttribute("aria-valuenow", String(start + 120));
	});
	// A drag of more than a second and a half sent nothing while it lasted, and nothing was kept before its end.
	expect(during).toBe(0);
	expect(storedDuring).toBe(storedBefore);
	await expect.poll(() => posts.length).toBe(1);
	await page.waitForTimeout(600);
	expect(posts).toHaveLength(1);
	expect(JSON.parse(posts[0] ?? "{}")).toEqual({ changes: { [PREF.sidebarWidth]: String(start + 120) } });
	expect(await page.evaluate((k) => localStorage.getItem(k), PREF.sidebarWidth)).toBe(String(start + 120));
});

async function openPanel(page: Page): Promise<void> {
	await page.goto(`${s.url}/?token=${s.accessToken}`);
	await sessionRow(page, FIXTURE.gammaTitle).click();
	await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.gammaTitle);
	await page.getByTestId("toggle-panel").click();
	await expect(page.getByTestId("right-panel")).toBeVisible();
}

test("the panes chosen in one window show in the open panel of another, live", async ({ browser }) => {
	const a = await browser.newContext();
	const b = await browser.newContext();
	try {
		const pa = await a.newPage();
		const pb = await b.newPage();
		await openPanel(pa);
		await openPanel(pb);
		const lower = pb.getByTestId("panel-pane-bottom");
		const upper = pb.getByTestId("panel-pane-top");
		await expect(lower).toHaveAttribute("data-tab", "files");

		await pa.getByTestId("panel-pane-bottom").getByTestId("pane-tab-btw").click();
		await pa.getByTestId("pane-fold-top").click();
		await expect(lower).toHaveAttribute("data-tab", "btw");
		await expect(upper).toHaveAttribute("data-collapsed", "true");

		// And back, from the other side: opened again and the divider where it was put.
		await pb.getByTestId("pane-fold-top").click();
		await expect(pa.getByTestId("panel-pane-top")).toHaveAttribute("data-collapsed", "false");
		await pb.getByTestId("resize-panes").focus();
		await pb.keyboard.press("End");
		const end = await pb.getByTestId("resize-panes").getAttribute("aria-valuenow");
		await expect(pa.getByTestId("resize-panes")).toHaveAttribute("aria-valuenow", String(end));

		// Put back as it was, so that the next test finds the default layout on the server.
		await pb.getByTestId("resize-panes").press("Enter");
		await pb.getByTestId("panel-pane-bottom").getByTestId("pane-tab-files").click();
		await expect
			.poll(async () => {
				const res = await fetch(`${s.url}/api/prefs`, { headers: { "x-omp-webui-token": s.accessToken } });
				return ((await res.json()) as { values: Record<string, string | null> }).values[PREF.panelPanes];
			})
			.toBeNull();
	} finally {
		await Promise.all([a.close(), b.close()]);
	}
});

test("a drag of the divider writes the layout once, where it ends, and the panes show every position on the way", async ({
	page,
}) => {
	await openPanel(page);
	const posts: string[] = [];
	page.on("request", (r) => {
		if (r.method() === "POST" && new URL(r.url()).pathname === "/api/prefs") posts.push(r.postData() ?? "");
	});
	const grip = page.getByTestId("resize-panes");
	const top = page.getByTestId("panel-pane-top");
	const start = (await boxOf(top)).height;
	const storedBefore = await page.evaluate((k) => localStorage.getItem(k), PREF.panelPanes);
	// The pointer goes down 100 px in steps, and is held there.
	const box = await boxOf(grip);
	const x = box.x + box.width / 2;
	const y = box.y + box.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	for (let i = 1; i <= 24; i++) {
		await page.mouse.move(x, y + (100 * i) / 24);
		await page.waitForTimeout(60);
	}
	const during = posts.length;
	const storedDuring = await page.evaluate((k) => localStorage.getItem(k), PREF.panelPanes);
	expect(Math.abs((await boxOf(top)).height - (start + 100))).toBeLessThan(2);
	await page.mouse.up();
	// A drag of more than a second and a half sent nothing while it lasted, and nothing was kept before its end.
	expect(during).toBe(0);
	expect(storedDuring).toBe(storedBefore);
	await expect.poll(() => posts.length).toBe(1);
	await page.waitForTimeout(600);
	expect(posts).toHaveLength(1);
	expect(Object.keys(JSON.parse(posts[0] ?? "{}").changes)).toEqual([PREF.panelPanes]);
	expect(JSON.parse(JSON.parse(posts[0] ?? "{}").changes[PREF.panelPanes]).split).toBeGreaterThan(0.5);
});
