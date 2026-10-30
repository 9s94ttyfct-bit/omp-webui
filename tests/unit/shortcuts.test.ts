import { afterEach, expect, test } from "bun:test";
import {
	checkBinding,
	chordFromEvent,
	resetAllBindings,
	resetBinding,
	setBinding,
	shortcutEntries,
	swapBinding,
} from "../../web/src/lib/shortcut-edit.ts";
import {
	bindingOf,
	type KeyEventLike,
	matchChord,
	matches,
	parseChord,
	parseOverrides,
	quickPromptFor,
} from "../../web/src/lib/shortcuts.ts";

/** Customizable keyboard shortcuts (#661): chords, matching, recording, conflicts and the changes kept. */

afterEach(() => resetAllBindings());

const key = (init: Partial<KeyEventLike> & { key: string }): KeyEventLike => ({
	metaKey: false,
	ctrlKey: false,
	shiftKey: false,
	altKey: false,
	...init,
});

test("a chord matches its key with exactly its modifiers, Ctrl standing for ⌘", () => {
	const c = parseChord("Mod+K");
	expect(matchChord(c, key({ key: "k", metaKey: true }))).toBe(true);
	expect(matchChord(c, key({ key: "k", ctrlKey: true }))).toBe(true);
	expect(matchChord(c, key({ key: "K", metaKey: true, shiftKey: true }))).toBe(false);
	expect(matchChord(c, key({ key: "k", metaKey: true, altKey: true }))).toBe(false);
	expect(matchChord(c, key({ key: "k" }))).toBe(false);
	expect(matchChord(parseChord("Mod+Shift+O"), key({ key: "O", metaKey: true, shiftKey: true }))).toBe(true);
});

test("a character Shift makes is matched whatever Shift does, and `Mod++` is ⌘ and plus", () => {
	expect(parseChord("Shift+?")).toEqual(parseChord("?"));
	expect(matchChord(parseChord("?"), key({ key: "?", shiftKey: true }))).toBe(true);
	expect(parseChord("Mod++")).toEqual({ mod: true, alt: false, shift: false, key: "+" });
	expect(matchChord(parseChord("Mod++"), key({ key: "+", metaKey: true, shiftKey: true }))).toBe(true);
});

test("no shortcut fires inside an input method's composition", () => {
	const enter = parseChord("Enter");
	expect(matchChord(enter, key({ key: "Enter" }))).toBe(true);
	expect(matchChord(enter, key({ key: "Enter", isComposing: true }))).toBe(false);
	expect(matchChord(enter, key({ key: "Process", keyCode: 229 }))).toBe(false);
});

test("a key that types text fires nothing while one is typing, but a chord with ⌘ does", () => {
	const field = { tagName: "TEXTAREA", isContentEditable: false } as unknown as EventTarget;
	expect(matchChord(parseChord("?"), key({ key: "?", target: field }))).toBe(false);
	expect(matchChord(parseChord("Space"), key({ key: " ", target: field }))).toBe(false);
	expect(matchChord(parseChord("Mod+K"), key({ key: "k", metaKey: true, target: field }))).toBe(true);
});

test("the recorder writes what was pressed as a chord, and waits through a modifier alone", () => {
	expect(chordFromEvent(key({ key: "O", metaKey: true, shiftKey: true }))).toEqual({ chord: "Mod+Shift+O" });
	expect(chordFromEvent(key({ key: "?", shiftKey: true }))).toEqual({ chord: "?" });
	// Option+L on a Mac types `¬`: the physical key names it.
	expect(chordFromEvent(key({ key: "¬", code: "KeyL", altKey: true }))).toEqual({ chord: "Alt+L" });
	expect(chordFromEvent(key({ key: " ", ctrlKey: true }))).toEqual({ chord: "Mod+Space" });
	expect(chordFromEvent(key({ key: "Shift", shiftKey: true }))).toEqual({ error: "modifierOnly" });
	expect(chordFromEvent(key({ key: "Meta", metaKey: true }))).toEqual({ error: "modifierOnly" });
	expect(chordFromEvent(key({ key: "Process", keyCode: 229 }))).toEqual({ error: "composing" });
	expect(chordFromEvent(key({ key: "a", isComposing: true }))).toEqual({ error: "composing" });
	expect(chordFromEvent(key({ key: "AudioVolumeUp" }))).toEqual({ error: "unsupported" });
});

