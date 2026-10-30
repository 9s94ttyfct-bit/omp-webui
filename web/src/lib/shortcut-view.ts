import { useApp } from "../store/app.ts";
import { pageOfElement } from "./settings-pages.ts";

/** How long the page is given to open Settings and draw the card before the scroll gives up. */
const CARD_WAIT_MS = 4000;

/** The card Settings › Keyboard shortcuts draws; it arrives with a chunk of its own. */
const CARD = '[data-testid="shortcuts-settings"]';

/**
 * Open Settings at one card (`selector` names it). Settings and its cards are chunks of their own, so the card is looked
 * for while the page draws — an observer, not a timer alone, since the chunks arrive whenever they arrive — and the page
 * gives up after `CARD_WAIT_MS` (it is open by then, at its top; only the jump is missing). The card is on one of
 * Settings' pages (the others are there but hidden): that page is shown, then the card is brought into view.
 */
export function showSettingsCard(selector: string): void {
	const app = useApp.getState();
	// Settings opened here is one step in the history, whichever of its pages it then shows.
	const opened = app.view.kind !== "settings";
	if (opened) app.setView({ kind: "settings" });
	const reveal = () => {
		const card = document.querySelector(selector);
		if (!card) return false;
		const page = pageOfElement(card);
		const view = useApp.getState().view;
		if (page && !(view.kind === "settings" && view.page === page)) {
			// The page is shown on the next render; the observer sees its cards change and comes back here.
			const replace = opened || view.kind !== "settings" || !view.page;
			useApp.getState().setView({ kind: "settings", page }, { replace });
			return false;
		}
		if (!card.getClientRects().length) return false;
		card.scrollIntoView({ behavior: "auto", block: "start" });
		return true;
	};
	if (reveal()) return;
	const observer = new MutationObserver(() => {
		if (reveal()) observer.disconnect();
	});
	observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class"] });
	setTimeout(() => observer.disconnect(), CARD_WAIT_MS);
}

/** Open Settings at the Keyboard shortcuts card (#639): `?` and `/hotkeys` go here, so the list takes no room in the sidebar. */
export function showShortcutsSettings(): void {
	showSettingsCard(CARD);
}
