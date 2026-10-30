import { expect, test } from "bun:test";
import { DEFAULT_PALETTE, isPalette, PALETTES } from "../../web/src/lib/theme.ts";
import {
	ANSI_TOKENS,
	backgroundsFor,
	CHART_TOKENS,
	CODE_TOKENS,
	COLOUR_TOKENS,
	colour,
	contrast,
	effective,
	hueLightness,
	readPalettes,
	resolve,
	SHAPE_TOKENS,
} from "../support/palettes.ts";

/**
 * Palettes (web/src/palettes.css): every palette is complete in both modes, the list the app offers is the list the
 * stylesheet defines, Claude is still the look the app always had, and every text colour is readable (WCAG AA, 4.5:1)
 * on every surface and tint it is drawn on. No browser: the E2E palette spec looks at the rendered result.
 */

const palettes = readPalettes();
const MODES = [
	["light", false],
	["dark", true],
] as const;

test("the palettes the app offers are the ones the stylesheet defines", () => {
	expect(Object.keys(palettes).sort()).toEqual([...PALETTES].sort());
	expect(isPalette(DEFAULT_PALETTE)).toBe(true);
	expect(DEFAULT_PALETTE).toBe("claude");
	for (const bad of [null, undefined, "", "Claude", "solarized", 3]) expect(isPalette(bad), String(bad)).toBe(false);
});

test("each palette defines every colour and code colour in light and in dark, and its shape once", () => {
	for (const [id, modes] of Object.entries(palettes)) {
		for (const [mode, tokens] of [
			["light", modes.light],
			["dark", modes.dark],
		] as const) {
			// Claude's dark `link` is the accent: written once in its light block, which also applies in dark.
			const need = [...COLOUR_TOKENS, ...CODE_TOKENS, ...CHART_TOKENS, ...ANSI_TOKENS].filter(
				(t) => !(id === "claude" && mode === "dark" && t === "link"),
			);
			expect(
				need.filter((t) => !(t in tokens)),
				`${id} ${mode} lacks`,
			).toEqual([]);
		}
		const known: readonly string[] = [
			...COLOUR_TOKENS,
			...CODE_TOKENS,
			...CHART_TOKENS,
			...ANSI_TOKENS,
			...SHAPE_TOKENS,
			"color-scheme",
		];
		for (const mode of ["light", "dark"] as const)
			expect(
				Object.keys(modes[mode]).filter((t) => !known.includes(t)),
				`${id} ${mode} has`,
			).toEqual([]);
		expect(modes.light["color-scheme"]).toBe("light");
		expect(modes.dark["color-scheme"]).toBe("dark");
	}
});

test("Claude is the look the app had: same surfaces and ink, accent and status colours only nudged for contrast", () => {
	const was = {
		light: {
			bg: "#faf9f5",
			"bg-soft": "#f3f1ea",
			surface: "#ffffff",
			hover: "#ecebe4",
			border: "#e3e1d7",
			fg: "#1f1e1b",
			"code-bg": "#f3f1ea",
			"user-bubble": "#efede4",
		},
		dark: {
			bg: "#1a1918",
			"bg-soft": "#201f1d",
			surface: "#262522",
			hover: "#2f2e2b",
			border: "#363531",
			fg: "#ecebe6",
			"code-bg": "#141413",
			"user-bubble": "#2c2b28",
		},
	};
	const hues = {
		light: {
			accent: "#ad4b2c",
			success: "#23703d",
			warning: "#855510",
			danger: "#b03224",
			muted: "#5c5b55",
			faint: "#6b6a64",
		},
		dark: {
			accent: "#e07a55",
			success: "#5bbf7c",
			warning: "#e0b04f",
			danger: "#ef6b5b",
			muted: "#b4b2aa",
			faint: "#9a988f",
		},
	};
	for (const [mode, dark] of MODES) {
		const tokens = effective(palettes.claude, dark);
		for (const [name, value] of Object.entries(was[mode])) expect(resolve(tokens, name), `${mode} ${name}`).toBe(value);
		for (const [name, value] of Object.entries(hues[mode])) {
			const now = hueLightness(colour(tokens, name));
			const before = hueLightness(colour({ x: value }, "x"));
			const dHue = Math.min(Math.abs(now.hue - before.hue), 360 - Math.abs(now.hue - before.hue));
			// A warm grey (muted, faint) has no hue to speak of; it only has to stay as light as it was, within a step.
			if (name !== "muted" && name !== "faint") expect(dHue, `${mode} ${name} hue`).toBeLessThan(8);
			expect(Math.abs(now.light - before.light), `${mode} ${name} lightness`).toBeLessThan(0.1);
		}
	}
});

