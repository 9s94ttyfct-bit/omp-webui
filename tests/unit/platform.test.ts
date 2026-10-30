import { expect, test } from "bun:test";
import { keyLabel, shortcutLabel } from "../../web/src/lib/platform.ts";
import { chordKeys, DEFAULT_CHORDS } from "../../web/src/lib/shortcuts.ts";

const keys = (id: keyof typeof DEFAULT_CHORDS) => chordKeys(DEFAULT_CHORDS[id]);

/** Shortcut hints are symbols on Apple platforms and spelled out elsewhere; the platform is a parameter here. */

test("Apple platforms write shortcuts with symbols", () => {
	expect(shortcutLabel(keys("newChat"), true)).toBe("⌘⇧O");
	expect(shortcutLabel(keys("steer"), true)).toBe("⌘↵");
	expect(shortcutLabel(keys("search"), true)).toBe("⌘K");
});

test("other platforms spell them out, never showing ⌘", () => {
	expect(shortcutLabel(keys("newChat"), false)).toBe("Ctrl+Shift+O");
	expect(shortcutLabel(keys("steer"), false)).toBe("Ctrl+Enter");
	expect(shortcutLabel(keys("search"), false)).toBe("Ctrl+K");
	for (const chord of Object.values(DEFAULT_CHORDS))
		expect(shortcutLabel(chordKeys(chord), false)).not.toMatch(/[⌘⇧↵]/);
});

test("keys that are the same everywhere stay as they are", () => {
	for (const apple of [true, false]) {
		expect(keyLabel("Esc", apple)).toBe("Esc");
		expect(keyLabel("?", apple)).toBe("?");
		expect(keyLabel("→", apple)).toBe("→");
	}
});
