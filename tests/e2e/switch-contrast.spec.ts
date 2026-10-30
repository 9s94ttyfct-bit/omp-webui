import { PALETTES } from "../../shared/prefs.ts";
import { contrast, type Rgb } from "../support/style.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * An off switch can be seen (WCAG 1.4.11, non-text contrast 3:1, #787): its track's edge stands out from the card it
 * sits on in every palette, light and dark. Off used to be a `--hover` track with a `--border` edge, 1.2–1.3:1 on a white
 * card, so in light themes "off" read as a faint pill or as nothing at all. axe's color-contrast checks only text, so it
 * never saw this. Measured on Settings › Safety's "When the reviewer denies a call, ask me", turned off; the look is
 * switched on the page itself (palettes are scoped by `data-palette` and the `dark` class).
 */

const POST = { "x-omp-webui": "1" };
const setGuard = (page: Page, config: Record<string, unknown>) =>
	page.request.post("/api/guard", { data: config, headers: POST });

// A worker's server is shared by the specs that run after this one: the guard goes back to off, as the harness starts it.
test.afterEach(async ({ page }) => {
	await setGuard(page, { mode: "off", reviewer: "", askWhenUnavailable: true, askWhenDenied: true });
});

test("an off switch's edge is at least 3:1 against its card in all palette and mode combinations", async ({ page }) => {
	await setGuard(page, { mode: "reviewer", reviewer: "", askWhenUnavailable: true, askWhenDenied: false });
	await page.goto("/#/settings/safety");
	const off = page.getByTestId("guard-ask-denied");
	await expect(off).toHaveAttribute("aria-checked", "false", { timeout: 60_000 });
	await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important}" });
	const low: string[] = [];
	for (const palette of PALETTES) {
		for (const dark of [false, true]) {
			await page.evaluate(
				([id, on]) => {
					document.documentElement.dataset.palette = id as string;
					document.documentElement.classList.toggle("dark", on as boolean);
				},
				[palette, dark],
			);
			// The edge's colour, and what is behind the switch: the backgrounds of its ancestors, composited over white.
			const { edge, card } = await off.evaluate((el) => {
				const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
				if (!ctx) throw new Error("no 2d canvas");
				const parse = (css: string): number[] => {
					ctx.clearRect(0, 0, 1, 1);
					ctx.fillStyle = "#000";
					ctx.fillStyle = css;
					ctx.fillRect(0, 0, 1, 1);
					const d = ctx.getImageData(0, 0, 1, 1).data;
					return [d[0], d[1], d[2], d[3] / 255];
				};
				const over = (top: number[], under: number[]) => {
					const a = top[3];
					return [0, 1, 2].map((i) => top[i] * a + under[i] * (1 - a)).concat(1);
				};
				const chain: Element[] = [];
				for (let e = el.parentElement; e; e = e.parentElement) chain.push(e);
				let bg = [255, 255, 255, 1];
				for (const e of chain.reverse()) bg = over(parse(getComputedStyle(e).backgroundColor), bg);
				const edge = over(parse(getComputedStyle(el).borderTopColor), bg);
				const rgb = (c: number[]) => ({ r: c[0], g: c[1], b: c[2] });
				return { edge: rgb(edge), card: rgb(bg) };
			});
			const ratio = contrast(edge as Rgb, card as Rgb);
			if (ratio < 3) low.push(`${palette} ${dark ? "dark" : "light"}: ${ratio.toFixed(2)}`);
		}
	}
	expect(low).toEqual([]);
});