test("the shipped bindings do not collide where they act", () => {
	const entries = shortcutEntries();
	for (const e of entries) {
		if (e.chord === null) continue;
		expect({ id: e.id, conflicts: checkBinding(entries, e.id, e.chord).conflicts.map((c) => c.id) }).toEqual({
			id: e.id,
			conflicts: [],
		});
	}
});

test("a global key collides with every surface's, two other surfaces do not collide", () => {
	const entries = shortcutEntries(["p1"]);
	// New chat on Enter would also send from the message box.
	expect(checkBinding(entries, "newChat", "Enter").conflicts.map((c) => c.id)).toEqual(["send"]);
	// The preset key on ⌘K would also open search.
	expect(checkBinding(entries, "presetCycle", "Mod+K").conflicts.map((c) => c.id)).toEqual(["search"]);
	// The model picker's favourite key and the subagent full screen's never act together.
	expect(checkBinding(entries, "agentList", "Mod+Shift+L").conflicts).toEqual([]);
	// A quick prompt's key works wherever a conversation is shown: it collides with a surface's own.
	expect(checkBinding(entries, "qp:p1", "Mod+Enter").conflicts.map((c) => c.id)).toEqual(["steer"]);
});

test("a collision with a binding that can take this one's keys is a swap; with a fixed one it is refused", () => {
	const entries = shortcutEntries();
	const swap = checkBinding(entries, "send", "Mod+Enter");
	expect(swap.conflicts.map((c) => c.id)).toEqual(["steer"]);
	expect(swap.swappable).toBe(true);
	const fixed = checkBinding(entries, "presetCycle", "Escape");
	expect(fixed.conflicts.map((c) => c.id)).toEqual(["stop"]);
	expect(fixed.swappable).toBe(false);
	// New chat taking ⌘K gives Search New chat's keys, which nothing else has.
	expect(checkBinding(entries, "newChat", "Mod+K").swappable).toBe(true);
});

test("a key that types text needs ⌘ or Alt except as a global key, and the system's keys are warned about", () => {
	const entries = shortcutEntries(["p1"]);
	expect(checkBinding(entries, "presetCycle", "J").bare).toBe(true);
	expect(checkBinding(entries, "qp:p1", "Shift+J").bare).toBe(true);
	expect(checkBinding(entries, "presetCycle", "Alt+J").bare).toBe(false);
	expect(checkBinding(entries, "goal", "G").bare).toBe(false);
	expect(checkBinding(entries, "goal", "Mod+W").reserved).toBe(true);
	expect(checkBinding(entries, "goal", "Mod+Shift+W").reserved).toBe(false);
});

test("a changed binding is what the key handlers match; cleared it matches nothing; reset it is the default again", () => {
	const cmdJ = key({ key: "j", metaKey: true });
	const cmdK = key({ key: "k", metaKey: true });
	setBinding("search", "Mod+J");
	expect(matches("search", cmdJ)).toBe(true);
	expect(matches("search", cmdK)).toBe(false);
	setBinding("search", null);
	expect(bindingOf("search")).toBeNull();
	expect(matches("search", cmdK)).toBe(false);
	resetBinding("search");
	expect(matches("search", cmdK)).toBe(true);
});

test("a swap moves both bindings at once, so no key does two things", () => {
	swapBinding("send", "Mod+Enter", "steer");
	expect(bindingOf("send")).toBe("Mod+Enter");
	expect(bindingOf("steer")).toBe("Enter");
	expect(matches("send", key({ key: "Enter", metaKey: true }))).toBe(true);
	expect(matches("steer", key({ key: "Enter" }))).toBe(true);
});

test("a quick prompt's key names that prompt", () => {
	const cmdOne = key({ key: "1", metaKey: true });
	expect(quickPromptFor(cmdOne)).toBeNull();
	setBinding("qp:abc", "Mod+1");
	expect(quickPromptFor(cmdOne)).toBe("abc");
	expect(quickPromptFor(key({ key: "1" }))).toBeNull();
});

test("what is kept is read back without what is not a binding", () => {
	expect(parseOverrides('{"search":"Mod+J","goal":null,"x":3,"y":""}')).toEqual({ search: "Mod+J", goal: null });
	expect(parseOverrides("not json")).toEqual({});
	expect(parseOverrides(null)).toEqual({});
	expect(parseOverrides("null")).toEqual({});
});
