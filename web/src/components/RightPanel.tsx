import type { PanelTab } from "@shared/panes.ts";
import type { FamilyStats, SessionEntry, SessionFileData } from "@shared/protocol.ts";
import {
	Bot,
	CircleDot,
	Cpu,
	FolderGit2,
	FolderTree,
	GitBranch,
	Hourglass,
	Info,
	ListChecks,
	ListTodo,
	MessageCircleQuestion,
	Sparkles,
	SquareTerminal,
} from "lucide-react";
import { lazy, type ReactNode, type RefObject, Suspense, useEffect, useMemo, useRef, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { fmtElapsed } from "../lib/clock.ts";
import type { Family } from "../lib/family.ts";
import { fmtCost, fmtCostExact, fmtRelative, fmtTokens } from "../lib/format.ts";
import { PANEL_SHEET_QUERY, useMediaQuery } from "../lib/media.ts";
import { blocks, messageOf } from "../lib/messages.ts";
import { useLayout } from "../lib/panel-widths.ts";
import { useStable } from "../lib/stable.ts";
import type { StartLive } from "../lib/start-live.ts";
import { jobRows } from "../lib/subagents.ts";
import { summarizeTodos } from "../lib/todos.ts";
import { type ConversationTotals, usageByModel } from "../lib/totals.ts";
import { activeMs } from "../lib/turn-stats.ts";
import { socket } from "../lib/ws.ts";
import { useAgentRows } from "../store/agents.ts";
import { dismissOverlays, useApp } from "../store/app.ts";
import type { LiveState } from "../store/live.ts";
import { Agents } from "./Agents.tsx";
import { BtwPanel } from "./BtwPanel.tsx";
import type { TurnSource } from "./changes/ChangesView.tsx";
import { FilesTab } from "./files/FilesTab.tsx";
import { HostTab } from "./HostTab.tsx";
import { JobsPane } from "./JobsBlock.tsx";
import { Pane, PaneSplit, type TabDefs } from "./PanelPanes.tsx";
import { ResizeHandle } from "./ResizeHandle.tsx";
import { ScrollPane } from "./ScrollPane.tsx";
import { TodoEditList } from "./TodoEditor.tsx";
import { TodoList, TodoProgress } from "./TodoList.tsx";
import { TodoReminderRow } from "./TodoStrip.tsx";
import { cx, Empty } from "./ui.tsx";

// The model guidance a conversation carries (#641), edited in its own tab (#715); read only when that tab is shown, so a chunk
// of its own with its strings (`lib/guidance-strings.ts`).
const GuidanceEditor = lazy(() => import("./GuidanceEditor.tsx").then((m) => ({ default: m.GuidanceEditor })));
// The folder's GitHub issues (#653): asked of `gh` only when the tab is shown, so a chunk of its own with its strings.
const IssuesTab = lazy(() => import("./IssuesTab.tsx").then((m) => ({ default: m.IssuesTab })));
// The Terminal tab (v0.11.18 §8): xterm.js and the shell's code are a chunk of their own, fetched when the tab is shown.
const ShellTab = lazy(() => import("./ShellTab.tsx").then((m) => ({ default: m.ShellTab })));
const QuestionsTab = lazy(() => import("./QuestionsPage.tsx").then((m) => ({ default: m.QuestionsTab })));
const WorktreesTab = lazy(() => import("./WorktreesTab.tsx").then((m) => ({ default: m.WorktreesTab })));

const NO_ENTRIES: readonly SessionEntry[] = [];
interface Props {
	live: LiveState | undefined;
	file: string | null;
	family: Family;
	/** The conversation's path as the page draws it, oldest first: what the Changes view reads of each turn. */
	entries?: readonly SessionEntry[];
	onClose: () => void;
	onNavigate: (file: string) => void;
	/** Starts omp for the conversation when none runs, for the Ask tab (see `StartLive`). */
	start?: StartLive;
	/** What the server adds the whole file up to, when the page holds only a part of it (see `usageByModel`). */
	figures?: FamilyStats | null;
	/** What the conversation has used, as the header counts it: its own requests, its subagents' and its advisors'. */
	totals: ConversationTotals;
}

/**
 * The chat's side panel: two panes, each with a row of the panel's tabs (a tab is in one row only) and the tab it shows (see
 * `lib/panel-panes.ts` for what is remembered). Other parts of the UI (a task card, the running-agents count, the task strip)
 * show a tab through `showPanelTab`. Below `lg` the panel is a sheet: one pane that lists every tab.
 */
export function RightPanel({ live, file, family, entries, onClose, onNavigate, start, figures, totals }: Props) {
	const fileData = family.files.find((f) => f.file === file);
	const agents = useAgentRows(file, live);
	const running = agents.filter((a) => a.running).length;
	const todos = useMemo(() => summarizeTodos(live?.state?.todoPhases), [live?.state?.todoPhases]);
	const jobs = useMemo(() => jobRows(live?.subagents), [live?.subagents]);
	const jobsRunning = jobs.filter((j) => j.running).length;
	// The conversation's open questions (#693), which the server counts for every page.
	const questionsOpen = useApp((s) => (file ? (s.meta?.questions?.byConversation[file] ?? 0) : 0));
	const t = useT();
	// What the conversation's turns changed, for the Files tab's Changes view: asked for by that view when it needs it, through a
	// function that never changes, so that this panel's redraws do not reach the tab.
	const headerCwd = fileData?.header?.cwd;
	const getTurns = useStable(
		(): TurnSource => ({
			entries: entries ?? NO_ENTRIES,
			results: family.toolResults,
			cwds: [live?.info.cwd, typeof headerCwd === "string" ? headerCwd : undefined].filter((c): c is string => !!c),
		}),
	);
	// Below `lg` the panel is a sheet over the conversation: Escape (or a tap beside it) closes it, and focus goes
	// into it and back to whatever opened it. Beside the conversation it is just a column.
	const sheet = useMediaQuery(PANEL_SHEET_QUERY);
	const panel = useRef<HTMLElement>(null);
	const closeRef = useRef(onClose);
	useEffect(() => {
		closeRef.current = onClose;
	});
	useEffect(() => {
		if (!sheet) return;
		const onKey = (e: KeyboardEvent) => {
			// A dialog, menu or tooltip opened from the panel has taken Escape for itself.
			if (e.key !== "Escape" || e.defaultPrevented) return;
			// An overlay opened over the sheet takes this Escape, even before it has registered as the top layer.
			if (dismissOverlays()) e.preventDefault();
			else closeRef.current();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [sheet]);
	useEffect(() => {
		if (!matchMedia(PANEL_SHEET_QUERY).matches) return;
		const opener = document.activeElement;
		panel.current?.focus();
		return () => {
			if (opener instanceof HTMLElement && opener !== document.body && opener.isConnected) opener.focus();
		};
	}, []);
	// By id, so that a tab added to `PANEL_TABS` is not drawn until it is defined here; the layout says where each is listed.
	const tabs: TabDefs = {
		agents: {
			Icon: Bot,
			label: t("panel.tabAgents"),
			// The panel opens on the tab last looked at, which may not be this one: subagents at work are shown on the tab
			// as a badge instead of the panel taking another tab by itself.
			count: agents.length ? `${running ? `${running}/` : ""}${agents.length}` : "",
			busy: running > 0,
			title: running ? t("panel.tabAgentsRunning", { n: running }) : undefined,
		},
		todos: {
			Icon: ListTodo,
			label: t("panel.tabTodos"),
			count: todos.total ? `${todos.done}/${todos.total}` : "",
		},
		jobs: {
			Icon: Hourglass,
			label: t("panel.tabJobs"),
			count: jobs.length ? `${jobsRunning ? `${jobsRunning}/` : ""}${jobs.length}` : "",
		},
		files: { Icon: FolderTree, label: t("panel.tabFiles"), count: "" },
		issues: { Icon: CircleDot, label: t("panel.tabIssues"), count: "" },
		info: { Icon: Info, label: t("panel.tabInfo"), count: "" },
		tree: { Icon: GitBranch, label: t("panel.tabBranches"), count: "" },
		btw: { Icon: MessageCircleQuestion, label: t("panel.tabAsk"), count: "" },
		host: { Icon: Cpu, label: t("panel.tabHost"), count: "" },
		terminal: { Icon: SquareTerminal, label: t("panel.tabTerminal"), count: "" },
		guidance: { Icon: Sparkles, label: t("panel.tabGuidance"), count: "" },
		questions: { Icon: ListChecks, label: t("panel.tabQuestions"), count: questionsOpen ? String(questionsOpen) : "" },
		worktrees: { Icon: FolderGit2, label: t("panel.tabWorktrees"), count: "" },
	};
	const body = (tab: PanelTab): ReactNode => {
		switch (tab) {
			case "agents":
				return <Agents file={file} live={live} />;
			case "todos":
				return (
					<ScrollPane className="min-h-0 flex-1 overflow-y-auto p-3">
						{live && !live.info.exited ? (
							<>
								{live.todoReminder && todos.total > todos.done ? (
									<TodoReminderRow
										reminder={live.todoReminder}
										className="mb-3 rounded-lg border border-border bg-surface"
									/>
								) : null}
								{todos.total ? (
									<div className="mb-3">
										<TodoProgress summary={todos} />
									</div>
								) : null}
								<TodoEditList
									live={live}
									empty={
										<Empty icon={<ListTodo size={22} />} title={t("panel.todosEmptyTitle")}>
											{t("panel.todosEmptyLive")}
										</Empty>
									}
								/>
							</>
						) : todos.total ? (
							<>
								<div className="mb-3">
									<TodoProgress summary={todos} />
								</div>
								<TodoList summary={todos} />
							</>
						) : (
							<Empty icon={<ListTodo size={22} />} title={t("panel.todosEmptyTitle")}>
								{live ? t("panel.todosEmptyLive") : t("panel.todosEmptyClosed")}
							</Empty>
						)}
					</ScrollPane>
				);
			case "jobs":
				return <JobsPane live={live} />;
			case "files":
				return (
					<FilesTab liveId={live && !live.info.exited ? live.info.liveId : null} file={file} getTurns={getTurns} />
				);
			case "issues":
				return (
					<Suspense fallback={null}>
						<IssuesTab cwd={live?.info.cwd ?? (typeof headerCwd === "string" ? headerCwd : null)} />
					</Suspense>
				);
			case "info":
				return (
					<ScrollPane className="min-h-0 flex-1 overflow-y-auto p-3">
						<SessionInfo live={live} file={file} fileData={fileData} figures={figures} totals={totals} />
					</ScrollPane>
				);
			case "guidance":
				return (
					<ScrollPane className="min-h-0 flex-1 overflow-y-auto p-3">
						{(live && !live.info.exited) || file ? (
							<Suspense fallback={null}>
								<GuidanceEditor liveId={live && !live.info.exited ? live.info.liveId : null} file={file} />
							</Suspense>
						) : (
							<Empty icon={<Sparkles size={22} />} title={t("panel.tabGuidance")}>
								{t("panel.guidanceNoProcess")}
							</Empty>
						)}
					</ScrollPane>
				);
			case "questions":
				return (
					<Suspense fallback={null}>
						<QuestionsTab file={file} />
					</Suspense>
				);
			case "worktrees":
				return (
					<Suspense fallback={null}>
						<WorktreesTab cwd={live?.info.cwd ?? (typeof headerCwd === "string" ? headerCwd : null)} />
					</Suspense>
				);
			case "tree":
				return (
					<ScrollPane className="min-h-0 flex-1 overflow-y-auto p-3">
						<Branches family={family} file={file} onNavigate={onNavigate} />
					</ScrollPane>
				);
			case "btw":
				return (
					<div className="min-h-0 flex-1">
						<BtwPanel live={live} start={start} />
					</div>
				);
			case "host":
				return <HostTab />;
			case "terminal": {
				// One shell per conversation: by its file, or by its process until omp has written one.
				const key = file ?? (live ? `live:${live.info.liveId}` : null);
				if (!key)
					return (
						<Empty icon={<SquareTerminal size={22} />} title={t("panel.tabTerminal")}>
							{t("panel.terminalNoConversation")}
						</Empty>
					);
				return (
					<Suspense fallback={null}>
						<ShellTab
							conversation={key}
							liveKey={live ? `live:${live.info.liveId}` : null}
							cwd={live?.info.cwd ?? (typeof headerCwd === "string" ? headerCwd : undefined)}
						/>
					</Suspense>
				);
			}
		}
	};
	return (
		<>
			{sheet ? (
				<div
					className="fixed inset-0 z-30 bg-black/40"
					aria-hidden
					data-testid="right-panel-backdrop"
					onClick={onClose}
				/>
			) : null}
			<PanelFrame frame={panel} sheet={sheet}>
				{sheet ? (
					<Pane pane="top" defs={tabs} body={body} first sheet onClose={onClose} />
				) : (
					<PaneSplit defs={tabs} body={body} onClose={onClose} />
				)}
			</PanelFrame>
		</>
	);
}

/**
 * The panel's box. Beside the conversation it is a column of the remembered width with a drag handle on its left
 * edge; as a sheet it keeps its fixed size. Dragging re-renders only this frame, not the tabs inside it.
 */
function PanelFrame({
	frame,
	sheet,
	children,
}: {
	frame: RefObject<HTMLElement | null>;
	sheet: boolean;
	children: ReactNode;
}) {
	const t = useT();
	const { width } = useLayout();
	return (
		<aside
			ref={frame}
			tabIndex={-1}
			className={cx(
				"flex flex-col border-l border-border bg-bg-soft outline-none",
				// `fixed` and `relative` are competing position utilities, and the stylesheet's order picks the winner: each
				// layout names its own, so a sheet is really laid over the page instead of sitting beside the transcript.
				sheet ? "fixed inset-y-0 right-0 z-30 w-[min(25rem,calc(100vw-3rem))] shadow-2xl" : "relative h-full shrink-0",
			)}
			style={sheet ? undefined : { width: width.panel }}
			aria-label={t("panel.rightAria")}
			data-testid="right-panel"
			// A popover opened from inside (the Files tab's transfer panel) keeps within the panel, not the whole window.
			data-popover-boundary
		>
			{sheet ? null : <ResizeHandle kind="panel" label={t("panel.resizePanel")} className="left-0" />}
			{children}
		</aside>
	);
}

/** What of omp's `get_session_stats` is shown: the counts of its messages and tool calls. */
interface SessionStats {
	userMessages: number;
	assistantMessages: number;
	toolCalls: number;
}

/**
 * The conversation's figures. The tokens and the cost are the header's account (`useConversationTotals`): the whole file,
 * `model_usage` requests (omp's judges) included, with its subagents and advisors. omp's own `get_session_stats` sums the
 * messages it holds in context, which leaves out what a compaction dropped, its advisors and the subagents it did not start
 * through `task` (#687): it is asked only for how many messages and tool calls there are, and only while it runs.
 */
function SessionInfo({
	live,
	file,
	fileData,
	figures,
	totals,
}: {
	live: LiveState | undefined;
	file: string | null;
	fileData: SessionFileData | undefined;
	figures?: FamilyStats | null;
	totals: ConversationTotals;
}) {
	const t = useT();
	const [stats, setStats] = useState<SessionStats | null>(null);
	const liveId = live && !live.info.exited ? live.info.liveId : null;
	const entriesKey = live?.entries.length ?? 0;
	// biome-ignore lint/correctness/useExhaustiveDependencies: entriesKey re-fetches omp's stats after each new entry.
	useEffect(() => {
		if (!liveId) return setStats(null);
		socket
			.rpc<SessionStats>(liveId, { type: "get_session_stats" })
			.then(setStats)
			.catch(() => setStats(null));
	}, [liveId, entriesKey]);
	const summary = useApp((s) => s.sessions.find((x) => x.file === file));
	const entries = live?.entries.length ? live.entries : (fileData?.entries ?? NO_ENTRIES);
	const byModel = useMemo(() => usageByModel(entries, figures), [entries, figures]);
	// How long the agent has worked in all (#692): its own turns (the whole file's clock, `figures`, when the page holds a
	// part of it) and every subagent's, nested ones included, as their saved transcripts count it.
	const ownMs = useMemo(() => activeMs(entries, figures), [entries, figures]);
	const workedMs = ownMs + totals.subagentActiveMs;
	// First element is the stable English id exposed as `data-stat` (E2E selects on it); second is the label.
	const rows: [string, string, string][] = [];
	if (stats) {
		rows.push([
			"Messages",
			t("panel.statMessages"),
			t("panel.statMessagesValue", { user: stats.userMessages, assistant: stats.assistantMessages }),
		]);
		rows.push(["Tool calls", t("panel.statToolCalls"), String(stats.toolCalls)]);
	} else if (summary) rows.push(["Messages", t("panel.statMessages"), String(summary.messageCount)]);
	const { usage, subagents, advisor } = totals;
	if (stats || summary || usage.cost > 0) {
		rows.push(["Input tokens", t("panel.statInputTokens"), usage.input.toLocaleString()]);
		rows.push(["Output tokens", t("panel.statOutputTokens"), usage.output.toLocaleString()]);
		rows.push(["Cache read", t("panel.statCacheRead"), usage.cacheRead.toLocaleString()]);
		rows.push(["Cache write", t("panel.statCacheWrite"), usage.cacheWrite.toLocaleString()]);
		rows.push(["Total cost", t("panel.statTotalCost"), fmtCostExact(totals.total.cost)]);
		if (subagents.count > 0) rows.push(["Subagent cost", t("panel.statSubagentCost"), fmtCostExact(subagents.cost)]);
		if (advisor.requests > 0) rows.push(["Advisor cost", t("panel.statAdvisorCost"), fmtCostExact(advisor.cost)]);
	}
	if (workedMs >= 1000) {
		const time = fmtElapsed(workedMs);
		rows.push([
			"Time worked",
			t("panel.statActive"),
			totals.subagentActiveMs >= 1000
				? t("panel.statActiveValue", { time, sub: fmtElapsed(totals.subagentActiveMs) })
				: time,
		]);
	}
	return (
		<div className="space-y-4 text-sm" data-testid="session-info">
			<dl className="divide-y divide-border rounded-xl border border-border bg-surface">
				{rows.map(([k, label, v]) => (
					<div key={k} className="flex justify-between gap-3 px-3 py-1.5">
						<dt className="text-muted">{label}</dt>
						<dd className="font-mono text-xs tabular-nums" data-stat={k}>
							{v}
						</dd>
					</div>
				))}
			</dl>
			{stats ? (
				<div className="text-xs text-faint">
					{t("panel.statsLive")} <code>get_session_stats</code>
					{t("panel.statsLiveEnd")}
				</div>
			) : null}
			{byModel.length ? (
				<div>
					<div className="mb-1.5 text-xs font-semibold">{t("panel.infoByModel")}</div>
					{byModel.map(([k, v]) => (
						<div key={k} className="flex justify-between py-0.5 text-xs">
							<span className="truncate text-muted">{k}</span>
							<span className="tabular-nums">
								{t("panel.infoByModelRow", { n: v.n, tokens: fmtTokens(v.tokens), cost: fmtCost(v.cost) })}
							</span>
						</div>
					))}
				</div>
			) : null}
			<div className="space-y-1 text-xs text-faint break-all">
				{file ? <div>{t("panel.infoFile", { file })}</div> : null}
				{live?.info.sessionId ? <div>{t("panel.infoSession", { id: live.info.sessionId })}</div> : null}
				{live?.info.pid ? <div>{t("panel.infoProcess", { pid: live.info.pid })}</div> : null}
			</div>
		</div>
	);
}

function Branches({
	family,
	file,
	onNavigate,
}: {
	family: Family;
	file: string | null;
	onNavigate: (file: string) => void;
}) {
	const sessions = useApp((s) => s.sessions);
	const t = useT();
	if (family.files.length < 2) {
		return (
			<Empty icon={<GitBranch size={22} />} title={t("panel.branchesEmptyTitle")}>
				{t("panel.branchesEmptyBody")}
			</Empty>
		);
	}
	return (
		<ul className="space-y-1" data-testid="branch-list">
			{family.files.map((f) => {
				const s = sessions.find((x) => x.file === f.file);
				const last = f.entries.findLast((e) => messageOf(e)?.role === "user");
				const m = last ? messageOf(last) : null;
				// A file the page holds a stretch of, or none of, says its last prompt itself.
				const text = f.lastPrompt ?? (m ? (blocks(m).find((b) => b.type === "text")?.text ?? "") : "");
				return (
					<li key={f.file}>
						<button
							type="button"
							onClick={() => onNavigate(f.file)}
							className={cx(
								"w-full rounded-lg border px-3 py-2 text-left text-xs",
								f.file === file ? "border-accent bg-accent-soft" : "border-border hover:bg-hover",
							)}
						>
							<div className="flex items-center gap-1.5 font-medium">
								<GitBranch size={12} />
								<span className="truncate">{s?.title || s?.preview || f.file.split("/").pop()}</span>
							</div>
							<div className="mt-0.5 truncate text-muted">{t("panel.branchLastPrompt", { text: text || "—" })}</div>
							<div className="mt-0.5 text-faint">
								{t("panel.branchEntries", { n: f.total ?? f.entries.length })}
								{s ? ` · ${fmtRelative(s.modifiedAt)}` : ""}
							</div>
						</button>
					</li>
				);
			})}
		</ul>
	);
}
