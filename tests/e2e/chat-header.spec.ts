import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { boxOf } from "../support/geometry.ts";
import { openSidebar, ownSession, sessionRow } from "../support/live.ts";
import { patchReplies } from "../support/state-patch.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The chat header has the room of its column. With little room (a phone, or a window whose sidebar and side panel
 * take most of it) the title keeps at least 120 px, the quota pill stays on one line, and the rest sits in a menu.
 * Long titles and folder paths end in an ellipsis and show in full as a tooltip (no model call).
 */

const quota = [
	{
		provider: "anthropic",
		limits: [
			{
				id: "anthropic:7d",
				label: "Claude 7 Day",
				window: { resetsAt: Date.now() + 3 * 86_400_000 },
				amount: { remainingFraction: 0.07, unit: "percent" },
				status: "ok",
			},
		],
	},
];

/** Start a conversation of the spec's own as a running one, with a provider quota and a context meter to show. */
async function startLiveChat(page: Page, n: number, title: string) {
	ownSession(n, title);
	await page.route("**/api/usage**", (route) => route.fulfill({ json: quota }));
	// omp only reports these after a model call.
	await patchReplies(page, {
		get_state: (data) => {
			const state = typeof data === "object" && data !== null ? data : {};
			const model = "model" in state && typeof state.model === "object" ? state.model : {};
			return {
				...state,
				model: { id: "claude-haiku-5-5", name: "Claude Haiku 5.5", ...model, provider: "anthropic" },
				contextUsage: { tokens: 4200, contextWindow: 200_000, percent: 2.1 },
			};
		},
	});
	await page.goto("/");
	await openSidebar(page);
	await expect(sessionRow(page, title)).toHaveCount(1, { timeout: 15_000 });
	await sessionRow(page, title).click();
	await page.getByTestId("composer").fill("!echo header-probe");
	await page.getByTestId("composer").press("Enter");
	// The quota pill comes from the transcript and can show before omp runs; the command's output needs omp.
	await expect(page.getByTestId("msg-exec").filter({ hasText: "header-probe" })).toBeVisible({ timeout: 60_000 });
	await expect(page.getByTestId("quota")).toBeVisible();
}

/** Everything the wide header shows beside the title: it is in the menu, or on the header, never both. */
const BESIDE_THE_TITLE = ["session-cost", "export-html", "session-controls", "open-goal"];

