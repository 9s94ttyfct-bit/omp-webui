import * as Menu from "@radix-ui/react-dropdown-menu";
import { ArrowDown, ArrowUp, Check, FileText, MoreHorizontal, Pencil, Plus, Trash2, X } from "lucide-react";
import { type ReactNode, useRef, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { controls } from "../lib/api.ts";
import {
	addPhase,
	addTask,
	movePhase,
	moveTask,
	phaseIs,
	removePhase,
	removeTask,
	renamePhase,
	setContent,
	setStatus,
	TODO_STATUSES,
	type TodoStatus,
	taskIs,
	todosToMarkdown,
	toggledStatus,
} from "../lib/todo-edit.ts";
import { type TodoPhase, withKeys } from "../lib/todos.ts";
import { refreshState, useApp } from "../store/app.ts";
import type { LiveState, TodoTask } from "../store/live.ts";
import { statusOf } from "./TodoList.tsx";
import { Button, cx, IconButton, Modal, Spinner } from "./ui.tsx";

/**
 * The todo list of a running conversation, editable: the state icon of a task finishes it (or takes it up again),
 * each task and phase has a menu for the rest (state, text, order, removal), and the footer adds tasks and phases or
 * edits the whole list as Markdown. Every change is a write of the whole list through omp's `/todo import` (see
 * `server/omp/todos.ts`), so what is shown afterwards is what omp reports, including its rule that exactly one task is
 * in progress.
 */

const itemCls =
	"flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none data-[highlighted]:bg-hover data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50";
const menuCls = "z-50 min-w-44 rounded-xl border border-border bg-surface p-1 shadow-2xl";

/**
 * The field that is open: a task's text or blocker, a new task or phase, a phase's name. `p`/`i` say where in the list,
 * and `content`/`phase`/`name` what was there when it was opened: if the list moves on beneath it (the model changes
 * it mid-edit), the field closes instead of landing its text on a different task.
 */
type Draft =
	| { kind: "text"; p: number; i: number; content: string }
	| { kind: "blocker"; p: number; i: number; content: string }
	| { kind: "newTask"; p: number; phase: string }
	| { kind: "phase"; p: number; name: string }
	| { kind: "newPhase" };

interface Ctrl {
	busy: boolean;
	editing: Draft | null;
	setEditing: (d: Draft | null) => void;
	/** Change the list omp reports now; skipped, and said so, when `still` no longer holds of it (the list moved on). */
	run: (still: (cur: TodoPhase[]) => boolean, make: (cur: TodoPhase[]) => TodoPhase[]) => Promise<void>;
}

/** One line of text with Enter to save and Escape to cancel. */
function Entry({
	label,
	placeholder,
	initial = "",
	busy,
	onSave,
	onCancel,
}: {
	label: string;
	placeholder?: string;
	initial?: string;
	busy: boolean;
	onSave: (value: string) => void;
	onCancel: () => void;
}) {
	const t = useT();
	const [value, setValue] = useState(initial);
	return (
		<form
			className="flex min-w-0 items-center gap-1"
			data-testid="todo-entry"
			onSubmit={(e) => {
				e.preventDefault();
				onSave(value);
			}}
		>
			<input
				// biome-ignore lint/a11y/noAutofocus: the user just asked for this field
				autoFocus
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={(e) => {
					if (e.key !== "Escape") return;
					// Not the side panel's: Escape closes this field first.
					e.preventDefault();
					onCancel();
				}}
				aria-label={label}
				placeholder={placeholder}
				disabled={busy}
				className="h-7 min-w-0 flex-1 rounded-md border border-border bg-bg-soft px-2 text-sm outline-none focus:border-faint"
			/>
			<IconButton label={t("common.save")} size="sm" type="submit" disabled={busy}>
				{busy ? <Spinner size={13} /> : <Check size={14} />}
			</IconButton>
			<IconButton label={t("common.cancel")} size="sm" onClick={onCancel} disabled={busy}>
				<X size={14} />
			</IconButton>
		</form>
	);
}

const STATE_LABELS = {
	pending: "panel.todoStatusPending",
	in_progress: "panel.todoStatusInProgress",
	completed: "panel.todoStatusDone",
	blocked: "panel.todoStatusBlocked",
	abandoned: "panel.todoStatusAbandoned",
} as const satisfies Record<TodoStatus, string>;

function TaskRow({ ctrl, p, i, task, last }: { ctrl: Ctrl; p: number; i: number; task: TodoTask; last: boolean }) {
	const t = useT();
	const { Icon, tone, label } = statusOf(task.status);
	const over = task.status === "completed" || task.status === "abandoned";
	const draft = ctrl.editing;
	const open =
		draft &&
		(draft.kind === "text" || draft.kind === "blocker") &&
		draft.p === p &&
		draft.i === i &&
		draft.content === task.content
			? draft
			: null;
	// Choosing "Edit text" opens a field: focus belongs there, not back on the menu's button.
	const toField = useRef(false);
	const here = (cur: TodoPhase[]) => taskIs(cur, p, i, task.content);
	return (
		<li className="flex items-start gap-1" data-testid="todo-task" data-status={task.status}>
			<button
				type="button"
				className="mt-0.5 shrink-0 rounded p-0.5 hover:bg-hover disabled:opacity-50"
				aria-label={t(over ? "panel.todoEditReopen" : "panel.todoEditDone", { task: task.content })}
				disabled={ctrl.busy}
				data-testid="todo-status-button"
				onClick={() => void ctrl.run(here, (cur) => setStatus(cur, p, i, toggledStatus(task.status)))}
			>
				<Icon size={14} className={tone} aria-hidden />
			</button>
			<div className="min-w-0 flex-1 py-0.5">
				{open?.kind === "text" ? (
					<Entry
						label={t("panel.todoEditTextLabel")}
						initial={task.content}
						busy={ctrl.busy}
						onSave={(value) => {
							if (!value.trim()) return;
							void ctrl.run(here, (cur) => setContent(cur, p, i, value));
						}}
						onCancel={() => ctrl.setEditing(null)}
					/>
				) : (
					<span className={cx("break-words", over && "text-faint line-through")} data-testid="todo-task-text">
						{task.content}
					</span>
				)}
				<span className="sr-only"> ({t(label)})</span>
				{open?.kind === "blocker" ? (
					<div className="mt-1">
						<Entry
							label={t("panel.todoEditBlockerLabel")}
							placeholder={t("panel.todoEditBlockerPlaceholder")}
							initial={task.blocker ?? ""}
							busy={ctrl.busy}
							onSave={(value) => void ctrl.run(here, (cur) => setStatus(cur, p, i, "blocked", value))}
							onCancel={() => ctrl.setEditing(null)}
						/>
					</div>
				) : task.status === "blocked" ? (
					<div className="text-xs text-warning" data-testid="todo-blocker">
						{task.blocker ? t("panel.todoBlockedBy", { reason: task.blocker }) : t("panel.todoStatusBlocked")}
					</div>
				) : null}
			</div>
			<Menu.Root>
				<Menu.Trigger asChild>
					<IconButton
						label={t("panel.todoEditTaskMenu", { task: task.content })}
						size="xs"
						disabled={ctrl.busy}
						data-testid="todo-task-menu"
					>
						<MoreHorizontal size={14} />
					</IconButton>
				</Menu.Trigger>
				<Menu.Portal>
					<Menu.Content
						align="end"
						sideOffset={4}
						collisionPadding={12}
						className={menuCls}
						onCloseAutoFocus={(e) => {
							if (!toField.current) return;
							toField.current = false;
							e.preventDefault();
						}}
					>
						<Menu.Label className="px-2 py-1 text-xs uppercase text-faint">{t("panel.todoEditState")}</Menu.Label>
						<Menu.RadioGroup value={task.status}>
							{TODO_STATUSES.map((status) => (
								<Menu.RadioItem
									key={status}
									value={status}
									className={itemCls}
									data-testid={`todo-set-${status}`}
									onSelect={() => {
										if (status === "blocked") {
											// A reason is asked for: the task is blocked once it is given (or left empty).
											toField.current = true;
											ctrl.setEditing({ kind: "blocker", p, i, content: task.content });
											return;
										}
										void ctrl.run(here, (cur) => setStatus(cur, p, i, status));
									}}
								>
									<span className="flex w-4 shrink-0 justify-center">
										<Menu.ItemIndicator>
											<Check size={14} />
										</Menu.ItemIndicator>
									</span>
									{t(STATE_LABELS[status])}
								</Menu.RadioItem>
							))}
						</Menu.RadioGroup>
						<Menu.Separator className="my-1 h-px bg-border" />
						<Menu.Item
							className={itemCls}
							data-testid="todo-edit-text"
							onSelect={() => {
								toField.current = true;
								ctrl.setEditing({ kind: "text", p, i, content: task.content });
							}}
						>
							<Pencil size={14} /> {t("panel.todoEditText")}
						</Menu.Item>
						<Menu.Item
							className={itemCls}
							disabled={i === 0}
							data-testid="todo-move-up"
							onSelect={() => void ctrl.run(here, (cur) => moveTask(cur, p, i, -1))}
						>
							<ArrowUp size={14} /> {t("panel.todoEditMoveUp")}
						</Menu.Item>
						<Menu.Item
							className={itemCls}
							disabled={last}
							data-testid="todo-move-down"
							onSelect={() => void ctrl.run(here, (cur) => moveTask(cur, p, i, 1))}
						>
							<ArrowDown size={14} /> {t("panel.todoEditMoveDown")}
						</Menu.Item>
						<Menu.Separator className="my-1 h-px bg-border" />
						<Menu.Item
							className={cx(itemCls, "text-danger")}
							data-testid="todo-remove-task"
							onSelect={() => void ctrl.run(here, (cur) => removeTask(cur, p, i))}
						>
							<Trash2 size={14} /> {t("panel.todoEditRemove")}
						</Menu.Item>
					</Menu.Content>
				</Menu.Portal>
			</Menu.Root>
		</li>
	);
}

function PhaseSection({ ctrl, p, phase, phases }: { ctrl: Ctrl; p: number; phase: TodoPhase; phases: number }) {
	const t = useT();
	const draft = ctrl.editing;
	const renaming = draft?.kind === "phase" && draft.p === p && draft.name === phase.name;
	const adding = draft?.kind === "newTask" && draft.p === p && draft.phase === phase.name;
	const done = phase.tasks.filter((x) => x.status === "completed" || x.status === "abandoned").length;
	const toField = useRef(false);
	const here = (cur: TodoPhase[]) => phaseIs(cur, p, phase.name);
	return (
		<section className="mb-3 last:mb-0" data-testid="todo-phase">
			<div className="mb-1 flex items-center gap-1.5 text-xs font-semibold">
				{renaming ? (
					<Entry
						label={t("panel.todoEditPhaseLabel")}
						initial={phase.name}
						busy={ctrl.busy}
						onSave={(value) => {
							if (!value.trim()) return;
							void ctrl.run(here, (cur) => renamePhase(cur, p, value));
						}}
						onCancel={() => ctrl.setEditing(null)}
					/>
				) : (
					<>
						<span className="min-w-0 truncate" data-testid="todo-phase-name-text">
							{phase.name}
						</span>
						<span className="shrink-0 font-normal tabular-nums text-faint" data-testid="todo-phase-count">
							{done}/{phase.tasks.length}
						</span>
						<Menu.Root>
							<Menu.Trigger asChild>
								<IconButton
									label={t("panel.todoEditPhaseMenu", { phase: phase.name })}
									size="xs"
									className="ml-auto"
									disabled={ctrl.busy}
									data-testid="todo-phase-menu"
								>
									<MoreHorizontal size={14} />
								</IconButton>
							</Menu.Trigger>
							<Menu.Portal>
								<Menu.Content
									align="end"
									sideOffset={4}
									collisionPadding={12}
									className={menuCls}
									onCloseAutoFocus={(e) => {
										if (!toField.current) return;
										toField.current = false;
										e.preventDefault();
									}}
								>
									<Menu.Item
										className={itemCls}
										data-testid="todo-phase-add-task"
										onSelect={() => {
											toField.current = true;
											ctrl.setEditing({ kind: "newTask", p, phase: phase.name });
										}}
									>
										<Plus size={14} /> {t("panel.todoEditAddTaskHere")}
									</Menu.Item>
									<Menu.Item
										className={itemCls}
										data-testid="todo-phase-rename"
										onSelect={() => {
											toField.current = true;
											ctrl.setEditing({ kind: "phase", p, name: phase.name });
										}}
									>
										<Pencil size={14} /> {t("panel.todoEditRenamePhase")}
									</Menu.Item>
									<Menu.Item
										className={itemCls}
										disabled={p === 0}
										data-testid="todo-phase-move-up"
										onSelect={() => void ctrl.run(here, (cur) => movePhase(cur, p, -1))}
									>
										<ArrowUp size={14} /> {t("panel.todoEditMoveUp")}
									</Menu.Item>
									<Menu.Item
										className={itemCls}
										disabled={p === phases - 1}
										data-testid="todo-phase-move-down"
										onSelect={() => void ctrl.run(here, (cur) => movePhase(cur, p, 1))}
									>
										<ArrowDown size={14} /> {t("panel.todoEditMoveDown")}
									</Menu.Item>
									<Menu.Separator className="my-1 h-px bg-border" />
									<Menu.Item
										className={cx(itemCls, "text-danger")}
										data-testid="todo-phase-remove"
										onSelect={() => void ctrl.run(here, (cur) => removePhase(cur, p))}
									>
										<Trash2 size={14} /> {t("panel.todoEditRemovePhase")}
									</Menu.Item>
								</Menu.Content>
							</Menu.Portal>
						</Menu.Root>
					</>
				)}
			</div>
			<ul className="space-y-1">
				{withKeys(phase.tasks, (task) => task.content).map(({ key, item: task }, i) => (
					<TaskRow key={key} ctrl={ctrl} p={p} i={i} task={task} last={i === phase.tasks.length - 1} />
				))}
				{adding ? (
					<li>
						<NewTask ctrl={ctrl} p={p} />
					</li>
				) : null}
			</ul>
		</section>
	);
}

function NewTask({ ctrl, p }: { ctrl: Ctrl; p: number }) {
	const t = useT();
	return (
		<Entry
			label={t("panel.todoEditNewTaskLabel")}
			placeholder={t("panel.todoEditNewTask")}
			busy={ctrl.busy}
			onSave={(value) => {
				if (!value.trim()) return;
				void ctrl.run(
					() => true,
					(cur) => addTask(cur, p, value),
				);
			}}
			onCancel={() => ctrl.setEditing(null)}
		/>
	);
}

/** The whole list as omp's Markdown, for the changes the menus do not make (many at once, a rewrite). */
function MarkdownDialog({
	live,
	open,
	onOpenChange,
}: {
	live: LiveState;
	open: boolean;
	onOpenChange: (o: boolean) => void;
}) {
	const t = useT();
	return (
		<Modal
			open={open}
			onOpenChange={onOpenChange}
			title={t("panel.todoMarkdownTitle")}
			description={t("panel.todoMarkdownHelp")}
			wide
		>
			{open ? <MarkdownBody live={live} onDone={() => onOpenChange(false)} /> : null}
		</Modal>
	);
}

function MarkdownBody({ live, onDone }: { live: LiveState; onDone: () => void }) {
	const t = useT();
	const liveId = live.info.liveId;
	const [text, setText] = useState(() => todosToMarkdown(live.state?.todoPhases ?? []));
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const save = async () => {
		setBusy(true);
		setError(null);
		try {
			await controls.replaceTodos(liveId, text);
			await refreshState(liveId, true);
			onDone();
		} catch (e) {
			// omp's own words: the line it could not read.
			setError((e as Error).message);
		} finally {
			setBusy(false);
		}
	};
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				void save();
			}}
		>
			<textarea
				value={text}
				onChange={(e) => setText(e.target.value)}
				aria-label={t("panel.todoMarkdownLabel")}
				spellCheck={false}
				rows={14}
				disabled={busy}
				data-testid="todo-markdown"
				className="w-full resize-y rounded-lg border border-border bg-bg-soft p-2.5 font-mono text-xs outline-none focus:border-faint"
			/>
			{error ? (
				<p role="alert" className="mt-2 whitespace-pre-wrap text-xs text-danger" data-testid="todo-markdown-error">
					{error}
				</p>
			) : null}
			<div className="mt-3 flex justify-end gap-2">
				<Button onClick={onDone} disabled={busy}>
					{t("common.cancel")}
				</Button>
				<Button variant="primary" type="submit" disabled={busy} data-testid="todo-markdown-save">
					{busy ? <Spinner size={14} /> : null} {t("panel.todoMarkdownApply")}
				</Button>
			</div>
		</form>
	);
}

