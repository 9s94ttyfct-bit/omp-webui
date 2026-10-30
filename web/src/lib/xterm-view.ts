import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { terminalLinkHandler } from "./terminal-links.ts";
import { followTerminalTheme, terminalTheme } from "./terminal-theme.ts";

/**
 * An xterm.js screen in `el`, as every terminal of the app draws one: the page's monospace font on its caption step, the
 * palette's colours (followed when they change), links that open in the browser, and the screen fitted to `el` whenever it
 * is resized (`onResize` is told the new size). `stop` takes it all down.
 */
export function makeXterm(
	el: HTMLElement,
	onResize: (cols: number, rows: number) => void,
): { term: XTerm; stop: () => void } {
	const styles = getComputedStyle(document.documentElement);
	const term = new XTerm({
		fontFamily: styles.getPropertyValue("--font-mono") || "ui-monospace, Menlo, monospace",
		// The type scale's caption step: the terminal is on the same scale as the page around it.
		fontSize: 12,
		cursorBlink: true,
		convertEol: false,
		theme: terminalTheme(),
		// Links the output prints open in the browser, in the macOS app as well (see `terminal-links.ts`).
		linkHandler: terminalLinkHandler({
			ask: (message) => confirm(message),
			open: (url) => void window.open(url, "_blank", "noopener,noreferrer"),
		}),
	});
	const fit = new FitAddon();
	term.loadAddon(fit);
	term.open(el);
	fit.fit();
	const ro = new ResizeObserver(() => {
		// A screen that is not drawn (its tab hidden) has no size to fit to.
		if (el.clientWidth === 0 || el.clientHeight === 0) return;
		fit.fit();
		onResize(term.cols, term.rows);
	});
	ro.observe(el);
	// A new palette, or the OS switching between light and dark under the System theme, recolours the screen as it is.
	const stopTheme = followTerminalTheme((theme) => {
		term.options.theme = theme;
	});
	return {
		term,
		stop: () => {
			ro.disconnect();
			stopTheme();
			term.dispose();
		},
	};
}

/** The whole scrollback as plain text (the DOM only holds the visible rows). */
export function bufferText(term: XTerm): string {
	const buf = term.buffer.active;
	const lines: string[] = [];
	for (let i = 0; i < buf.length; i++) {
		const line = buf.getLine(i);
		if (!line) continue;
		if (line.isWrapped && lines.length) lines[lines.length - 1] += line.translateToString(true);
		else lines.push(line.translateToString(true));
	}
	return lines.join("\n").replace(/\s+$/, "\n");
}
