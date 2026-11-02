import { FIXTURE_CWD } from "../support/fixtures.ts";
import { newChatIn } from "../support/new-chat.ts";
import { boxOf } from "../support/style.ts";
import { devices, expect, type Page, test } from "./fixtures.ts";

/**
 * New chat's layout (no model call): the settings of the conversation about to start are a bar under the composer, every
 * one of them always shown, at every width (a phone shows them as icons, wrapping); the composer itself holds the field,
 * Attach and Send.
 */

/** The settings in the bar's order: the model's, a divider, then the conversation's rules. */
const SETTINGS = [
	"preset-picker",
	"model-picker",
	"thinking-picker",
	"mode-picker",
	"guard-picker",
	"guidance-picker",
	"approval-picker",
	"unattended-toggle",
	"goal-mode",
];

const newChat = () => newChatIn(process.env.OMPW_E2E_WORK as string);

async function openNewChat(page: Page) {
	await page.goto(newChat());
	await expect(page.getByTestId("thinking-picker")).toBeVisible({ timeout: 60_000 });
	await expect(page.getByTestId("guidance-picker")).toBeVisible();
}

test.describe("at 1400 px", () => {
	test.use({ viewport: { width: 1400, height: 900 } });

	test("the settings are a bar under the composer, in order, none of them inside it", async ({ page }) => {
		await openNewChat(page);
		const footer = page.getByTestId("composer-footer");
		const bar = page.getByTestId("new-chat-settings");
		for (const id of SETTINGS) {
			await expect(footer.getByTestId(id), id).toHaveCount(0);
			await expect(bar.getByTestId(id), id).toBeVisible();
		}
		// In the bar's order: each one comes after the one before it in the document.
		const order = await bar.evaluate(
			(el, ids) =>
				ids.map((id) => {
					const all = [...el.querySelectorAll("[data-testid]")];
					return all.findIndex((n) => n.getAttribute("data-testid") === id);
				}),
			SETTINGS,
		);
		expect(order).toEqual([...order].sort((a, b) => a - b));
		const field = await boxOf(page.getByTestId("composer"));
		const send = await boxOf(page.getByTestId("send"));
		const top = (await boxOf(bar)).y;
		expect(top).toBeGreaterThanOrEqual(Math.max(field.y + field.height, send.y + send.height));
		await expect(page.getByTestId("composer-more")).toHaveCount(0);
	});
});

/** The model's settings and the conversation's rules: the bar breaks between the two, never inside one where it has room. */
const MODEL_GROUP = SETTINGS.slice(0, 4);
const RULES_GROUP = SETTINGS.slice(4);

for (const [width, lang] of [
	[1000, "en"],
	[1400, "en"],
	[1400, "zh-CN"],
] as const) {
	test.describe(`at ${width} px (${lang})`, () => {
		test.use({ viewport: { width, height: 900 } });

		test("the bar wraps between the model's settings and the rules, each group on a line of its own", async ({
			page,
		}) => {
			await page.addInitScript((l) => localStorage.setItem("ompw.lang", l), lang);
			await openNewChat(page);
			const bar = page.getByTestId("new-chat-settings");
			const centres = async (ids: readonly string[]) =>
				Promise.all(ids.map(async (id) => Math.round(((b) => b.y + b.height / 2)(await boxOf(bar.getByTestId(id))))));
			const model = new Set(await centres(MODEL_GROUP));
			const rules = new Set(await centres(RULES_GROUP));
			expect(model.size, "the model's settings share one line").toBe(1);
			expect(rules.size, "the rules share one line").toBe(1);
		});
	});
}

