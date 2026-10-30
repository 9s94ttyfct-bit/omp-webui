import AxeBuilder from "@axe-core/playwright";
import { unfoldAdvanced } from "../support/controls.ts";
import { ownSession, sessionRow, startLive } from "../support/live.ts";
import { rpcState } from "../support/rpc-state.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * Every setting of the session controls explains itself (#597): an "About" button under which what it does, what each
 * choice means, what it costs and what to pick is opened, and nothing of it is there until it is. No model call is made:
 * the controls only need a process.
 */

const panel = (page: Page) => page.getByTestId("session-controls-panel");

/** The settings with an explanation, by row, with what each says that a reader would act on. */
const ROWS = [
	{ row: "auto-compaction", label: "Auto-compaction", says: ["never compacts by itself", "extra model request"] },
	{ row: "auto-retry", label: "Auto-retry", says: ["retry limit (10 by default)", "billed request"] },
	{ row: "steering-mode", label: "Steering delivery", says: ["its own turn", "(omp recommends this)"] },
	{ row: "follow-up-mode", label: "Follow-up delivery", says: ["end of its turn", "in the order you queued them"] },
	{ row: "interrupt-mode", label: "Interrupt tools on steer", says: ["skipped", "Keep Immediately"] },
	{ row: "fast-mode", label: "Fast mode", says: ["priority tier", "premium rate"] },
	{ row: "slow-mode", label: "Slow mode (cheaper flex tier)", says: ["flex tier", "no default to set here"] },
	{ row: "cache-warming", label: "Prompt-cache warming", says: ["one-token reply", "at most 30 minutes"] },
] as const;

/** A page of its own on the shared server, with the page's socket tapped before it loads. */
async function openPage(page: Page, title: string, options: { lang?: string; theme?: string } = {}) {
	const next = await page.context().newPage();
	await next.addInitScript(
		({ lang, theme }) => {
			localStorage.setItem("ompw.autoTitle", "off");
			localStorage.setItem("ompw.lang", lang);
			localStorage.setItem("ompw.theme", theme);
		},
		{ lang: options.lang ?? "en", theme: options.theme ?? "light" },
	);
	const tap = await tapSocket(next);
	await next.goto("/");
	await expect(sessionRow(next, title)).toHaveCount(1, { timeout: 15_000 });
	return { page: next, tap };
}

/** The panel of a conversation whose omp says slow mode is supported (the rest of the rows are omp's own answers). */
async function openPanelWithSlowMode(page: Page, title: string, probe: string, options = {}) {
	const only = await openPage(page, title, options);
	await startLive(only.page, only.tap, title, probe);
	only.tap.answer("get_state", () => ({
		ok: true,
		data: rpcState({
			slowModeSupported: true,
			slowModeEnabled: false,
			slowModeScope: "session",
			fastModeEnabled: false,
		}),
	}));
	await only.page.reload();
	await sessionRow(only.page, title).click();
	await only.page.getByTestId("session-controls").click();
	await expect(panel(only.page)).toBeVisible({ timeout: 60_000 });
	await unfoldAdvanced(only.page);
	return only.page;
}

const info = (page: Page, row: string) => panel(page).getByTestId(`${row}-info`);
const help = (page: Page, row: string) => panel(page).getByTestId(`${row}-help`);

