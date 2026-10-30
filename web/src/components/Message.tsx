import { type InterviewRequest, parseInterviewPrompt } from "@shared/guided-goal.ts";
import type { SessionEntry } from "@shared/protocol.ts";
import {
	Brain,
	ChevronDown,
	ChevronLeft,
	ChevronRight,
	FileText,
	GitBranch,
	GitFork,
	Pencil,
	RefreshCw,
	ScrollText,
	SquareTerminal,
	Target,
} from "lucide-react";
import { memo, useId, useMemo, useState } from "react";
import "../i18n/later.ts";
import "../lib/bash-times-live.ts";
import { useT } from "../i18n/index.ts";
import { useBashDuration } from "../lib/bash-times.ts";
import { fmtBytes } from "../lib/files-rows.ts";
import { fmtDuration, fmtTokens } from "../lib/format.ts";
import { type AgentMessage, blocks, imageSrc, resultsAdded, type ToolResults, textOf } from "../lib/messages.ts";
import { classifyCustom, contentText, noticeOf, ruleReminders } from "../lib/notices.ts";
import { serverOffsetMs } from "../lib/server-clock.ts";
import { useToolTimerMode } from "../lib/tool-timer.ts";
import { editedMessage, userParts } from "../lib/user-message.ts";
import { useApp } from "../store/app.ts";
import type { ToolExec } from "../store/live.ts";
import { AssistantError, InterruptedCalls } from "./AssistantError.tsx";
import { CopyButton, Markdown } from "./Markdown.tsx";
import { FallbackNote, LiveNoticeRow, NoteRow, RuleNote, TypedNote } from "./NoticeRows.tsx";
import { StartTime } from "./StartTime.tsx";
import { ToolCard } from "./ToolCard.tsx";
import { TurnStatsLine } from "./TurnStats.tsx";
import { Button, cx, IconButton } from "./ui.tsx";

export interface MessageActions {
	edit?: (entry: SessionEntry, text: string) => void;
	regenerate?: (entry: SessionEntry) => void;
	fork?: (entry: SessionEntry) => void;
	switchSibling?: (entry: SessionEntry, to: SessionEntry) => void;
	openSubagent?: (toolCallId: string) => void;
	/** Set inside a subagent's transcript: that subagent, whose children a task card there starts (see `subagentsForToolCall`). */
	subagentOwner?: string;
	/** The one failed message omp's `/retry` would redo, and what Retry does; absent when there is nothing to retry. */
	retry?: { entryId: string; run: () => void };
	/** The step that ends the conversation with tool calls nobody answered, and what Continue does; absent when there is none. */
	resume?: { entryId: string; run: () => void };
	/** The conversation is paused: what runs in it is frozen (see `ToolCard`'s `paused`). */
	paused?: boolean;
}

export interface Siblings {
	list: SessionEntry[];
	index: number;
}

export interface RowProps {
	entry: SessionEntry | null;
	message: AgentMessage;
	toolResults: ToolResults;
	tools: Record<string, ToolExec>;
	actions: MessageActions;
	siblings?: Siblings;
	streaming?: boolean;
	/**
	 * No turn is running that could still start or answer this message's tool calls: the conversation is not streaming, or
	 * a later step followed. A call with no result then was interrupted (omp or the server was killed while the tool ran).
	 */
	idle?: boolean;
	readOnly?: boolean;
}

function SiblingNav({
	entry,
	siblings,
	actions,
}: {
	entry: SessionEntry;
	siblings: Siblings;
	actions: MessageActions;
}) {
	const t = useT();
	if (siblings.list.length < 2 || !actions.switchSibling) return null;
	const go = (d: number) => {
		const to = siblings.list[siblings.index + d];
		if (to) actions.switchSibling?.(entry, to);
	};
	return (
		<div className="flex items-center text-xs text-muted" data-testid="sibling-nav">
			<IconButton label={t("chat.siblingPrevious")} size="xs" disabled={siblings.index === 0} onClick={() => go(-1)}>
				<ChevronLeft size={14} />
			</IconButton>
			<span className="tabular-nums">
				{siblings.index + 1} / {siblings.list.length}
			</span>
			<IconButton
				label={t("chat.siblingNext")}
				size="xs"
				disabled={siblings.index >= siblings.list.length - 1}
				onClick={() => go(1)}
			>
				<ChevronRight size={14} />
			</IconButton>
		</div>
	);
}

