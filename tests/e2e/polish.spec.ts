import { PALETTES } from "../../web/src/lib/theme.ts";
import { blend, effective, hex, parseHex, readPalettes, resolve } from "../support/palettes.ts";
import { distance, pixelsAt } from "../support/pixels.ts";
import type { Rgb } from "../support/style.ts";
import { expect, type Locator, type Page, test } from "./fixtures.ts";

/**
 * The small controls share one polished style in every palette and mode: scrollbars (slim, rounded, in the palette's ink,
 * brighter under the pointer), range sliders (a groove filled up to the value, a round thumb, a focus ring on the thumb),
 * the resize handle (a hairline and a grip that show under the pointer, the keyboard and a drag) and the focus ring.
 *
 * A specimen of each is put on the Settings page (the real stylesheet) at fixed positions and sizes, and screenshots
 * of it are checked pixel by pixel against the palette's colours at fixed states: scrollbar at rest and under the
 * pointer; slider at 40 %, focused and at 100 %; handle at rest, hovered, focused and dragged;
 * a focused button. Flat colour of one-to-fourteen-pixel parts, which come out the same on every OS (the scrollbars are
 * drawn by the engine from the CSS parts, not by the OS: the test browser is started with scrollbars shown, since
 * Playwright hides them by default). Screenshots of every combination are attached to the report. No model call.
 */

test.use({ reducedMotion: "reduce", launchOptions: { ignoreDefaultArgs: ["--hide-scrollbars"] } });

const palettes = readPalettes();
const MODES = ["light", "dark"] as const;
const COMBOS = PALETTES.flatMap((id) => MODES.map((mode) => ({ id, mode })));

const SPECIMEN = `
<div id="specimen" style="position:fixed;left:20px;top:20px;z-index:99999;width:560px;padding:20px;display:grid;grid-template-columns:200px 280px;gap:24px 32px;background:var(--bg);color:var(--fg)">
	<div id="sp-scroll" style="width:200px;height:100px;overflow:auto;background:var(--surface)"><div style="width:400px;height:400px"></div></div>
	<div style="display:flex;flex-direction:column;justify-content:center;gap:8px">
		<button id="sp-before" style="height:24px;width:60px;background:var(--surface)">first</button>
		<input id="sp-range" type="range" min="0" max="100" value="40" style="width:240px">
	</div>
	<div id="sp-box" style="position:relative;width:200px;height:70px;background:var(--surface)">
		<div id="sp-handle" class="resize-handle" role="separator" aria-orientation="vertical" tabindex="0" style="position:absolute;top:0;bottom:0;left:97px;width:6px;cursor:col-resize"></div>
	</div>
	<div><button id="sp-btn" style="height:36px;width:120px;background:var(--accent);color:var(--accent-fg);border-radius:var(--radius-xl)">Focus me</button></div>
</div>`;

const tokens = (id: string, mode: (typeof MODES)[number]) => effective(palettes[id], mode === "dark");
const colour = (id: string, mode: (typeof MODES)[number], name: string): Rgb =>
	parseHex(resolve(tokens(id, mode), name));

async function openSpecimen(page: Page, id: string, mode: string) {
	await page.addInitScript(
		([p, m]) => {
			localStorage.setItem("ompw.palette", p);
			localStorage.setItem("ompw.theme", m);
		},
		[id, mode],
	);
	await page.goto("/#/settings");
	await expect(page.getByTestId("settings-page")).toBeVisible();
	await page.evaluate((html) => document.body.insertAdjacentHTML("beforeend", html), SPECIMEN);
	await page.mouse.move(690, 400); // off everything of the specimen
}

const box = async (target: Locator) => {
	const b = await target.boundingBox();
	if (!b) throw new Error(`no box for ${target}`);
	return b;
};

