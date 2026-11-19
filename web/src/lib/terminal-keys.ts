/**
 * What a terminal screen needs beyond the text a phone's on-screen keyboard types: the keys it lacks (Esc, Tab, Ctrl, the
 * arrows, Ctrl-C), and the way out for the keyboard (#369, #277). Plain data and functions, so they are testable without a
 * screen; `components/TerminalKeys.tsx` draws the keys, `lib/xterm-view.ts` takes the way out.
 */

export type KeyId = "esc" | "tab" | "up" | "down" | "left" | "right" | "ctrlc";

/**
 * What a key sends. The arrows are `ESC [ x`, or `ESC O x` while the program asked for the application's cursor keys
 * (`vim`, `less`, `top` do: xterm.js reports it as `applicationCursorKeysMode`).
 */
export function keyData(id: KeyId, applicationCursorKeys: boolean): string {
	switch (id) {
		case "esc":
			return "\x1b";
		case "tab":
			return "\t";
		case "ctrlc":
			return "\x03";
		default: {
			const letter = { up: "A", down: "B", right: "C", left: "D" }[id];
			return `${applicationCursorKeys ? "\x1bO" : "\x1b["}${letter}`;
		}
	}
}

/**
 * What a one-shot Ctrl turns the next typed character into: a letter (or one of `@[\]^_`) becomes its control code, `a` to
 * `\x01`, `c` to `\x03` (as a terminal sends Ctrl-C). Anything else, and anything longer than one character (a pasted text, an
 * IME composition), is sent as it is.
 */
export function withCtrl(data: string): string {
	if (data.length !== 1) return data;
	const code = data.toUpperCase().charCodeAt(0);
	return code >= 0x40 && code <= 0x5f ? String.fromCharCode(code - 0x40) : data;
}

/** Ctrl+F6, as the Browser tab has it: the keyboard leaves the screen for the tab's own controls. */
export function isLeaveKey(e: Pick<KeyboardEvent, "key" | "ctrlKey" | "altKey" | "metaKey" | "shiftKey">): boolean {
	return e.key === "F6" && e.ctrlKey && !e.altKey && !e.metaKey && !e.shiftKey;
}

/** Give the keyboard to the first control of `toolbar`: the way out of a screen that keeps every key, Tab and Esc included. */
export function leaveTerminal(toolbar: HTMLElement | null): void {
	toolbar?.querySelector<HTMLElement>("button:not(:disabled)")?.focus();
}

const SCREEN_READER_KEY = "ompw.termScreenReader";

/** Whether this device's terminals expose their output to a screen reader (xterm leaves it off: it costs work on every write). */
export function screenReaderMode(storage: Pick<Storage, "getItem"> = localStorage): boolean {
	try {
		return storage.getItem(SCREEN_READER_KEY) === "on";
	} catch {
		return false;
	}
}

export function setScreenReaderMode(on: boolean, storage: Pick<Storage, "setItem"> = localStorage): void {
	try {
		storage.setItem(SCREEN_READER_KEY, on ? "on" : "off");
	} catch {
		// Storage is blocked: the choice holds for the terminals open now.
	}
}
