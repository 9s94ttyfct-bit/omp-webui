/**
 * What a tool card's header says of its call, and what it leaves for the opened card to say (kept apart from the card so
 * that the rules can be tested without drawing one).
 */

/**
 * `path` as short as it is clear: as the call's own `path` argument wrote it when that names the same file relative to
 * something, else relative to the conversation's folder when it is in it, else as it is.
 */
export function headerPath(path: string | undefined, args: unknown, cwd: string | undefined): string | undefined {
	if (!path) return path;
	const own = args && typeof args === "object" ? (args as Record<string, unknown>).path : undefined;
	const rel = typeof own === "string" ? own.trim().replace(/^\.\//, "") : "";
	if (rel && !rel.startsWith("/") && rel.length < path.length && path.endsWith(`/${rel}`)) return rel;
	const base = cwd?.replace(/\/+$/, "");
	return base && path.startsWith(`${base}/`) ? path.slice(base.length + 1) : path;
}

/**
 * The arguments name omp's own words for what the call is for (`i`, which omp 18 adds to nearly every call and keeps in the
 * call's arguments, and `intent`): the header says it beside the call, so it is not an argument the card has more to say about.
 */
const INTENT_KEYS: ReadonlySet<string> = new Set(["i", "intent"]);

/**
 * The arguments are one line the header already shows whole (`bash` with only its command, `read` with only its path):
 * the opened card then shows the output alone, not the same line again as JSON (#333).
 */
export function argsShownInHeader(args: unknown, summary: string): boolean {
	if (!args || typeof args !== "object") return false;
	const values = Object.entries(args as Record<string, unknown>)
		.filter(([key]) => !INTENT_KEYS.has(key))
		.map(([, value]) => value);
	return values.length === 1 && typeof values[0] === "string" && values[0].trim() === summary;
}
