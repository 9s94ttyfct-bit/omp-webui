import AxeBuilder from "@axe-core/playwright";
import type { SavedMac } from "../../shared/macs.ts";
import { en } from "../../web/src/i18n/macs.ts";
import { zh } from "../../web/src/i18n/zh-CN/macs.ts";
import { boxOf } from "../support/geometry.ts";
import { appReady, openSidebar } from "../support/live.ts";
import { devices, expect, type Page, test } from "./fixtures.ts";

/**
 * The machine switcher (#628): the row under the New chat button, there only once the server has saved a Mac. The
 * pages here read the list as `meta.macs` says it (a stand-in for `/api/meta` adds it, so that no spec leaves a Mac in the
 * list every other spec of the worker would then show); the one that adds a Mac through the dialog uses the real list and puts
 * it back. No model call.
 */

const STUDIO: SavedMac = {
	id: "11111111-1111-4111-8111-111111111111",
	name: "Studio Mac",
	host: "studio.example.com",
	lastConnected: "2026-10-20T08:30:00Z",
};
const LAPTOP: SavedMac = {
	id: "22222222-2222-4222-8222-222222222222",
	name: "Laptop",
	host: "laptop.example.com",
	lastConnected: null,
};

const mutating = { "x-omp-webui": "1" };

/** Make the page's `meta` say the server has saved `macs`; with `keepReal`, the ones the server really has stay after them. */
async function withMacs(page: Page, macs: SavedMac[], keepReal = false) {
	await page.route("**/api/meta", async (route) => {
		const real = await (await route.fetch()).json();
		return route.fulfill({ json: { ...real, local: true, macs: [...macs, ...(keepReal ? (real.macs ?? []) : [])] } });
	});
}

/** What the page tells a Mac's window to be, when the app (its shell) is there to be told. */
async function withShell(page: Page, answer: { ok: boolean }) {
	await page.addInitScript((reply) => {
		const posted: unknown[] = [];
		Object.assign(window, { __macsPosted: posted });
		Object.assign(window, {
			webkit: {
				messageHandlers: {
					ompwMacs: {
						postMessage: (message: unknown) => {
							posted.push(message);
							return Promise.resolve(reply);
						},
					},
				},
			},
		});
	}, answer);
}

const posted = (page: Page) => page.evaluate(() => (window as unknown as { __macsPosted: unknown[] }).__macsPosted);

const row = (page: Page) => page.getByTestId("machine-row");
const trigger = (page: Page) => page.getByTestId("machine-switcher");
const menu = (page: Page) => page.getByTestId("machine-menu");
const items = (page: Page) => page.getByTestId("machine-item");

async function openMenu(page: Page) {
	await trigger(page).click();
	await expect(menu(page)).toBeVisible();
}

async function goHome(page: Page, lang = "en", theme = "light") {
	await page.addInitScript(
		([l, m]) => {
			localStorage.setItem("ompw.lang", l);
			localStorage.setItem("ompw.theme", m);
		},
		[lang, theme],
	);
	await page.goto("/");
	await appReady(page);
}

test("a computer with no saved Mac has no machine row", async ({ page }) => {
	await withMacs(page, []);
	await goHome(page);
	await expect(page.getByTestId("new-chat")).toBeVisible();
	await expect(row(page)).toHaveCount(0);
	await expect(trigger(page)).toHaveCount(0);
});

test("with Macs saved the row is under the New chat button, one line high, and its menu lists this Mac and each saved one", async ({
	page,
}) => {
	await withMacs(page, [STUDIO, LAPTOP]);
	await goHome(page);
	await expect(trigger(page)).toBeVisible();
	await expect(trigger(page)).toHaveText(en.thisMac);
	const above = await boxOf(page.getByTestId("new-chat"));
	const below = await boxOf(row(page));
	expect(above.y + above.height).toBeLessThanOrEqual(below.y);
	expect((await boxOf(trigger(page))).height).toBe(32);

	await openMenu(page);
	await expect(page.getByTestId("machine-this")).toContainText(en.thisMac);
	await expect(page.getByTestId("machine-this")).toContainText(en.hereConnected);
	await expect(items(page)).toHaveCount(2);
	await expect(items(page).nth(0)).toContainText("Studio Mac");
	await expect(items(page).nth(0)).toContainText("Last opened");
	await expect(items(page).nth(1)).toContainText("Laptop");
	await expect(items(page).nth(1)).toContainText(en.neverConnected);
	await expect(page.getByTestId("machine-add")).toHaveText(en.add);
	// What a Mac is doing is not known yet: no state is claimed for any of them, and no dot says one.
	for (const name of [en.stateRunning, en.stateAttention, en.stateUnreachable]) {
		await expect(menu(page)).not.toContainText(name);
	}
	await expect(items(page).first()).toHaveAttribute("data-state", "unknown");
	await expect(items(page).nth(1)).toHaveAttribute("data-state", "unknown");
	// The server's list is what the row shows: nothing it holds for the app's own use (team, store) reaches the page.
	await expect(menu(page)).not.toContainText("storeId");
});

