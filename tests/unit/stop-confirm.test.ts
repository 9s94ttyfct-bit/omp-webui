import { expect, test } from "bun:test";
import { dismissesStop, STOP_CONFIRM_MS, stopPress } from "../../web/src/lib/stop-confirm.ts";

test("the first Esc asks; a second one within the time stops", () => {
	expect(stopPress(null, 10_000)).toBe("arm");
	expect(stopPress(10_000, 10_001)).toBe("stop");
	expect(stopPress(10_000, 10_000 + STOP_CONFIRM_MS)).toBe("stop");
});

test("an Esc after the time is a first one again", () => {
	expect(stopPress(10_000, 10_000 + STOP_CONFIRM_MS + 1)).toBe("arm");
	expect(STOP_CONFIRM_MS).toBe(3000);
});

test("any key but Esc, Tab and the modifiers withdraws the question", () => {
	for (const key of ["a", "Enter", " ", "ArrowUp", "Backspace", "F5", "?", "Process"])
		expect(dismissesStop(key)).toBe(true);
	for (const key of ["Escape", "Tab", "Shift", "Control", "Alt", "Meta", "CapsLock"])
		expect(dismissesStop(key)).toBe(false);
});
