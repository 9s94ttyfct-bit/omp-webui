import type { GuardConfig } from "../../shared/guard.ts";
import { en as guardEn } from "../../web/src/i18n/guard.ts";
import { en as guidanceEn } from "../../web/src/i18n/guidance.ts";
import { newChatIn } from "../support/new-chat.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * A page signed in through Cloudflare Access is the person's own (`Meta.owner`): it changes the guard's settings (Settings ›
 * Safety), a conversation's own guard and the guidance exactly as the page on this computer does, and is told the Guard page
 * is on that computer. A page on the network that holds only the token is shown these and told why it cannot change them,
 * never left with a control that does nothing. The page is made one or the other by what `/api/meta` tells it; the server's
 * own decision, by the request's authentication, is `tests/contract/remote-auth.test.ts` and `lan-local.test.ts`.
 */

const POST = { "x-omp-webui": "1" };
const WORK = () => process.env.OMPW_E2E_WORK as string;

/** Make the page one that came through the tunnel: signed in through Access (`owner`), or holding only the token. */
const asRemotePage = (page: Page, owner: boolean) =>
	page.route("**/api/meta", async (route) => {
		const real = await (await route.fetch()).json();
		return route.fulfill({ json: { ...real, remote: true, local: false, owner } });
	});

const served = async (page: Page): Promise<GuardConfig> =>
	((await (await page.request.get("/api/guard")).json()) as { config: GuardConfig }).config;
const setGuard = (page: Page, config: Partial<GuardConfig>) =>
	page.request.post("/api/guard", { data: config, headers: POST });

/** The requests the page sends to `prefix`, from now on. */
function asked(page: Page, prefix: string, method?: string): string[] {
	const seen: string[] = [];
	page.on("request", (r) => {
		if ((method === undefined || r.method() === method) && new URL(r.url()).pathname.startsWith(prefix))
			seen.push(`${r.method()} ${new URL(r.url()).pathname}`);
	});
	return seen;
}

const newChat = async (page: Page): Promise<void> => {
	await page.goto(newChatIn(WORK()));
	await expect(page.getByTestId("model-picker")).toBeVisible({ timeout: 60_000 });
};

test.beforeEach(async ({ page }) => {
	await setGuard(page, { mode: "reviewer", reviewer: "", askWhenUnavailable: true, askWhenDenied: true });
});
test.afterEach(async ({ page }) => {
	await setGuard(page, { mode: "off", reviewer: "", askWhenUnavailable: true, askWhenDenied: true });
	expect((await page.request.post("/api/model-guidance/restore", { headers: POST })).status()).toBe(200);
});

test("an Access page changes the guard in Settings › Safety, and is told the Guard page is on the computer", async ({
	page,
}) => {
	const guardPage = asked(page, "/api/guard/");
	await asRemotePage(page, true);
	await page.goto("/#/settings/safety");
	const card = page.getByTestId("guard-settings");
	await expect(card.getByTestId("guard-mode-reviewer")).toBeChecked({ timeout: 30_000 });
	await card.getByTestId("guard-mode-ask").check();
	await expect(page.getByTestId("guard-status")).toHaveAttribute("data-state", "saved");
	await expect.poll(async () => (await served(page)).mode).toBe("ask");
	// The Guard page's summary and link are this computer's: said instead, and nothing of it is asked for.
	await expect(page.getByTestId("guard-page-local")).toHaveText(guardEn.settingsPageLocal);
	await expect(page.getByTestId("guard-open-page")).toHaveCount(0);
	expect(guardPage).toEqual([]);

	// The Guard page itself says where it is, and leads back to the card it may change.
	await page.evaluate(() => {
		location.hash = "#/guard";
	});
	await expect(page.getByTestId("guard-page-remote")).toContainText(guardEn.pageAccessTitle);
	await page.getByTestId("guard-page-settings").click();
	await expect(page.getByTestId("guard-settings")).toBeVisible();
	expect(guardPage).toEqual([]);
});

