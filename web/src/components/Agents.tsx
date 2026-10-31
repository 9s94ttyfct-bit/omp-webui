import {
	ArrowDown,
	Bot,
	ChevronLeft,
	CircleCheck,
	CircleDashed,
	CircleMinus,
	CircleX,
	Maximize2,
	Send,
} from "lucide-react";
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import "../i18n/later.ts";
import { type MessageKey, useT, type Vars } from "../i18n/index.ts";
import { fmtElapsed } from "../lib/clock.ts";
import { glideToEnd, useFollowEnd } from "../lib/follow-end.ts";
import { costColumn, fmtCost, fmtCostExact, fmtRelative, fmtTokens } from "../lib/format.ts";
import { messageOf, toolResultsById } from "../lib/messages.ts";
import { useNow } from "../lib/now.ts";
import { assignmentOfInit, assignmentOfRow } from "../lib/subagent-assignment.ts";
import { startedByMainAgent } from "../lib/subagent-continue.ts";
import { liveToolOutput, pendingTail } from "../lib/subagent-transcript.ts";
import { canContinue, type SubagentWait, subagentWait } from "../lib/subagent-wait.ts";
import {
	type AgentRow,
	childRows,
	ENDED,
	elapsedMs,
	isOver,
	parentId,
	rowContext,
	rowTotals,
	subagentsForToolCall,
	toolCallArguments,
} from "../lib/subagents.ts";
import { timerWanted, toolTimer } from "../lib/tool-time.ts";
import { useToolTimerMode } from "../lib/tool-timer.ts";
import { indexTree, pathTo } from "../lib/tree.ts";
import { fmtCountdown, resetTime } from "../lib/usage-limit.ts";
import { socket } from "../lib/ws.ts";
import { openAgentForToolCall, selectAgent, showAgentFull, useAgentRows, useAgentUi } from "../store/agents.ts";
import { useApp } from "../store/app.ts";
import type { LiveState, ToolExec } from "../store/live.ts";
import { useSubagentTranscript } from "../store/subagent-transcript.ts";
import { AssignmentDetails } from "./Assignment.tsx";
import { ContextPercent } from "./ContextPercent.tsx";
import { MessageRow } from "./Message.tsx";
import { StopSubagent } from "./SubagentStop.tsx";
import { argSummary } from "./ToolCard.tsx";
import { ToolTimer } from "./ToolTimer.tsx";
import { Badge, cx, Empty, IconButton, Spinner } from "./ui.tsx";

type Translate = (key: MessageKey, vars?: Vars) => string;

export function statusLabel(t: Translate, status: string): string {
	switch (status) {
		case "completed":
			return t("panel.statusCompleted");
		case "done":
			return t("panel.statusDone");
		case "aborted":
			return t("panel.statusAborted");
		case "failed":
			return t("panel.statusFailed");
		case "error":
			return t("panel.statusError");
		case "cancelled":
			return t("panel.statusCancelled");
		case ENDED:
			return t("panel.statusEnded");
		case "running":
			return t("panel.statusRunning");
		case "started":
			return t("panel.statusStarted");
		case "pending":
			return t("panel.statusPending");
		default:
			return status;
	}
}

export function StatusIcon({ status }: { status: string }) {
	const t = useT();
	if (status === "completed" || status === "done")
		return <CircleCheck size={14} className="text-success" aria-label={t("panel.iconCompleted")} />;
	if (status === ENDED) return <CircleMinus size={14} className="text-faint" aria-label={statusLabel(t, status)} />;
	if (isOver(status)) return <CircleX size={14} className="text-danger" aria-label={statusLabel(t, status)} />;
	if (status === "running" || status === "started") return <Spinner size={14} className="text-accent" />;
	return <CircleDashed size={14} className="text-faint" aria-label={statusLabel(t, status)} />;
}

/**
 * The wait of a running subagent as of `now`, from the conversation's own state: frozen when it is paused, and given the
 * grace of omp's first moments after it ran again (see `subagentWait`). Null when it is not waiting.
 */
