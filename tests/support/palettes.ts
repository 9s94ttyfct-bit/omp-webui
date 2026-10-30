import { readFileSync } from "node:fs";
import { contrast, type Rgb } from "./style.ts";

/**
 * web/src/palettes.css as data, for the specs that hold the palettes to their promises: what each palette defines in
 * each mode, resolved the way the cascade does (a `.dark` block over its light block, `var(--x)` followed), and the
 * colour arithmetic WCAG asks for. The stylesheet is the only source; nothing here restates a colour.
 */

export type Tokens = Record<string, string>;
export interface PaletteModes {
	/** The palette's light block exactly as written, shape tokens (fonts, radii) included. */
	light: Tokens;
	/** The palette's dark block exactly as written: colours only. */
	dark: Tokens;
}

const CSS = new URL("../../web/src/palettes.css", import.meta.url);

/** Every palette in palettes.css by id; Claude's light block is `:root` and its dark block `.dark`. */
export function readPalettes(): Record<string, PaletteModes> {
	const css = readFileSync(CSS, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
	const found: Record<string, Partial<PaletteModes>> = {};
	for (const [, selectors, body] of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
		const tokens: Tokens = {};
		for (const [, custom, property, value] of body.matchAll(/(?:--([\w-]+)|(color-scheme)):\s*([^;]+);/g))
			tokens[custom ?? property] = value.replace(/\s+/g, " ").trim();
		for (const selector of selectors.split(",").map((s) => s.trim())) {
			const m = /^(?::root|\.dark|\[data-palette="(\w+)"\](\.dark)?)$/.exec(selector);
			if (!m) throw new Error(`palettes.css: unexpected selector ${selector}`);
			const id = m[1] ?? "claude";
			const dark = selector === ".dark" || m[2] === ".dark";
			// Claude's `:root` and `[data-palette="claude"]` are one block under two selectors: the same tokens twice.
			const modes = found[id] ?? {};
			found[id] = modes;
			modes[dark ? "dark" : "light"] = tokens;
		}
	}
	for (const [id, modes] of Object.entries(found))
		if (!modes.light || !modes.dark) throw new Error(`palette ${id} lacks a mode`);
	return found as Record<string, PaletteModes>;
}

/** The tokens in force for a palette in a mode: its light block, with the dark block over it in dark. */
export function effective(modes: PaletteModes, dark: boolean): Tokens {
	return dark ? { ...modes.light, ...modes.dark } : modes.light;
}

/** `--name`'s value with `var(--other)` references followed (the cascade resolves them on one element the same way). */
export function resolve(tokens: Tokens, name: string): string {
	let value = tokens[name];
	for (let hops = 0; value?.startsWith("var(--") && hops < 8; hops++) value = tokens[value.slice(6, -1)];
	if (value === undefined) throw new Error(`token --${name} is not defined`);
	return value;
}

export interface Rgba extends Rgb {
	a: number;
}

/** A #rgb, #rrggbb or #rrggbbaa colour. */
export function parseHex(hex: string): Rgba {
	let h = hex.trim().replace(/^#/, "");
	if (h.length === 3) h = [...h].map((c) => c + c).join("");
	if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(h)) throw new Error(`not a hex colour: ${hex}`);
	const n = (i: number) => Number.parseInt(h.slice(i, i + 2), 16);
	return { r: n(0), g: n(2), b: n(4), a: h.length === 8 ? n(6) / 255 : 1 };
}

/** The colour token `name` of a palette in a mode, as RGB (alpha 1 unless the token has one). */
export function colour(tokens: Tokens, name: string): Rgba {
	return parseHex(resolve(tokens, name));
}

/** `top` at `alpha` over the opaque `under`. */
export function blend(top: Rgb, alpha: number, under: Rgb): Rgb {
	const mix = (a: number, b: number) => a * alpha + b * (1 - alpha);
	return { r: mix(top.r, under.r), g: mix(top.g, under.g), b: mix(top.b, under.b) };
}

export const hex = ({ r, g, b }: Rgb) =>
	`#${[r, g, b].map((v) => Math.round(v).toString(16).padStart(2, "0")).join("")}`;

/** Hue (degrees) and lightness (0–1) of a colour, to tell a nudge from a different colour. */
export function hueLightness({ r, g, b }: Rgb): { hue: number; light: number } {
	const [R, G, B] = [r / 255, g / 255, b / 255];
	const max = Math.max(R, G, B);
	const min = Math.min(R, G, B);
	const d = max - min;
	let hue = 0;
	if (d > 0) {
		if (max === R) hue = ((G - B) / d) % 6;
		else if (max === G) hue = (B - R) / d + 2;
		else hue = (R - G) / d + 4;
	}
	return { hue: (hue * 60 + 360) % 360, light: (max + min) / 2 };
}

export { contrast };

/** The colours that must exist in both modes of a palette (palettes.css documents them). */
export const COLOUR_TOKENS = [
	"bg",
	"bg-soft",
	"surface",
	"hover",
	"border",
	"fg",
	"muted",
	"faint",
	"accent",
	"accent-soft",
	"accent-fg",
	"success",
	"warning",
	"danger",
	"code-bg",
	"user-bubble",
	"link",
] as const;

export const CODE_TOKENS = [
	"foreground",
	"token-comment",
	"token-keyword",
	"token-string",
	"token-string-expression",
	"token-constant",
	"token-function",
	"token-parameter",
	"token-punctuation",
	"token-link",
	"token-inserted",
	"token-deleted",
	"token-changed",
].map((t) => `shiki-${t}`);

/** The usage chart's eight series colours. */
export const CHART_TOKENS = Array.from({ length: 8 }, (_, i) => `chart-${i + 1}`);

/** The built-in terminal's sixteen ANSI colours: the eight, then their bright twins. */
const ANSI_NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
export const ANSI_TOKENS = [...ANSI_NAMES.map((n) => `ansi-${n}`), ...ANSI_NAMES.map((n) => `ansi-bright-${n}`)];

/** What a palette sets once, in its light block, for both modes: the focus ring, the faces and the corners. */
export const SHAPE_TOKENS = [
	"ring",
	"font-ui",
	"font-display",
	"radius-xs",
	"radius-sm",
	"radius-md",
	"radius-lg",
	"radius-xl",
	"radius-2xl",
	"radius-3xl",
	"radius-4xl",
	"radius-pill",
];

/**
 * The backgrounds a text colour has to hold on, by name. Text sits on the six solid surfaces and on the translucent
 * tints the app lays over them: the accent tint of a selected row, the 10 % and 15 % tints of status cards and badges
 * (a badge sits on its card, so one tint over another counts too).
 */
export function backgroundsFor(tokens: Tokens, text: string): Record<string, Rgb> {
	const solids = ["bg", "bg-soft", "surface", "hover", "code-bg", "user-bubble"] as const;
	const solid = (name: string) => colour(tokens, name);
	const out: Record<string, Rgb> = {};
	for (const name of solids) out[name] = solid(name);
	const tint = (token: string, alpha: number, under: Rgb) => blend(solid(token), alpha, under);
	const bases = ["bg", "bg-soft", "surface"] as const;
	if (["fg", "muted", "faint", "accent", "link"].includes(text)) {
		const alpha = colour(tokens, "accent-soft").a;
		for (const b of bases) out[`accent-soft over ${b}`] = tint("accent", alpha, solid(b));
		for (const status of ["danger", "warning"])
			for (const b of ["bg", "bg-soft"] as const) out[`${status} 10% over ${b}`] = tint(status, 0.1, solid(b));
	}
	if (text === "accent") out["accent 10% over bg"] = tint("accent", 0.1, solid("bg"));
	if (["success", "warning", "danger"].includes(text)) {
		for (const b of bases) {
			out[`${text} 10% over ${b}`] = tint(text, 0.1, solid(b));
			out[`${text} 15% over ${b}`] = tint(text, 0.15, solid(b));
		}
		out[`${text} 15% over ${text} 10% over bg`] = tint(text, 0.15, tint(text, 0.1, solid("bg")));
		for (const card of ["danger", "warning"])
			out[`${text} 15% over ${card} 10% over bg`] = tint(text, 0.15, tint(card, 0.1, solid("bg")));
	}
	return out;
}
