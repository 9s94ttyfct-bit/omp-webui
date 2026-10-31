/**
 * What the agent graph's toolbar narrows it by (#736): the subagents' status and when they started. Here, beside the
 * preferences that remember the choice (`ompw.agentGraph.status`, `ompw.agentGraph.time` in `shared/prefs.ts`), so that
 * the server refuses a value the page never writes.
 */

export const STATUS_FILTERS = ["all", "running", "failed"] as const;
export type StatusFilter = (typeof STATUS_FILTERS)[number];

export const TIME_FILTERS = ["all", "hour", "today"] as const;
export type TimeFilter = (typeof TIME_FILTERS)[number];

export interface GraphFilter {
	status: StatusFilter;
	time: TimeFilter;
}

export const NO_FILTER: GraphFilter = { status: "all", time: "all" };

/** The status a stored value names; anything else (not set, a choice an earlier or later version had) is `all`. */
export const statusFilterOf = (v: string | null): StatusFilter => STATUS_FILTERS.find((s) => s === v) ?? "all";

/** The time a stored value names; anything else is `all`. */
export const timeFilterOf = (v: string | null): TimeFilter => TIME_FILTERS.find((s) => s === v) ?? "all";