/**
 * The message that starts a guided goal (shared/guided-goal.ts) is the web UI's instructions to omp, not something
 * the user wrote: it shows as one compact line, in the interface language, with what omp was told behind a disclosure.
 */
function InterviewChip({ request, text }: { request: InterviewRequest; text: string }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const id = useId();
	return (
		<div className="text-sm" data-testid="interview-chip">
			<div className="flex items-start gap-2">
				<Target size={15} className="mt-1 shrink-0 text-accent" />
				<span className="min-w-0 flex-1 break-words" data-testid="interview-title">
					<span className="font-medium">{t("panel.guidedSetup")}</span>
					{request.rough ? <span className="text-muted"> · {request.rough}</span> : null}
				</span>
				<IconButton
					label={t("panel.guidedSetupInstructions")}
					size="sm"
					aria-expanded={open}
					aria-controls={id}
					data-testid="interview-instructions-toggle"
					onClick={() => setOpen(!open)}
				>
					<ChevronDown size={14} className={cx("transition-transform", open && "rotate-180")} />
				</IconButton>
			</div>
			<pre
				id={id}
				hidden={!open}
				className="mt-2 max-h-72 overflow-auto rounded-lg bg-bg-soft px-3 py-2 font-sans text-xs leading-relaxed whitespace-pre-wrap text-muted"
				data-testid="interview-instructions"
			>
				{text}
			</pre>
		</div>
	);
}

/**
 * The text files attached to a user message (#617), one compact chip each: the name and size, and a disclosure that
 * shows the file's text. Folded by default: a file is often longer than the message it belongs to.
 */
function FileChips({ files, spaced }: { files: { name: string; bytes: number; text: string }[]; spaced?: boolean }) {
	return (
		<div className={cx("flex flex-col gap-1.5 whitespace-normal", spaced && "mt-2")} data-testid="file-chips">
			{files.map((f, i) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: the files of a message have no ids, and the list never changes
				<FileChip key={i} file={f} />
			))}
		</div>
	);
}

function FileChip({ file }: { file: { name: string; bytes: number; text: string } }) {
	const t = useT();
	const [open, setOpen] = useState(false);
	const id = useId();
	return (
		<div className="text-sm" data-testid="file-chip">
			<div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-2.5 py-1">
				<FileText size={15} className="shrink-0 text-muted" />
				<span className="min-w-0 flex-1 truncate font-medium" title={file.name} data-testid="file-chip-name">
					{file.name}
				</span>
				<span className="shrink-0 text-xs text-muted tabular-nums" data-testid="file-chip-size">
					{fmtBytes(file.bytes)}
				</span>
				<IconButton
					label={open ? t("chat.fileChipHide") : t("chat.fileChipShow")}
					size="sm"
					aria-expanded={open}
					aria-controls={open ? id : undefined}
					data-testid="file-chip-toggle"
					onClick={() => setOpen(!open)}
				>
					<ChevronDown size={14} className={cx("transition-transform", open && "rotate-180")} />
				</IconButton>
			</div>
			{/* Mounted only while open: a file can be 256 KB, and most are never looked at. */}
			{open ? (
				<pre
					id={id}
					className="mt-1 max-h-72 overflow-auto rounded-lg bg-code px-3 py-2 font-mono text-xs leading-relaxed whitespace-pre text-fg"
					data-testid="file-chip-text"
				>
					{file.text}
				</pre>
			) : null}
		</div>
	);
}

