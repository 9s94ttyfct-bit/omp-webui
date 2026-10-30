import { Ban, Circle, CircleAlert, CircleCheck, CircleDot, type LucideIcon } from "lucide-react";
import "../i18n/later.ts";
import { type MessageKey, useT } from "../i18n/index.ts";
import { type TodoSummary, withKeys } from "../lib/todos.ts";
import { cx } from "./ui.tsx";

/** The todo list as the TUI's TODO panel shows it: phases with their done/total, tasks with their state and blockers. */

const STATUS: Record<string, { Icon: LucideIcon; tone: string; label: MessageKey }> = {
	completed: { Icon: CircleCheck, tone: "text-success", label: "panel.todoStatusDone" },
	in_progress: { Icon: CircleDot, tone: "text-accent", label: "panel.todoStatusInProgress" },
	blocked: { Icon: CircleAlert, tone: "text-warning", label: "panel.todoStatusBlocked" },
	abandoned: { Icon: Ban, tone: "text-faint", label: "panel.todoStatusAbandoned" },
	pending: { Icon: Circle, tone: "text-faint", label: "panel.todoStatusPending" },
};

/** The state icon of a task; what omp does not name yet is pending. */
export function statusOf(status: string) {
	return Object.hasOwn(STATUS, status) ? STATUS[status] : STATUS.pending;
}

/** `3 of 7 done · 1 blocked`, with a bar. */
export function TodoProgress({ summary }: { summary: TodoSummary }) {
	const t = useT();
	const pct = summary.total ? (summary.done / summary.total) * 100 : 0;
	return (
		<div className="flex items-center gap-2 text-xs text-muted" data-testid="todo-overview">
			<div
				className="h-1.5 w-20 shrink-0 overflow-hidden rounded-full bg-hover"
				role="progressbar"
				aria-valuemin={0}
				aria-valuemax={summary.total}
				aria-valuenow={summary.done}
				aria-label={t("panel.todosSummary", { done: summary.done, total: summary.total })}
			>
				<div className="h-full rounded-full bg-accent" style={{ width: `${pct}%` }} />
			</div>
			<span className="tabular-nums" data-testid="todo-summary">
				{t("panel.todosSummary", { done: summary.done, total: summary.total })}
			</span>
			{summary.blocked > 0 ? (
				<span className="tabular-nums text-warning" data-testid="todo-blocked-count">
					· {t("panel.todosBlockedCount", { n: summary.blocked })}
				</span>
			) : null}
		</div>
	);
}

export function TodoList({ summary }: { summary: TodoSummary }) {
	const t = useT();
	return (
		<div data-testid="todo-list">
			{withKeys(summary.phases, (p) => p.name).map(({ key, item: p }) => (
				<section key={key} className="mb-3 last:mb-0" data-testid="todo-phase">
					<div className="mb-1 flex items-baseline gap-2 text-xs font-semibold">
						<span className="min-w-0 truncate">{p.name}</span>
						<span className="shrink-0 font-normal tabular-nums text-faint" data-testid="todo-phase-count">
							{p.done}/{p.tasks.length}
						</span>
					</div>
					<ul className="space-y-1">
						{withKeys(p.tasks, (task) => task.content).map(({ key: taskKey, item: task }) => {
							const { Icon, tone, label } = statusOf(task.status);
							const over = task.status === "completed" || task.status === "abandoned";
							return (
								<li
									key={taskKey}
									className="flex items-start gap-2 text-sm"
									data-testid="todo-task"
									data-status={task.status}
								>
									<Icon size={14} className={cx("mt-0.5 shrink-0", tone)} aria-hidden />
									<div className="min-w-0">
										<span className={cx(over && "text-faint line-through")}>{task.content}</span>
										<span className="sr-only"> ({t(label)})</span>
										{task.status === "blocked" ? (
											<div className="text-xs text-warning" data-testid="todo-blocker">
												{task.blocker
													? t("panel.todoBlockedBy", { reason: task.blocker })
													: t("panel.todoStatusBlocked")}
											</div>
										) : null}
									</div>
								</li>
							);
						})}
					</ul>
				</section>
			))}
		</div>
	);
}
