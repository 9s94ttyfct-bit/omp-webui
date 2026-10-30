import { Hourglass } from "lucide-react";
import { useMemo, useState } from "react";
import "../i18n/later.ts";
import { type MessageKey, useT, type Vars } from "../i18n/index.ts";
import { fmtElapsed } from "../lib/clock.ts";
import { useNow } from "../lib/now.ts";
import { useShownInPanel } from "../lib/panel-panes.ts";
import { type AgentRow, elapsedMs, jobRows } from "../lib/subagents.ts";
import { openAgent } from "../store/agents.ts";
import type { LiveState } from "../store/live.ts";
import { StatusIcon } from "./Agents.tsx";
import { ScrollPane } from "./ScrollPane.tsx";
import { Empty, Spinner } from "./ui.tsx";

/** Rows shown before the rest fold behind "N more". */
const COLLAPSED_ROWS = 3;

function Job({ row, now, inPane }: { row: AgentRow; now: number; inPane: boolean }) {
	const t = useT();
	const p = row.live?.progress;
	const elapsed = elapsedMs(row, now);
	const percent = p?.completionPercent;
	const doing = row.live?.description ?? p?.description ?? p?.lastIntent;
	return (
		<button
			type="button"
			className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-xs hover:bg-hover"
			data-testid="job-row"
			data-agent-id={row.id}
			data-running={row.running}
			onClick={() => openAgent(row.id)}
		>
			{row.running ? <Spinner size={12} className="shrink-0 text-accent" /> : <StatusIcon status={row.status} />}
			<span className="shrink-0 rounded bg-hover px-1.5 py-0.5 text-xs font-medium text-muted" data-testid="job-kind">
				{row.live?.detached ? t("panel.jobKindBackground") : t("panel.jobKindTask")}
			</span>
			{p?.resolvedModel && !inPane ? (
				<span className="hidden shrink-0 font-mono text-faint sm:inline">{p.resolvedModel}</span>
			) : null}
			<span className="shrink-0 font-medium">{row.id}</span>
			<span className="min-w-0 flex-1 truncate text-muted">{doing}</span>
			{percent !== undefined ? (
				<span className="flex shrink-0 items-center gap-1.5 tabular-nums text-accent">
					{inPane ? null : (
						<span className="hidden h-1 w-10 overflow-hidden rounded-full bg-hover sm:block" aria-hidden>
							<span className="block h-full rounded-full bg-accent" style={{ width: `${Math.min(100, percent)}%` }} />
						</span>
					)}
					{percent}%
				</span>
			) : null}
			<span className="shrink-0 tabular-nums text-faint" data-testid="job-elapsed">
				{elapsed === undefined ? "" : fmtElapsed(elapsed)}
			</span>
		</button>
	);
}

function jobsTitle(t: (key: MessageKey, vars?: Vars) => string, rows: AgentRow[], running: number): string {
	return running < rows.length
		? t("panel.jobsWaitingSome", { running, n: rows.length })
		: rows.length === 1
			? t("panel.jobsWaitingOne")
			: t("panel.jobsWaiting", { n: rows.length });
}

/**
 * What the agent is waiting on while subagents run: one row per job with its kind, model, name, description,
 * progress and elapsed time, running ones first. Rows past the first few fold behind "N more"; each row opens
 * that subagent's live view. It is there only while something runs, and never takes more than about a third of
 * the screen: a long list scrolls inside it instead of pushing the conversation and the composer away. While a pane
 * of the side panel shows the Jobs tab it is not drawn here: the pane has it.
 */
export function JobsBlock({ live }: { live: LiveState }) {
	const inPanel = useShownInPanel("jobs");
	return inPanel ? null : <JobsCard live={live} />;
}

function JobsCard({ live }: { live: LiveState }) {
	const t = useT();
	const rows = useMemo(() => jobRows(live.subagents), [live.subagents]);
	const [expanded, setExpanded] = useState(false);
	const running = rows.filter((r) => r.running).length;
	const now = useNow(running ? 1000 : null);
	if (!rows.length) return null;
	const shown = expanded ? rows : rows.slice(0, COLLAPSED_ROWS);
	return (
		<section
			className="mb-2 flex max-h-[35vh] flex-col overflow-hidden rounded-xl border border-border bg-bg-soft"
			aria-label={t("panel.jobsBlockAria")}
			data-testid="jobs-block"
			data-running={running}
		>
			<div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs font-medium">
				<Spinner size={12} className="text-accent" />
				{jobsTitle(t, rows, running)}
			</div>
			<div className="min-h-0 flex-1 divide-y divide-border overflow-y-auto" data-testid="jobs-rows">
				{shown.map((r) => (
					<Job key={r.id} row={r} now={now} inPane={false} />
				))}
			</div>
			{rows.length > COLLAPSED_ROWS ? (
				<button
					type="button"
					className="w-full shrink-0 border-t border-border px-3 py-1 text-left text-xs text-muted hover:bg-hover hover:text-fg"
					data-testid="jobs-more"
					aria-expanded={expanded}
					onClick={() => setExpanded((e) => !e)}
				>
					{expanded ? t("panel.jobsFewer") : t("panel.jobsMore", { n: rows.length - COLLAPSED_ROWS })}
				</button>
			) : null}
		</section>
	);
}

/** The Jobs tab of the side panel: the same list, every row (the pane scrolls), with an empty state while nothing runs. */
export function JobsPane({ live }: { live: LiveState | undefined }) {
	const t = useT();
	const rows = useMemo(() => jobRows(live?.subagents), [live?.subagents]);
	const running = rows.filter((r) => r.running).length;
	const now = useNow(running ? 1000 : null);
	if (!rows.length) {
		// The pane has no padding of its own (the list runs edge to edge): the empty state's text gets its own.
		return (
			<ScrollPane className="min-h-0 flex-1 overflow-y-auto p-3">
				<Empty icon={<Hourglass size={22} />} title={t("panel.jobsEmptyTitle")}>
					{t("panel.jobsEmptyBody")}
				</Empty>
			</ScrollPane>
		);
	}
	return (
		<section
			className="flex min-h-0 flex-1 flex-col"
			aria-label={t("panel.jobsBlockAria")}
			data-testid="jobs-list"
			data-running={running}
		>
			<div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-1.5 text-xs font-medium">
				{running ? <Spinner size={12} className="text-accent" /> : null}
				{jobsTitle(t, rows, running)}
			</div>
			<div className="min-h-0 flex-1 divide-y divide-border overflow-y-auto" data-testid="jobs-rows">
				{rows.map((r) => (
					<Job key={r.id} row={r} now={now} inPane />
				))}
			</div>
		</section>
	);
}
