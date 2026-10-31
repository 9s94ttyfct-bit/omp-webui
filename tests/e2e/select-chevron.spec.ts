import { realpathSync } from "node:fs";
import { choose } from "../support/select.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * The app's selects wear its own chevron, not the one the OS draws. In the composer the thinking level is as wide as
 * the level it shows, with the chevron right after it like the model and preset chips beside it (it used to be as wide
 * as its longest option: "Off", then a gap of about 60px, then a heavy native arrow). The sidebar's project filter
 * starts its text where the filter field above it does. On a computer the control is the app's own listbox; on a phone
 * the system's `<select>`, so it still takes a phone's own picker. No model call.
 */

/** What a select looks like, measured: its own box, the words it shows, and the chevron laid over it. */
async function look(select: Locator) {
	return select.evaluate((el) => {
		const style = getComputedStyle(el);
		const ctx = document.createElement("canvas").getContext("2d");
		if (!ctx) throw new Error("no 2d canvas");
		ctx.font = style.font;
		const box = el.getBoundingClientRect();
		const chevron = el.parentElement?.querySelector("svg")?.getBoundingClientRect();
		return {
			appearance: style.appearance,
			left: box.left,
			right: box.right,
			width: box.width,
			/** Where the words end: the select's inner left edge plus what the shown option measures. */
			textRight:
				box.left +
				Number.parseFloat(style.borderLeftWidth) +
				Number.parseFloat(style.paddingLeft) +
				ctx.measureText(el instanceof HTMLSelectElement ? (el.selectedOptions[0]?.text ?? "") : (el.textContent ?? ""))
					.width,
			chevron: chevron ? { left: chevron.left, right: chevron.right } : null,
		};
	});
}

/** The fixture conversation, by its address: the sidebar is a drawer on a phone. */
async function openAlpha(page: Page, alpha: string) {
	await page.goto(`/#/s/${encodeURIComponent(realpathSync(alpha))}`);
	await expect(page.getByTestId("thinking-picker")).toBeVisible();
}

test("the thinking level is as wide as what it shows, with the app's chevron 6px or less after it", async ({
	page,
	e2eServer,
}) => {
	await openAlpha(page, e2eServer.fixtures.alpha);
	const shown = await look(page.getByTestId("thinking-picker"));
	expect(shown.appearance, "the browser draws no chevron of its own").toBe("none");
	expect(shown.chevron, "the app's chevron").not.toBeNull();
	const gap = (shown.chevron?.left ?? 0) - shown.textRight;
	expect(gap, "px between the shown level and the chevron").toBeGreaterThanOrEqual(0);
	expect(gap, "px between the shown level and the chevron").toBeLessThanOrEqual(6);
	// The chevron is the last thing of the control: no empty space after it either.
	expect(shown.right - (shown.chevron?.right ?? 0)).toBeLessThanOrEqual(1);

	// It still takes a level the way a select does.
	const picker = page.getByTestId("thinking-picker");
	await choose(picker, "high");
	await expect(picker).toHaveAttribute("data-value", "high");
});

test("every select of Settings has the app's chevron at its right end and still selects", async ({ page }) => {
	const pages = ["look", "chats", "models", "safety", "app"];
	let count = 0;
	// Settings is five pages: only the shown one has boxes to measure, so each page is opened in turn.
	for (const id of pages) {
		await page.goto(`/#/settings/${id}`);
		await expect(page.locator(`[data-testid="settings-page-tab"][data-page="${id}"]`)).toHaveAttribute(
			"aria-current",
			"page",
		);
		if (id === "models") await expect(page.getByTestId("default-thinking")).toBeVisible();
		const selects = page.locator(
			`[data-settings-page="${id}"] :is(select:not([aria-hidden]), [role="combobox"][data-value])`,
		);
		count += await selects.count();
		for (const [i, select] of (await selects.all()).entries()) {
			const shown = await look(select);
			expect(shown.appearance, `${id} select ${i} draws no chevron of its own`).toBe("none");
			expect(shown.chevron, `${id} select ${i} has the app's chevron`).not.toBeNull();
			expect(shown.chevron?.right, `${id} select ${i}: the chevron is inside its right end`).toBeLessThanOrEqual(
				shown.right,
			);
			expect(shown.chevron?.left, `${id} select ${i}: the chevron is in its right half`).toBeGreaterThan(
				shown.left + shown.width / 2,
			);
		}
	}
	expect(count, "selects on the pages").toBeGreaterThanOrEqual(4);
	await page.goto("/#/settings/models");
	const level = page.getByTestId("default-thinking");
	await choose(level, "high");
	await expect(level).toHaveAttribute("data-value", "high");
});

test.describe("on a touch screen, where selects are 16px", () => {
	test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

	test("the thinking level still shows its whole word, in the size of the chips beside it", async ({
		page,
		e2eServer,
	}) => {
		await page.goto(`/#/s/${encodeURIComponent(realpathSync(e2eServer.fixtures.alpha))}`);
		// On a phone the thinking level is behind "⋯", in a panel where each control says what it is.
		await page.getByTestId("composer-more").click();
		const picker = page.getByTestId("composer-more-panel").getByTestId("thinking-picker");
		await expect(picker).toBeVisible();
		const { clipped, size, sizer, shown } = await picker.evaluate((el) => {
			const words = getComputedStyle(el.parentElement?.querySelector("[data-select-sizer]") as Element);
			return {
				clipped: el.scrollWidth > el.clientWidth,
				size: getComputedStyle(el).fontSize,
				sizer: words.fontSize,
				shown: words.visibility,
			};
		});
		expect(size, "the field itself stays 16px, or iOS zooms in when it takes focus").toBe("16px");
		expect(sizer, "the words shown are the chips' 12px").toBe("12px");
		expect(shown, "and they are drawn").toBe("visible");
		expect(clipped, "the shown level is cut off").toBe(false);
	});
});
