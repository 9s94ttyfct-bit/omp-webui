import { mkdirSync } from "node:fs";
import { FIXTURE } from "../support/fixtures.ts";
import { devices, expect, type Page, test, webkit } from "./fixtures.ts";

/**
 * The top edge of the page in an iPhone home-screen web app (#620). iOS 26 and later draw their own progressive blur over
 * the top of such a web app (the "scroll pocket"), which lands on the chat header and makes it look out of focus; it goes
 * away only while the page has a fixed element across its top edge (the sidebar drawer's scrim is one, which is why the
 * header was sharp with the sidebar open). WebKit looks for that element at one point, 4px under the top edge and in the
 * middle, takes its colour from its style, and wants it wider than 90% of the window, taller than 10px, and not
 * transparent. The page keeps one there, painting nothing, in a home-screen app only (`navigator.standalone`).
 *
 * The blur is drawn by the system, not by the page, so no browser here shows it: these tests hold the page to what
 * WebKit looks for, in Playwright's WebKit with the iPhone profile and `navigator.standalone` set the way iOS sets it.
 */

const SHOTS = process.env.PWA_SHOTS;
const { defaultBrowserType: _b, ...iphone } = devices["iPhone 15"];

/** The strip as WebKit judges it: what it is, where it stands, and what colour its style declares. */
const edge = (page: Page) =>
	page.evaluate(() => {
		const el = document.querySelector<HTMLElement>("[data-testid='ios-top-edge']");
		if (!el) return null;
		const s = getComputedStyle(el);
		const r = el.getBoundingClientRect();
		return {
			display: s.display,
			position: s.position,
			zIndex: s.zIndex,
			pointerEvents: s.pointerEvents,
			color: s.backgroundColor,
			x: r.x,
			y: r.y,
			width: r.width,
			height: r.height,
			window: innerWidth,
			page: getComputedStyle(document.body).backgroundColor,
		};
	});

async function openChat(
	use: { e2eServer: { url: string }; workerStorageState: string },
	options: { standalone: boolean; theme?: "light" | "dark" },
) {
	const browser = await webkit.launch({ channel: undefined });
	const context = await browser.newContext({
		...iphone,
		baseURL: use.e2eServer.url,
		storageState: use.workerStorageState,
	});
	const page = await context.newPage();
	await page.addInitScript(
		([standalone, theme]) => {
			if (standalone) Object.defineProperty(navigator, "standalone", { value: true, configurable: true });
			localStorage.setItem("ompw.theme", theme as string);
		},
		[options.standalone, options.theme ?? "dark"] as const,
	);
	await page.goto("/");
	await page.getByRole("button", { name: "Show sidebar" }).click();
	await page.getByTestId("session-item").filter({ hasText: FIXTURE.alphaTitle }).click();
	await expect(page.getByTestId("chat-title")).toBeVisible();
	await page.mouse.move(300, 600); // no tooltip over the header
	return { page, close: () => browser.close() };
}

const top = (page: Page) => page.screenshot({ clip: { x: 0, y: 0, width: 393, height: 20 } });
const shot = async (page: Page, name: string) => {
	if (!SHOTS) return;
	mkdirSync(SHOTS, { recursive: true });
	await page.screenshot({ path: `${SHOTS}/${name}.png`, clip: { x: 0, y: 0, width: 393, height: 160 } });
};

for (const theme of ["dark", "light"] as const) {
	test(`${theme}: a home-screen app has a fixed, solid strip across the top that paints nothing`, async ({
		e2eServer,
		workerStorageState,
	}) => {
		const { page, close } = await openChat({ e2eServer, workerStorageState }, { standalone: true, theme });
		try {
			const strip = await edge(page);
			expect(strip, "the strip is in the page").not.toBeNull();
			expect(strip).toMatchObject({ display: "block", position: "fixed", pointerEvents: "none", x: 0, y: 0 });
			// What WebKit asks of a top edge: wider than 90% of the window, taller than 10px, solid, and the page's colour.
			expect(strip?.width).toBeGreaterThanOrEqual((strip?.window ?? 0) * 0.9);
			expect(strip?.height).toBeGreaterThan(10);
			expect(strip?.color).toBe(strip?.page);
			expect(strip?.color).toMatch(/^rgb\(/); // alpha 1: rgba() appears for anything less
			// Above every other fixed layer (dialogs, the drawer, toasts), so the 4px point always finds it.
			expect(Number(strip?.zIndex)).toBe(2147483647);
			await shot(page, `standalone-${theme}`);

			// It declares a colour and paints nothing: a red layer under it (above the page, below the strip) stays red, and
			// the top of the window looks as it does with the strip taken away.
			await page.evaluate(() => {
				const red = document.createElement("div");
				red.style.cssText = "position:fixed;top:0;left:0;right:0;height:30px;z-index:1;background:rgb(255,0,0)";
				document.body.append(red);
			});
			const withStrip = await top(page);
			await page.evaluate(() => document.querySelector<HTMLElement>("[data-testid='ios-top-edge']")?.remove());
			const without = await top(page);
			expect(withStrip.equals(without), "the strip paints no pixel").toBe(true);
			// ... and that red is really there to be covered: the same window without it is another picture.
			await page.evaluate(() => document.querySelector<HTMLElement>("body > div[style*='255']")?.remove());
			expect(without.equals(await top(page)), "the red layer is on the screen").toBe(false);
		} finally {
			await close();
		}
	});
}

test("in a browser tab there is no strip", async ({ e2eServer, workerStorageState }) => {
	const { page, close } = await openChat({ e2eServer, workerStorageState }, { standalone: false });
	try {
		expect((await edge(page))?.display ?? "none").toBe("none");
		await shot(page, "browser-dark");
	} finally {
		await close();
	}
});

test("with the sidebar open the strip is still above the drawer and its scrim", async ({
	e2eServer,
	workerStorageState,
}) => {
	const { page, close } = await openChat({ e2eServer, workerStorageState }, { standalone: true });
	try {
		await page.getByRole("button", { name: "Show sidebar" }).click();
		await expect(page.getByTestId("sidebar-drawer")).toBeVisible();
		const strip = await edge(page);
		expect(strip?.display).toBe("block");
		const others = await page.evaluate(() =>
			[...document.querySelectorAll<HTMLElement>("body *")]
				.filter((el) => getComputedStyle(el).position === "fixed" && el.dataset.testid !== "ios-top-edge")
				.map((el) => Number(getComputedStyle(el).zIndex) || 0),
		);
		expect(others.length).toBeGreaterThan(0);
		expect(Math.max(...others)).toBeLessThan(Number(strip?.zIndex));
		await shot(page, "standalone-sidebar-open-dark");
	} finally {
		await close();
	}
});
