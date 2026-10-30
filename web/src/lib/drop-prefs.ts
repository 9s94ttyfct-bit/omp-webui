import {
	type DropAction,
	type DropChoices,
	type DropKind,
	parseChoices,
	serializeChoices,
} from "@shared/attachment.ts";
import { PREF, type PrefKey } from "@shared/prefs.ts";
import { setPref } from "./prefs.ts";
import { inShell } from "./shell-notify.ts";

/**
 * The preference the remembered choices are kept in here: the macOS app's own, or the browser's. "Insert path" is the real
 * path in the app and a copy sent to the server in a browser, so what was remembered in one is never used in the other (a
 * phone that opens the app's server would otherwise upload files after a choice made on the Mac, where nothing was sent).
 */
export const choicesKey = (): PrefKey => (inShell() ? PREF.dropChoicesApp : PREF.dropChoicesPage);

/** What the person asked to be remembered about dropped files, by kind (Settings › Dropped files undoes it). */
export const readChoices = (): DropChoices => parseChoices(localStorage.getItem(choicesKey()));

/** Remember `add` on top of what is remembered, for this kind of page (`choicesKey`). */
export function rememberChoices(add: DropChoices): void {
	if (Object.keys(add).length) setPref(choicesKey(), serializeChoices({ ...readChoices(), ...add }));
}

/** Remember `action` for `kind`, or forget it (null: ask each time). */
export function setChoice(kind: DropKind, action: DropAction | null): void {
	const next = { ...readChoices() };
	if (action === null) delete next[kind];
	else next[kind] = action;
	setPref(choicesKey(), serializeChoices(next));
}
