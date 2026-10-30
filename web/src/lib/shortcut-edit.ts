/**
 * Changing a keyboard shortcut (#661): what a key pressed in the recorder is, whether it may be bound to an action, which
 * action already has it, and the changes themselves. Only Settings › Keyboard shortcuts uses this, so it is in that card's
 * chunk; the bindings and the matching are `shortcuts.ts`, on the first page.
 */

import { SHORTCUTS, type ShortcutScope } from "./shortcut-list.ts";
import {
	bindingOf,
	type Chord,
	DEFAULT_CHORDS,
	eventKey,
	type KeyEventLike,
	parseChord,
	printable,
	QUICK_PROMPT_PREFIX,
	saveShortcutOverrides,
	shortcutOverrides,
} from "./shortcuts.ts";

/** Keys with a name of their own a binding may use; the rest are one character. */
export const NAMED_KEYS = new Set([
	"Enter",
	"Tab",
	"Escape",
	"Backspace",
	"Delete",
	"Space",
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"Home",
	"End",
	"PageUp",
	"PageDown",
	...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
]);

/** The one way a chord is written: modifiers in a fixed order, so equal chords are equal text. */
export function chordText(c: Chord): string {
	return [c.mod && "Mod", c.alt && "Alt", c.shift && "Shift", c.key].filter(Boolean).join("+");
}

/** Where a binding acts. A quick prompt's key works wherever a conversation is on screen, as a global key does. */
export type EditScope = ShortcutScope | "Quick prompts";

export interface Entry {
	id: string;
	scope: EditScope;
	/** A convention of the surface, not rebound (`SHORTCUTS[id].fixed`). */
	fixed: boolean;
	/** The chord bound now, or null for none. */
	chord: string | null;
}

/** Every binding: the app's, then one per quick prompt (with none until the person gives it one). */
export function shortcutEntries(promptIds: readonly string[] = []): Entry[] {
	const out: Entry[] = Object.entries(SHORTCUTS).map(([id, s]) => ({
		id,
		scope: s.scope,
		fixed: "fixed" in s && s.fixed === true,
		chord: bindingOf(id),
	}));
	for (const p of promptIds) {
		const id = QUICK_PROMPT_PREFIX + p;
		out.push({ id, scope: "Quick prompts", fixed: false, chord: bindingOf(id) });
	}
	return out;
}

/** Whether a key can do two things at once in these two places: the same surface, or one of them acting everywhere. */
export const overlaps = (a: EditScope, b: EditScope): boolean =>
	a === b || a === "Global" || b === "Global" || a === "Quick prompts" || b === "Quick prompts";

/**
 * Keys the browser or macOS takes before the page sees them, or that are the text field's own (copy, paste, undo): a
 * binding may use one, but is told it may never fire, or that it takes that key from where it is.
 */
export const RESERVED = new Set([
	"Mod+W",
	"Mod+Q",
	"Mod+T",
	"Mod+N",
	"Mod+L",
	"Mod+R",
	"Mod+H",
	"Mod+M",
	"Mod+Z",
	"Mod+X",
	"Mod+C",
	"Mod+V",
	"Mod+A",
	"Mod+0",
	"Mod+=",
	"Mod+-",
	"Mod+Tab",
	"Mod+Space",
	"Mod+Alt+H",
	"Mod+Shift+T",
	"Mod+Shift+N",
	"Mod+Shift+Z",
	"Mod+Shift+Tab",
]);

const MODIFIER_KEYS = new Set([
	"Shift",
	"Control",
	"Meta",
	"Alt",
	"AltGraph",
	"CapsLock",
	"Fn",
	"OS",
	"Hyper",
	"Super",
]);

export type Recorded =
	| { chord: string }
	/** A modifier alone (wait for the key), an input method composing, or a key no binding can name. */
	| { error: "modifierOnly" | "composing" | "unsupported" };

/** The chord a key pressed in the recorder makes. */
export function chordFromEvent(e: KeyEventLike): Recorded {
	if (e.isComposing === true || e.keyCode === 229 || e.key === "Process") return { error: "composing" };
	if (MODIFIER_KEYS.has(e.key)) return { error: "modifierOnly" };
	const key = eventKey(e);
	if (key.length > 1 && !NAMED_KEYS.has(key)) return { error: "unsupported" };
	// Read back through `parseChord`: Shift that made a character (`?`) is not part of the chord.
	return {
		chord: chordText(parseChord(chordText({ key, mod: e.metaKey || e.ctrlKey, alt: e.altKey, shift: e.shiftKey }))),
	};
}

export interface Check {
	/** A key that types text, without ⌘/Ctrl or Alt, for a binding outside the global ones: it would take the letter from the message box. */
	bare: boolean;
	/** The bindings that have this chord where this one acts. */
	conflicts: Entry[];
	/** Whether the one conflicting binding can take this binding's chord instead (it is not fixed, and that chord is free for it). */
	swappable: boolean;
	reserved: boolean;
}

const bareFor = (scope: EditScope, chord: string): boolean => {
	const c = parseChord(chord);
	return printable(c.key) && !c.mod && !c.alt && scope !== "Global";
};

function conflictsIn(entries: readonly Entry[], self: Entry, chord: string): Entry[] {
	return entries.filter((e) => e.id !== self.id && e.chord === chord && overlaps(self.scope, e.scope));
}

/** What binding `chord` to `id` would mean. */
export function checkBinding(entries: readonly Entry[], id: string, chord: string): Check {
	const self = entries.find((e) => e.id === id);
	if (!self) throw new Error(`No shortcut ${id}`);
	const conflicts = conflictsIn(entries, self, chord);
	let swappable = false;
	const other = conflicts.length === 1 ? conflicts[0] : undefined;
	if (other && !other.fixed) {
		// After the swap this binding has `chord`, and the other one this binding's chord now (or none).
		const after = entries.map((e) => (e.id === self.id ? { ...e, chord } : e));
		const given = self.chord;
		swappable =
			given === null ||
			(!bareFor(other.scope, given) && conflictsIn(after, { ...other, chord: given }, given).length === 0);
	}
	return { bare: bareFor(self.scope, chord), conflicts, swappable, reserved: RESERVED.has(chord) };
}

/** The default chord of `id` (a quick prompt has none). */
export const defaultChord = (id: string): string | null => (DEFAULT_CHORDS as Record<string, string>)[id] ?? null;

function withBinding(next: Record<string, string | null>, id: string, chord: string | null): void {
	if (chord === defaultChord(id)) delete next[id];
	else next[id] = chord;
}

/** Bind `chord` to `id` (null: no key at all). */
export function setBinding(id: string, chord: string | null): void {
	const next = { ...shortcutOverrides() };
	withBinding(next, id, chord);
	saveShortcutOverrides(next);
}

/** Bind `chord` to `id`, and give `other` (which had it) the chord `id` had. One write: never both on one key. */
export function swapBinding(id: string, chord: string, other: string): void {
	const next = { ...shortcutOverrides() };
	withBinding(next, other, bindingOf(id));
	withBinding(next, id, chord);
	saveShortcutOverrides(next);
}

/** Back to the default. */
export function resetBinding(id: string): void {
	const next = { ...shortcutOverrides() };
	delete next[id];
	saveShortcutOverrides(next);
}

/** Every binding back to its default (a quick prompt's to none). */
export function resetAllBindings(): void {
	saveShortcutOverrides({});
}
