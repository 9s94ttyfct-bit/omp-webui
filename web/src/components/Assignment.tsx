import { ChevronRight } from "lucide-react";
import { type ReactNode, useLayoutEffect, useRef, useState } from "react";
import "../i18n/later.ts";
import { useT } from "../i18n/index.ts";
import { type Assignment, type TaskItem, taskItemsOf } from "../lib/subagent-assignment.ts";
import { CopyButton, Markdown } from "./Markdown.tsx";
import { Badge, cx } from "./ui.tsx";

/**
 * What a subagent was told: its task and the context its parent shared with every subagent of the call. Shown in the
 * Agents tab (`AssignmentDetails`, from the subagent's transcript or its frames) and on the task card (`TaskAssignments`,
 * from the call's arguments). Each text is Markdown, rendered as every message is, with a button that copies it as
 * written; one that is long is cut to a few lines until "Show more" opens it.
 */

/** A long text is cut to this height, its last lines fading out, until it is opened. */
const CUT = "max-h-48 overflow-hidden";
const FADE = "[mask-image:linear-gradient(to_bottom,black_70%,transparent)]";

/** `children` (the rendered text), cut to a few lines with a "Show more" when they do not fit. */
function Clipped({ text, children }: { text: string; children: ReactNode }) {
	const t = useT();
	const [full, setFull] = useState(false);
	const [clipped, setClipped] = useState(false);
	const box = useRef<HTMLDivElement>(null);
	// Whether the text is taller than the box it is cut to; measured while it is cut, kept while it is open.
	// biome-ignore lint/correctness/useExhaustiveDependencies: a new text is a new thing to measure
	useLayoutEffect(() => {
		const el = box.current;
		if (el && !full) setClipped(el.scrollHeight > el.clientHeight + 1);
	}, [text, full]);
	return (
		<>
			<div
				ref={box}
				className={cx("prose-compact", !full && CUT, clipped && !full && FADE)}
				data-testid="assignment-body"
			>
				{children}
			</div>
			{clipped ? (
				<button
					type="button"
					className="inline-flex min-h-6 items-center text-xs text-accent hover:underline"
					aria-expanded={full}
					data-testid="assignment-more"
					onClick={() => setFull((f) => !f)}
				>
					{full ? t("panel.agentTextLess") : t("panel.agentTextMore")}
				</button>
			) : null}
		</>
	);
}

/** The task: always in view when the assignment is. */
function TaskText({ text }: { text: string }) {
	const t = useT();
	return (
		<section data-testid="assignment-task">
			<div className="flex items-center justify-between">
				<h4 className="text-xs font-medium text-faint">{t("panel.agentTask")}</h4>
				<CopyButton text={text} label={t("panel.agentCopyTask")} />
			</div>
			<Clipped text={text}>
				<Markdown text={text} />
			</Clipped>
		</section>
	);
}

/** The context every subagent of the call got: the same text for each, so it stays closed until asked for. */
function ContextText({ text }: { text: string }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	return (
		<section data-testid="assignment-context">
			<div className="flex items-center justify-between">
				<button
					type="button"
					className="inline-flex min-h-6 items-center gap-1 text-xs font-medium text-faint hover:text-fg"
					aria-expanded={open}
					onClick={() => setOpen((o) => !o)}
				>
					<ChevronRight size={12} className={cx("shrink-0 transition-transform", open && "rotate-90")} />
					{t("panel.agentContext")}
				</button>
				<CopyButton text={text} label={t("panel.agentCopyContext")} />
			</div>
			{open ? (
				<Clipped text={text}>
					<Markdown text={text} />
				</Clipped>
			) : null}
		</section>
	);
}

/** The task of an assignment, and its shared context when it has one. */
export function AssignmentView({ assignment }: { assignment: Assignment }) {
	return (
		<div className="space-y-2" data-testid="assignment">
			{assignment.task ? <TaskText text={assignment.task} /> : null}
			{assignment.context ? <ContextText text={assignment.context} /> : null}
		</div>
	);
}

