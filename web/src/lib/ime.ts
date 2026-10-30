import { useMemo, useRef } from "react";

/** The `keyCode` every browser gives a key pressed while an input method is composing. */
const COMPOSING_KEY_CODE = 229;

/**
 * How soon after `compositionend` an Enter still belongs to it. WebKit (the macOS app's WKWebView, Safari) ends the
 * composition *before* it delivers the keydown of the Enter that confirmed it — with `isComposing` already false —
 * and both come out of the same keystroke, milliseconds apart. No typist sends a message that soon after confirming
 * a word.
 */
export const AFTER_COMPOSITION_MS = 50;

interface KeyEventLike {
	keyCode: number;
	timeStamp: number;
	nativeEvent: { isComposing: boolean };
}

/**
 * The keydown belongs to an input method rather than to the page: it is part of a composition (`isComposing`), or
 * it is the Enter/Esc that ended one (keyCode 229, or right after `compositionend` at `endedAt`). It must neither
 * send, save nor stop anything.
 */
export function imeKey(e: KeyEventLike, endedAt = Number.NEGATIVE_INFINITY): boolean {
	return e.nativeEvent.isComposing || e.keyCode === COMPOSING_KEY_CODE || e.timeStamp - endedAt < AFTER_COMPOSITION_MS;
}

/** For a text field: `onCompositionEnd` goes on the field and `imeKey(e)` is asked from its `onKeyDown`. */
export function useImeGuard(): {
	onCompositionEnd: (e: { timeStamp: number }) => void;
	imeKey: (e: KeyEventLike) => boolean;
} {
	const endedAt = useRef(Number.NEGATIVE_INFINITY);
	return useMemo(
		() => ({
			onCompositionEnd: (e) => {
				endedAt.current = e.timeStamp;
			},
			imeKey: (e) => imeKey(e, endedAt.current),
		}),
		[],
	);
}