function UserMessage({ entry, message, actions, siblings, readOnly }: RowProps) {
	const t = useT();
	const [editing, setEditing] = useState(false);
	const text = textOf(message);
	const interview = parseInterviewPrompt(text);
	// What was typed, and the text files attached to it (#617): the files show as chips, and the edit is of the words
	// alone. Copy and everything else keep the full text.
	const { typed, files } = useMemo(() => userParts(text), [text]);
	const [draft, setDraft] = useState(typed);
	const images = blocks(message).filter((b) => b.type === "image");
	return (
		<div className="group flex flex-col items-end gap-1 fade-in" data-testid="msg-user" data-entry-id={entry?.id}>
			{editing ? (
				<div className="w-full max-w-[85%] rounded-2xl border border-border bg-surface p-3 has-[textarea:focus-visible]:border-accent has-[textarea:focus-visible]:ring-1 has-[textarea:focus-visible]:ring-accent">
					<textarea
						className="min-h-24 w-full resize-y bg-transparent text-[15px] outline-none"
						value={draft}
						aria-label={t("chat.userEditMessage")}
						onChange={(e) => setDraft(e.target.value)}
						// biome-ignore lint/a11y/noAutofocus: entering edit mode is an explicit user action
						autoFocus
					/>
					{actions.edit ? null : (
						<p className="mt-1 text-xs text-muted" data-testid="edit-busy">
							{t("chat.userEditBusy")}
						</p>
					)}
					{files.length ? <FileChips files={files} spaced /> : null}
					<div className="mt-2 flex justify-end gap-2">
						<Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
							{t("common.cancel")}
						</Button>
						<Button
							size="sm"
							variant="primary"
							disabled={(!draft.trim() && !files.length) || !actions.edit}
							onClick={() => {
								setEditing(false);
								// The attached files' blocks are put back as they were: editing the words never loses them.
								if (entry) actions.edit?.(entry, editedMessage(draft.trim(), files));
							}}
						>
							{t("chat.userSendAsBranch")}
						</Button>
					</div>
				</div>
			) : (
				<div className="max-w-[85%] rounded-2xl rounded-br-md bg-bubble px-4 py-2.5 text-[15px] leading-relaxed whitespace-pre-wrap break-words">
					{images.length ? (
						<div className="mb-2 flex flex-wrap gap-2">
							{images.map((b, i) => (
								<img
									// biome-ignore lint/suspicious/noArrayIndexKey: images have no ids
									key={i}
									alt={t("chat.userAttachment")}
									className="max-h-48 rounded-lg"
									src={imageSrc(b.data ?? "", b.mimeType) ?? undefined}
								/>
							))}
						</div>
					) : null}
					{interview ? <InterviewChip request={interview} text={text} /> : typed}
					{files.length ? <FileChips files={files} spaced={typed !== ""} /> : null}
				</div>
			)}
			<div className="flex items-center gap-0.5">
				<div
					className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 pointer-coarse:opacity-100 focus-within:opacity-100"
					data-testid="msg-actions"
				>
					<CopyButton text={text} label={t("chat.userCopyMessage")} />
					{!readOnly && entry && actions.edit && !interview ? (
						<IconButton
							label={t("chat.userEdit")}
							size="sm"
							onClick={() => {
								setDraft(typed);
								setEditing(true);
							}}
						>
							<Pencil size={14} />
						</IconButton>
					) : null}
					{!readOnly && entry && actions.fork ? (
						<IconButton label={t("chat.userFork")} size="sm" onClick={() => actions.fork?.(entry)}>
							<GitFork size={14} />
						</IconButton>
					) : null}
				</div>
				{/* Last in the row, so the switcher stays at the bubble's edge and the actions (invisible until hover) take the room beside it.
				    With several versions it is always shown: the branches stay discoverable and reachable without hover. */}
				{siblings && entry ? <SiblingNav entry={entry} siblings={siblings} actions={actions} /> : null}
			</div>
		</div>
	);
}

/**
 * A thinking block: open while the model is thinking and folded once it answers, unless
 * Settings › Keep thinking expanded is on. A click always wins for that block.
 */
function Thinking({ text, streaming }: { text: string; streaming?: boolean }) {
	const t = useT();
	const keepOpen = useApp((s) => s.keepThinkingOpen);
	const [chosen, setChosen] = useState<boolean | null>(null);
	const open = chosen ?? (keepOpen || Boolean(streaming));
	return (
		<div className="my-1.5" data-testid="thinking">
			<button
				type="button"
				className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-fg"
				aria-expanded={open}
				onClick={() => setChosen(!open)}
			>
				<Brain size={14} />
				{streaming ? t("chat.thinking") : t("chat.thoughtProcess")}
				<ChevronDown size={13} className={cx("transition-transform", open && "rotate-180")} />
			</button>
			{open ? (
				<div className="mt-1.5 border-l-2 border-border pl-3 text-sm text-muted whitespace-pre-wrap">{text}</div>
			) : null}
		</div>
	);
}

