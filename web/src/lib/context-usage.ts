import type { RpcState } from "../store/live.ts";

/** How full a context window is: the conversation's own (`contextUsage`) or a subagent's (`rowContext`). */
export type ContextUsage = NonNullable<RpcState["contextUsage"]>;

/**
 * How close a context is to full: past 80% `high` (omp compacts near there), past 60% `warn`. The status line's meter
 * and each subagent's figure take their colour from it.
 */
export type ContextLevel = "ok" | "warn" | "high";

export function contextLevel(percent: number): ContextLevel {
	return percent > 80 ? "high" : percent > 60 ? "warn" : "ok";
}

/**
 * A subagent's context as omp's progress record of it says (`contextTokens` of `contextWindow`, the same figures as the
 * conversation's `contextUsage`), or undefined while either is missing or zero: nothing measured yet is not 0%.
 */
export function progressContext(
	p: { contextTokens?: unknown; contextWindow?: unknown } | undefined,
): ContextUsage | undefined {
	const tokens = p?.contextTokens;
	const window = p?.contextWindow;
	if (typeof tokens !== "number" || typeof window !== "number") return undefined;
	if (!Number.isFinite(tokens) || !Number.isFinite(window) || tokens <= 0 || window <= 0) return undefined;
	return { tokens, contextWindow: window, percent: (tokens * 100) / window };
}
