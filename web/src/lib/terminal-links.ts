import type { ILinkHandler } from "@xterm/xterm";
import "../i18n/later.ts";
import { t } from "../i18n/index.ts";
import { webUrl } from "./web-url.ts";

/**
 * What a hyperlink in the terminal's output (OSC 8: `ESC ] 8 ;; url ST text ESC ] 8 ;; ST`, which omp's own output uses)
 * does when it is clicked. xterm's default asks, then calls `window.open()` with no address and sets the new window's
 * location. The macOS app hands a new window to the system's browser by the address it is opened with (`externalURL`),
 * and a blank one has none: the link did nothing there, after the question. The address is given to `open` here instead.
 *
 * The text a link shows is whatever the program wrote and can name a different address than the one it goes to, so the
 * person is asked, with the address, before anything opens. Only `http:` and `https:` links ever get this far (xterm
 * passes no other scheme on while `allowNonHttpProtocols` is off), and it is checked again here.
 */
export interface LinkEnvironment {
	/** Ask the person; true when they agree. */
	ask(message: string): boolean;
	/** Open `url` in a window of its own, as a link with `target=_blank rel=noopener` does. */
	open(url: string): void;
}

export function terminalLinkHandler(env: LinkEnvironment): ILinkHandler {
	return {
		allowNonHttpProtocols: false,
		activate(_event, text) {
			const url = webUrl(text);
			if (url !== null && env.ask(t("pages.termOpenLink", { url }))) env.open(url);
		},
	};
}