/** One footer per agent turn: copy, versions, regenerate, branch, and the turn's usage. */
export function TurnFooter({
	entries,
	messages,
	actions,
	siblings,
	readOnly,
}: {
	entries: SessionEntry[];
	messages: AgentMessage[];
	actions: MessageActions;
	siblings?: Siblings;
	readOnly?: boolean;
}) {
	const t = useT();
	const first = entries[0];
	const last = entries.at(-1);
	const text = messages
		.map(textOf)
		.filter((t) => t.trim())
		.join("\n\n");
	return (
		<div className="flex min-h-7 flex-wrap items-center gap-x-0.5 gap-y-0.5" data-testid="turn-footer">
			{siblings && first ? <SiblingNav entry={first} siblings={siblings} actions={actions} /> : null}
			{text ? <CopyButton text={text} label={t("chat.footerCopyResponse")} /> : null}
			{!readOnly && last && actions.regenerate ? (
				<IconButton label={t("chat.footerRegenerate")} size="sm" onClick={() => actions.regenerate?.(last)}>
					<RefreshCw size={14} />
				</IconButton>
			) : null}
			{!readOnly && last && actions.fork ? (
				<IconButton label={t("chat.footerBranchFrom")} size="sm" onClick={() => actions.fork?.(last)}>
					<GitFork size={14} />
				</IconButton>
			) : null}
			<span className="ml-2 min-w-0">
				<TurnStatsLine entries={entries} messages={messages} />
			</span>
		</div>
	);
}

function AssistantMessage({ entry, message, toolResults, tools, actions, streaming, idle }: RowProps) {
	const bs = blocks(message);
	const text = textOf(message);
	return (
		<div className="fade-in" data-testid="msg-assistant" data-entry-id={entry?.id}>
			{/* The clock time the reply started (#691): its own short line, there from the reply's first frame. */}
			{message.timestamp ? (
				<div className="flex h-4 items-center">
					<StartTime at={message.timestamp - serverOffsetMs()} className="text-xs text-faint tabular-nums" />
				</div>
			) : null}
			{bs.map((b, i) => {
				const key = `${i}-${b.type}`;
				// A thinking block omp marks `narration` is prose for the user: the answer, not the thought process.
				if (b.type === "thinking" && b.narration)
					return b.thinking?.trim() ? <Markdown key={key} text={b.thinking} /> : null;
				if (b.type === "thinking" && b.thinking?.trim())
					return <Thinking key={key} text={b.thinking} streaming={streaming && i === bs.length - 1} />;
				if (b.type === "text" && b.text) return <Markdown key={key} text={b.text} />;
				if (b.type === "toolCall" && b.id) {
					// Keyed by its place, like the other blocks: while the arguments stream the call has a stand-in id
					// (`pending-<i>`, see `applyDelta`), and a key that changed with it would remount the running card,
					// restarting its spinner and dropping a choice made on it (#708).
					return (
						<ToolCard
							key={key}
							id={b.id}
							name={b.name ?? "tool"}
							args={b.arguments}
							result={toolResults.get(b.id)}
							exec={tools[b.id]}
							idle={idle}
							calledAt={message.completedAt}
							paused={actions.paused}
							onOpenSubagent={actions.openSubagent}
							subagentOwner={actions.subagentOwner}
						/>
					);
				}
				return null;
			})}
			{streaming && !text && !bs.some((b) => b.type === "toolCall") ? <TypingDots /> : null}
			<AssistantError
				message={message}
				onRetry={entry && actions.retry?.entryId === entry.id ? actions.retry.run : undefined}
			/>
			{entry && actions.resume?.entryId === entry.id ? <InterruptedCalls onContinue={actions.resume.run} /> : null}
		</div>
	);
}

