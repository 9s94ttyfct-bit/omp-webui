import type { FamilyViewKind } from "../shared/protocol.ts";

/**
 * What `/api/family?view=…` is asked for, and the budget of a window of the history. Nothing here reads a file: the main
 * thread parses a request with this, and the worker (`history.ts`) answers it, so the parts both need are in one module
 * that loads neither the worker host nor the index.
 */

/** The most entries a window holds. A request's `limit` narrows it. */
export const WINDOW_ENTRIES = 200;
/** The most bytes of raw entry text a window holds (`limit` scales it down in proportion). */
export const WINDOW_BYTES = 1024 * 1024;
/** A window holds at least this many entries, however large they are: one huge entry still comes. */
export const MIN_WINDOW_ENTRIES = 8;

const KINDS: readonly FamilyViewKind[] = ["tail", "before", "after", "around", "stats"];

/** One request for a window of the history. The fields a kind does not use are absent. */
export interface ViewRequest {
	kind: FamilyViewKind;
	at?: string;
	leaf?: string;
	limit?: number;
}

/** A view that cannot be answered: the entry it names is not in the file. The page asks for the end of the history instead. */
export class ViewError extends Error {
	constructor(
		message: string,
		readonly code: "unknown_entry",
	) {
		super(message);
		this.name = "ViewError";
	}
}

export type ParsedView = { ok: true; view: ViewRequest | undefined } | { ok: false; error: string };

/**
 * The view a request asks for, from its query: none (the whole lineage) when `view` is absent. An unknown `view`, a
 * `before`, `after` or `around` without `at`, and a `limit` that is not a number are refused. `limit` is a whole number of
 * entries between 1 and `WINDOW_ENTRIES`; `stats` takes no other parameter.
 */
export function parseViewRequest(query: URLSearchParams): ParsedView {
	const kind = query.get("view");
	if (kind === null) return { ok: true, view: undefined };
	if (!(KINDS as readonly string[]).includes(kind)) {
		return { ok: false, error: `Unknown view "${kind}": expected one of ${KINDS.join(", ")}` };
	}
	if (kind === "stats") return { ok: true, view: { kind } };
	const at = query.get("at") || undefined;
	const leaf = query.get("leaf") || undefined;
	const rawLimit = query.get("limit");
	let limit: number | undefined;
	if (rawLimit !== null && rawLimit !== "") {
		const n = Number(rawLimit);
		if (!Number.isFinite(n)) return { ok: false, error: `Invalid limit "${rawLimit}": expected a number of entries` };
		limit = Math.min(WINDOW_ENTRIES, Math.max(1, Math.floor(n)));
	}
	const view = kind as Exclude<FamilyViewKind, "stats">;
	if (view !== "tail" && at === undefined) return { ok: false, error: `The ${view} view needs "at"` };
	return {
		ok: true,
		view: {
			kind: view,
			...(view !== "tail" && at !== undefined ? { at } : {}),
			...(leaf !== undefined ? { leaf } : {}),
			...(limit !== undefined && limit < WINDOW_ENTRIES ? { limit } : {}),
		},
	};
}