for (const [id, modes] of Object.entries(palettes)) {
	for (const [mode, dark] of MODES) {
		test(`${id} ${mode}: text is at least 4.5:1 on every surface and tint it sits on`, () => {
			const tokens = effective(modes, dark);
			const low: string[] = [];
			for (const text of ["fg", "muted", "faint", "accent", "success", "warning", "danger", "link"]) {
				for (const [where, bg] of Object.entries(backgroundsFor(tokens, text))) {
					const ratio = contrast(colour(tokens, text), bg);
					if (ratio < 4.5) low.push(`${text} on ${where}: ${ratio.toFixed(2)}`);
				}
			}
			expect(low).toEqual([]);
		});

		test(`${id} ${mode}: labels on the accent and danger fills, the accent bar and the code colours hold`, () => {
			const tokens = effective(modes, dark);
			const low: string[] = [];
			const on = (label: string, fg: string, bg: string, min: number) => {
				const ratio = contrast(colour(tokens, fg), colour(tokens, bg));
				if (ratio < min) low.push(`${label}: ${ratio.toFixed(2)} < ${min}`);
			};
			// Primary buttons print `accent-fg` on `accent`, danger ones on `danger`.
			on("accent-fg on accent", "accent-fg", "accent", 4.5);
			on("accent-fg on danger", "accent-fg", "danger", 4.5);
			// The bar that marks the current or highlighted row (3:1, the bar against the row).
			for (const row of ["hover", "bg-soft", "surface"]) on(`accent bar on ${row}`, "accent", row, 3);
			for (const code of CODE_TOKENS) on(`${code} on code-bg`, code, "code-bg", 4.5);
			expect(low).toEqual([]);
		});

		test(`${id} ${mode}: the eight chart colours are 3:1 on every surface the chart is drawn on, and all different`, () => {
			const tokens = effective(modes, dark);
			const low: string[] = [];
			// The usage chart is a card on the surface; the bar under the pointer is lit by `hover`, the page and sidebar
			// are what a chart colour is compared with in the tooltip's swatch and the legend.
			for (const series of CHART_TOKENS)
				for (const surface of ["surface", "hover", "bg", "bg-soft"]) {
					const ratio = contrast(colour(tokens, series), colour(tokens, surface));
					if (ratio < 3) low.push(`${series} on ${surface}: ${ratio.toFixed(2)}`);
				}
			expect(low).toEqual([]);
			const values = CHART_TOKENS.map((series) => resolve(tokens, series).toLowerCase());
			expect(new Set(values).size, values.join(" ")).toBe(CHART_TOKENS.length);
		});

		test(`${id} ${mode}: the sixteen ANSI colours are 4.5:1 on the terminal's background, and all different`, () => {
			const tokens = effective(modes, dark);
			const low: string[] = [];
			for (const ansi of ANSI_TOKENS) {
				const ratio = contrast(colour(tokens, ansi), colour(tokens, "code-bg"));
				if (ratio < 4.5) low.push(`${ansi} on code-bg: ${ratio.toFixed(2)}`);
			}
			expect(low).toEqual([]);
			const values = ANSI_TOKENS.map((ansi) => resolve(tokens, ansi).toLowerCase());
			expect(new Set(values).size, values.join(" ")).toBe(ANSI_TOKENS.length);
		});
	}
}