export function TypingDots() {
	const t = useT();
	return (
		<div
			className="flex items-center gap-1 py-2"
			role="status"
			aria-label={t("chat.assistantWorking")}
			data-testid="typing"
		>
			<span className="typing-dot h-1.5 w-1.5 rounded-full bg-muted" />
			<span className="typing-dot h-1.5 w-1.5 rounded-full bg-muted" />
			<span className="typing-dot h-1.5 w-1.5 rounded-full bg-muted" />
		</div>
	);
}

function ExecMessage({ message }: { message: AgentMessage }) {
	const isPy = message.role === "pythonExecution";
	return (
		<div className="rounded-xl border border-border bg-bg-soft text-sm" data-testid="msg-exec">
			<div className="flex items-center gap-2 border-b border-border px-3 py-1.5 font-mono text-xs">
				<SquareTerminal size={14} className="text-muted" />
				<span className="text-accent">{isPy ? "$" : "!"}</span>
				<span className="truncate">{message.command ?? message.code}</span>
				<ExecTail message={message} />
			</div>
			<pre className="max-h-80 overflow-auto p-3 font-mono text-xs whitespace-pre-wrap">
				{message.output ?? textOf(message)}
			</pre>
		</div>
	);
}

/**
 * The right end of a `!command`'s header: how long it ran (when this browser heard it end, see `lib/bash-times.ts`) and a
 * non-zero exit code. Its own component, so that a length that arrives after the message does not draw the message again.
 */
function ExecTail({ message }: { message: AgentMessage }) {
	const t = useT();
	const mode = useToolTimerMode();
	const ms = useBashDuration(message.role === "bashExecution" ? message.command : undefined, message.timestamp);
	const time = mode !== "off" && ms !== undefined ? fmtDuration(ms) : null;
	const failed = typeof message.exitCode === "number" && message.exitCode !== 0;
	if (time === null && !failed) return null;
	return (
		<span className="ml-auto flex shrink-0 items-center gap-2">
			{time !== null ? (
				<span className="text-faint tabular-nums" data-testid="exec-time" title={t("chat.toolTimerDone", { time })}>
					{time}
				</span>
			) : null}
			{failed ? <span className="text-danger">{t("chat.execExit", { code: message.exitCode ?? 0 })}</span> : null}
		</span>
	);
}

/**
 * A row draws its message and, for each tool call in it, that call's saved result and live state: nothing else of the
 * maps it is handed. Those maps are new objects whenever any tool anywhere in the conversation starts, streams or ends,
 * or an entry is saved, so comparing them whole would redraw every row on screen for each of those.
 */
export function sameRow(a: RowProps, b: RowProps): boolean {
	if (
		a.entry !== b.entry ||
		a.message !== b.message ||
		a.actions !== b.actions ||
		a.siblings !== b.siblings ||
		a.streaming !== b.streaming ||
		a.idle !== b.idle ||
		a.readOnly !== b.readOnly
	)
		return false;
	if (a.toolResults === b.toolResults && a.tools === b.tools) return true;
	return sameToolState(a, b, [b.message]);
}

let lastChange: {
	a: RowProps["tools"];
	b: RowProps["tools"];
	ra: ToolResults;
	rb: ToolResults;
	ids: Set<string> | null;
} | null = null;

/**
 * The tool calls whose saved result or live state differs between `a` and `b`: the results saved since, and the few
 * live records that moved. Null when that is not known (the results are not snapshots of one log), and then every call
 * has to be looked at. Asked for once per turn on screen with the same pair, it is worked out once.
 */
export function changedTools(
	a: Pick<RowProps, "toolResults" | "tools">,
	b: Pick<RowProps, "toolResults" | "tools">,
): Set<string> | null {
	const last = lastChange;
	if (last && last.a === a.tools && last.b === b.tools && last.ra === a.toolResults && last.rb === b.toolResults)
		return last.ids;
	const added = resultsAdded(a.toolResults, b.toolResults);
	let ids: Set<string> | null = null;
	if (added !== null) {
		ids = new Set(added);
		if (a.tools !== b.tools) {
			for (const id in b.tools) if (a.tools[id] !== b.tools[id]) ids.add(id);
			for (const id in a.tools) if (!(id in b.tools)) ids.add(id);
		}
	}
	lastChange = { a: a.tools, b: b.tools, ra: a.toolResults, rb: b.toolResults, ids };
	return ids;
}