test("every setting has an About button that opens what it does, what its choices mean, what it costs and what to pick", async ({
	page,
}) => {
	ownSession(0x6c, "Help every row");
	const p = await openPanelWithSlowMode(page, "Help every row", "help-every-row-up");

	for (const { row, label, says } of ROWS) {
		const button = info(p, row);
		await expect(button, row).toHaveAccessibleName(`About “${label}”`);
		await expect(button, row).toHaveAttribute("aria-expanded", "false");
		await expect(help(p, row), row).toHaveCount(0);

		await button.click();
		await expect(button, row).toHaveAttribute("aria-expanded", "true");
		const text = help(p, row);
		await expect(text, row).toBeVisible();
		// The button names the element it opened.
		const id = await text.getAttribute("id");
		await expect(button, row).toHaveAttribute("aria-controls", id as string);
		// What it does, every choice of the row with its own meaning, the cost and the recommendation.
		await expect(text, row).toContainText("Cost and risk");
		await expect(text, row).toContainText("Recommended");
		for (const choice of await panel(p).getByTestId(row).getByRole("radio").all()) {
			const name = (await choice.evaluate((el) => el.closest("label")?.textContent ?? "")).trim();
			await expect(text.locator("li").filter({ hasText: new RegExp(`^${name}:`) }), `${row}: ${name}`).toHaveCount(1);
		}
		for (const phrase of says) await expect(text, row).toContainText(phrase);
		// It is inside the row it explains, below the controls.
		expect(await text.evaluate((el) => el.closest("fieldset")?.dataset.testid)).toBe(row);

		// Pressing the button again closes it.
		await button.click();
		await expect(button, row).toHaveAttribute("aria-expanded", "false");
		await expect(help(p, row), row).toHaveCount(0);
	}

	// Compact context has its own button, beside its title.
	const compact = info(p, "compact");
	await expect(compact).toHaveAccessibleName("About “Compact context”");
	await compact.click();
	await expect(help(p, "compact")).toContainText("Summarizes the older part of the conversation now");
	await expect(help(p, "compact")).toContainText("the compact is queued for the end of the turn");
	await expect(help(p, "compact")).toContainText("Recommended");
	// It has no choices to list.
	await expect(help(p, "compact").locator("li")).toHaveCount(0);
});

test("one explanation is open at a time, the keyboard opens and closes it, and closing the panel closes it", async ({
	page,
}) => {
	ownSession(0x6d, "Help keyboard");
	const p = await openPanelWithSlowMode(page, "Help keyboard", "help-keyboard-up");

	await info(p, "auto-retry").click();
	await expect(help(p, "auto-retry")).toBeVisible();
	await info(p, "cache-warming").click();
	await expect(help(p, "cache-warming")).toBeVisible();
	await expect(help(p, "auto-retry")).toHaveCount(0);
	await expect(info(p, "auto-retry")).toHaveAttribute("aria-expanded", "false");

	// Enter and Space on the focused button, which stays focused.
	const button = info(p, "steering-mode");
	await button.focus();
	await p.keyboard.press("Enter");
	await expect(help(p, "steering-mode")).toBeVisible();
	await expect(button).toBeFocused();
	await p.keyboard.press("Space");
	await expect(help(p, "steering-mode")).toHaveCount(0);
	await p.keyboard.press("Space");
	await expect(help(p, "steering-mode")).toBeVisible();

	// The panel closed and opened again starts with every explanation closed.
	await p.keyboard.press("Escape");
	await expect(panel(p)).toBeHidden();
	await p.getByTestId("session-controls").click();
	await expect(panel(p)).toBeVisible();
	await expect(panel(p).locator('[data-testid$="-help"]')).toHaveCount(0);
});