function waitOf(row: AgentRow, live: LiveState | undefined, now: number): SubagentWait | null {
	const wait = row.running ? row.live?.retry : null;
	return wait ? subagentWait(wait, now, Boolean(live?.info.pausedAt), live?.resumedAt ?? 0) : null;
}

/**
 * The Stop in the header of a subagent's view (the panel's and the full screen's). While the subagent waits to retry, in a
 * way the page can end for the person (see `canContinue`) and the main agent started it (it is the agent that brings it
 * back, see `continuePrompt`), the stop button is a split one with "Stop and continue" in its menu.
 */
export function DetailStop({
	liveId,
	row,
	rows,
	live,
}: {
	liveId: string;
	row: AgentRow;
	rows: AgentRow[];
	live: LiveState | undefined;
}) {
	const view = waitOf(row, live, useNow(1000));
	const continuable = view !== null && canContinue(view, Boolean(live?.info.pausedAt)) && startedByMainAgent(rows, row);
	return <StopSubagent liveId={liveId} id={row.id} name={row.name} kind="button" continuable={continuable} />;
}

/**
 * What a subagent's retry wait says: the countdown to omp's retry with the time it comes at (a usage-limit wait is the
 * reset away), that the time is up and omp is about to start the turn (or has), that the conversation is paused, or that
 * omp has not retried and how late it is. The same words as the conversation's own wait, shorter.
 */
function waitText(t: Translate, view: SubagentWait, now: number): string {
	switch (view.phase) {
		case "counting": {
			const time = fmtCountdown(view.left);
			const at = view.at === null ? null : resetTime(view.at / 1000, now);
			if (view.usageLimit)
				return at === null ? t("chat.agentRetryUsage", { time }) : t("chat.agentRetryUsageAt", { time, at });
			const vars = { attempt: view.attempt, max: view.max, time };
			return at === null ? t("chat.agentRetry", vars) : t("chat.agentRetryAt", { ...vars, at });
		}
		case "overdue":
			return t("chat.agentRetryOverdue", { late: fmtCountdown(view.late) });
		case "paused":
			return t("chat.agentRetryPaused");
		default:
			return t("chat.agentRetrying");
	}
}

