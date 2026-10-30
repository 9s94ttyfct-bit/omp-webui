import type { ITheme } from "@xterm/xterm";

const ANSI = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"] as const;

/** `colour` (any CSS colour the stylesheet wrote) at `alpha`, as the #rrggbbaa xterm.js reads; undefined when it is not one. */
function translucent(colour: string, alpha: number): string | undefined {
	const ctx = document.createElement("canvas").getContext("2d");
	if (!ctx || !colour) return undefined;
	ctx.fillStyle = colour;
	// An opaque colour reads back as #rrggbb whatever way it was written (#fff, rgb(…), a name).
	const opaque = String(ctx.fillStyle);
	if (!/^#[0-9a-f]{6}$/i.test(opaque)) return undefined;
	return `${opaque}${Math.round(alpha * 255)
		.toString(16)
		.padStart(2, "0")}`;
}

/**
 * The built-in terminal's colours in the palette and mode on screen now: the code background and ink, the accent for
 * the cursor and the selection, and the palette's own sixteen ANSI colours (`--ansi-*` in palettes.css, each readable on
 * the code background). Read from the stylesheet when asked, so it is whatever <html data-palette class="dark"> says.
 */
export function terminalTheme(root: Element = document.documentElement): ITheme {
	const styles = getComputedStyle(root);
	const read = (name: string) => styles.getPropertyValue(`--${name}`).trim() || undefined;
	const accent = read("accent") ?? "";
	const selection = translucent(accent, 0.35);
	const theme: ITheme = {
		background: read("code-bg"),
		foreground: read("fg"),
		cursor: read("accent"),
		cursorAccent: read("code-bg"),
		selectionBackground: selection,
		selectionInactiveBackground: selection,
	};
	for (const name of ANSI) {
		const cap = `${name[0].toUpperCase()}${name.slice(1)}` as Capitalize<typeof name>;
		theme[name] = read(`ansi-${name}`);
		theme[`bright${cap}`] = read(`ansi-bright-${name}`);
	}
	return theme;
}

/**
 * Calls `apply` with the terminal's colours whenever <html>'s palette or light/dark class changes (the chooser in
 * Settings, or the OS appearance while the theme is System). Returns the function that stops it.
 */
export function followTerminalTheme(apply: (theme: ITheme) => void): () => void {
	const observer = new MutationObserver(() => apply(terminalTheme()));
	observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-palette"] });
	return () => observer.disconnect();
}
