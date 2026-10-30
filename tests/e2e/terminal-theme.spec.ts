import AxeBuilder from "@axe-core/playwright";
import { ANSI_TOKENS, colour, effective, readPalettes } from "../support/palettes.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The built-in terminal (Commands › Run) is drawn in the palette and mode on screen, and follows them: the OS going
 * dark under the System theme and a new palette on <html> both recolour a terminal that is already open — its
 * background, its ink and its sixteen ANSI colours (`--ansi-*` of the palette). The terminal runs `omp --version` in a
 * PTY (no model call); what is read is the colour xterm.js really draws with: the background of its screen, the ink of
 * its rows, and the colour each `xterm-fg-N` class gives text.
 */

const palettes = readPalettes();
const rgb = ({ r, g, b }: { r: number; g: number; b: number }) => `rgb(${r}, ${g}, ${b})`;

/** What the terminal paints with now: its background, its ink, and the colour of ANSI 0–15. */
async function painted(page: Page) {
	return page.evaluate(() => {
		const root = document.querySelector('[data-testid="terminal"]');
		const rows = root?.querySelector<HTMLElement>(".xterm-rows");
		const screen = root?.querySelector<HTMLElement>(".xterm-scrollable-element");
		if (!rows || !screen) throw new Error("no terminal on the page");
		const ansi = Array.from({ length: 16 }, (_, i) => {
			const probe = document.createElement("span");
			probe.className = `xterm-fg-${i}`;
			rows.append(probe);
			const color = getComputedStyle(probe).color;
			probe.remove();
			return color;
		});
		return { background: getComputedStyle(screen).backgroundColor, foreground: getComputedStyle(rows).color, ansi };
	});
}

/** What the terminal has to paint with in `palette` and `mode`, from the stylesheet. */
function expected(palette: string, mode: "light" | "dark") {
	const tokens = effective(palettes[palette], mode === "dark");
	return {
		background: rgb(colour(tokens, "code-bg")),
		foreground: rgb(colour(tokens, "fg")),
		ansi: ANSI_TOKENS.map((name) => rgb(colour(tokens, name))),
	};
}

async function openTerminal(page: Page) {
	await page.goto("/#/cli");
	await page.getByTestId("cli-line").fill("--version");
	await page.getByTestId("cli-run").click();
	await expect(page.getByTestId("terminal-status")).toHaveText(/exited 0/, { timeout: 30_000 });
}

test("under the System theme the terminal follows the OS going dark and light again, ANSI colours included", async ({
	page,
}) => {
	await page.addInitScript(() => localStorage.setItem("ompw.theme", "system"));
	await page.emulateMedia({ colorScheme: "light" });
	await openTerminal(page);
	expect(await painted(page)).toEqual(expected("claude", "light"));

	await page.emulateMedia({ colorScheme: "dark" });
	await expect.poll(() => painted(page)).toEqual(expected("claude", "dark"));

	await page.emulateMedia({ colorScheme: "light" });
	await expect.poll(() => painted(page)).toEqual(expected("claude", "light"));
});

test("a palette chosen while the terminal is open recolours it, in light and in dark", async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("ompw.theme", "light"));
	await openTerminal(page);
	expect(await painted(page)).toEqual(expected("claude", "light"));

	// What the palette chooser does to <html>: `data-palette` (lib/theme.ts paintPalette).
	for (const palette of ["chatgpt", "terminal", "omp", "hermes"]) {
		await page.evaluate((id) => {
			document.documentElement.dataset.palette = id;
		}, palette);
		await expect.poll(() => painted(page), palette).toEqual(expected(palette, "light"));
	}
	// And the mode chooser: the `dark` class.
	await page.evaluate(() => document.documentElement.classList.add("dark"));
	await expect.poll(() => painted(page)).toEqual(expected("hermes", "dark"));
});

test("the terminal's own end line is readable (4.5:1) in every palette, light and dark", async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("ompw.theme", "light"));
	await openTerminal(page);
	const low: string[] = [];
	for (const palette of Object.keys(palettes)) {
		for (const dark of [false, true]) {
			await page.evaluate(
				([id, on]) => {
					document.documentElement.dataset.palette = id as string;
					document.documentElement.classList.toggle("dark", on as boolean);
				},
				[palette, dark],
			);
			await page.waitForTimeout(100);
			// The line the app writes when the process ends ("[process exited with code 0]"); dim, it was about 3:1.
			const { violations } = await new AxeBuilder({ page })
				.include('[data-testid="terminal"] .xterm-rows')
				.withRules(["color-contrast"])
				.analyze();
			for (const v of violations) for (const n of v.nodes) low.push(`${palette} ${dark ? "dark" : "light"}: ${n.html}`);
		}
	}
	expect(low).toEqual([]);
});