/**
 * The editable list with its footer. `empty` is what a conversation with no list shows above the footer, whose
 * "Add task" starts one.
 */
export function TodoEditList({ live, empty }: { live: LiveState; empty?: ReactNode }) {
	const t = useT();
	const toast = useApp((s) => s.toast);
	const liveId = live.info.liveId;
	const phases = live.state?.todoPhases ?? [];
	const [busy, setBusy] = useState(false);
	const [editing, setEditing] = useState<Draft | null>(null);
	const [markdown, setMarkdown] = useState(false);

	const run: Ctrl["run"] = async (still, make) => {
		// What omp reports now, not what was on screen when the menu was opened.
		const cur = useApp.getState().lives[liveId]?.state?.todoPhases ?? [];
		if (!still(cur)) {
			toast("warning", t("panel.todoEditStale"));
			setEditing(null);
			return;
		}
		setBusy(true);
		try {
			await controls.replaceTodos(liveId, todosToMarkdown(make(cur)));
			await refreshState(liveId, true);
			setEditing(null);
		} catch (e) {
			toast("error", t("panel.todoEditFailed", { error: (e as Error).message }));
		} finally {
			setBusy(false);
		}
	};
	const ctrl: Ctrl = { busy, editing, setEditing, run };
	const keyed = withKeys(phases, (p) => p.name);
	return (
		<div data-testid="todo-editor" aria-busy={busy}>
			{phases.length === 0 ? (
				empty
			) : (
				<div data-testid="todo-list">
					{keyed.map(({ key, item: phase }, p) => (
						<PhaseSection key={key} ctrl={ctrl} p={p} phase={phase} phases={phases.length} />
					))}
				</div>
			)}
			{phases.length === 0 && editing?.kind === "newTask" ? (
				<div className="mt-2">
					<NewTask ctrl={ctrl} p={0} />
				</div>
			) : null}
			{editing?.kind === "newPhase" ? (
				<div className="mt-2">
					<Entry
						label={t("panel.todoEditPhaseLabel")}
						placeholder={t("panel.todoEditNewPhase")}
						busy={busy}
						onSave={(value) => {
							if (!value.trim()) return;
							void ctrl.run(
								() => true,
								(cur) => addPhase(cur, value),
							);
						}}
						onCancel={() => setEditing(null)}
					/>
				</div>
			) : null}
			<div className="mt-3 flex flex-wrap gap-1.5">
				<Button
					size="sm"
					disabled={busy}
					data-testid="todo-add-task"
					onClick={() =>
						setEditing({ kind: "newTask", p: Math.max(0, phases.length - 1), phase: phases.at(-1)?.name ?? "" })
					}
				>
					<Plus size={13} /> {t("panel.todoEditAddTask")}
				</Button>
				<Button size="sm" disabled={busy} data-testid="todo-add-phase" onClick={() => setEditing({ kind: "newPhase" })}>
					<Plus size={13} /> {t("panel.todoEditAddPhase")}
				</Button>
				<Button size="sm" disabled={busy} data-testid="todo-edit-markdown" onClick={() => setMarkdown(true)}>
					<FileText size={13} /> {t("panel.todoEditMarkdown")}
				</Button>
			</div>
			<MarkdownDialog live={live} open={markdown} onOpenChange={setMarkdown} />
		</div>
	);
}
