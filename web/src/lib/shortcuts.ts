/**
 * Every keyboard binding in the app. Key handlers match events through `matches(id, e)`; Settings › Keyboard shortcuts
 * lists the same ids (`shortcut-list.ts`, with the surface each acts on and its name), so the list shown to users cannot
 * drift from what the handlers do.
 *
 * A binding is data, a chord such as `Mod+Shift+O` (#661): what a key does is derived from it, and a binding the person
 * changed in Settings is kept on this device (localStorage `ompw.shortcuts`, never sent to the server: another device has
 * another keyboard). The list, the editor, its conflict checks and its warnings are in that card's chunk
 * (`shortcut-list.ts`, `shortcut-edit.ts`); only what the key handlers need is here, on the first page.
 */

import { useSyncExternalStore } from "react";
import { shortcutLabel } from "./platform.ts";

export interface KeyEventLike {
	key: string;
	/** The physical key (`KeyL`): what Option on a Mac does to `key` cannot hide it. */
	code?: string;
	metaKey: boolean;
	ctrlKey: boolean;
	shiftKey: boolean;
	altKey: boolean;
	/** A key that is part of an input method's composition belongs to the input method, never to a shortcut. */
	isComposing?: boolean;
	keyCode?: number;
	target?: EventTarget | null;
}

/** Each binding's default chord: modifiers (`Mod`, `Alt`, `Shift`, in that order) and a key, joined by `+`. */
export const DEFAULT_CHORDS = {
	search: "Mod+K",
	newChat: "Mod+Shift+O",
	sidebar: "Mod+\\",
	goal: "Mod+Shift+G",
	approval: "Mod+Shift+A",
	toasts: "Mod+Shift+Y",
	help: "?",
	send: "Enter",
	steer: "Mod+Enter",
	ghostAccept: "Tab",
	ghostAcceptBare: "ArrowRight",
	newline: "Shift+Enter",
	stop: "Escape",
	presetCycle: "Mod+Shift+M",
	agentExit: "Escape",
	agentPrev: "Alt+ArrowUp",
	agentNext: "Alt+ArrowDown",
	agentList: "Alt+L",
	menuNext: "ArrowDown",
	menuPrev: "ArrowUp",
	menuAccept: "Tab",
	menuDismiss: "Escape",
	modelLove: "Mod+Shift+L",
};

export type ShortcutId = keyof typeof DEFAULT_CHORDS;

/** A quick prompt's binding (#659) is kept with the others, under this prefix and the prompt's id. */
export const QUICK_PROMPT_PREFIX = "qp:";

export interface Chord {
	mod: boolean;
	alt: boolean;
	shift: boolean;
	/** A letter in upper case, another character as typed, or a named key (`Enter`, `ArrowUp`, `Space`, `F5`). */
	key: string;
}

/** A key that types something: alone (or with Shift only) it is text, not a shortcut, wherever one is typing. */
export const printable = (k: string) => k.length === 1 || k === "Space";

/** `Mod+Shift+O` → its parts (`Mod++` is ⌘ and `+`). Shift is not kept for a character Shift makes (`?`, `!`). */
export function parseChord(text: string): Chord {
	const mods = text.split(/\+(?!$)/);
	const typed = mods.pop() ?? "";
	const key = typed.length === 1 ? typed.toUpperCase() : typed;
	return {
		mod: mods.includes("Mod"),
		alt: mods.includes("Alt"),
		shift: mods.includes("Shift") && !(key.length === 1 && !/[A-Z]/.test(key)),
		key,
	};
}

/** The key an event is about, as a chord names it (a modifier alone is named too, and no chord has it). */
export function eventKey(e: KeyEventLike): string {
	if (e.key === " ") return "Space";
	if (e.key.length > 1) return e.key;
	// Option on a Mac turns a letter or digit into another character (Option+L is `¬`): the physical key says which.
	return (e.altKey && /^(?:Key|Digit)(.)$/.exec(e.code ?? "")?.[1]) || e.key.toUpperCase();
}

/** Whether `e` is the chord `c`: the same key and exactly its modifiers (Ctrl counts as ⌘ on a Mac). */
export function matchChord(c: Chord, e: KeyEventLike): boolean {
	return (
		// A key that is part of an input method's composition is the input method's.
		!e.isComposing &&
		e.keyCode !== 229 &&
		eventKey(e) === c.key &&
		(e.metaKey || e.ctrlKey) === c.mod &&
		e.altKey === c.alt &&
		(e.shiftKey === c.shift || (c.key.length === 1 && !/[A-Z]/.test(c.key))) &&
		// A key that types text fires no shortcut while one is typing it.
		!(printable(c.key) && !c.mod && !c.alt && typingInField(e.target ?? null))
	);
}