/**
 * The Agents tab's header for one subagent: what it was told, pinned at the top of its view so it is there while its
 * transcript is read (it used to sit in the transcript, and scrolled away with it). Closed to one line — the word
 * "Assignment" and the first line of the task — until it is opened, then the whole assignment, which scrolls inside
 * the header rather than covering the transcript.
 *
 * Opened, the header is as tall as the assignment, up to 40% of the window or 20rem, and gives way to the transcript
 * below it, which keeps a minimum height of its own (set where the view lays it out): what the header shrinks to is the
 * room the view has left, which the window's height alone does not tell, since the view spends a fixed height on the
 * panel's tabs, its header and its statistics and a phone held sideways has little left after them. The line with the
 * word "Assignment" stays at the top of the header while the rest scrolls, so it can be closed from anywhere.
 */
export function AssignmentDetails({ assignment }: { assignment: Assignment }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	return (
		<details
			className={cx(
				"border-b border-border bg-surface text-xs",
				open ? "max-h-[min(40vh,20rem)] min-h-9 overflow-y-auto" : "shrink-0",
			)}
			data-testid="subagent-assignment"
			open={open}
			onToggle={(e) => setOpen(e.currentTarget.open)}
		>
			<summary className="sticky top-0 z-10 flex min-h-8 cursor-pointer items-center gap-1.5 bg-surface px-3 py-1.5 font-medium">
				<ChevronRight size={13} className={cx("shrink-0 text-faint transition-transform", open && "rotate-90")} />
				<span className="shrink-0">{t("panel.agentAssignment")}</span>
				<span className="min-w-0 flex-1 truncate text-muted">{previewOf(assignment.task)}</span>
			</summary>
			{open ? (
				<div className="border-t border-border p-2">
					<AssignmentView assignment={assignment} />
				</div>
			) : null}
		</details>
	);
}

/** The first line of a task that says something: a heading ("# Target") only says which part comes next. */
function previewOf(task: string): string {
	const lines = task.split("\n").map((l) => l.trim());
	return lines.find((l) => l && !/^#{1,6}\s/.test(l)) ?? lines.find(Boolean)?.replace(/^#{1,6}\s+/, "") ?? "";
}

function TaskItemRow({ item, index, onOpen }: { item: TaskItem; index: number; onOpen?: () => void }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	return (
		<li data-testid="task-item" data-name={item.name}>
			<button
				type="button"
				className="flex min-h-6 w-full items-center gap-2 rounded px-1.5 py-1 text-left text-xs hover:bg-hover"
				aria-expanded={open}
				onClick={() => {
					if (!open) onOpen?.();
					setOpen(!open);
				}}
			>
				<ChevronRight size={12} className={cx("shrink-0 text-faint transition-transform", open && "rotate-90")} />
				<span className="shrink-0 font-medium">{item.name ?? t("panel.agentUnnamed", { n: index + 1 })}</span>
				{item.agent ? <Badge>{item.agent}</Badge> : null}
				<span className="min-w-0 flex-1 truncate text-muted">{previewOf(item.assignment.task)}</span>
			</button>
			{open ? (
				<div className="px-1.5 pt-1 pb-2 pl-6">
					<AssignmentView assignment={item.assignment} />
				</div>
			) : null}
		</li>
	);
}

/**
 * The subagents a `task` call starts, each opening to its assignment. They come from the call's own arguments, so they
 * are there while the model is still writing the call, while the subagents run, and when the conversation is opened
 * again later. `details` is the call's result, for the ids omp gave subagents the call did not name. `onOpen`: a
 * subagent was opened by hand (the card keeps open for what is being read, rather than folding when the call ends).
 */
export function TaskAssignments({ args, details, onOpen }: { args: unknown; details?: unknown; onOpen?: () => void }) {
	const t = useT();
	const items = taskItemsOf(args, details);
	if (!items.length) return null;
	return (
		<ul
			className="space-y-0.5 rounded-lg border border-border bg-surface p-1"
			aria-label={t("panel.agentAssignments")}
			data-testid="task-assignments"
		>
			{items.map((item, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: an item is its place in the call; names may repeat or not yet exist
				<TaskItemRow key={i} item={item} index={i} onOpen={onOpen} />
			))}
		</ul>
	);
}