test.describe("phone", () => {
	const { defaultBrowserType: _browser, ...phone } = devices["iPhone 13"];
	test.use(phone);

	test("phone: every setting is an icon in the bar, none behind ⋯ and none past the screen", async ({ page }) => {
		await openNewChat(page);
		const bar = page.getByTestId("new-chat-settings");
		await expect(bar).toHaveAttribute("data-composer-narrow", "");
		await expect(page.getByTestId("composer-more")).toHaveCount(0);
		// The goal on: its "skip the questions" switch is in the bar too.
		await bar.getByTestId("goal-mode").click();
		const width = page.viewportSize()?.width ?? 0;
		for (const id of [...SETTINGS, "goal-direct"]) {
			const control = bar.getByTestId(id);
			await expect(control, id).toBeVisible();
			const b = await boxOf(control);
			expect(b.x + b.width, id).toBeLessThanOrEqual(width);
			// An icon, not a word: no wider than an icon button (32 px) and its focus ring's room.
			expect(b.width, id).toBeLessThanOrEqual(40);
			// It still says what it is to whoever cannot see the icon.
			await expect(control, id).toHaveAccessibleName(/\S/);
		}
	});
});

test.describe("the folder above the composer", () => {
	test.use({ viewport: { width: 1400, height: 900 } });

	test("the folder row is one line: the folder button, the name field, Options", async ({ page }) => {
		await page.goto("/#/new");
		const folder = page.getByTestId("folder-menu");
		await expect(folder).toHaveAttribute("data-mode", "new", { timeout: 60_000 });
		await expect(folder).toContainText("New project");
		const centre = async (id: string | null) => {
			const b = await boxOf(id ? page.getByTestId(id) : page.getByRole("button", { name: /^Options/ }));
			return b.y + b.height / 2;
		};
		const line = await centre("folder-menu");
		expect(Math.abs((await centre("new-project-name")) - line)).toBeLessThanOrEqual(4);
		expect(Math.abs((await centre(null)) - line)).toBeLessThanOrEqual(4);
		for (const gone of ["use-existing-folder", "back-to-new-project", "cwd-picker"])
			await expect(page.getByTestId(gone), gone).toHaveCount(0);
	});

	test("menu: the recent folders, a new project and an existing folder are in the folder button's menu", async ({
		page,
	}) => {
		const work = process.env.OMPW_E2E_WORK as string;
		await page.goto(newChat());
		const folder = page.getByTestId("folder-menu");
		await expect(folder).toHaveAttribute("data-mode", "existing", { timeout: 60_000 });
		await expect(folder).toHaveText(work.split("/").pop() as string);
		await expect(folder).toHaveAttribute("title", work);

		await folder.click();
		const recent = page.getByTestId("folder-menu-recent");
		await expect(recent.first()).toBeVisible();
		expect(await recent.count()).toBeLessThanOrEqual(4);
		const titles = await recent.evaluateAll((els) => els.map((el) => el.getAttribute("title")));
		expect(titles).not.toContain(work);
		expect(titles).toContain(FIXTURE_CWD);
		// The projects folder is changed where the note under the name says it, not from this menu.
		await expect(page.getByRole("menu").getByTestId("new-project-root-change")).toHaveCount(0);
		await page.locator(`[data-testid="folder-menu-recent"][title="${FIXTURE_CWD}"]`).click();
		await expect(folder).toHaveText(FIXTURE_CWD.split("/").pop() as string);

		await folder.click();
		await page.getByTestId("folder-menu-new").click();
		await expect(folder).toHaveAttribute("data-mode", "new");
		await expect(page.getByTestId("new-project-name")).toBeVisible();

		await folder.click();
		await page.getByTestId("folder-menu-existing").click();
		await expect(page.getByRole("dialog").getByTestId("dir-up")).toBeVisible();
	});

	test("keyboard: Enter opens the menu, the arrows move through it, Escape gives the button the keyboard back", async ({
		page,
	}) => {
		await page.goto(newChat());
		const folder = page.getByTestId("folder-menu");
		await expect(folder).toHaveAttribute("data-mode", "existing", { timeout: 60_000 });
		await folder.focus();
		await page.keyboard.press("Enter");
		const menu = page.getByRole("menu");
		await expect(menu).toBeVisible();
		await expect(page.getByTestId("folder-menu-new")).toBeFocused();
		await page.keyboard.press("ArrowDown");
		await expect(page.getByTestId("folder-menu-existing")).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(menu).toBeHidden();
		await expect(folder).toBeFocused();
	});
});
