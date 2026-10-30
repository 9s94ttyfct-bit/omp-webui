import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The GitHub star prompt: after five days with a sent message, only while the repository is public. The clock is
 * fixed and GitHub's answer is mocked on the server's `/api/repo`; the repository is private today, so the real
 * answer never shows the card.
 */

const REPO = "https://github.com/9s94ttyfct-bit/omp-webui";
/** Noon on 2026-10-18, local time. */
const NOW = new Date(2026, 9, 18, 12);
const FIVE_DAYS = ["2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-10-16"];

/** The page's usage history and clock, and what `/api/repo` answers (null: it fails). */
async function setup(page: Page, o: { days: string[]; isPublic: boolean | null }) {
	await page.clock.setFixedTime(NOW);
	await page.addInitScript((days) => {
		if (!localStorage.getItem("ompw.usageDays")) localStorage.setItem("ompw.usageDays", JSON.stringify(days));
	}, o.days);
	const asked = { n: 0 };
	await page.route("**/api/repo", (route) => {
		asked.n++;
		return o.isPublic === null
			? route.fulfill({ status: 502, body: "no" })
			: route.fulfill({ json: { public: o.isPublic } });
	});
	return asked;
}

const card = (page: Page) => page.getByTestId("star-prompt");
const stored = (page: Page, key: string) => page.evaluate((k) => localStorage.getItem(k), key);

test("after five days of use on a public repository the sidebar asks for a star, and the link ends the asking", async ({
	page,
}) => {
	await page
		.context()
		.route(`${REPO}**`, (route) => route.fulfill({ body: "<title>stub</title>", contentType: "text/html" }));
	await setup(page, { days: FIVE_DAYS, isPublic: true });
	await page.goto("/");
	await expect(card(page)).toBeVisible();
	await expect(card(page)).toContainText("Enjoying omp web UI?");
	await expect(page.getByTestId("star-link")).toHaveAttribute("href", REPO);

	const [popup] = await Promise.all([page.waitForEvent("popup"), page.getByTestId("star-link").click()]);
	await popup.waitForLoadState();
	expect(popup.url()).toBe(REPO);
	await expect(card(page)).toHaveCount(0);
	expect(JSON.parse((await stored(page, "ompw.star")) ?? "null")).toEqual({ never: true });
	await page.reload();
	await expect(page.getByTestId("nav-settings")).toBeVisible();
	await expect(card(page)).toHaveCount(0);
});

test("'Don't ask again' is permanent, 'Not now' waits a month", async ({ page }) => {
	await setup(page, { days: FIVE_DAYS, isPublic: true });
	await page.goto("/");
	await card(page).getByTestId("star-later").click();
	await expect(card(page)).toHaveCount(0);
	const { until } = JSON.parse((await stored(page, "ompw.star")) ?? "{}");
	expect(until - NOW.getTime()).toBe(30 * 24 * 60 * 60 * 1000);
	await page.reload();
	await expect(page.getByTestId("nav-settings")).toBeVisible();
	await expect(card(page)).toHaveCount(0);

	// A month on, it is back; this time the answer is final.
	await page.clock.setFixedTime(new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000));
	await page.reload();
	await expect(card(page)).toBeVisible();
	await card(page).getByTestId("star-never").click();
	await expect(card(page)).toHaveCount(0);
	await page.clock.setFixedTime(new Date(NOW.getTime() + 400 * 24 * 60 * 60 * 1000));
	await page.reload();
	await expect(page.getByTestId("nav-settings")).toBeVisible();
	await expect(card(page)).toHaveCount(0);
});