test("an Access page picks New chat's guard and guidance, and the warm-up process is given them", async ({ page }) => {
	await asRemotePage(page, true);
	await newChat(page);
	const guard = page.getByTestId("guard-picker");
	await guard.click();
	const panel = page.getByTestId("guard-picker-panel");
	await panel.getByTestId("session-guard-mode-ask").check();
	await expect(guard).toHaveAttribute("data-mode", "ask");
	await expect(guard).toHaveAttribute("data-own", "true");
	await page.keyboard.press("Escape");

	const chip = page.getByTestId("guidance-picker");
	await expect(chip).toHaveText(guidanceEn.chipOff);
	await chip.click();
	await page.getByTestId("guidance-option").filter({ hasText: "One of each kind at a time" }).click();
	await expect(chip).toHaveText(guidanceEn.chip.replace("{name}", "One of each kind at a time"));
});

test("a page holding only the token is shown New chat's guard and guidance, says why it cannot change them, and sends nothing", async ({
	page,
}) => {
	const changes = asked(page, "/api/model-guidance/live");
	const guardChanges = asked(page, "/api/guard", "POST");
	await asRemotePage(page, false);
	await newChat(page);
	const chip = page.getByTestId("guidance-picker");
	await expect(chip).toHaveAttribute("data-block", "remote");
	await expect(chip).toHaveAttribute("aria-disabled", "true");
	await expect(chip).toHaveAttribute("title", guidanceEn.readOnlyRemote);
	// A tap on a phone has no tooltip: it is told why, and no list opens. (Still focusable: the keyboard reaches it, and
	// Playwright's click waits for an element that says it is disabled, which a browser's tap does not.)
	await chip.focus();
	await page.keyboard.press("Enter");
	await expect(page.getByTestId("toast-text").filter({ hasText: guidanceEn.readOnlyRemote })).toBeVisible();
	await expect(page.getByTestId("guidance-list")).toHaveCount(0);

	await page.getByTestId("guard-picker").click();
	await expect(page.getByTestId("guard-picker-panel").getByTestId("session-guard-readonly")).toHaveText(
		guardEn.sessionReadOnly,
	);
	await expect(page.getByTestId("guard-picker-panel").getByRole("radio")).toHaveCount(0);
	expect(changes).toEqual([]);
	expect(guardChanges).toEqual([]);
});

test("a pick the server refuses is said in a toast, and the chip keeps what the conversation carries", async ({
	page,
}) => {
	await newChat(page);
	await page.route("**/api/model-guidance/live", (route) =>
		route.fulfill({ status: 403, json: { error: "Guidance is changed elsewhere" } }),
	);
	const chip = page.getByTestId("guidance-picker");
	await expect(chip).toHaveText(guidanceEn.chipOff);
	await chip.click();
	await page.getByTestId("guidance-option").filter({ hasText: "One of each kind at a time" }).click();
	await expect(
		page
			.getByTestId("toast-text")
			.filter({ hasText: guidanceEn.pickFailed.replace("{error}", "Guidance is changed elsewhere") }),
	).toBeVisible();
	await expect(chip).toHaveText(guidanceEn.chipOff);
});

test.describe("on a touch screen", () => {
	test.use({ hasTouch: true });

	test("a row shows its text under a mouse only, so a tap on it picks at once", async ({ page }) => {
		await newChat(page);
		const chip = page.getByTestId("guidance-picker");
		await chip.tap();
		const list = page.getByTestId("guidance-list");
		const option = list.getByTestId("guidance-option").filter({ hasText: "One of each kind at a time" });
		await expect(option).toBeVisible();
		// What a tap sends first: a touch pointer coming over the row. It changes nothing drawn (iOS Safari would take a tap
		// whose hover changes the page for a hover alone, and send no click).
		await option.dispatchEvent("pointerover", { pointerType: "touch", bubbles: true });
		await expect(list.getByTestId("guidance-preview")).toHaveCount(0);
		// A mouse over it shows its text.
		await option.dispatchEvent("pointerover", { pointerType: "mouse", bubbles: true });
		await expect(list.getByTestId("guidance-preview")).toBeVisible();
		await option.dispatchEvent("pointerout", { pointerType: "mouse", bubbles: true });

		await option.tap();
		await expect(chip).toHaveText(guidanceEn.chip.replace("{name}", "One of each kind at a time"));
	});
});
