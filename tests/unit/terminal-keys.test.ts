import { expect, test } from "bun:test";
import {
	isLeaveKey,
	keyData,
	screenReaderMode,
	setScreenReaderMode,
	withCtrl,
} from "../../web/src/lib/terminal-keys.ts";

/**
 * The keys a touch screen's keyboard lacks, as a terminal wants them (#369), the one-shot Ctrl, the way out of a screen that
 * keeps every key (#277) and the switch for screen reader mode (#289).
 */

test("the arrow keys are ESC [ x, or ESC O x while the program asked for the application's cursor keys", () => {
	expect(keyData("up", false)).toBe("\x1b[A");
	expect(keyData("down", false)).toBe("\x1b[B");
	expect(keyData("right", false)).toBe("\x1b[C");
	expect(keyData("left", false)).toBe("\x1b[D");
	expect(keyData("up", true)).toBe("\x1bOA");
	expect(keyData("left", true)).toBe("\x1bOD");
	expect(keyData("esc", false)).toBe("\x1b");
	expect(keyData("tab", false)).toBe("\t");
	expect(keyData("ctrlc", false)).toBe("\x03");
});

test("Ctrl turns one letter into its control code, and leaves anything else as typed", () => {
	expect(withCtrl("c")).toBe("\x03");
	expect(withCtrl("C")).toBe("\x03");
	expect(withCtrl("l")).toBe("\x0c");
	expect(withCtrl("d")).toBe("\x04");
	expect(withCtrl("[")).toBe("\x1b");
	// A digit, a space, a pasted text and an IME composition are not control characters.
	expect(withCtrl("1")).toBe("1");
	expect(withCtrl(" ")).toBe(" ");
	expect(withCtrl("ls -l")).toBe("ls -l");
	expect(withCtrl("你")).toBe("你");
});

test("Ctrl+F6 alone leaves the screen", () => {
	const key = (over: Partial<KeyboardEvent>) => ({
		key: "F6",
		ctrlKey: true,
		altKey: false,
		metaKey: false,
		shiftKey: false,
		...over,
	});
	expect(isLeaveKey(key({}))).toBe(true);
	expect(isLeaveKey(key({ ctrlKey: false }))).toBe(false);
	expect(isLeaveKey(key({ shiftKey: true }))).toBe(false);
	expect(isLeaveKey(key({ key: "F5" }))).toBe(false);
});

test("screen reader mode is off until chosen, and the choice is kept; blocked storage means off", () => {
	const data = new Map<string, string>();
	const storage = {
		getItem: (k: string) => data.get(k) ?? null,
		setItem: (k: string, v: string) => void data.set(k, v),
	};
	expect(screenReaderMode(storage)).toBe(false);
	setScreenReaderMode(true, storage);
	expect(screenReaderMode(storage)).toBe(true);
	setScreenReaderMode(false, storage);
	expect(screenReaderMode(storage)).toBe(false);
	const blocked = {
		getItem: () => {
			throw new DOMException("blocked", "SecurityError");
		},
		setItem: () => {
			throw new DOMException("blocked", "SecurityError");
		},
	};
	expect(screenReaderMode(blocked)).toBe(false);
	expect(() => setScreenReaderMode(true, blocked)).not.toThrow();
});
