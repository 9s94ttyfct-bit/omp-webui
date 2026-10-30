import type { Locator, Page } from "@playwright/test";

/** An element's layout box in CSS pixels. */
export interface Box {
	x: number;
	y: number;
	width: number;
	height: number;
}

/** The box of a visible element; throws (instead of handing `null` on) when it is hidden or gone. */
export async function boxOf(target: Locator): Promise<Box> {
	const box = await target.boundingBox();
	if (!box) throw new Error(`no layout box for ${target}`);
	return box;
}

/** sRGB, 0–255 per channel. */
export interface Rgb {
	r: number;
	g: number;
	b: number;
}

const channel = (c: number) => {
	const s = c / 255;
	return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = ({ r, g, b }: Rgb) => 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);

/** WCAG 2 contrast ratio (1–21) between two opaque colors. */
export function contrast(a: Rgb, b: Rgb): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

/** A color to measure: the element's text, its `::placeholder` text, or the first color of its box-shadow. */
type Source = "color" | "placeholder" | "shadow";

/**
 * Contrast of the control's text / placeholder / box-shadow color against what is behind it. The browser resolves any
 * CSS color syntax (rgb, color-mix, oklab…) through a canvas; translucent layers are composited down the ancestor
 * chain, over white.
 */
export async function contrastOf(target: Locator, source: Source): Promise<number> {
	const { fg, bg } = await target.evaluate((el, src) => {
		const ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
		if (!ctx) throw new Error("no 2d canvas");
		/** [r, g, b, alpha 0–1] of any CSS color string. */
		const parse = (css: string): number[] => {
			ctx.clearRect(0, 0, 1, 1);
			ctx.fillStyle = "#000";
			ctx.fillStyle = css;
			ctx.fillRect(0, 0, 1, 1);
			const d = ctx.getImageData(0, 0, 1, 1).data;
			return [d[0], d[1], d[2], d[3] / 255];
		};
		const over = (top: number[], under: number[]): number[] => {
			const a = top[3];
			return [top[0] * a + under[0] * (1 - a), top[1] * a + under[1] * (1 - a), top[2] * a + under[2] * (1 - a), 1];
		};
		const chain: Element[] = [];
		for (let e: Element | null = el; e; e = e.parentElement) chain.push(e);
		let bgColor = [255, 255, 255, 1];
		for (const e of chain.reverse()) bgColor = over(parse(getComputedStyle(e).backgroundColor), bgColor);

		const style = getComputedStyle(el, src === "placeholder" ? "::placeholder" : null);
		let css = style.color;
		if (src === "shadow") {
			const m = /(rgba?\([^)]*\)|color\([^)]*\)|ok[a-z]+\([^)]*\)|#[0-9a-f]{3,8})/i.exec(style.boxShadow);
			if (!m) throw new Error(`no color in box-shadow "${style.boxShadow}"`);
			css = m[1];
		}
		const text = parse(css);
		// Placeholders can be dimmed with `opacity` instead of a translucent color.
		if (src === "placeholder") text[3] *= Number(style.opacity);
		const fgColor = over(text, bgColor);
		return {
			fg: { r: fgColor[0], g: fgColor[1], b: fgColor[2] },
			bg: { r: bgColor[0], g: bgColor[1], b: bgColor[2] },
		};
	}, source);
	return contrast(fg, bg);
}

/** `focus()` takes `focusVisible` (forces :focus-visible), which the DOM typings do not list yet. */
interface VisibleFocus extends FocusOptions {
	focusVisible?: boolean;
}

/**
 * What shows that `target` has keyboard focus: its own outline, or a changed border or shadow on it or on one of the
 * three ancestors above it (a card around a field, a label around a select). `null` when nothing changes. Transitions
 * are switched off first, otherwise a just-started one still reads as the old value.
 */
export async function focusCue(page: Page, target: Locator): Promise<string | null> {
	await page.addStyleTag({ content: "*,*::before,*::after{transition:none!important;animation:none!important}" });
	return target.evaluate((el: HTMLElement) => {
		const read = (e: Element) => {
			const s = getComputedStyle(e);
			const outline =
				s.outlineStyle !== "none" && Number.parseFloat(s.outlineWidth) > 0 && !/, 0\)$/.test(s.outlineColor);
			const sig = [
				s.borderTopColor,
				s.borderRightColor,
				s.borderBottomColor,
				s.borderLeftColor,
				s.boxShadow,
				s.outlineStyle,
				s.outlineColor,
			];
			return { outline, sig: sig.join("|") };
		};
		const chain: Element[] = [];
		for (let e: Element | null = el, i = 0; e && i < 4; e = e.parentElement, i++) chain.push(e);
		if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
		const before = chain.map(read);
		const options: VisibleFocus = { focusVisible: true };
		el.focus(options);
		if (document.activeElement !== el) return "NOT FOCUSABLE";
		const after = chain.map(read);
		if (after[0].outline) return "own outline";
		for (let i = 0; i < chain.length; i++)
			if (before[i].sig !== after[i].sig) return i === 0 ? "own border/shadow" : `ancestor ${i} border/shadow/outline`;
		return null;
	});
}