/** Whether every tool call in `messages` has the same saved result and live state in `a` as in `b`. */
export function sameToolState(
	a: Pick<RowProps, "toolResults" | "tools">,
	b: Pick<RowProps, "toolResults" | "tools">,
	messages: readonly AgentMessage[],
): boolean {
	for (const m of messages) {
		for (const block of blocks(m)) {
			if (block.type !== "toolCall" || !block.id) continue;
			if (a.toolResults.get(block.id) !== b.toolResults.get(block.id) || a.tools[block.id] !== b.tools[block.id])
				return false;
		}
	}
	return true;
}

export const MessageRow = memo(function MessageRow(props: RowProps) {
	const t = useT();
	const { message } = props;
	if (message.role === "user" || message.role === "developer") {
		if (message.attribution === "agent") {
			const text = textOf(message);
			const rules = ruleReminders(text);
			if (rules.length > 0) return <RuleNote rules={rules} />;
			return <NoteRow icon={<ScrollText size={14} />} title={t("chat.noteAgentInjected")} text={text} />;
		}
		return <UserMessage {...props} />;
	}
	if (message.role === "assistant") return <AssistantMessage {...props} />;
	if (message.role === "bashExecution" || message.role === "pythonExecution") return <ExecMessage message={message} />;
	if (message.role === "custom" || message.role === "hookMessage") {
		// A message omp keeps to itself (a rule's injected text) is not a row, here or in the saved transcript.
		if (message.display === false) return null;
		const typed = classifyCustom(message.customType, message.details, message.content);
		if (typed) return <TypedNote note={typed} />;
		return (
			<NoteRow
				icon={<ScrollText size={14} />}
				title={message.customType ?? t("chat.noteExtension")}
				text={textOf(message)}
			/>
		);
	}
	if (message.role === "fileMention") {
		const files = message.files ?? [];
		return (
			<NoteRow
				icon={<ScrollText size={14} />}
				title={t("chat.noteRead", {
					files: files.map((f) => `@${f.path}`).join(", ") || t("chat.noteMentionedFiles"),
				})}
				text={files.map((f) => `\`${f.path}\`\n\n\`\`\`\n${f.content ?? ""}\n\`\`\``).join("\n\n")}
			/>
		);
	}
	return null;
}, sameRow);

/** Rows for non-message entries (summaries, compaction, model switches). */
export function EntryNote({ entry }: { entry: SessionEntry }) {
	const t = useT();
	if (entry.type === "branch_summary")
		return (
			<NoteRow icon={<GitBranch size={14} />} title={t("chat.noteBranchSummary")} text={String(entry.summary ?? "")} />
		);
	if (entry.type === "compaction") {
		return (
			<NoteRow
				icon={<ScrollText size={14} />}
				title={
					entry.tokensBefore
						? t("chat.noteCompactedTokens", { tokens: fmtTokens(Number(entry.tokensBefore)) })
						: t("chat.noteCompacted")
				}
				text={String(entry.summary ?? "")}
			/>
		);
	}
	if (entry.type === "model_change") {
		// omp moved to its fallback model: say so, apart from the switches the user made.
		if (entry.resolvedModelIsFallback === true)
			return <FallbackNote title={t("chat.noteFallbackSaved", { model: String(entry.model ?? "") })} />;
		return (
			<div className="my-2 flex items-center gap-3 text-xs text-faint">
				<div className="h-px flex-1 bg-border" />
				{t("chat.noteModelChange", { model: String(entry.model ?? "") })}
				<div className="h-px flex-1 bg-border" />
			</div>
		);
	}
	if (entry.type === "custom_message") {
		const typed = classifyCustom(entry.customType, entry.details, entry.content);
		if (typed) return <TypedNote note={typed} />;
		return (
			<NoteRow
				icon={<ScrollText size={14} />}
				title={String(entry.customType ?? t("chat.noteExtension"))}
				text={contentText(entry.content)}
			/>
		);
	}
	const notice = noticeOf(entry);
	if (notice) return <LiveNoticeRow notice={notice} />;
	return null;
}
