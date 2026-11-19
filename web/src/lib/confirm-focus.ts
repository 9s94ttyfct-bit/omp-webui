import { useEffect, useRef } from "react";

/**
 * An inline question that takes the place of the button that asked it (Restart, Turn off) removes the focused element from
 * the page when it appears and again when it goes: focus falls to the page and the keyboard starts from its top. The question
 * takes the keyboard on its safe answer (`autoFocus` on Cancel) and, when it closes, this gives it back to the button.
 * Pass `confirming` and put the returned ref on the button. Focus is only given back when nothing else holds it: a question
 * that closes by itself while the person is somewhere else leaves them there.
 */
export function useConfirmFocus<E extends HTMLElement>(confirming: boolean) {
	const opener = useRef<E>(null);
	const was = useRef(false);
	useEffect(() => {
		const active = document.activeElement;
		if (was.current && !confirming && (!active || active === document.body)) opener.current?.focus();
		was.current = confirming;
	}, [confirming]);
	return opener;
}
