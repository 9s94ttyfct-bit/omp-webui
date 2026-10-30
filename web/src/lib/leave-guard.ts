import type { View } from "../store/app.ts";

/**
 * What stands between a person and a page that would lose what they have not saved (the Files tab's editor, `FileEditor.tsx`).
 * One holder at a time registers; whatever would take them away from the unsaved text asks first: another view or conversation
 * (`setView`, Back and Forward), the large view closing or showing another file (`store/big.ts`). A page that is closed or
 * reloaded is the browser's to ask (`beforeunload`, which the holder registers itself). Nothing here knows what is held: this module
 * is small and loaded with the page, and the editor's code is not.
 */
export interface LeaveGuard {
	/**
	 * Whether going to `next` loses the unsaved text. `next` is the view being shown; null when no view changes (the large view
	 * closing, or showing another file).
	 */
	blocks(next: View | null): boolean;
	/** Ask the person: `go` runs if they agree to lose it, `stay` if they do not (nothing, when none is given). */
	ask(go: () => void, stay?: () => void): void;
}

let holder: LeaveGuard | null = null;

/** Register `guard`; the answer gives it up again (a holder that is no longer the registered one does not release another's). */
export function holdLeaveGuard(guard: LeaveGuard): () => void {
	holder = guard;
	return () => {
		if (holder === guard) holder = null;
	};
}

/** Run `go` now, or after the person agreed to lose what is unsaved when going to `next` would. */
export function whenFree(next: View | null, go: () => void, stay?: () => void): void {
	if (holder?.blocks(next)) holder.ask(go, stay);
	else go();
}