test("in a short window the panel stays inside it and scrolls, and an explanation that opens is brought into view", async ({
	page,
}) => {
	ownSession(0x6e, "Help short window");
	const p = await openPanelWithSlowMode(page, "Help short window", "help-short-window-up");

	for (const height of [900, 600, 440]) {
		await p.setViewportSize({ width: 1280, height });
		await p.keyboard.press("Escape");
		await expect(panel(p)).toBeHidden();
		await p.getByTestId("session-controls").click();
		await expect(panel(p)).toBeVisible();

		// Whatever is open, the panel is within the window.
		for (const row of ["cache-warming", "compact"]) {
			await info(p, row).click();
			const text = help(p, row);
			await expect(text).toBeVisible();
			const box = await panel(p).boundingBox();
			expect(box, `${height}: panel`).not.toBeNull();
			const { y, height: h } = box as { y: number; height: number };
			expect(y, `${height}: top`).toBeGreaterThanOrEqual(0);
			expect(y + h, `${height}: bottom`).toBeLessThanOrEqual(height);
			// The explanation can be read: it is inside the part of the panel that shows.
			await expect
				.poll(
					async () => {
						const t = await text.boundingBox();
						const pb = await panel(p).boundingBox();
						if (!t || !pb) return false;
						return t.y >= pb.y - 1 && t.y + t.height <= pb.y + pb.height + 1;
					},
					{ message: `${height}: ${row} help is in view` },
				)
				.toBe(true);
		}
		// What does not fit scrolls inside the panel.
		if (height < 700) {
			const scrolls = await panel(p).evaluate(
				(el) => el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY === "auto",
			);
			expect(scrolls, `${height}: scrolls`).toBe(true);
		}
	}
});

test("the explanations are in Simplified Chinese, fit the panel, and are accessible in both themes", async ({
	page,
}) => {
	ownSession(0x6f, "Help in Chinese");
	for (const theme of ["light", "dark"]) {
		const only = await openPage(page, "Help in Chinese", { lang: "zh-CN", theme });
		try {
			await startLive(only.page, only.tap, "Help in Chinese", `help-zh-${theme}-up`);
			only.tap.answer("get_state", () => ({
				ok: true,
				data: rpcState({
					slowModeSupported: true,
					slowModeEnabled: false,
					slowModeScope: "session",
					fastModeEnabled: false,
				}),
			}));
			await only.page.reload();
			await sessionRow(only.page, "Help in Chinese").click();
			await only.page.getByTestId("session-controls").click();
			await expect(panel(only.page)).toBeVisible({ timeout: 60_000 });
			await unfoldAdvanced(only.page);

			await expect(info(only.page, "auto-retry")).toHaveAccessibleName("关于“自动重试”");
			await info(only.page, "auto-retry").click();
			await expect(help(only.page, "auto-retry")).toContainText("成本与风险");
			await expect(help(only.page, "auto-retry")).toContainText("建议");
			await expect(help(only.page, "auto-retry")).toContainText("重试上限");
			// No English left of what the row explains.
			expect(await help(only.page, "auto-retry").innerText()).not.toMatch(/Cost and risk|Recommended/);
			await info(only.page, "cache-warming").click();
			await expect(help(only.page, "cache-warming")).toContainText("30 分钟");

			// Nothing runs off the side of the panel.
			const wide = await panel(only.page).evaluate((el) => el.scrollWidth > el.clientWidth);
			expect(wide, "horizontal overflow").toBe(false);

			const { violations } = await new AxeBuilder({ page: only.page })
				.include('[data-testid="session-controls-panel"]')
				.analyze();
			expect(
				violations.flatMap((v) => v.nodes.map((n) => `${v.id} ${n.target.join(" ")}: ${n.any[0]?.message ?? v.help}`)),
				theme,
			).toEqual([]);
		} finally {
			await only.page.close();
		}
	}
});

test("a setting whose omp configuration cannot be read says so on its star, and cannot be made the default", async ({
	page,
}) => {
	ownSession(0x70, "Help unreadable");
	// The server answers an empty configuration: what the process uses is then not known. The route is the context's, as
	// the conversation's page is one that openPage opens.
	await page
		.context()
		.route("**/api/controls/settings**", (r) =>
			r.fulfill({ status: 200, contentType: "application/json", body: "{}" }),
		);
	const p = await openPanelWithSlowMode(page, "Help unreadable", "help-unreadable-up");

	for (const row of ["auto-retry", "cache-warming"]) {
		const star = panel(p).getByTestId(`${row}-set-default`);
		await expect(star, row).toBeDisabled();
		await expect(star, row).toHaveAccessibleName(
			"omp's configuration could not be read, so what this setting is now is not known and there is no default to set.",
		);
	}
});
