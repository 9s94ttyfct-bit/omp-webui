/**
 * The oldest Bun that runs omp-webui from source. Bun 1.3 keeps a transpiled module in its cache and, on the next start,
 * loads it with the `source(...)` macro calls of the `install.ts` files under `server/omp` no longer expanded: the server started once and
 * then failed at every start with `ReferenceError: source is not defined`; 1.4.0 keeps the expansion. `Bun.Terminal`
 * (the Terminal tab, the Commands & terminal runner) is a second floor, 1.3.5 (#306).
 */
export const MIN_BUN = "1.4.0";

/** Whether `version` (`Bun.version`: `1.4.4`, or a canary such as `1.4.5-canary.20261101+abc`) is `MIN_BUN` or newer. */
export function bunMeetsMinimum(version: string, minimum = MIN_BUN): boolean {
	const parts = (v: string) =>
		v
			.split(/[-+]/)[0]
			?.split(".")
			.map((n) => Number.parseInt(n, 10) || 0) ?? [];
	const have = parts(version);
	const need = parts(minimum);
	for (let i = 0; i < Math.max(have.length, need.length); i++) {
		const a = have[i] ?? 0;
		const b = need[i] ?? 0;
		if (a !== b) return a > b;
	}
	return true;
}
