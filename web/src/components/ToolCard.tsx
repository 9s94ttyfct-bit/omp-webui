import {
	Bot,
	ChevronRight,
	CircleAlert,
	CircleCheck,
	CircleDashed,
	FileText,
	Globe,
	Image as ImageIcon,
	ListTodo,
	Pencil,
	Search,
	SquareTerminal,
	Wrench,
} from "lucide-react";
import { lazy, Suspense, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import "../i18n/later.ts";
import { t, useT } from "../i18n/index.ts";
import {
	type DiffRow,
	type FileChange,
	listingRows,
	parseDiff,
	resultTexts,
	splitWarnings,
	type ToolChanges,
	toolChanges,
} from "../lib/diff.ts";
import { type AgentMessage, imagesOf, textOf } from "../lib/messages.ts";
import { useScrolls } from "../lib/scrolls.ts";
import { serverOffsetMs } from "../lib/server-clock.ts";
import { taskItemsOf } from "../lib/subagent-assignment.ts";
import { rememberToolChoice, toolChoice } from "../lib/tool-choice.ts";
import { atEnd, outputTail, toolOpen } from "../lib/tool-open.ts";
import { timerWanted, toolStartedAt, toolTimer } from "../lib/tool-time.ts";
import { useToolTimerMode } from "../lib/tool-timer.ts";
import { useGuard } from "../store/guard.ts";
import type { ToolExec } from "../store/live.ts";
import { TaskAssignments } from "./Assignment.tsx";
import { DiffView, PathLabel } from "./DiffView.tsx";
import { CopyButton } from "./Markdown.tsx";
import { MdOpenButton } from "./md/MdOpenButton.tsx";
import { StartTime } from "./StartTime.tsx";
import { CallStops } from "./SubagentStop.tsx";
import { ToolImages } from "./ToolImages.tsx";
import { ToolTimer } from "./ToolTimer.tsx";
import { Badge, cx, Spinner } from "./ui.tsx";

// What the guard decided about the call: its words and strings are a chunk of their own, loaded when a call has a verdict.
const GuardVerdict = lazy(() => import("./GuardVerdict.tsx"));

const ICONS: Record<string, typeof Wrench> = {
	bash: SquareTerminal,
	eval: SquareTerminal,
	read: FileText,
	write: Pencil,
	edit: Pencil,
	grep: Search,
	glob: Search,
	find: Search,
	web_search: Globe,
	browser: Globe,
	task: Bot,
	todo: ListTodo,
};

const SUMMARY_KEYS = ["intent", "command", "path", "pattern", "query", "url", "i", "file", "name", "task"];

export function argSummary(args: unknown): string {
	if (!args || typeof args !== "object") return "";
	const rec = args as Record<string, unknown>;
	for (const k of SUMMARY_KEYS) {
		const v = rec[k];
		if (typeof v === "string" && v.trim()) return v.trim().split("\n")[0].slice(0, 160);
	}
	if (Array.isArray(rec.tasks))
		return t(rec.tasks.length === 1 ? "chat.toolTask" : "chat.toolTasks", { n: rec.tasks.length });
	return "";
}

function resultText(result: unknown): string {
	if (!result) return "";
	if (typeof result === "string") return result;
	if (typeof result === "object" && result !== null && "content" in result) {
		return textOf({ role: "toolResult", content: (result as AgentMessage).content });
	}
	return JSON.stringify(result, null, 2);
}

/** The tools whose card shows the file they touched, and what changed in it, instead of raw JSON. */
const FILE_TOOLS: Record<string, true> = { edit: true, write: true };

function intentOf(args: unknown, exec?: ToolExec): string {
	const a = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
	for (const k of ["intent", "i"]) {
		const v = a[k];
		if (typeof v === "string" && v.trim()) return v.trim().split("\n")[0].slice(0, 160);
	}
	return exec?.intent ?? "";
}

interface FileView {
	changes: ToolChanges;
	/** Parsed `details.diff` of each file in `changes.files`; empty when it has none. */
	rows: DiffRow[][];
	/** `write`'s content as a numbered listing; empty when there is none. */
	listing: DiffRow[];
	content: string;
}

function fileViewOf(name: string, args: unknown, details: unknown): FileView {
	const changes = toolChanges(name, args, details);
	const written = name === "write" && args && typeof args === "object" && "content" in args ? args.content : "";
	const text = typeof written === "string" ? written : "";
	return {
		changes,
		rows: changes.files.map((f) => (f.diff ? parseDiff(f.diff) : [])),
		listing: listingRows(text),
		content: text,
	};
}

export interface ToolCardProps {
	id: string;
	name: string;
	args: unknown;
	result?: AgentMessage;
	exec?: ToolExec;
	/** Nothing is running that could still start or answer the call (see `RowProps.idle`): without a result it was interrupted. */
	idle?: boolean;
	/**
	 * The conversation is paused: a call without a result is frozen, not running, and its card is open with what the page
	 * holds of it (its arguments, and the output so far when the page saw the tool print it) instead of a spinner that spins
	 * for nothing. omp does not answer while it is frozen, so a call the page did not see start has no more than its arguments.
	 */
	paused?: boolean;
	onOpenSubagent?: (toolCallId: string) => void;
	/** The subagent whose transcript the card is in, when it is in one (see `subagentsForToolCall`). */
	subagentOwner?: string;
	/**
	 * When the assistant message that made the call ended (its `completedAt`): what the call's duration is measured from
	 * when the page did not see it run (see `lib/tool-time.ts`).
	 */
	calledAt?: number;
}

export function ToolCard({
	id,
	name,
	args,
	result,
	exec,
	idle,
	paused,
	calledAt,
	onOpenSubagent,
	subagentOwner,
}: ToolCardProps) {
	const t = useT();
	// What "Guard dangerous commands" decided about this call, when it has: a lookup here, the words in a chunk of their own.
	const verdict = useGuard((s) => s.byCall[id]);
	// Open while the tool runs (its output streams in) and folded when it is done, like a thinking block; a click wins.
	const [chosen, setChosen] = useState<boolean | null>(() => toolChoice(id));
	const [showRaw, setShowRaw] = useState(false);
	const Icon = ICONS[name] ?? Wrench;
	const running = !result && !!exec && !exec.done;
	// A call that has no result and is not over: running, or about to start. Frozen while the conversation is paused.
	const unfinished = !result && !exec?.done;
	const frozen = !!paused && !idle && unfinished;
	const open = toolOpen(chosen, running || frozen);
	const isError = result?.isError ?? exec?.isError ?? false;
	const live = exec?.result ?? exec?.partial;
	const summary = argSummary(args) || exec?.intent || "";
	// A call that has neither result nor live record is about to start (between the model's call and the tool's first frame), unless nothing is running any more.
	const unanswered = !result && !exec;
	const pending = unanswered && !idle;
	const interrupted = unanswered && !!idle;
	// How long it ran, when the setting wants it for this tool: a card that is frozen (the conversation is paused) has no clock to show.
	const timerMode = useToolTimerMode();
	const offsetMs = serverOffsetMs();
	const timer = timerWanted(timerMode, name) && !frozen ? toolTimer({ result, exec, calledAt, offsetMs }) : null;
	// The clock time it started (#691), whatever the timer setting.
	const startedAt = toolStartedAt({ exec, calledAt, offsetMs });
	const details = result
		? result.details
		: typeof live === "object" && live !== null && "details" in live
			? live.details
			: undefined;
	const view = useMemo(() => (FILE_TOOLS[name] ? fileViewOf(name, args, details) : null), [name, args, details]);
	const images = useMemo(
		() =>
			imagesOf(
				result
					? result.content
					: typeof live === "object" && live !== null && "content" in live
						? live.content
						: undefined,
			),
		[result, live],
	);
	const hasDiff = !isError && !!view?.rows.some((r) => r.length > 0);
	// A structured view (diff / written content) replaces the raw JSON; anything else keeps the plain layout.
	const structured = !!view && !isError && (hasDiff || view.listing.length > 0);
	// A `task` call's assignments are rows of their own: its arguments say the same again as JSON, so they wait for the toggle too.
	const assigned = useMemo(() => name === "task" && taskItemsOf(args, details).length > 0, [name, args, details]);
	const firstPath = view?.changes.files[0]?.path;
	const counts = hasDiff ? view?.changes.counts : undefined;
	// Only a card that shows the raw text builds it: a folded one (or one showing a diff) costs nothing per streamed update.
	const showsArgs = open && (!(structured || assigned) || showRaw);
	const showsOutput = open && (!structured || showRaw);
	const output = !showsOutput ? "" : result ? textOf(result) : resultText(live);
	const argsSection = showsArgs ? (
		<Section title={t("chat.toolArguments")} text={JSON.stringify(args ?? {}, null, 2)} />
	) : null;
	const outputSection = output ? (
		<Section
			title={running ? t("chat.toolOutputStreaming") : t("chat.toolOutput")}
			text={output}
			error={isError}
			streaming={running}
		/>
	) : null;
	const rawToggle = (
		<button
			type="button"
			data-testid="tool-raw-toggle"
			aria-expanded={showRaw}
			className="inline-flex min-h-6 items-center text-xs text-accent hover:underline"
			onClick={() => setShowRaw((r) => !r)}
		>
			{showRaw ? t("chat.toolRawHide") : t("chat.toolRawShow")}
		</button>
	);
	return (
		<div
			className={cx("my-1.5 rounded-xl border bg-bg-soft text-sm", isError ? "border-danger/40" : "border-border")}
			data-testid="tool-card"
			data-tool={name}
		>
			<button
				type="button"
				className="flex w-full items-center gap-2 px-3 py-2 text-left"
				aria-expanded={open}
				onClick={() => {
					rememberToolChoice(id, !open);
					setChosen(!open);
				}}
			>
				<ChevronRight size={14} className={cx("shrink-0 text-faint transition-transform", open && "rotate-90")} />
				<Icon size={15} className="shrink-0 text-muted" />
				<span className="shrink-0 font-medium">{name}</span>
				{view && firstPath ? (
					<>
						<span className="flex min-w-0 max-w-[75%] shrink items-baseline gap-1.5">
							<PathLabel path={firstPath} className="shrink" />
							{view.changes.files.length > 1 ? (
								<span className="shrink-0 text-xs text-faint">
									{t("chat.toolMoreFiles", { n: view.changes.files.length - 1 })}
								</span>
							) : null}
						</span>
						{counts ? (
							<span className="flex shrink-0 gap-1.5 font-mono text-xs">
								<span className="text-success">
									<span aria-hidden="true">+{counts.added}</span>
									<span className="sr-only">
										{t(counts.added === 1 ? "chat.toolLinesAddedOne" : "chat.toolLinesAdded", { n: counts.added })}
									</span>
								</span>
								<span className="text-danger">
									<span aria-hidden="true">−{counts.removed}</span>
									<span className="sr-only">
										{t(counts.removed === 1 ? "chat.toolLinesRemovedOne" : "chat.toolLinesRemoved", {
											n: counts.removed,
										})}
									</span>
								</span>
							</span>
						) : null}
						<span className="min-w-0 flex-1 truncate font-mono text-xs text-faint">{intentOf(args, exec)}</span>
					</>
				) : (
					<span className="min-w-0 flex-1 truncate font-mono text-xs text-muted">{summary}</span>
				)}
				{images.length > 0 ? (
					<Badge className="shrink-0">
						<ImageIcon size={11} aria-hidden />
						<span data-testid="tool-image-count">
							{t(images.length === 1 ? "chat.toolImage" : "chat.toolImages", { n: images.length })}
						</span>
					</Badge>
				) : null}
				<StartTime at={startedAt} />
				{timer ? <ToolTimer timer={timer} /> : null}
				{frozen ? (
					<span className="shrink-0" data-testid="tool-paused">
						<Badge tone="accent">{t("chat.pendingPaused")}</Badge>
					</span>
				) : running || pending ? (
					<Spinner size={14} className="text-accent" />
				) : interrupted ? (
					<span
						className="flex shrink-0 items-center gap-1 text-xs text-faint"
						data-testid="tool-interrupted"
						title={t("chat.toolInterruptedTip")}
					>
						<CircleDashed size={15} aria-hidden />
						{t("chat.toolInterrupted")}
					</span>
				) : isError ? (
					<CircleAlert size={15} className="text-danger" aria-label={t("chat.toolFailed")} />
				) : (
					<CircleCheck size={15} className="text-success" aria-label={t("chat.toolDone")} />
				)}
			</button>
			{name === "task" && onOpenSubagent ? (
				<div className="-mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 px-9 pb-2">
					<button
						type="button"
						className="inline-flex min-h-6 items-center text-xs text-accent hover:underline"
						onClick={() => onOpenSubagent(id)}
					>
						{t("chat.toolViewSubagents")}
					</button>
					<CallStops toolCallId={id} args={args} owner={subagentOwner} />
				</div>
			) : null}
			{verdict ? (
				<div className="-mt-1 px-9 pb-2">
					<Suspense fallback={null}>
						<GuardVerdict decision={verdict} />
					</Suspense>
				</div>
			) : null}
			{open ? (
				<div className="space-y-2 border-t border-border px-3 py-2">
					{name === "task" ? (
						<TaskAssignments
							args={args}
							details={details}
							onOpen={() => {
								// Reading a subagent's assignment is a choice to keep the card open, as opening it by hand is.
								if (chosen !== null) return;
								rememberToolChoice(id, true);
								setChosen(true);
							}}
						/>
					) : null}
					{structured && view ? (
						<FileBody view={view} texts={result ? resultTexts(result) : resultTexts(live)}>
							{rawToggle}
							{argsSection}
							{outputSection}
						</FileBody>
					) : assigned ? (
						<>
							{outputSection}
							{rawToggle}
							{argsSection}
						</>
					) : (
						<>
							{argsSection}
							{outputSection}
						</>
					)}
					{images.length > 0 ? <ToolImages images={images} tool={name} /> : null}
				</div>
			) : null}
		</div>
	);
}

function opLabel(f: FileChange): string {
	if (f.move) return t("chat.toolOpMove", { path: f.move });
	if (f.op === "create") return t("chat.toolOpCreate");
	if (f.op === "delete") return t("chat.toolOpDelete");
	return "";
}

function NoteBox({
	testId,
	title,
	tone,
	lines,
}: {
	testId: string;
	title: string;
	tone: "warning" | "danger";
	lines: string[];
}) {
	return (
		<div
			data-testid={testId}
			role="note"
			className={cx(
				"rounded-lg border p-2 text-xs",
				tone === "danger" ? "border-danger/40 bg-danger/10" : "border-warning/40 bg-warning/10",
			)}
		>
			<div
				className={cx(
					"mb-1 text-xs font-medium uppercase tracking-wide",
					tone === "danger" ? "text-danger" : "text-warning",
				)}
			>
				{title}
			</div>
			{lines.map((line, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: static list
				<pre key={i} className="font-mono leading-relaxed whitespace-pre-wrap">
					{line}
				</pre>
			))}
		</div>
	);
}

/** One file of an edit: its diff, labelled with the path when several files changed or the file was created/deleted/moved. */
function FileSection({ file, rows, many }: { file: FileChange; rows: DiffRow[]; many: boolean }) {
	const t = useT();
	const op = opLabel(file);
	// A Markdown file it wrote or edited opens in the Markdown editor from here (nothing for a file that was deleted).
	const open = file.op === "delete" ? null : <MdOpenButton path={file.move ?? file.path} />;
	const label =
		many || op ? (
			<span className="flex min-w-0 items-center gap-2 normal-case tracking-normal">
				<PathLabel path={file.path} />
				{op ? <span className="shrink-0 text-faint">{op}</span> : null}
				{open}
			</span>
		) : (
			(open ?? undefined)
		);
	return rows.length > 0 ? (
		<DiffView rows={rows} copyText={file.diff ?? ""} title={t("chat.toolDiff")} label={label} />
	) : (
		<div className="flex items-center gap-2 text-xs">{label}</div>
	);
}

/** An edit's diff per file (or a write's content), with what omp warned about next to it; `children` is the raw-data toggle. */
function FileBody({ view, texts, children }: { view: FileView; texts: string[]; children: React.ReactNode }) {
	const t = useT();
	const { changes, rows, listing, content } = view;
	const anyDiff = rows.some((r) => r.length > 0);
	const { output: summary, warnings } = splitWarnings(texts);
	const notes = changes.diagnostics;
	return (
		<>
			{anyDiff ? (
				changes.files.map((f, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: files are a static list, never reordered
					<FileSection key={i} file={f} rows={rows[i]} many={changes.files.length > 1} />
				))
			) : (
				<>
					<DiffView
						rows={listing}
						copyText={content}
						title={t("chat.toolContent")}
						label={changes.files[0] ? <MdOpenButton path={changes.files[0].path} /> : undefined}
					/>
					{summary ? <p className="font-mono text-xs whitespace-pre-wrap text-muted">{summary}</p> : null}
				</>
			)}
			{notes ? (
				<NoteBox
					testId="tool-diagnostics"
					title={notes.summary ? `${t("chat.toolDiagnostics")} · ${notes.summary}` : t("chat.toolDiagnostics")}
					tone={notes.errored ? "danger" : "warning"}
					lines={notes.messages}
				/>
			) : null}
			{warnings.length > 0 ? (
				<NoteBox testId="tool-warnings" title={t("chat.toolWarnings")} tone="warning" lines={warnings} />
			) : null}
			{children}
		</>
	);
}

function Section({
	title,
	text,
	error,
	streaming,
}: {
	title: string;
	text: string;
	error?: boolean;
	/** The text is still growing: show its end and follow it, unless the reader scrolled up. */
	streaming?: boolean;
}) {
	const t = useT();
	const [full, setFull] = useState(false);
	const box = useRef<HTMLPreElement>(null);
	const [scrollRef, scrolls] = useScrolls<HTMLPreElement>();
	const setBox = useCallback(
		(el: HTMLPreElement | null) => {
			box.current = el;
			return scrollRef(el);
		},
		[scrollRef],
	);
	const following = useRef(true);
	const limit = 4000;
	const shown =
		full || text.length <= limit ? text : streaming ? outputTail(text, limit) : `${text.slice(0, limit)}\n…`;
	// biome-ignore lint/correctness/useExhaustiveDependencies: `shown` is the trigger: the box grew.
	useLayoutEffect(() => {
		const el = box.current;
		if (streaming && el && following.current) el.scrollTop = el.scrollHeight;
	}, [shown, streaming]);
	return (
		<div>
			<div className="mb-1 flex items-center justify-between text-xs font-medium uppercase tracking-wide text-faint">
				{title}
				<CopyButton text={text} label={t("chat.toolCopy", { title: title.toLowerCase() })} />
			</div>
			<pre
				ref={setBox}
				// A box that scrolls is reached and scrolled from the keyboard; one that does not is no stop on the way.
				tabIndex={scrolls ? 0 : undefined}
				onScroll={(e) => {
					following.current = atEnd(e.currentTarget);
				}}
				className={cx(
					"max-h-96 overflow-auto rounded-lg bg-code p-2 font-mono text-xs leading-relaxed whitespace-pre-wrap",
					error && "text-danger",
				)}
			>
				{shown}
			</pre>
			{text.length > limit ? (
				<button
					type="button"
					className="inline-flex min-h-6 items-center text-xs text-accent hover:underline"
					onClick={() => setFull((f) => !f)}
				>
					{full ? t("chat.toolShowLess") : t("chat.toolShowAll", { n: text.length.toLocaleString() })}
				</button>
			) : null}
		</div>
	);
}