test("a private repository never shows it, however long it has been used; neither does a failed lookup", async ({
	page,
}) => {
	const days = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, "0")}`);
	for (const isPublic of [false, null]) {
		const asked = await setup(page, { days, isPublic });
		await page.goto("/");
		await expect(page.getByTestId("nav-settings")).toBeVisible();
		// The gate really was asked (not merely skipped), and the answer kept the card away.
		await expect.poll(() => asked.n).toBeGreaterThan(0);
		await page.waitForTimeout(500);
		await expect(card(page)).toHaveCount(0);
		await page.unrouteAll({ behavior: "wait" });
	}
});

test("with the real, private repository the card does not show", async ({ page }) => {
	await page.clock.setFixedTime(NOW);
	await page.addInitScript((days) => localStorage.setItem("ompw.usageDays", JSON.stringify(days)), FIVE_DAYS);
	await page.goto("/");
	await expect(page.getByTestId("nav-settings")).toBeVisible();
	await expect.poll(async () => (await (await page.request.get("/api/repo")).json()).public).toBe(false);
	await expect(card(page)).toHaveCount(0);
});

test("a sent message counts today once; the fifth day brings the card, a rejected send counts nothing", async ({
	page,
}) => {
	const asked = await setup(page, { days: FIVE_DAYS.slice(0, 4), isPublic: true });
	const tap = await tapSocket(page);
	let reject = true;
	tap.answer("prompt", () =>
		reject ? { ok: false, error: "forced prompt failure" } : { ok: true, data: { agentInvoked: true } },
	);
	await page.addInitScript((cwd) => localStorage.setItem("ompw.cwd", cwd), process.env.OMPW_E2E_WORK as string);
	await page.goto("/");
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });

	// Four days: nothing yet, and the repository was not even asked about.
	await expect(card(page)).toHaveCount(0);
	expect(asked.n).toBe(0);
	await page.getByTestId("composer").fill("first try");
	await page.getByTestId("send").click();
	await expect(page.getByText("forced prompt failure")).toBeVisible();
	expect(JSON.parse((await stored(page, "ompw.usageDays")) ?? "[]")).toHaveLength(4);
	await expect(card(page)).toHaveCount(0);

	reject = false;
	await page.getByTestId("send").click();
	await expect.poll(async () => JSON.parse((await stored(page, "ompw.usageDays")) ?? "[]")).toContain("2026-10-18");
	await expect(card(page)).toBeVisible();
	expect(JSON.parse((await stored(page, "ompw.usageDays")) ?? "[]")).toHaveLength(5);
});

test("a lookup that failed is made again a day later and then shows the card", async ({ page }) => {
	await page.clock.install({ time: NOW });
	await page.addInitScript((days) => localStorage.setItem("ompw.usageDays", JSON.stringify(days)), FIVE_DAYS);
	let reachable = false;
	let asked = 0;
	await page.route("**/api/repo", (route) => {
		asked++;
		return reachable ? route.fulfill({ json: { public: true } }) : route.fulfill({ status: 502, body: "no" });
	});
	await page.goto("/");
	await expect(page.getByTestId("nav-settings")).toBeVisible();
	await expect.poll(() => asked).toBe(1);
	await expect(card(page)).toHaveCount(0);

	// An hour on, nothing; GitHub is back, and a day after the failed try the page asks again by itself.
	reachable = true;
	await page.clock.fastForward("01:00:00");
	await page.waitForTimeout(300);
	expect(asked).toBe(1);
	await page.clock.fastForward("23:01:00");
	await expect(card(page)).toBeVisible();
	expect(asked).toBe(2);
});

test("Settings turns the prompt off, and with it the lookup of the repository; turned on, it comes back", async ({
	page,
}) => {
	const asked = await setup(page, { days: FIVE_DAYS, isPublic: true });
	await page.goto("/");
	await expect(card(page)).toBeVisible();
	await page.goto("/#/settings/app");
	const setting = page.getByTestId("star-prompt-setting");
	await expect(setting).toBeChecked();
	await setting.uncheck();
	await expect(card(page)).toHaveCount(0);
	expect(JSON.parse((await stored(page, "ompw.star")) ?? "null")).toEqual({ never: true });

	// Off stays off after a reload, and the server is not asked about the repository again.
	const before = asked.n;
	await page.reload();
	await expect(page.getByTestId("star-prompt-setting")).not.toBeChecked();
	await page.waitForTimeout(500);
	await expect(card(page)).toHaveCount(0);
	expect(asked.n).toBe(before);

	await page.getByTestId("star-prompt-setting").check();
	await expect(card(page)).toBeVisible();
	expect(asked.n).toBe(before + 1);
});

test("a prompt turned off before the first visit never looks the repository up", async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("ompw.star", JSON.stringify({ never: true })));
	const asked = await setup(page, { days: FIVE_DAYS, isPublic: true });
	await page.goto("/");
	await expect(page.getByTestId("nav-settings")).toBeVisible();
	await page.waitForTimeout(500);
	expect(asked.n).toBe(0);
	await expect(card(page)).toHaveCount(0);
});