test.describe("phone", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("a running conversation keeps a readable title and a one-line quota; the rest is in a menu", async ({
		page,
	}) => {
		const title = "Header probe: a conversation title much longer than a phone header has room for";
		await startLiveChat(page, 0xb4, title);

		const heading = page.getByTestId("chat-title");
		const box = await boxOf(heading);
		expect(box.width, "title width").toBeGreaterThanOrEqual(120);
		expect(await heading.evaluate((el) => getComputedStyle(el).textOverflow)).toBe("ellipsis");
		expect(await heading.evaluate((el) => el.scrollWidth > el.clientWidth), "title is cut").toBe(true);
		await expect(heading).toHaveAttribute("title", title);

		const header = page.locator("header");
		expect(await header.evaluate((el) => el.scrollWidth <= el.clientWidth), "nothing hangs off the header").toBe(true);
		const pill = await boxOf(page.getByTestId("quota"));
		expect(pill.height, "quota pill is one line").toBeLessThan(32);

		for (const id of BESIDE_THE_TITLE) await expect(page.getByTestId(id), id).toHaveCount(0);
		await page.getByTestId("chat-more").click();
		const menu = page.getByTestId("chat-more-panel");
		for (const id of BESIDE_THE_TITLE) await expect(menu.getByTestId(id), id).toBeVisible();
		await expect(menu.getByRole("button", { name: "Rename" })).toBeVisible();
		await expect(menu.getByTestId("session-cost")).toHaveText(/tokens · \$/);
		// The menu writes its cost like every other cost, not with the six decimals of the tooltip.
		await expect(menu.getByText(/^cost \$/)).toHaveText(/^cost \$\d+(\.\d{2,4})?$/);
	});

	test("the menu's Goal opens its dialog, and closing that returns focus to the menu button", async ({ page }) => {
		await startLiveChat(page, 0xb5, "Header probe goal");
		await page.getByTestId("chat-more").click();
		await page.getByTestId("chat-more-panel").getByTestId("open-goal").click();
		await expect(page.getByTestId("goal-rough")).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(page.getByTestId("goal-rough")).toHaveCount(0);
		await expect(page.getByTestId("chat-more")).toBeFocused();
	});

	test("the menu's session settings open on their own: the menu is gone behind them and focus returns to its button", async ({
		page,
	}) => {
		await startLiveChat(page, 0x7300, "Header probe session panel");
		await page.getByTestId("chat-more").click();
		await page.getByTestId("chat-more-panel").getByTestId("session-controls").click();
		const panel = page.getByTestId("session-controls-panel");
		await expect(panel).toBeVisible();
		// No menu card behind the panel, so its title is not on the screen twice.
		await expect(page.getByTestId("chat-more-panel")).toHaveCount(0);
		await expect(page.getByText("This session", { exact: true })).toHaveCount(1);
		await page.keyboard.press("Escape");
		await expect(panel).toHaveCount(0);
		await expect(page.getByTestId("chat-more")).toBeFocused();
	});

	test("a folder path too long for the header ends in an ellipsis and shows in full as a tooltip", async ({ page }) => {
		const cwd =
			"/Users/someone/work/clients/acme-corporation/projects/shipment-tracking-gateway/services/postgres-pool-exhaustion";
		const title = "Long path probe";
		const id = "01a00000-0000-7000-8000-0000000099b6";
		const stamp = (min: number) => new Date(Date.UTC(2026, 0, 8, 10, min)).toISOString();
		const dir = join(process.env.OMPW_E2E_AGENT_DIR as string, "sessions", "-long-path-probe");
		mkdirSync(dir, { recursive: true });
		const lines = [
			{ type: "session", version: 3, id, timestamp: stamp(0), cwd, title },
			{
				type: "message",
				id: "lp000001",
				parentId: null,
				timestamp: stamp(1),
				message: {
					role: "user",
					content: [{ type: "text", text: title }],
					attribution: "user",
					timestamp: Date.parse(stamp(1)),
				},
			},
		];
		writeFileSync(
			join(dir, `2026-01-08T10-00-00-000Z_${id}.jsonl`),
			`${lines.map((l) => JSON.stringify(l)).join("\n")}\n`,
		);

		await page.goto("/");
		await page.getByRole("button", { name: "Show sidebar" }).click();
		await expect(sessionRow(page, title)).toHaveCount(1, { timeout: 15_000 });
		await sessionRow(page, title).click();

		const folder = page.getByTestId("chat-cwd");
		await expect(folder).toHaveAttribute("title", cwd);
		expect(await folder.evaluate((el) => getComputedStyle(el).textOverflow)).toBe("ellipsis");
		expect(await folder.evaluate((el) => el.scrollWidth > el.clientWidth), "path is cut").toBe(true);
		// It is cut inside the header, not pushed past it.
		const header = page.locator("header");
		expect(await header.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
	});
});

test.describe("window", () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test("the header follows the room its column has: the side panel takes room, closing it gives it back", async ({
		page,
	}) => {
		await startLiveChat(page, 0xb7, "Header probe window");
		// Sidebar (288 px) and no panel: the column is 992 px.
		for (const id of BESIDE_THE_TITLE) await expect(page.getByTestId(id), id).toBeVisible();
		await expect(page.getByTestId("chat-more")).toHaveCount(0);

		// The panel (400 px) leaves 592 px: too little for all of it beside the title.
		await page.getByTestId("toggle-panel").click();
		await expect(page.getByTestId("right-panel")).toBeVisible();
		await expect(page.getByTestId("chat-more")).toBeVisible();
		for (const id of BESIDE_THE_TITLE) await expect(page.getByTestId(id), id).toHaveCount(0);
		expect((await boxOf(page.getByTestId("chat-title"))).width).toBeGreaterThanOrEqual(120);

		await page.getByTestId("right-panel-close").click();
		await expect(page.getByTestId("chat-more")).toHaveCount(0);
		for (const id of BESIDE_THE_TITLE) await expect(page.getByTestId(id), id).toBeVisible();
	});
});
