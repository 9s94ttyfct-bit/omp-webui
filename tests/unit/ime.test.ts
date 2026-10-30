import { expect, test } from "bun:test";
import { AFTER_COMPOSITION_MS, imeKey } from "../../web/src/lib/ime.ts";

/** Enter that confirms an input-method composition belongs to the IME, in the order Blink and WebKit deliver it. */

const key = (init: { keyCode?: number; timeStamp?: number; isComposing?: boolean }) => ({
	keyCode: init.keyCode ?? 13,
	timeStamp: init.timeStamp ?? 10_000,
	nativeEvent: { isComposing: init.isComposing ?? false },
});

test("a plain Enter is the page's", () => {
	expect(imeKey(key({}))).toBe(false);
	expect(imeKey(key({}), 0)).toBe(false);
});

test("Blink: the Enter that confirms a composition arrives with isComposing", () => {
	expect(imeKey(key({ isComposing: true }))).toBe(true);
});

test("WebKit: compositionend came first, so isComposing is false, but the keydown has keyCode 229", () => {
	expect(imeKey(key({ keyCode: 229 }))).toBe(true);
});

test("an Enter right after compositionend is the one that ended it, whatever its keyCode", () => {
	expect(imeKey(key({ timeStamp: 5_010 }), 5_000)).toBe(true);
	expect(imeKey(key({ timeStamp: 5_000 + AFTER_COMPOSITION_MS - 1 }), 5_000)).toBe(true);
});

test("an Enter typed after the composition has settled sends", () => {
	expect(imeKey(key({ timeStamp: 5_000 + AFTER_COMPOSITION_MS }), 5_000)).toBe(false);
	expect(imeKey(key({ timeStamp: 9_000 }), 5_000)).toBe(false);
});
