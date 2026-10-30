/**
 * The type scale is three steps and no others: caption 12px (the floor), body 14px and title 15px. The page says so
 * in one place (the `--text-*` theme tokens in `web/src/index.css`), and this fails for a size that is not one of
 * them: a one-off `text-[13px]` (or smaller) in the page's source, a `font-size` under the floor in the stylesheet, or
 * a step the stylesheet no longer defines.
 *
 * The sizes that are not the scale's own are the ones that end up looking like an accident: a 13px caption beside a
 * 12px one, a 10px key cap. Run after the page is changed: `bun scripts/check-type-scale.ts`.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..");

/** The three steps of the scale, in pixels. The caption is the floor: nothing is drawn smaller. */
export const SCALE = { caption: 12, body: 14, title: 15 } as const;

/** The theme tokens the scale is written in, and the size each one is. */
const TOKENS: Record<string, number> = {
	"--text-xs": SCALE.caption,
	"--text-sm": SCALE.body,
	"--text-title": SCALE.title,
};

/** The sizes of the scale, as a list to look a size up in. */
const ON_SCALE: number[] = Object.values(SCALE);

export interface Problem {
	/** `file:line`, for the message. */
	at: string;
	what: string;
}

/** The line a problem is on, counted from the start of the file. */
function lineOf(src: string, index: number): number {
	return src.slice(0, index).split("\n").length;
}

/** The off-scale sizes in one file's text, each with the line it is on. */
export function offScaleSizes(src: string, file: string): Problem[] {
	const problems: Problem[] = [];
	for (const match of src.matchAll(/\btext-\[(\d+(?:\.\d+)?)px\]/g)) {
		const px = Number.parseFloat(match[1]);
		// A size the scale has: the utility that names it (text-xs, text-sm) is the one to write, but an explicit
		// `text-[12px]` is the same size and is not an error. The title's one-offs (15px, and 16px for a touch
		// screen) are the scale's own too.
		if (ON_SCALE.includes(px as 12 | 14 | 15) || px === SCALE.title + 1) continue;
		problems.push({
			at: `${file}:${lineOf(src, match.index ?? 0)}`,
			what: `text-[${match[1]}px] is off the type scale: use text-xs (${SCALE.caption}px), text-sm (${SCALE.body}px) or text-title (${SCALE.title}px)`,
		});
	}
	// A size handed to a library that draws the text itself (the chart's ticks, the terminal's grid), not a class.
	for (const match of src.matchAll(/\bfontSize:\s*(\d+(?:\.\d+)?)/g)) {
		const px = Number.parseFloat(match[1]);
		if (ON_SCALE.includes(px as 12 | 14 | 15)) continue;
		problems.push({
			at: `${file}:${lineOf(src, match.index ?? 0)}`,
			what: `fontSize: ${match[1]} is off the type scale: use ${SCALE.caption}px, ${SCALE.body}px or ${SCALE.title}px`,
		});
	}
	return problems;
}

/**
 * The one size that is not a step of the scale: a text field on a touch screen is 16px, because iOS Safari zooms
 * into a field under 16px and never zooms back out. It is a platform rule, not a type size, and it is not one the
 * page chooses.
 */
const TOUCH_FIELD = 16;

/** The sizes the stylesheet writes that are not one of the scale's. */
export function offScaleStylesheet(css: string, file: string): Problem[] {
	const problems: Problem[] = [];
	for (const match of css.matchAll(/font-size:\s*(\d+(?:\.\d+)?)px/g)) {
		const px = Number.parseFloat(match[1]);
		if (!ON_SCALE.includes(px) && px !== TOUCH_FIELD) {
			problems.push({
				at: `${file}:${lineOf(css, match.index ?? 0)}`,
				what: `font-size: ${match[1]}px is off the type scale: use ${SCALE.caption}px, ${SCALE.body}px or ${SCALE.title}px`,
			});
		}
	}
	return problems;
}

/** The theme tokens the stylesheet must define, and the size each one is. */
export function missingTokens(css: string): Problem[] {
	const problems: Problem[] = [];
	for (const [token, px] of Object.entries(TOKENS)) {
		const found = new RegExp(`${token}:\\s*(\\d+(?:\\.\\d+)?)px`).exec(css);
		if (!found) {
			problems.push({ at: "web/src/index.css", what: `${token} (the ${px}px step) is not defined` });
		} else if (Number.parseFloat(found[1]) !== px) {
			problems.push({
				at: "web/src/index.css",
				what: `${token} is ${found[1]}px, not the ${px}px of the type scale`,
			});
		}
	}
	return problems;
}

/** Every file of the page's source, the dictionaries left out (they hold words, not sizes). */
function sourceFiles(): string[] {
	const files: string[] = [];
	const walk = (dir: string) => {
		for (const entry of readdirSync(join(ROOT, dir))) {
			if (entry === "i18n" || entry.startsWith(".")) continue;
			const path = join(dir, entry);
			if (statSync(join(ROOT, path)).isDirectory()) walk(path);
			else if (/\.(ts|tsx|css)$/.test(entry)) files.push(path);
		}
	};
	walk("web/src");
	return files.sort();
}

if (import.meta.main) {
	const problems: Problem[] = [];
	for (const file of sourceFiles()) {
		const src = readFileSync(join(ROOT, file), "utf8");
		if (file.endsWith(".css")) problems.push(...offScaleStylesheet(src, file));
		else problems.push(...offScaleSizes(src, file));
	}
	problems.push(...missingTokens(readFileSync(join(ROOT, "web/src/index.css"), "utf8")));
	if (problems.length > 0) {
		for (const p of problems) console.error(`${p.at}: ${p.what}`);
		console.error(
			`\nThe type scale is ${Object.entries(SCALE)
				.map(([name, px]) => `${name} ${px}px`)
				.join(", ")} (web/src/index.css). Use text-xs, text-sm or text-title.`,
		);
		process.exit(1);
	}
	console.log(
		`The type scale is ${Object.entries(SCALE)
			.map(([name, px]) => `${name} ${px}px`)
			.join(", ")}; no size off the scale.`,
	);
}