export const STORE_KEY = "ompw.shortcuts";

function storage(): Storage | undefined {
	try {
		return localStorage;
	} catch {
		// None outside a page, or refused (some private modes): the defaults, for this page.
	}
}

/** What the person changed, by id: a chord, or null for a binding cleared. Anything else stored is left out. */
export function parseOverrides(raw: string | null | undefined): Record<string, string | null> {
	const out: Record<string, string | null> = {};
	try {
		for (const [id, chord] of Object.entries(JSON.parse(raw ?? "{}") ?? {}))
			if (chord === null || (typeof chord === "string" && chord)) out[id] = chord;
	} catch {}
	return out;
}

let overrides = parseOverrides(storage()?.getItem(STORE_KEY));
const compiled = new Map<string, Chord | null>();
let version = 0;
const listeners = new Set<() => void>();

function changed(next: Record<string, string | null>): void {
	overrides = next;
	compiled.clear();
	version++;
	for (const listener of listeners) listener();
}

/** The bindings the person changed on this device, by id. */
export const shortcutOverrides = (): Readonly<Record<string, string | null>> => overrides;

/** Keep `next` as this device's changes (an empty object is every default). */
export function saveShortcutOverrides(next: Record<string, string | null>): void {
	try {
		storage()?.setItem(STORE_KEY, JSON.stringify(next));
	} catch {
		// Full or refused storage: the change still applies until reload.
	}
	changed(next);
}

/** The chord bound to `id` now (a quick prompt's too), or null when it has none. */
export const bindingOf = (id: string): string | null =>
	id in overrides ? (overrides[id] ?? null) : ((DEFAULT_CHORDS as Record<string, string>)[id] ?? null);

function chordOf(id: string): Chord | null {
	let c = compiled.get(id);
	if (c === undefined) {
		const text = bindingOf(id);
		c = text ? parseChord(text) : null;
		compiled.set(id, c);
	}
	return c;
}

export function matches(id: ShortcutId, e: KeyEventLike): boolean {
	const c = chordOf(id);
	return !!c && matchChord(c, e);
}

/** The id of the quick prompt `e` is bound to, or null. */
export function quickPromptFor(e: KeyEventLike): string | null {
	for (const id in overrides) {
		const c = id.startsWith(QUICK_PROMPT_PREFIX) && chordOf(id);
		if (c && matchChord(c, e)) return id.slice(QUICK_PROMPT_PREFIX.length);
	}
	return null;
}

const SHOWN: Record<string, string> = { Escape: "Esc", ArrowUp: "↑", ArrowDown: "↓", ArrowLeft: "←", ArrowRight: "→" };

/** A chord's keys to show (`Mod` stays a name: `keyLabel` says ⌘ or Ctrl); none for no chord. */
export function chordKeys(text: string | null): string[] {
	if (!text) return [];
	const c = parseChord(text);
	return [c.mod && "Mod", c.alt && "Alt", c.shift && "Shift", SHOWN[c.key] ?? c.key].filter((k) => k !== false);
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** Re-render on any change of a binding (in this page or another one of this origin). */
export const useShortcutVersion = (): number => useSyncExternalStore(subscribe, () => version);

/** The keys bound to `id` as this platform writes them (`⌘⇧O`, `Ctrl+Shift+O`); empty when the binding was cleared. */
export function useShortcutLabel(id: string): string {
	useShortcutVersion();
	return shortcutLabel(chordKeys(bindingOf(id)));
}

/** `Label (⌘K)`, or the label alone when the binding was cleared. */
export const withKeys = (label: string, keys: string): string => (keys ? `${label} (${keys})` : label);

// Another tab changed them (`storage` does not fire in the tab that wrote it).
if (typeof window !== "undefined") {
	window.addEventListener("storage", (e) => {
		if (e.key === null || e.key === STORE_KEY) changed(parseOverrides(storage()?.getItem(STORE_KEY)));
	});
}

/** True when focus is in a text field, where printable shortcuts like `?` must not fire. */
export function typingInField(target: EventTarget | null): boolean {
	const el = target as HTMLElement | null;
	if (!el) return false;
	return el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName);
}
