/**
 * Esc does not stop a running reply at once: the first one asks, the second one (within `STOP_CONFIRM_MS`) stops. A
 * stray key (a synthetic one from a test driver, a hand that slipped) must not end minutes of work. The Stop button is
 * a deliberate click and stays immediate. This is the whole rule; `StopConfirm.tsx` is its keyboard and screen.
 */

/** How long the prompt waits for the second Esc, and how long that second Esc counts. */
export const STOP_CONFIRM_MS = 3000;

/** What an Esc that would stop does: ask (`arm`), or, with the question open and young enough, stop. */
export function stopPress(armedAt: number | null, now: number): "arm" | "stop" {
	return armedAt !== null && now - armedAt <= STOP_CONFIRM_MS ? "stop" : "arm";
}

/** Keys that are not an answer: Esc itself, a modifier on its way to a chord, and Tab, which walks to the prompt's buttons. */
const NEUTRAL_KEYS: Record<string, true> = {
	Escape: true,
	Tab: true,
	Shift: true,
	Control: true,
	Alt: true,
	AltGraph: true,
	Meta: true,
	CapsLock: true,
	Fn: true,
	OS: true,
};

/** Whether this key, pressed with the question open, withdraws it: anything but Esc, Tab and the modifiers. */
export function dismissesStop(key: string): boolean {
	return NEUTRAL_KEYS[key] !== true;
}
