import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_PALETTE, isPalette, PALETTES } from "../../web/src/lib/theme.ts";
import {
	ANSI_TOKENS,
	backgroundsFor,
	blend,
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

/**
 * What the Changes view's diff rows (web/src/components/changes/DiffBody.tsx) draw their line numbers and the mark of a
 * clipped row in, the tints of an added and a removed row, and the box they are tinted over (`bg-code`), read from the
 * component itself; and how much of a token's colour a changed row keeps (web/src/index.css, `--diff-token`), with the
 * tokens it is written for. axe reports text over a translucent background as "incomplete", not as a violation, so this is
 * what holds them to 4.5:1 (audits A-013, A-032).
 */
function diffRowColours(): {
	texts: Record<string, string>;
	tints: { token: string; alpha: number }[];
	box: string;
	tokenShare: number;
	mixedTokens: string[];
} {
	const src = readFileSync(join(import.meta.dir, "../../web/src/components/changes/DiffBody.tsx"), "utf8");
	const num = /const NUM = "[^"]*\btext-([a-z-]+)/.exec(src)?.[1];
	const clipped = /className="text-([a-z-]+)" title=\{t\("files\.rowClipped"\)\}/.exec(src)?.[1];
	const tint = /const TINT = \{ add: "bg-([a-z-]+)\/(\d+)", del: "bg-([a-z-]+)\/(\d+)"/.exec(src);
	const box = /className="overflow-x-auto bg-([a-z-]+) /.exec(src)?.[1];
	const css = readFileSync(join(import.meta.dir, "../../web/src/index.css"), "utf8");
	const share = /color: color-mix\(in srgb, var\(--diff-token\) (\d+)%, var\(--fg\)\) !important;/.exec(css)?.[1];
	if (!num || !clipped || !tint || !box || !share)
		throw new Error(
			"DiffBody.tsx or index.css no longer has what this test reads (NUM, TINT, the clipped mark, the box, the mix)",
		);
	return {
		texts: { "line number": num, "clipped mark": clipped },
		tints: [
			{ token: tint[1] as string, alpha: Number(tint[2]) / 100 },
			{ token: tint[3] as string, alpha: Number(tint[4]) / 100 },
		],
		box: box === "code" ? "code-bg" : box,
		tokenShare: Number(share) / 100,
		mixedTokens: [...css.matchAll(/span\[style\*="var\(--([a-z-]+)\)"\] \{\n\t--diff-token: var\(--\1\);/g)].map(
			(m) => m[1] as string,
		),
	};
}
const diffRows = diffRowColours();

test("a changed diff row mixes every code colour the highlighter writes", () => {
	expect([...diffRows.mixedTokens].sort()).toEqual([...CODE_TOKENS].sort());
});

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

		test(`${id} ${mode}: a diff row's line numbers are 4.5:1 on its tint, over every surface the diff is drawn on`, () => {
			const tokens = effective(modes, dark);
			const low: string[] = [];
			// The rows' own box (`bg-code`), and the surfaces around it: the panel (`bg-soft`), the editor and the large view.
			for (const [what, text] of Object.entries(diffRows.texts))
				for (const { token, alpha } of diffRows.tints)
					for (const base of [diffRows.box, "bg", "bg-soft", "surface"]) {
						const under = blend(colour(tokens, token), alpha, colour(tokens, base));
						const ratio = contrast(colour(tokens, text), under);
						if (ratio < 4.5)
							low.push(`${what} (${text}) on ${token} ${alpha * 100}% over ${base}: ${ratio.toFixed(2)}`);
					}
			expect(low).toEqual([]);
		});

		test(`${id} ${mode}: a changed diff row's code colours, mixed toward the text colour, are 4.5:1 on its tint (A-032)`, () => {
			const tokens = effective(modes, dark);
			const low: string[] = [];
			for (const code of CODE_TOKENS)
				for (const { token, alpha } of diffRows.tints) {
					const mixed = blend(colour(tokens, code), diffRows.tokenShare, colour(tokens, "fg"));
					const under = blend(colour(tokens, token), alpha, colour(tokens, diffRows.box));
					const ratio = contrast(mixed, under);
					if (ratio < 4.5) low.push(`${code} on ${token} ${alpha * 100}% over ${diffRows.box}: ${ratio.toFixed(2)}`);
				}
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
