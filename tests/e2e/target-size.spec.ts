import { rmSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { openSidebar, sessionRow, startLive } from "../support/live.ts";
import { panelTab } from "../support/panel.ts";
import { tapSocket } from "../support/socket-tap.ts";
import { TARGETS_PROMPT, writeTargetsSession } from "../support/target-fixtures.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * Click targets are at least 24 × 24 CSS pixels (WCAG 2.2 target size): the sidebar row's actions button, and the
 * text-only buttons of the transcript: "View subagents" on a task card, the raw-arguments toggle of a task card and of
 * an edit card, "Show all" on a long diff and on a long result, "+N more" on the advisor's notes, and the Ask panel's
 * follow-up. axe's `target-size` runs over the chat with all of them on screen and over the sidebar with the row's
 * button shown, on a desktop and on a phone, and each button's own box is measured too (axe also passes a small
 * target that has room around it). No model call.
 */

let file = "";
test.beforeAll(() => {
	file = writeTargetsSession(process.env.OMPW_E2E_AGENT_DIR as string);
});
test.afterAll(() => {
	rmSync(file, { force: true });
});

/** axe's target-size over what is on the page now; each element too small, in words. */
async function tooSmall(page: Page, where: string): Promise<string[]> {
	const { violations } = await new AxeBuilder({ page }).withRules(["target-size"]).analyze();
	return violations.flatMap((v) =>
		v.nodes.map((n) => `${where}: ${n.target.join(" ")} — ${(n.any[0]?.message ?? v.help).replace(/\s+/g, " ")}`),
	);
}

/** `what` is at least `min` pixels high, and wide too when it is an icon. */
async function expectTarget(what: Locator, name: string, icon = false) {
	await what.scrollIntoViewIfNeeded();
	const box = await what.boundingBox();
	if (!box) throw new Error(`${name} has no box`);
	expect(box.height, `${name} height`).toBeGreaterThanOrEqual(24);
	if (icon) expect(box.width, `${name} width`).toBeGreaterThanOrEqual(24);
}

for (const [label, size] of [
	["a desktop", { width: 1400, height: 900 }],
	["a phone", { width: 390, height: 844 }],
] as const) {
	test(`${label}: the transcript's text buttons, the Ask follow-up and the sidebar row's menu are 24px or more`, async ({
		page,
	}) => {
		await page.setViewportSize(size);
		await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
		const tap = await tapSocket(page);
		tap.answer("get_btw_history", () => ({
			ok: true,
			data: { records: [{ id: "btw-1", question: "Why?", answer: "Because.", status: "done", createdAt: 1 }] },
		}));
		await page.goto("/");
		await openSidebar(page);
		// The output of `!echo` is kept in the conversation: each run has a probe of its own to tell its output apart.
		await startLive(page, tap, TARGETS_PROMPT, `target-probe-${size.width}`);
		await expect(page.getByText("TARGET-FINAL: done.")).toBeVisible();

		// The turn folds its steps; open it, then each card, so every button is on the page.
		await page.getByTestId("work-summary").first().click();
		const cards = page.getByTestId("tool-card");
		await expect(cards).toHaveCount(3);
		for (let i = 0; i < 3; i++) await cards.nth(i).getByRole("button").first().click();

		const bad: string[] = [];
		const buttons: [string, Locator][] = [
			["View subagents", page.getByRole("button", { name: /^View subagents/ })],
			// The same control on each card that has one (a task card and an edit card each keep their own state): both measured.
			["raw arguments toggle (task card)", page.locator('[data-tool="task"]').getByTestId("tool-raw-toggle")],
			["raw arguments toggle (edit card)", page.locator('[data-tool="edit"]').getByTestId("tool-raw-toggle")],
			["Show all lines", page.getByRole("button", { name: /^Show all \(320 lines\)/ })],
			["Show all chars", page.getByRole("button", { name: /^Show all \(\d[\d,]* chars\)/ })],
			["+N more", page.getByTestId("advisor-more")],
		];
		for (const [name, button] of buttons) {
			await expect(button, name).toBeVisible();
			await expectTarget(button, name);
		}
		bad.push(...(await tooSmall(page, "chat")));

		// The Ask panel: its follow-up button.
		await page.getByTestId("toggle-panel").click();
		await panelTab(page, /Ask/).click();
		const followUp = page.getByRole("button", { name: "Ask a follow-up" });
		await expect(followUp).toBeVisible();
		await expectTarget(followUp, "Ask a follow-up");
		bad.push(...(await tooSmall(page, "ask panel")));
		// Put the panel away: on a phone it is a sheet over the page (Escape closes it), on a desktop it sits beside it.
		if (size.width < 1024) await page.keyboard.press("Escape");
		else await page.getByTestId("toggle-panel").click();
		await expect(page.getByTestId("right-panel")).toHaveCount(0);

		// The sidebar row's button, shown by pointing at the row (it is hidden until then, except on a touch screen).
		await openSidebar(page);
		const row = sessionRow(page, TARGETS_PROMPT);
		await row.hover();
		const menu = page.getByRole("button", { name: `Actions for ${TARGETS_PROMPT}` });
		await expect(menu).toBeVisible();
		await expectTarget(menu, "session row menu", true);
		bad.push(...(await tooSmall(page, "sidebar")));

		expect(bad, label).toEqual([]);
	});
}
