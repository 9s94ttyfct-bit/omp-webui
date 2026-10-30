import { ChevronRight, ListTodo, PanelRight, TriangleAlert } from "lucide-react";
import { useMemo, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { showPanelTab, useShownInPanel } from "../lib/panel-panes.ts";
import { summarizeTodos } from "../lib/todos.ts";
import type { LiveState, TodoReminder } from "../store/live.ts";
import { TodoEditList } from "./TodoEditor.tsx";
import { TodoProgress } from "./TodoList.tsx";
import { cx, IconButton } from "./ui.tsx";

/**
 * omp's reminder to finish the list, as a row of its own: in the strip above the composer, and at the top of the Todos tab
 * when a pane of the side panel shows that and the strip is not drawn.
 */
export function TodoReminderRow({ reminder, className }: { reminder: TodoReminder; className?: string }) {
	const t = useT();
	return (
		<div
			className={cx("flex items-start gap-2 px-3 py-1.5 text-xs text-warning", className)}
			role="status"
			data-testid="todo-reminder"
			data-attempt={reminder.attempt}
			title={reminder.todos.map((todo) => todo.content).join("\n")}
		>
			<TriangleAlert size={13} className="mt-px shrink-0" aria-hidden />
			<span>
				{t(reminder.todos.length === 1 ? "panel.todoReminderOne" : "panel.todoReminder", {
					n: reminder.todos.length,
					attempt: reminder.attempt,
					max: reminder.maxAttempts,
				})}
			</span>
		</div>
	);
}

/**
 * The TUI's TODO panel, as a strip above the composer next to the goal bar: how far the list is, the task in
 * progress (or the one that is blocked), and a click away the whole list. omp's reminder to finish the list shows as
 * a row of its own. A list that is all done goes away with the turn that finished it. While a pane of the side panel
 * shows the Todos tab the strip is not drawn: the pane has all of it.
 */
export function TodoStrip({ live }: { live: LiveState }) {
	const inPanel = useShownInPanel("todos");
	return inPanel ? null : <TodoStripCard live={live} />;
}

function TodoStripCard({ live }: { live: LiveState }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const phases = live.state?.todoPhases;
	const summary = useMemo(() => summarizeTodos(phases), [phases]);
	const incomplete = summary.total - summary.done;
	// Nothing to show for no list, for a finished one nobody is working on any more, or for a process that is gone.
	if (summary.total === 0 || (incomplete === 0 && !live.streaming) || live.info.exited) return null;

	const reminder = incomplete > 0 ? live.todoReminder : null;
	const focus = summary.current ?? summary.firstBlocked;
	const blockedOnly = !summary.current && summary.firstBlocked !== null;
	const pct = (summary.done / summary.total) * 100;
	return (
		<div className="mb-2 rounded-xl border border-border bg-surface text-sm" data-testid="todo-strip" data-open={open}>
			{reminder ? <TodoReminderRow reminder={reminder} className="border-b border-border" /> : null}
			<div className="flex items-center gap-1 pr-1.5">
				<button
					type="button"
					className="flex min-w-0 flex-1 items-center gap-2 rounded-xl py-1.5 pl-3 text-left"
					aria-expanded={open}
					data-testid="todo-toggle"
					onClick={() => setOpen(!open)}
				>
					<ListTodo size={15} className="shrink-0 text-accent" aria-hidden />
					<span className="sr-only">{t("panel.tabTodos")}</span>
					<span className="shrink-0 text-xs tabular-nums text-muted" data-testid="todo-progress">
						{summary.done}/{summary.total}
					</span>
					<span className="h-1 w-12 shrink-0 overflow-hidden rounded-full bg-hover max-sm:hidden" aria-hidden>
						<span className="block h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
					</span>
					{focus ? (
						<span className="flex min-w-0 flex-1 items-baseline gap-1.5">
							{summary.phases.length > 1 ? (
								<span className="max-w-[30%] shrink-0 truncate text-xs text-faint" data-testid="todo-phase-name">
									{focus.phase}
								</span>
							) : null}
							<span
								className={cx("truncate", blockedOnly && "text-warning")}
								data-testid="todo-current"
								data-status={focus.task.status}
								title={focus.task.content}
							>
								{focus.task.content}
							</span>
						</span>
					) : (
						<span className="min-w-0 flex-1 truncate text-success" data-testid="todo-current" data-status="completed">
							{t("panel.todoStripAllDone")}
						</span>
					)}
					{summary.blocked > 0 ? (
						<span className="shrink-0 text-xs tabular-nums text-warning" data-testid="todo-blocked-badge">
							{t("panel.todosBlockedCount", { n: summary.blocked })}
						</span>
					) : null}
					<ChevronRight
						size={14}
						className={cx("shrink-0 text-faint transition-transform", open && "rotate-90")}
						aria-hidden
					/>
				</button>
				<IconButton
					label={t("panel.todoStripOpenPanel")}
					size="sm"
					data-testid="todo-open-panel"
					onClick={() => showPanelTab("todos")}
				>
					<PanelRight size={14} />
				</IconButton>
			</div>
			{open ? (
				<div className="max-h-72 overflow-y-auto border-t border-border px-3 py-2" data-testid="todo-expanded">
					<div className="mb-2">
						<TodoProgress summary={summary} />
					</div>
					<TodoEditList live={live} />
				</div>
			) : null}
		</div>
	);
}