for (const { id, mode } of COMBOS) {
	test(`${id} ${mode}: scrollbar, slider, resize handle and focus ring`, async ({ page }, testInfo) => {
		await openSpecimen(page, id, mode);
		const c = (name: string) => colour(id, mode, name);
		const bad: string[] = [];
		const near = (what: string, got: Rgb, want: Rgb, tolerance = 4) => {
			if (distance(got, want) > tolerance) bad.push(`${what}: painted ${hex(got)}, expected about ${hex(want)}`);
		};
		const surface = c("surface");
		const bg = c("bg");
		const accent = c("accent");

		// ---- Scrollbar: the parts are the stylesheet's (the standard properties would switch them off), at rest and under the pointer.
		const scroll = page.locator("#sp-scroll");
		expect(
			await scroll.evaluate((el) => [getComputedStyle(el).scrollbarWidth, getComputedStyle(el).scrollbarColor]),
		).toEqual(["auto", "auto"]);
		const s = await box(scroll);
		expect(await scroll.evaluate((el: HTMLElement) => el.offsetWidth - el.clientWidth), "a 14px bar").toBe(14);
		const thumbAt = { x: s.x + s.width - 7, y: s.y + 20 };
		const trackAt = { x: s.x + s.width - 7, y: s.y + s.height - 30 };
		const gutterAt = { x: s.x + s.width - 1, y: s.y + 20 };
		/** A screenshot after two frames: the engine repaints the parts of a scrollbar or slider a frame after the state changes. */
		const snap = async () => {
			await page.evaluate(() => {
				const { promise, resolve } = Promise.withResolvers<void>();
				requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
				return promise;
			});
			return page.screenshot({ animations: "disabled" });
		};
		const shoot = async (name: string) => {
			const png = await snap();
			await testInfo.attach(`${name}-${id}-${mode}.png`, { body: png, contentType: "image/png" });
			return png;
		};
		let png = await shoot("rest");
		let [thumb, track, gutter] = await pixelsAt(page, png, [thumbAt, trackAt, gutterAt]);
		near("scroll thumb at rest", thumb, blend(c("fg"), 0.18, surface));
		near("scroll track", track, surface, 2);
		near("scroll gutter", gutter, surface, 2);
		await page.mouse.move(thumbAt.x, thumbAt.y);
		[thumb] = await pixelsAt(page, await snap(), [thumbAt]);
		near("scroll thumb under the pointer", thumb, blend(c("fg"), 0.46, surface));
		await page.mouse.move(690, 400);

		// ---- Slider: filled with the accent up to the value, a thumb in the surface colour with an accent rim.
		const range = page.locator("#sp-range");
		const r = await box(range);
		const mid = r.y + r.height / 2;
		const thumbCentre = (share: number) => r.x + 9 + (r.width - 18) * share;
		await expect
			.poll(() => range.evaluate((el) => el.style.getPropertyValue("--range-fill")), { message: "range-fill keeps up" })
			.toBe("40%");
		png = await shoot("slider");
		const ringSpot = { x: thumbCentre(0.4), y: mid - 11 };
		let [filled, empty, knob, rim, beforeFocus] = await pixelsAt(page, png, [
			{ x: r.x + 20, y: mid },
			{ x: r.x + r.width - 20, y: mid },
			{ x: thumbCentre(0.4), y: mid },
			{ x: thumbCentre(0.4) - 8, y: mid },
			ringSpot,
		]);
		near("slider groove, filled part", filled, accent);
		near("slider groove, empty part", empty, blend(c("fg"), 0.18, bg));
		near("slider thumb", knob, surface);
		near("slider thumb rim", rim, accent, 40);
		// Keyboard: the thumb wears the focus ring (the accent at 35 %, 4px around it) and End fills the groove to the end.
		await page.locator("#sp-before").focus();
		await page.keyboard.press("Tab");
		await expect(range).toBeFocused();
		[filled] = await pixelsAt(page, await shoot("slider-focus"), [ringSpot]);
		// The ring is the accent at 35 % just outside the thumb, where its drop shadow also falls: the pixel has to be clearly
		// nearer the ring's colour than it was before the focus, not exactly it.
		const ringColour = blend(accent, 0.35, bg);
		if (distance(filled, ringColour) + 12 > distance(beforeFocus, ringColour))
			bad.push(`slider focus ring is not drawn (${hex(beforeFocus)} → ${hex(filled)}, ring ${hex(ringColour)})`);
		await page.keyboard.press("End");
		await expect.poll(() => range.evaluate((el) => el.style.getPropertyValue("--range-fill"))).toBe("100%");
		[filled] = await pixelsAt(page, await shoot("slider-end"), [{ x: r.x + r.width - 40, y: mid }]);
		near("slider groove after End", filled, accent);

		// ---- Resize handle: nothing at rest; hairline and grip under the pointer, the keyboard and a drag.
		const handle = page.locator("#sp-handle");
		const h = await box(handle);
		const hair = { x: h.x + 3, y: h.y + 8 };
		const grip = { x: h.x + 3, y: h.y + h.height / 2 };
		png = await shoot("handle-rest");
		let [rest, restGrip] = await pixelsAt(page, png, [hair, grip]);
		near("handle at rest", rest, surface, 2);
		near("handle grip at rest", restGrip, surface, 2);
		await handle.hover();
		png = await shoot("handle-hover");
		const [hovered, hoveredGrip] = await pixelsAt(page, png, [hair, grip]);
		near("handle hairline under the pointer", hovered, blend(accent, 0.55, surface));
		if (distance(hoveredGrip, surface) < 12)
			bad.push(`handle grip under the pointer is not drawn (${hex(hoveredGrip)})`);
		await page.mouse.move(690, 400);
		await handle.evaluate((el) => el.setAttribute("data-dragging", "true"));
		png = await shoot("handle-drag");
		const [dragged, draggedGrip] = await pixelsAt(page, png, [hair, grip]);
		near("handle hairline while dragged", dragged, accent);
		near("handle grip while dragged", draggedGrip, accent);
		await handle.evaluate((el) => el.removeAttribute("data-dragging"));
		await page.locator("#sp-range").focus();
		await page.keyboard.press("Tab"); // the handle is next in the tab order after the range
		await expect(handle).toBeFocused();
		png = await shoot("handle-focus");
		const [focused] = await pixelsAt(page, png, [hair]);
		near("handle hairline with keyboard focus", focused, accent);
		await handle.evaluate((el) => (el as HTMLElement).blur());

		// ---- Focus ring: 2px in the accent, offset 2px, around the button.
		const button = page.locator("#sp-btn");
		const b = await box(button);
		const ringAt = { x: b.x - 3, y: b.y + b.height / 2 };
		[rest] = await pixelsAt(page, await shoot("button-rest"), [ringAt]);
		near("no ring before focus", rest, bg, 2);
		await handle.focus();
		await page.keyboard.press("Tab");
		await expect(button).toBeFocused();
		const [ring] = await pixelsAt(page, await shoot("button-focus"), [ringAt]);
		near("focus ring", ring, accent);

		expect(bad, `${id} ${mode}`).toEqual([]);
	});
}

test("native checkboxes, radios and the text caret take the palette's accent", async ({ page }) => {
	await openSpecimen(page, "hermes", "dark");
	const probe = await page.evaluate(() => {
		const style = getComputedStyle(document.documentElement);
		return {
			accent: style.accentColor,
			caret: style.caretColor,
			accentToken: style.getPropertyValue("--accent").trim(),
		};
	});
	// Native checkboxes, radios and progress bars, and the text caret, are in the accent of the palette.
	const rgb = (css: string) => {
		const { r, g, b } = parseHex(css);
		return `rgb(${r}, ${g}, ${b})`;
	};
	expect(probe.accent).toBe(rgb(probe.accentToken));
	expect(probe.caret).toBe(rgb(probe.accentToken));
});