test("in a browser a saved Mac opens its own page in a new tab", async ({ page, context }) => {
	await context.route("https://studio.example.com/**", (route) =>
		route.fulfill({ contentType: "text/html", body: "<title>Studio</title>studio" }),
	);
	await withMacs(page, [STUDIO]);
	await goHome(page);
	await openMenu(page);
	const [tab] = await Promise.all([context.waitForEvent("page"), items(page).first().click()]);
	await tab.waitForLoadState();
	expect(tab.url()).toBe("https://studio.example.com/");
	// This page stays where it was.
	expect(new URL(page.url()).origin).toBe(new URL(process.env.OMPW_E2E_URL as string).origin);
	await expect(menu(page)).toBeHidden();
});

test("in the macOS app a saved Mac is opened by the app, in its own window, and no tab opens", async ({
	page,
	context,
}) => {
	await withShell(page, { ok: true });
	await withMacs(page, [STUDIO, LAPTOP]);
	const tabs: string[] = [];
	context.on("page", (p) => tabs.push(p.url()));
	await goHome(page);
	await openMenu(page);
	await items(page).nth(1).click();
	await expect.poll(() => posted(page)).toEqual([{ type: "open", id: LAPTOP.id }]);
	expect(tabs).toEqual([]);
	// Add Mac… is the app's own sheet there: the page asks for it and shows no dialog of its own.
	await openMenu(page);
	await page.getByTestId("machine-add").click();
	await expect.poll(() => posted(page)).toEqual([{ type: "open", id: LAPTOP.id }, { type: "add" }]);
	await expect(page.getByTestId("mac-add-form")).toHaveCount(0);
});

test("when the app does not open the Mac, the page says so", async ({ page }) => {
	await withShell(page, { ok: false });
	await withMacs(page, [STUDIO]);
	await goHome(page);
	await openMenu(page);
	await items(page).first().click();
	await expect(page.getByTestId("toast").filter({ hasText: en.openRefused })).toBeVisible();
});

/** The handlers of the shell's bridges a page has: a remote window of the macOS app has `ompwWindow` and not `ompwMacs`. */
async function withBridges(page: Page, names: string[]) {
	await page.addInitScript((bridges) => {
		const handlers: Record<string, unknown> = {};
		for (const name of bridges) handlers[name] = { postMessage: () => Promise.resolve({ ok: true }) };
		Object.assign(window, { webkit: { messageHandlers: handlers } });
	}, names);
}

test("in a remote window of the macOS app the page has no machine row: it has no way to open a Mac there", async ({
	page,
}) => {
	await withBridges(page, ["ompwTheme", "ompwWindow"]);
	await withMacs(page, [STUDIO, LAPTOP]);
	await goHome(page);
	await expect(page.getByTestId("new-chat")).toBeVisible();
	await expect(row(page)).toHaveCount(0);
	await expect(trigger(page)).toHaveCount(0);
});

test("the app's own window (both bridges) and a browser (neither) have the row", async ({ page }) => {
	await withBridges(page, ["ompwWindow", "ompwMacs"]);
	await withMacs(page, [STUDIO]);
	await goHome(page);
	await expect(trigger(page)).toBeVisible();
	const browser = await page.context().newPage();
	await withMacs(browser, [STUDIO]);
	await browser.goto("/");
	await appReady(browser);
	await expect(browser.getByTestId("machine-switcher")).toBeVisible();
});

