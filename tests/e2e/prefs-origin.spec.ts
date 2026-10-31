import { DEFAULT_ROWS } from "../../shared/panes.ts";
import { PREF, type PrefsSnapshot } from "../../shared/prefs.ts";
import { FIXTURE } from "../support/fixtures.ts";
import { boxOf } from "../support/geometry.ts";
import { sessionRow } from "../support/live.ts";
import { choose } from "../support/select.ts";
import { startTestServer, type TestServer } from "../support/server.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * localStorage belongs to one origin (`127.0.0.1:<port>`), and the macOS app takes another port when its own is
 * taken: the preferences must not stay behind. They are kept by the server and applied by index.html before the app
 * loads (no model call).
 */

const SIDEBAR_DEFAULT = 288;
const PANEL_DEFAULT = 400;
const PANES = JSON.stringify({ version: 2, rows: DEFAULT_ROWS, top: "agents", bottom: "btw", collapsed: "top" });

let s: TestServer;
test.beforeAll(async () => {
	s = await startTestServer(0);
});
test.afterAll(async () => {
	await s?.stop();
});

const stored = (s2: TestServer): Promise<PrefsSnapshot> =>
	fetch(`${s2.url}/api/prefs`, { headers: { "x-omp-webui-token": s2.accessToken } }).then((r) => r.json());

/** Press on the handle, move the pointer by `dx`, release. */
async function drag(page: Page, el: Locator, dx: number) {
	const box = await boxOf(el);
	const x = box.x + box.width / 2;
	const y = box.y + box.height / 2;
	await page.mouse.move(x, y);
	await page.mouse.down();
	await page.mouse.move(x + dx, y, { steps: 8 });
	await page.mouse.up();
}

/** What index.html and nothing after it has done to the page. */
const painted = (page: Page) =>
	page.evaluate((keys) => {
		const root = document.documentElement;
		return {
			dark: root.classList.contains("dark"),
			palette: root.dataset.palette,
			stored: Object.fromEntries(keys.map((k) => [k, localStorage.getItem(k)])),
		};
	}, Object.values(PREF));

test("theme, palette, language, panel widths and the panes survive the server coming up on another port, painted before the app loads", async ({
	page,
}) => {
	const firstUrl = s.url;
	await page.goto(`${firstUrl}/?token=${s.accessToken}`);
	await expect(page.getByTestId("resize-sidebar")).toBeVisible();

	// Chosen on the first port, in the app's own controls.
	await page.goto(`${firstUrl}/#/settings`);
	await page.locator("label", { has: page.locator('input[name="theme"]'), hasText: "Light" }).click();
	await page.getByTestId("palette-terminal").click();
	await drag(page, page.getByTestId("resize-sidebar"), 100);
	await sessionRow(page, FIXTURE.gammaTitle).click();
	await expect(page.getByTestId("chat-title")).toHaveText(FIXTURE.gammaTitle);
	await page.getByTestId("toggle-panel").click();
	await expect(page.getByTestId("right-panel")).toBeVisible();
	await drag(page, page.getByTestId("resize-panel"), -120);
	// The panes too: Ask in the lower one, the upper one folded to its row.
	await page.getByTestId("panel-pane-bottom").getByTestId("pane-tab-btw").click();
	await page.getByTestId("pane-fold-top").click();
	await page.goto(`${firstUrl}/#/settings`);
	await choose(page.getByTestId("language"), "zh-CN");
	await expect(page.locator("html")).toHaveAttribute("lang", "zh-CN");

	// They are on the server, not only in this origin.
	await expect
		.poll(async () => (await stored(s)).values, { message: "the server keeps what was chosen" })
		.toMatchObject({
			[PREF.theme]: "light",
			[PREF.palette]: "terminal",
			[PREF.lang]: "zh-CN",
			[PREF.sidebarWidth]: String(SIDEBAR_DEFAULT + 100),
			[PREF.panelWidth]: String(PANEL_DEFAULT + 120),
			[PREF.panelPanes]: PANES,
		});

	// The server comes back on another port: another origin, which has none of it in its own storage.
	await s.restart(0);
	expect(s.url).not.toBe(firstUrl);

	// Painted from the document alone: with every script of the app held back, index.html has already applied them.
	await page.route("**/assets/**", (route) => route.abort());
	await page.goto(`${s.url}/?token=${s.accessToken}`);
	expect(await painted(page)).toMatchObject({
		dark: false,
		palette: "terminal",
		stored: {
			[PREF.theme]: "light",
			[PREF.palette]: "terminal",
			[PREF.lang]: "zh-CN",
			[PREF.sidebarWidth]: String(SIDEBAR_DEFAULT + 100),
			[PREF.panelWidth]: String(PANEL_DEFAULT + 120),
			[PREF.panelPanes]: PANES,
		},
	});
	await page.unroute("**/assets/**");

	// And the app comes up as it was left.
	await page.goto(`${s.url}/#/settings`);
	await page.reload();
	await expect(page.getByTestId("language")).toHaveAttribute("data-value", "zh-CN");
	await expect(page.locator('input[name="theme"][value="light"]')).toBeChecked();
	await expect(page.getByTestId("palette-terminal").getByRole("radio")).toBeChecked();
	await expect(page.locator("html")).toHaveAttribute("data-palette", "terminal");
	await expect(page.locator("html")).not.toHaveClass(/\bdark\b/);
	await expect(page.getByTestId("resize-sidebar")).toHaveAttribute("aria-valuenow", String(SIDEBAR_DEFAULT + 100));
	await sessionRow(page, FIXTURE.gammaTitle).click();
	await page.getByTestId("toggle-panel").click();
	await expect(page.getByTestId("right-panel")).toBeVisible();
	await expect(page.getByTestId("panel-pane-bottom")).toHaveAttribute("data-tab", "btw");
	await expect(page.getByTestId("panel-pane-top")).toHaveAttribute("data-collapsed", "true");
	expect(Math.round((await boxOf(page.getByTestId("right-panel"))).width)).toBe(PANEL_DEFAULT + 120);
});

test.describe("a browser that chose its preferences before the server kept them", () => {
	test("hands them over once, and they are there on the next port", async ({ page }) => {
		const legacy = await startTestServer(0);
		try {
			// A first visit after an upgrade: localStorage already holds the person's choices, and no marker of a server.
			// Only this port's origin has them; the next port's must get them from the server.
			await page.addInitScript((port) => {
				if (location.port !== port) return;
				localStorage.setItem("ompw.theme", "light");
				localStorage.setItem("ompw.palette", "hermes");
				localStorage.setItem("ompw.sidebarWidth", "350");
			}, new URL(legacy.url).port);
			await page.goto(`${legacy.url}/?token=${legacy.accessToken}`);
			await expect(page.getByTestId("resize-sidebar")).toBeVisible();
			await expect
				.poll(async () => (await stored(legacy)).values)
				.toMatchObject({ [PREF.theme]: "light", [PREF.palette]: "hermes", [PREF.sidebarWidth]: "350" });

			await legacy.restart(0);
			await page.route("**/assets/**", (route) => route.abort());
			await page.goto(`${legacy.url}/?token=${legacy.accessToken}`);
			expect(await painted(page)).toMatchObject({
				dark: false,
				palette: "hermes",
				stored: { [PREF.theme]: "light", [PREF.palette]: "hermes", [PREF.sidebarWidth]: "350" },
			});
		} finally {
			await page.unroute("**/assets/**");
			await legacy.stop();
		}
	});
});
