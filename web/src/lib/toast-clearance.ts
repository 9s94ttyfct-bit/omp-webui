import { useSyncExternalStore } from "react";

/**
 * The room the conversation leaves the toast stack, in px from the window's edges: `bottom` is how far up the chat's
 * bottom block (what is above the composer, and the composer) reaches, `top` how far down the transcript starts (under
 * the header and any banner). The stack stands above the block and under the transcript's top, so it covers neither the
 * composer, nor a request's choices, nor the header's buttons, nor a banner's. Null where there is no conversation on
 * screen: the stack keeps to its own place. A store of its own: the stack is rendered elsewhere, and reads it to size
 * itself.
 */
export interface ToastClearance {
	top: number;
	bottom: number;
}
let clearance: ToastClearance | null = null;
const listeners = new Set<() => void>();
export function setClearance(next: ToastClearance | null) {
	const same =
		next === clearance || (next && clearance && next.top === clearance.top && next.bottom === clearance.bottom);
	if (same) return;
	clearance = next;
	for (const l of listeners) l();
}
export function useToastClearance(): ToastClearance | null {
	return useSyncExternalStore(
		(l) => {
			listeners.add(l);
			return () => {
				listeners.delete(l);
			};
		},
		() => clearance,
	);
}