/** The Agents tab: the conversation's subagents, running ones first; one opens as a live view of its transcript. */
export function Agents({ file, live }: { file: string | null; live: LiveState | undefined }) {
	const t = useT();
	const rows = useAgentRows(file, live);
	const selected = useAgentUi((s) => s.selected);
	const row = selected && selected.file === file ? rows.find((r) => r.id === selected.id) : undefined;
	const now = useNow(!row && rows.some((r) => r.running) ? 1000 : null);
	const liveId = live && !live.info.exited ? live.info.liveId : null;
	if (row) return <AgentDetail key={row.id} row={row} rows={rows} live={live} />;
	if (!rows.length) {
		return (
			<Empty icon={<Bot size={22} />} title={t("panel.agentsEmptyTitle")}>
				{t("panel.agentsEmptyBody")}
			</Empty>
		);
	}
	// The costs down the list are one column: one number of decimals, so that `$0.0088` is not over `$0.01`.
	const money = costColumn(rows.map((r) => rowTotals(r).cost));
	return (
		<ul className="min-h-0 flex-1 divide-y divide-border overflow-y-auto" data-testid="subagent-list">
			{rows.map((r) => {
				const p = r.live?.progress;
				const doing = p?.lastIntent || p?.description || r.live?.description;
				const elapsed = r.running ? elapsedMs(r, now) : undefined;
				const { cost } = rowTotals(r);
				const view = waitOf(r, live, now);
				return (
					<li key={r.id} className="relative">
						<button
							type="button"
							className={cx("w-full px-3 py-2.5 text-left hover:bg-hover", r.running && liveId && "pr-11")}
							onClick={() => selectAgent(r.id)}
							data-testid="subagent-item"
							data-agent-id={r.id}
							data-running={r.running}
						>
							<div className="flex items-center gap-2">
								<StatusIcon status={r.status} />
								<span className="truncate text-sm font-medium" style={{ paddingLeft: `${r.depth * 12}px` }}>
									{r.name}
								</span>
								{r.agent ? <Badge>{r.agent}</Badge> : null}
								<span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-faint tabular-nums">
									<ContextPercent ctx={rowContext(r)} />
									{elapsed !== undefined ? (
										<span className="text-accent" data-testid="subagent-elapsed">
											{fmtElapsed(elapsed)}
										</span>
									) : null}
									{cost > 0 ? money(cost) : r.running ? null : r.stat ? fmtRelative(r.stat.modifiedAt) : null}
								</span>
							</div>
							{doing ? <div className="mt-0.5 truncate pl-6 text-xs text-muted">{doing}</div> : null}
							{view ? (
								<div
									className={cx(
										"mt-0.5 truncate pl-6 text-xs tabular-nums",
										view.phase === "overdue" ? "text-danger" : "text-warning",
									)}
									data-testid="subagent-wait"
									data-phase={view.phase}
								>
									{waitText(t, view, now)}
								</div>
							) : null}
							{r.running && p?.currentTool ? (
								<div className="mt-0.5 truncate pl-6 font-mono text-xs text-faint">
									{p.currentTool}
									{p.currentToolArgs ? `: ${p.currentToolArgs}` : ""}
								</div>
							) : null}
						</button>
						{r.running && liveId ? (
							<div className="absolute top-1.5 right-2">
								<StopSubagent liveId={liveId} id={r.id} name={r.name} kind="icon" />
							</div>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}

const NO_TOOLS: Record<string, ToolExec> = {};
/** Lines of a running tool's output the live view keeps in sight. */
const TOOL_OUTPUT_LINES = 12;
/** A figure of the live view (tokens, cost, time): a third of the row, or more when it needs it, never broken. */
const STAT = "grow basis-[28%] whitespace-nowrap";

/** The tools a subagent is running right now, with what each has printed so far. */
function RunningTools({ tools }: { tools: Record<string, ToolExec> }) {
	const t = useT();
	const mode = useToolTimerMode();
	const running = Object.values(tools).filter((x) => !x.done);
	if (!running.length) return null;
	return (
		<div className="space-y-1.5" data-testid="subagent-running-tools">
			<div className="text-xs font-medium text-faint">{t("panel.agentRunningTools")}</div>
			{running.map((x) => {
				const output = liveToolOutput(x.partial, TOOL_OUTPUT_LINES);
				const timer = timerWanted(mode, x.toolName) ? toolTimer({ exec: x }) : null;
				return (
					<div
						key={x.toolCallId}
						className="rounded-lg border border-accent/30 bg-accent-soft/40 px-2.5 py-1.5"
						data-testid="subagent-running-tool"
						data-tool={x.toolName}
					>
						<div className="flex items-center gap-2 text-xs">
							<Spinner size={12} className="shrink-0 text-accent" />
							<span className="font-medium">{x.toolName}</span>
							<span className="min-w-0 flex-1 truncate font-mono text-muted">{x.intent || argSummary(x.args)}</span>
							{timer ? <ToolTimer timer={timer} /> : null}
						</div>
						{output ? (
							<pre
								className="mt-1 max-h-40 overflow-auto rounded bg-code p-1.5 font-mono text-xs leading-snug whitespace-pre-wrap"
								data-testid="subagent-tool-output"
							>
								{output}
							</pre>
						) : null}
					</div>
				);
			})}
		</div>
	);
}

/**
 * The live view of one subagent: its numbers, assignment, transcript as it streams, and a box to steer it. In the Agents
 * tab it has its own header (the way back to the list, Stop, Full screen); `header` replaces that for the full screen,
 * which also gives the transcript a readable width instead of the panel's.
 */
export function AgentDetail({
	row,
	rows,
	live,
	header,
	onOpenAgent,
}: {
	row: AgentRow;
	rows: AgentRow[];
	live: LiveState | undefined;
	header?: ReactNode;
	/**
	 * Where another subagent of the conversation opens (its parent, a child, one a task card started), for a view that is
	 * neither the Agents tab nor the full screen (the agent graph, #719). Absent: the tab's or the full screen's own way.
	 */
	onOpenAgent?: (id: string) => void;
}) {
	const wide = header !== undefined;
	const open = (id: string) => (onOpenAgent ? onOpenAgent(id) : wide ? showAgentFull(id) : selectAgent(id));
	const t = useT();
	const toast = useApp((s) => s.toast);
	const [msg, setMsg] = useState("");
	const liveId = live && !live.info.exited ? live.info.liveId : null;
	// Behind a full screen of the same subagent (the panel stays mounted under it) it does not read its transcript too.
	const behind = useApp((s) => !wide && s.view.kind === "chat" && s.view.agent !== undefined);
	const { entries, error } = useSubagentTranscript(row, liveId, !behind);
	const results = useMemo(() => toolResultsById(entries), [entries]);
	const path = useMemo(() => pathTo(indexTree(entries), entries.at(-1)?.id ?? null), [entries]);
	const tools = row.live?.tools ?? NO_TOOLS;
	const streaming = row.live?.streaming;
	const tail = pendingTail(streaming, row.live?.streamEnded, entries);
	const now = useNow(row.running ? 1000 : null);
	const view = waitOf(row, live, now);
	const elapsed = elapsedMs(row, now);
	const { tokens, cost } = rowTotals(row);
	const children = childRows(rows, row.id);
	const parent = parentId(row.id);
	const parentRow = parent ? rows.find((r) => r.id === parent) : undefined;
	const initial = useMemo(() => assignmentOfInit(entries), [entries]);
	const assignment = assignmentOfRow(row, initial);
	const model = row.live?.progress?.resolvedModel;
	const ctx = rowContext(row);
	// A task card inside this subagent's transcript opens the subagents it started, which are named after it.
	const actions = useMemo(
		() => ({
			openSubagent: (toolCallId: string) => {
				if (!onOpenAgent) return openAgentForToolCall(toolCallId, entries, row.id);
				const started = subagentsForToolCall(rows, toolCallId, toolCallArguments(entries, toolCallId), row.id);
				if (started[0]) onOpenAgent(started[0].id);
			},
			subagentOwner: row.id,
		}),
		[entries, row.id, rows, onOpenAgent],
	);

	// Follow the end while content arrives, unless the reader has scrolled up to read (see `useFollowEnd`).
	const scroller = useRef<HTMLDivElement>(null);
	const content = useRef<HTMLDivElement>(null);
	const { following, atEnd, setAtEnd, pin, scrolled } = useFollowEnd();
	// biome-ignore lint/correctness/useExhaustiveDependencies: new entries, a longer message or tool output move the end.
	useLayoutEffect(() => {
		const el = scroller.current;
		if (el && following.current) pin(el);
	}, [entries, streaming, tools, following, pin]);
	// The transcript's own box changes height without its content moving: opening or closing the assignment above it
	// takes room from its bottom, and no scroll event follows, so the end would slip below the fold with nothing to
	// say so (no "Jump to latest" either). And its content changes height without a render (a picture decodes, code is
	// coloured). A view that follows the end is pinned to it again whenever either changes size.
	useEffect(() => {
		const el = scroller.current;
		const rows = content.current;
		if (!el || !rows) return;
		const observer = new ResizeObserver(() => {
			if (following.current) pin(el);
		});
		observer.observe(el);
		observer.observe(rows);
		return () => observer.disconnect();
	}, [following, pin]);

	return (
		<div
			className="flex min-h-0 flex-1 flex-col"
			data-testid={wide ? "subagent-full-detail" : "subagent-detail"}
			data-agent-id={row.id}
		>
			{wide ? (
				header
			) : (
				<div className="flex items-center gap-2 border-b border-border px-2 py-2">
					<IconButton label={t("panel.agentBack")} size="sm" onClick={() => selectAgent(null)}>
						<ChevronLeft size={15} />
					</IconButton>
					<StatusIcon status={row.status} />
					<span className="min-w-0 truncate text-sm font-semibold">
						{parentRow ? (
							<button
								type="button"
								className="mr-1 font-normal text-muted hover:text-fg hover:underline"
								data-testid="subagent-parent"
								aria-label={t("panel.agentParent", { name: parentRow.id })}
								onClick={() => open(parentRow.id)}
							>
								{parentRow.id} ›
							</button>
						) : null}
						{parentRow ? row.name : row.id}
					</span>
					<Badge className="ml-auto shrink-0">{statusLabel(t, row.status)}</Badge>
					{row.running && liveId ? <DetailStop liveId={liveId} row={row} rows={rows} live={live} /> : null}
					<IconButton
						label={t("panel.agentFull")}
						size="sm"
						data-testid="subagent-full-enter"
						onClick={(e) => showAgentFull(row.id, e.currentTarget)}
					>
						<Maximize2 size={14} />
					</IconButton>
				</div>
			)}
			{/* Three equal columns where they fit; in a narrow column (the graph's detail on a phone) a figure goes whole to the
			    next row instead of wrapping or running into the next one (#789). */}
			<div className="flex flex-wrap gap-x-3 gap-y-2 border-b border-border p-3 text-center text-xs">
				<div className={STAT}>
					<div className="text-sm font-semibold tabular-nums">{fmtTokens(tokens)}</div>
					<div className="text-faint">{t("panel.agentTokens")}</div>
				</div>
				<div className={STAT} title={fmtCostExact(cost)}>
					<div className="text-sm font-semibold tabular-nums">{fmtCost(cost)}</div>
					<div className="text-faint">{t("panel.agentCost")}</div>
				</div>
				<div className={STAT}>
					<div className="text-sm font-semibold tabular-nums" data-testid="subagent-detail-elapsed">
						{elapsed === undefined ? "—" : fmtElapsed(elapsed)}
					</div>
					<div className="text-faint">{t("panel.agentTime")}</div>
				</div>
			</div>
			{row.agent || model || ctx ? (
				<div className="flex flex-wrap items-center gap-1.5 border-b border-border px-3 py-1.5 text-xs text-muted">
					{row.agent ? <Badge>{row.agent}</Badge> : null}
					{model ? <span className="font-mono">{model}</span> : null}
					<ContextPercent ctx={ctx} className="ml-auto" />
				</div>
			) : null}
			{view ? (
				<div className="border-b border-border bg-warning/10 px-3 py-1.5 text-xs text-fg">
					<div className="tabular-nums" data-testid="subagent-detail-wait" data-phase={view.phase}>
						{waitText(t, view, now)}
					</div>
					{/* A wait the page can have retried now is retried from the Stop menu in the header ("Stop and continue"), for a
					    subagent the main agent started: that agent brings it back (see `continuePrompt`). One a subagent started
					    belongs to that subagent, which the page cannot ask: it says so rather than leaving the wait unexplained. */}
					{liveId && canContinue(view, Boolean(live?.info.pausedAt)) && !startedByMainAgent(rows, row) ? (
						<div className="mt-1 text-muted" data-testid="subagent-wait-hint">
							{t("chat.agentRetryNestedHint")}
						</div>
					) : null}
				</div>
			) : null}
			{/* The assignment is pinned above the transcript, not in it: it says what the subagent was asked to do, and
			    that has to stay in view while its work is read. */}
			{assignment ? <AssignmentDetails assignment={assignment} /> : null}
			{/* The transcript keeps a minimum height: the assignment above it gives way to it, however little room the
			    window leaves the view (a phone held sideways), instead of leaving it a line. */}
			<div className="relative flex min-h-24 flex-1 flex-col">
				<div
					ref={scroller}
					className={cx(
						"min-h-0 flex-1 overflow-y-auto py-3 text-sm",
						// The full screen keeps the transcript to a readable column, centred; the panel is as wide as it is.
						wide ? "px-[max(0.75rem,calc(50%_-_24rem))]" : "px-3",
					)}
					data-testid="subagent-scroll"
					data-following={atEnd}
					onScroll={(e) => scrolled(e.currentTarget)}
				>
					<div ref={content} className="space-y-4">
						{children.length ? (
							<div className="rounded-lg border border-border bg-surface p-2" data-testid="subagent-children">
								<div className="mb-1 text-xs font-medium text-faint">{t("panel.agentChildren")}</div>
								<ul className="space-y-0.5">
									{children.map((c) => (
										<li key={c.id}>
											<button
												type="button"
												className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-hover"
												data-testid="subagent-child"
												data-agent-id={c.id}
												onClick={() => open(c.id)}
											>
												<StatusIcon status={c.status} />
												<span className="truncate font-medium">{c.name}</span>
												<span className="min-w-0 flex-1 truncate text-muted">
													{c.live?.description ?? c.live?.progress?.description}
												</span>
											</button>
										</li>
									))}
								</ul>
							</div>
						) : null}
						{error ? <div className="text-xs text-danger">{error}</div> : null}
						{!row.file && !entries.length && !tail ? (
							<div className="text-xs text-muted">{t("panel.agentNoTranscript")}</div>
						) : null}
						{path.map((e) => {
							const m = messageOf(e);
							if (!m || m.role === "toolResult") return null;
							return (
								<MessageRow
									key={e.id}
									entry={e}
									message={m}
									toolResults={results}
									tools={tools}
									actions={actions}
									readOnly
								/>
							);
						})}
						{tail ? (
							<MessageRow
								entry={null}
								message={tail}
								toolResults={results}
								tools={tools}
								actions={actions}
								streaming={!row.live?.streamEnded}
								readOnly
							/>
						) : null}
						{row.running ? <RunningTools tools={tools} /> : null}
					</div>
				</div>
				{atEnd ? null : (
					<button
						type="button"
						className="absolute bottom-2 left-1/2 flex -translate-x-1/2 items-center gap-1 rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-muted shadow-lg hover:text-fg"
						onClick={() => {
							const el = scroller.current;
							if (!el) return;
							// A glide to the end (smooth) aims at where the end is when it starts: while the subagent writes it ends
							// short, still not following. One that is writing is gone to at once.
							if (row.running) {
								setAtEnd(true);
								pin(el);
							} else glideToEnd(el);
						}}
					>
						<ArrowDown size={12} /> {t("panel.agentJumpLatest")}
					</button>
				)}
			</div>
			{row.running && liveId ? (
				<>
					{view && view.phase !== "running" ? (
						<div
							className={cx(
								"border-t border-border pt-1.5 text-xs text-muted",
								wide ? "px-[max(0.5rem,calc(50%_-_24rem))]" : "px-2",
							)}
							data-testid="subagent-steer-note"
						>
							{t("chat.agentSteerNote")}
						</div>
					) : null}
					<form
						className={cx(
							"flex gap-1.5 py-2",
							view && view.phase !== "running" ? "" : "border-t border-border",
							wide ? "px-[max(0.5rem,calc(50%_-_24rem))]" : "px-2",
						)}
						data-panel-bar
						onSubmit={(e) => {
							e.preventDefault();
							if (!msg.trim()) return;
							socket
								.act(liveId, { type: "steer_subagent", subagentId: row.id, message: msg.trim() })
								.then(() => setMsg(""))
								.catch((err) => toast("error", err.message));
						}}
					>
						<input
							aria-label={t("panel.agentMessageAria")}
							placeholder={t("panel.agentSteerPlaceholder")}
							value={msg}
							onChange={(e) => setMsg(e.target.value)}
							className="min-w-0 flex-1 rounded-lg border border-border bg-surface px-2.5 py-1.5 text-xs outline-none focus:border-faint"
						/>
						<IconButton label={t("panel.agentSend")} type="submit">
							<Send size={14} />
						</IconButton>
					</form>
				</>
			) : null}
		</div>
	);
}