test("Add Mac… in a browser asks for a name and an address, says what is wrong with them, and saves the Mac in the server's list", async ({
	page,
}) => {
	await withMacs(page, [STUDIO], true);
	await goHome(page);
	await openMenu(page);
	await page.getByTestId("machine-add").click();
	const form = page.getByTestId("mac-add-form");
	await expect(form).toBeVisible();
	const error = page.getByTestId("mac-add-error");

	await form.getByTestId("mac-add-submit").click();
	await expect(error).toHaveText(en.problemNameEmpty);
	await form.getByTestId("mac-add-name").fill("Office Mac");
	await form.getByTestId("mac-add-address").fill("office.local");
	await form.getByTestId("mac-add-submit").click();
	await expect(error).toHaveText(en.addressLocalName);
	await form.getByTestId("mac-add-address").fill("studio.example.com");
	await form.getByTestId("mac-add-submit").click();
	await expect(error).toHaveText(en.problemHostTaken.replace("{name}", "Studio Mac"));

	const added = { name: "Office Mac", host: "office.example.com" };
	try {
		await form.getByTestId("mac-add-address").fill("https://Office.Example.com");
		await form.getByTestId("mac-add-submit").click();
		await expect(page.getByTestId("toast").filter({ hasText: en.added.replace("{name}", added.name) })).toBeVisible();
		await expect(form).toHaveCount(0);
		// The server holds it, and the row (reading meta again) lists it after the Mac the stand-in added.
		const meta = await (await page.request.get("/api/meta")).json();
		expect(meta.macs.map((m: SavedMac) => [m.name, m.host])).toEqual([[added.name, added.host]]);
		await openMenu(page);
		await expect(items(page)).toHaveCount(2);
		await expect(items(page).nth(1)).toContainText(added.name);
	} finally {
		const meta = await (await page.request.get("/api/meta")).json();
		for (const mac of meta.macs as SavedMac[]) {
			await page.request.delete(`/api/macs/${mac.id}`, { headers: mutating });
		}
	}
	const after = await (await page.request.get("/api/meta")).json();
	expect(after.macs).toEqual([]);
});

test("the row and its menu are in Chinese, and axe finds nothing wrong with them in either theme", async ({ page }) => {
	await withMacs(page, [STUDIO, LAPTOP]);
	await goHome(page, "zh-CN", "dark");
	await expect(trigger(page)).toHaveText(zh.thisMac);
	await openMenu(page);
	await expect(page.getByTestId("machine-this")).toContainText(zh.hereConnected);
	await expect(items(page).nth(1)).toContainText(zh.neverConnected);
	await expect(page.getByTestId("machine-add")).toHaveText(zh.add);
	const violations = async () =>
		(
			await new AxeBuilder({ page })
				.include('[data-testid="machine-row"]')
				.include('[data-testid="machine-menu"]')
				.withRules(["color-contrast", "aria-allowed-attr", "aria-required-children", "button-name"])
				.analyze()
		).violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`);
	expect(await violations()).toEqual([]);
	await page.keyboard.press("Escape");
	await page.evaluate(() => localStorage.setItem("ompw.theme", "light"));
	await page.reload();
	await appReady(page);
	await openMenu(page);
	expect(await violations()).toEqual([]);
});

const { defaultBrowserType: _browser, ...pixel } = devices["Pixel 5"];

test.describe("on a phone", () => {
	test.use({ ...pixel, viewport: { width: 390, height: 844 } });

	test("the row fits the drawer, the menu is within the screen and its choices are as tall as a finger", async ({
		page,
	}) => {
		await withMacs(page, [STUDIO, LAPTOP]);
		await page.addInitScript(() => localStorage.setItem("ompw.lang", "en"));
		await page.goto("/");
		await openSidebar(page);
		await expect(trigger(page)).toBeVisible();
		const bar = await boxOf(trigger(page));
		expect(bar.x).toBeGreaterThanOrEqual(0);
		expect(bar.x + bar.width).toBeLessThanOrEqual(390);
		await openMenu(page);
		const box = await boxOf(menu(page));
		expect(box.x).toBeGreaterThanOrEqual(0);
		expect(box.x + box.width).toBeLessThanOrEqual(390);
		for (const choice of [
			page.getByTestId("machine-this"),
			items(page).first(),
			items(page).nth(1),
			page.getByTestId("machine-add"),
		]) {
			expect((await boxOf(choice)).height).toBeGreaterThanOrEqual(44);
		}
		// Nothing makes the page wider than the screen.
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
	});
});
