/** Runtime type guards shared by the server and the web UI. */

/** A plain object — a JSON object, not an array or null. Its fields stay `unknown`: check the ones you use. */
export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `value` as a number to add to a total: itself when it is a finite number, else 0. A session file says whatever it says
 * (a hand edit, another tool, another version of omp), and `"a"`, `null`, `{}` or `1e999` added with `+` made totals of
 * `"0a"`, `"0[object Object]"` and `Infinity`.
 */
export function finite(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** What a request cost, from its usage record: `cost.total` when that is a finite number, else 0. */
export function usageCost(usage: Record<string, unknown>): number {
	return isRecord(usage.cost) ? finite(usage.cost.total) : 0;
}
