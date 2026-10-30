import type { ExitInfo } from "@shared/exit.ts";
import type { Goal } from "@shared/goal.ts";
import { type GoalProposal, PROPOSE_GOAL_TOOL, readProposal } from "@shared/guided-goal.ts";
import { type AttachedHold, EMPTY_HOLD, statusOf, widgetOf } from "@shared/held-state.ts";
import type { LiveInfo, OmpFrame, SessionEntry } from "@shared/protocol.ts";
import { parseRiskTitle } from "@shared/risk-confirm.ts";
import { commandText } from "../lib/command-notes.ts";
import {
	type AgentMessage,
	type ContentBlock,
	isAgentMessage,
	blocks as messageBlocks,
	messageOf,
	type RetryRecovery,
} from "../lib/messages.ts";
import { type CommandNote, ircKey, ircMode, type LiveNotice } from "../lib/notices.ts";
import { type RetryWait, sameWait, waitFromFrame, waitFromInfo } from "../lib/retry-wait.ts";
import { serverOffsetMs } from "../lib/server-clock.ts";
import { applySubagentFrame, trimTools, unseen } from "./subagents-live.ts";

/** Pure state model for one live omp process, driven by forwarded RPC frames. */

export interface SlashCommand {
	name: string;
	source: string;
	aliases?: string[];
	description?: string;
	input?: { hint?: string };
	subcommands?: { name: string; description?: string }[];
}

export interface ModelInfo {
	id: string;
	name?: string;
	provider: string;
	/** The API the model speaks (`anthropic-messages`, `openai-responses`…): with the provider, what omp's service tiers go by. */
	api?: string;
	reasoning?: boolean;
	contextWindow?: number;
	cost?: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number };
	input?: string[];
	/** The thinking levels the model takes besides `off`; `unverified`: omp has not checked them, so it offers no `auto`. */
	thinking?: { efforts?: string[]; unverified?: boolean };
}

export interface TodoTask {
	content: string;
	status: string;
	blocker?: string;
}

export interface RpcState {
	model?: ModelInfo;
	thinkingLevel?: string;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: string;
	followUpMode: string;
	interruptMode: string;
	sessionFile?: string;
	sessionId?: string;
	sessionName?: string;
	fastModeEnabled?: boolean;
	fastModeActive?: boolean;
	slowModeSupported?: boolean;
	slowModeEnabled?: boolean;
	/**
	 * Where omp's slow mode lives: `global` when `set_slow_mode` writes omp's own `config.yml` (so it reaches every
	 * conversation, not just this one), `session` when it is the process's own. Absent where omp does not say (an
	 * older omp, which has no slow mode at all).
	 */
	slowModeScope?: "global" | "session";
	tokensPerSecond?: number | null;
	autoCompactionEnabled?: boolean;
	messageCount: number;
	queuedMessageCount: number;
	isSettled?: boolean;
	queuedMessages?: { steering: string[]; followUp: string[]; liveSteered?: number };
	todoPhases?: { name: string; tasks: TodoTask[] }[];
	contextUsage?: { tokens: number; contextWindow: number; percent: number };
	/** The account is past its usage limit: `low_priority` (served on spare capacity) or `wrap_up` (a short allowance). */
	usageLimit?: { stage: string; resetsAtSec?: number; allowanceLeftPercent?: number; extraUsage?: boolean };
	/** Every tool the process offers the model, including the ones the web UI registered (`set_host_tools`). */
	dumpTools?: { name: string }[];
}

export interface OverlayMessage {
	messageId: string;
	message: AgentMessage;
	ended: boolean;
}

export interface ToolExec {
	toolCallId: string;
	toolName: string;
	args: unknown;
	intent?: string;
	partial?: unknown;
	result?: unknown;
	isError?: boolean;
	done: boolean;
	startedAt: number;
	/**
	 * When the page saw the tool end (`tool_execution_end`), on this page's clock. Together with `startedAt` it is how long
	 * the call ran, unless `late`.
	 */
	endedAt?: number;
	/**
	 * The page did not see the tool start (it attached while the tool ran, or heard only its end): `startedAt` is when the
	 * page first heard of it, not when it began, and says nothing about how long it has run (see `lib/tool-time.ts`).
	 */
	late?: true;
}

export interface SubagentProgress {
	id: string;
	agent?: string;
	status?: string;
	task?: string;
	assignment?: string;
	description?: string;
	lastIntent?: string;
	recentOutput?: string[];
	recentTools?: { tool: string; args?: string; intent?: string; isError?: boolean }[];
	toolCount?: number;
	requests?: number;
	tokens?: number;
	cost?: number;
	durationMs?: number;
	contextTokens?: number;
	contextWindow?: number;
	resolvedModel?: string;
	index?: number;
	/** The agent's own estimate of how far along it is (0–100). */
	completionPercent?: number;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolIntent?: string;
}

export interface SubagentState {
	id: string;
	agent?: string;
	status: string;
	index?: number;
	description?: string;
	task?: string;
	assignment?: string;
	/** Runs as a background job, not within its parent's tool call. */
	detached?: boolean;
	sessionFile?: string;
	parentToolCallId?: string;
	progress?: SubagentProgress;
	/** The assistant message being written, or just finished, from `subagent_event` frames. */
	streaming?: AgentMessage | null;
	/** `streaming` is complete: it is, or is about to be, in the transcript too. */
	streamEnded?: boolean;
	/** The subagent's tool calls with their live output, from `subagent_event` frames. */
	tools?: Record<string, ToolExec>;
	/** When this run started and ended, on this browser's clock. */
	startedAt?: number;
	finishedAt?: number;
	/**
	 * omp is backing off before it retries this subagent's failed turn (a usage-limit wait of hours, most of all): from
	 * its `subagent_event` frames, or its progress for a tab that attached meanwhile. Absent when it is not.
	 */
	retry?: RetryWait | null;
	/**
	 * The wait the retried turn has got past (its attempt and delay): the subagent wrote or ran something after it. omp's
	 * registry may still carry that `retryState` until the turn ends; a progress record with it does not bring it back.
	 */
	retryPassed?: { attempt: number; delayMs: number };
	updatedAt: number;
}

export interface UIRequest {
	id: string;
	method: string;
	title?: string;
	message?: string;
	options?: string[];
	optionDetails?: { description?: string }[];
	placeholder?: string;
	prefill?: string;
	questions?: AskQuestion[];
	timeout?: number;
	/** When omp stops waiting and answers by itself, on this page's clock; only for a dialog that has a `timeout`. */
	deadline?: number;
	/** `propose_goal`: the goal the model proposes at the end of a guided interview. */
	proposal?: GoalProposal;
	[key: string]: unknown;
}

export interface AskQuestion {
	id: string;
	question: string;
	header?: string;
	options: { label: string; description?: string; preview?: string }[];
	multi?: boolean;
	recommended?: number;
}

export interface BtwTurn {
	question: string;
	answer: string;
	status: string;
	error?: string;
}

export interface BtwRecord extends BtwTurn {
	id: string;
	createdAt: number;
	/** The model that answered, as `provider/id`, where the server knows it (omp's own record does not say). */
	model?: string;
	followUps?: BtwTurn[];
}

/** A failed turn omp retries by itself: backing off before attempt `attempt` of `maxAttempts`, or given up. */
export type RetryState = RetryWait | { phase: "failed"; attempt: number; finalError?: string };

/** The reminder omp sent because the agent stopped with todos left (`todo_reminder`). */
export interface TodoReminder {
	/** The todos still open when it stopped. */
	todos: TodoTask[];
	attempt: number;
	maxAttempts: number;
	/** The turn the reminder asked for has started: the reminder is cleared when that turn ends. */
	resumed: boolean;
}

/** How an automatic compaction ended (`auto_compaction_end`), in the TUI's own terms. */
export interface CompactionOutcome {
	kind: "cancelled" | "completed" | "failed";
	/** What omp did: `context-full`, `remote`, `handoff`, `shake` or `snapcompact`. */
	action?: string;
	/** omp's own words for a failure. */
	message?: string;
	/** The context's size before it was compacted, when omp says. */
	tokensBefore?: number;
	/** When this page heard of it. */
	at: number;
}

export interface LiveState {
	info: LiveInfo;
	/**
	 * What omp said of its state, as the page last read it; for a paused conversation the page attached to, only the part the
	 * server kept of it (`LiveAttached.state`), which a read replaces once omp runs for an action or is resumed.
	 */
	state: Partial<RpcState> | null;
	entries: SessionEntry[];
	leafId: string | null;
	overlay: OverlayMessage[];
	tools: Record<string, ToolExec>;
	subagents: Record<string, SubagentState>;
	/** `liveSteered`: how many of the leading `steering` entries omp already sent into the running response (it can no longer withdraw them). */
	queue: { steering: string[]; followUp: string[]; liveSteered?: number };
	uiRequests: UIRequest[];
	/**
	 * A dialog waits for the user's answer: `uiRequests.length > 0`, set through `withUiRequests`, for a process the page
	 * listens to. For one it does not, the server's word that one waits (`withWork`): the page holds no dialog to show.
	 */
	needsInput: boolean;
	statuses: Record<string, string>;
	widgets: Record<string, string[]>;
	commands: SlashCommand[];
	/** What commands printed, each placed after the entry saved last when it came (see `withLiveNotices`); the latest 50. */
	commandOutput: CommandNote[];
	btw: Record<string, BtwRecord>;
	goal: Goal | null;
	/** Latest provider sign-in URL from a `login` flow (`open_url`). */
	loginUrl: { url: string; launchUrl?: string; instructions?: string } | null;
	exited: ExitInfo | null;
	lastError: string | null;
	/** The retry omp is waiting to make, or has given up on (until the next turn starts); null when there is none. */
	retry: RetryState | null;
	/** omp is compacting the context by itself (`auto_compaction_start` … `auto_compaction_end`). */
	compacting: { reason?: string; action?: string } | null;
	/** What omp announced while it worked (rules applied, model fallbacks, IRC messages), in the order it did. */
	notices: LiveNotice[];
	/** The reminder to finish the todo list, shown until the turn it started ends. */
	todoReminder: TodoReminder | null;
	/** How the last automatic compaction ended; null while one runs and before the first. */
	compactionOutcome: CompactionOutcome | null;
	streaming: boolean;
	/**
	 * Goes up with every frame that starts or ends a turn (`agent_start`, a terminal `agent_end`, `session_settled`). An answer
	 * to a `get_state` asked before the last of them is older than what the page knows of the turn, so it does not say
	 * whether one runs (#680).
	 */
	turnMarks: number;
	/** omp is idle and nothing has started since: its `session_settled` frame, or `get_state.isSettled` when the page asked. */
	settled: boolean;
	/**
	 * omp sent its own `session_settled` frame and no turn has started since. A wait it announces then is one it has lost
	 * (omp 18.12, when two failures overlap): unlike `settled`, the state the page read on attach does not count, since a
	 * turn may start and fail between that read and the wait it announces.
	 */
	idleAnnounced: boolean;
	/**
	 * A turn of an active goal ended and omp may start the next one: omp has not said it is settled. A goal run is many
	 * turns (`agent_start` … `agent_end`, the next one ~1 ms after the last) and one `session_settled` at its end, so
	 * between two of them `streaming` is false though the run is not over (see `working` in `shared/attention.ts`).
	 */
	continuing: boolean;
	/**
	 * omp is in the read-only plan mode `--plan-yolo` starts it in. omp 18.12 tells RPC clients nothing of plan mode (no
	 * `get_state` field, no command to enter or leave it), so this is inferred: true from the start for a process started
	 * with that flag, false once the page has read the hidden `plan-yolo-handoff` entry omp writes when the plan is approved
	 * (see `pullEntries`). It is the process's, not the session's: omp 18.12 is still in plan mode after `/new` or a fork
	 * until the plan is approved (the new session's first request again carries "Plan mode active"), so `leaveSession`
	 * leaves it alone.
	 */
	planMode: boolean;
	/**
	 * The process's `LiveInfo.revision` as of what this page has read of its entries: `entries` can hold nothing omp has
	 * rewritten since, so an attach that finds the same revision reads only what came after the last one. Moved by the
	 * frames this page hears (each is stamped with it) and set by a full read; null while the page does not know (never
	 * read, or a full read is pending), in which case an attach reads everything again and frames do not move it.
	 */
	revision: number | null;
	/**
	 * When this page saw the process run again after a pause (its clock), 0 when it has not. omp retries what came due
	 * while it was frozen the moment it runs, so a wait is late only from here (see `retryPhase`'s `thawedAt`).
	 */
	resumedAt: number;
	/**
	 * What this page knows the process is set to as a person chose it, which can be `auto` (omp's `get_state` reports only
	 * the level `auto` resolved to): the `configured` selector of the last `thinking_level_changed` frame it heard (the
	 * level itself when explicit). Undefined until then: a page that attaches later has heard nothing, and takes the
	 * selector from the journal or from how the process started (see `selectedThinking`).
	 */
	thinking?: string;
}

export function initialLive(info: LiveInfo): LiveState {
	return {
		info,
		state: null,
		entries: [],
		leafId: null,
		overlay: [],
		tools: {},
		subagents: {},
		queue: { steering: [], followUp: [] },
		uiRequests: [],
		needsInput: false,
		statuses: {},
		widgets: {},
		commands: [],
		commandOutput: [],
		btw: {},
		goal: null,
		loginUrl: null,
		exited: null,
		lastError: null,
		retry: waitFromInfo(info, serverOffsetMs()),
		compacting: null,
		notices: [],
		todoReminder: null,
		compactionOutcome: null,
		streaming: info.streaming,
		turnMarks: 0,
		settled: false,
		idleAnnounced: false,
		continuing: false,
		planMode: info.args.includes("--plan-yolo"),
		revision: null,
		resumedAt: resumedFromInfo(info),
	};
}

/** When the server says the process ran again after a pause, on this page's clock; 0 when it says nothing. */
function resumedFromInfo(info: LiveInfo): number {
	return info.resumedAt && !info.pausedAt ? info.resumedAt - serverOffsetMs() : 0;
}

/**
 * The process as the server describes it now (a `live` announce, the answer to Resume or Retry now): its `info`, and
 * when it was paused before and is not now, the moment this page saw it run again (`resumedAt`, on its own clock). A
 * page that attached after the resume has no earlier pause to compare with: the server's stamp says when it ran again
 * (`LiveInfo.resumedAt`), which a page that saw it run keeps its own reading over.
 */
export function withInfo(s: LiveState, info: LiveInfo, now = Date.now()): LiveState {
	const resumed = Boolean(s.info.pausedAt) && !info.pausedAt;
	if (resumed) return { ...s, info, resumedAt: now };
	const stamped = resumedFromInfo(info);
	return stamped > s.resumedAt ? { ...s, info, resumedAt: stamped } : { ...s, info };
}

/**
 * What the server last said of the work of a process this page does not listen to (`LiveInfo.streaming`, `continuing`,
 * `asking`). None of its frames reach the page, so the dot beside its conversation, the count in the tab's title and the
 * notifications go by this, and by nothing else (#592). `needsInput` says a dialog waits without there being one the
 * page could show: it shows them once it listens (attaching brings them), which is when it is looked at.
 */
export function withWork(s: LiveState, info: LiveInfo): LiveState {
	const streaming = info.streaming;
	const continuing = info.continuing === true;
	const asking = info.asking === true;
	if (s.streaming === streaming && s.continuing === continuing && s.needsInput === asking) return s;
	const work = { ...s, streaming, continuing };
	return asking ? { ...work, needsInput: true } : withUiRequests(work, []);
}

/**
 * What the server says of omp's backoff (`LiveInfo.retry`) set against what this page saw of it: a page that attached
 * while omp was backing off, or that lost its connection while a backoff began, ended or went on to its next attempt,
 * missed the frames. The server's wait replaces the page's unless it is the same one (same attempt, delay and start),
 * of which the page keeps its own view, taking only the start of the retried turn it may have missed. `offsetMs`: the
 * server's clock minus this page's (see `serverOffsetMs`). The missed frames may include the start of a turn, so that
 * omp was idle (`settled`) is not known again until it says so.
 */
export function reconcileRetry(live: LiveState, info: LiveInfo, offsetMs: number = serverOffsetMs()): LiveState {
	const s = live.settled || live.idleAnnounced ? { ...live, settled: false, idleAnnounced: false } : live;
	const wait = s.retry?.phase === "waiting" ? s.retry : null;
	const held = waitFromInfo(info, offsetMs);
	if (!held) return wait ? { ...s, retry: null } : s;
	if (!wait || !sameWait(wait, held)) return { ...s, retry: held };
	return held.resumed && !wait.resumed ? { ...s, retry: { ...wait, resumed: true } } : s;
}

/**
 * The process moved to another session file (`/new`, fork, branch, resume in the same omp): what belonged to the session
 * it left is gone. omp leaves the previous goal and its subagents behind (it answers `goal: null` for a new session, and
 * restores only a goal journaled in the target), so the page must not keep showing them, nor the tool runs, the queue
 * and the notices of the old conversation. What it reads from omp again (state, goal, subagents, commands, entries) is
 * `hydrate`'s business. Plan mode is not among what is dropped (see `LiveState.planMode`).
 */
export function leaveSession(s: LiveState): LiveState {
	return {
		...s,
		goal: null,
		continuing: false,
		subagents: {},
		tools: {},
		overlay: [],
		queue: { steering: [], followUp: [] },
		todoReminder: null,
		btw: {},
		notices: [],
		lastError: null,
		compactionOutcome: null,
	};
}

const DIALOG_METHODS: Record<string, true> = { select: true, confirm: true, input: true, editor: true, ask: true };

/** Replace the pending dialogs; `needsInput` follows, so the two can never disagree. */
export function withUiRequests(s: LiveState, uiRequests: UIRequest[]): LiveState {
	return { ...s, uiRequests, needsInput: uiRequests.length > 0 };
}

/**
 * A dialog that asks before a tool runs: omp's own (a select titled `Allow tool: <name>`, the call's details on the lines
 * after; see approval-mode.md) or the gate's, which asks about a risky call a remote page drives (`parseRiskTitle`). Both
 * are answered the same way (`denial`) and shown the same way.
 */
export function isApproval(req: UIRequest): boolean {
	return req.method === "select" && (/^Allow tool:/.test(req.title ?? "") || parseRiskTitle(req.title) !== null);
}

/** What answers a tool approval with no: its Deny choice, else a dismissal (which omp takes as a no too). */
export function denial(req: UIRequest): Record<string, unknown> {
	const deny = req.options?.find((o) => /^deny/i.test(o));
	return deny === undefined ? { id: req.id, cancelled: true } : { id: req.id, value: deny };
}

/** The approvals `denied` are answered (see `denial`): they leave the list, and a note says why the tools did not run. */
export function withApprovalsDenied(s: LiveState, denied: UIRequest[]): LiveState {
	const ids = new Set(denied.map((r) => r.id));
	const left = withUiRequests(
		s,
		s.uiRequests.filter((r) => !ids.has(r.id)),
	);
	return addNotice(left, {
		kind: "approvalDenied",
		tools: denied.map(
			(r) => parseRiskTitle(r.title)?.tool ?? (r.title ?? "").split("\n")[0].replace(/^Allow tool:\s*/, ""),
		),
	});
}

/**
 * What omp answers an `ask` when its deadline passes: the recommended option of each question, the first without one
 * (omp's own rule; its answer is not sent to the page). Nothing for another dialog, which omp takes as cancelled.
 */
function chosenOnTimeout(req: UIRequest): { question: string; answer: string }[] {
	return (req.questions ?? []).flatMap((q) => {
		const pick = q.options[Math.min(Math.max(q.recommended ?? 0, 0), Math.max(q.options.length - 1, 0))];
		return pick ? [{ question: q.question, answer: pick.label }] : [];
	});
}

/**
 * The server has sent a tab that attached what it holds for it (dialogs that wait, the message omp is writing and what omp
 * said once that still holds, as frames before this) and says that is all: a dialog this page still shows beyond `dialogs`
 * was settled while it was away (answered in another tab, cancelled by omp, timed out), and so was a half-written message
 * that is not `message`. Likewise a compaction, an extension's status line or widget the page shows and `held` does not
 * name ended while it was away. Messages that ended wait for the entries to catch up with them, and stay.
 */
export function applyAttached(
	s: LiveState,
	dialogs: string[],
	message: string | null,
	held: AttachedHold | undefined,
): LiveState {
	// A server that predates `held` names nothing of what it keeps: the page drops what it shows beyond that (see `EMPTY_HOLD`).
	const kept = held ?? EMPTY_HOLD;
	const asking = s.uiRequests.filter((r) => dialogs.includes(r.id));
	const overlay = s.overlay.filter((o) => o.ended || o.messageId === message);
	// A process the page did not listen to said a dialog waited without the page holding one (see `withWork`): the dialogs
	// the server lists now are all there are, so `needsInput` follows them too.
	const asked =
		asking.length === s.uiRequests.length && s.needsInput === asking.length > 0 ? s : withUiRequests(s, asking);
	const shown = overlay.length === s.overlay.length ? asked : { ...asked, overlay };
	const statuses = keep(shown.statuses, kept.statuses);
	const widgets = keep(shown.widgets, kept.widgets);
	if (statuses === shown.statuses && widgets === shown.widgets && (kept.compacting || !shown.compacting)) return shown;
	return { ...shown, statuses, widgets, compacting: kept.compacting ? shown.compacting : null };
}

/** `shown` without the keys `named` does not name; `shown` itself when none goes. */
function keep<T>(shown: Record<string, T>, named: string[]): Record<string, T> {
	const gone = Object.keys(shown).filter((key) => !named.includes(key));
	if (gone.length === 0) return shown;
	return Object.fromEntries(Object.entries(shown).filter(([key]) => named.includes(key)));
}

function str(v: unknown): string | undefined {
	return typeof v === "string" ? v : undefined;
}

function num(v: unknown): number {
	return typeof v === "number" ? v : 0;
}

/**
 * Finished tools a process keeps. A tool's card draws its saved result once the transcript has it, and nothing else of
 * the live record, so the ones the transcript has by now are dead weight: omp runs for days, a goal's tool calls number
 * in the thousands, and each record holds the call's whole output. A few stay for the moment between a tool ending and
 * its result being saved.
 */
const KEEP_DONE_TOOLS = 50;

/** The most notices kept for a process: it can run for days. */
const MAX_NOTICES = 40;

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** Append a notice, placed after the last saved entry. */
function addNotice(s: LiveState, n: DistributiveOmit<LiveNotice, "seq" | "at" | "after">): LiveState {
	const seq = (s.notices.at(-1)?.seq ?? 0) + 1;
	const notice = { ...n, seq, at: Date.now(), after: s.entries.at(-1)?.id ?? null } as LiveNotice;
	return { ...s, notices: [...s.notices, notice].slice(-MAX_NOTICES) };
}

/** The rules of a `ttsr_triggered` frame: what the terminal shows is the description, else the rule's text. */
function rulesOf(v: unknown): { name: string; text: string }[] {
	if (!Array.isArray(v)) return [];
	return v.flatMap((r) => {
		const { name, description, content } = rec(r);
		if (typeof name !== "string" || !name) return [];
		return [{ name, text: (str(description) || str(content) || "").trim() }];
	});
}

function rec(v: unknown): Record<string, unknown> {
	return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
}

function upsertOverlay(list: OverlayMessage[], id: string, message: AgentMessage, ended: boolean): OverlayMessage[] {
	const i = list.findIndex((o) => o.messageId === id);
	if (i < 0) return [...list, { messageId: id, message, ended }];
	const next = list.slice();
	next[i] = { messageId: id, message, ended: ended || next[i].ended };
	return next;
}

/**
 * Apply one `assistantMessageEvent` delta (text/thinking/toolcall start·delta·end)
 * to a streaming message's content blocks. `*_end` events carry the finished block.
 */
export function applyDelta(msg: AgentMessage, ev: Record<string, unknown>): AgentMessage {
	const type = str(ev.type) ?? "";
	const i = typeof ev.contentIndex === "number" ? ev.contentIndex : -1;
	if (i < 0) return msg;
	// A copy to write into by the event's index: a block of the message that is not readable keeps its place (see `blocks`).
	const content: ContentBlock[] = [...messageBlocks(msg)];
	const cur = content[i];
	const delta = str(ev.delta) ?? "";
	switch (type) {
		case "text_start":
			content[i] = { type: "text", text: "" };
			break;
		case "text_delta":
			content[i] = { type: "text", text: (cur?.text ?? "") + delta };
			break;
		case "text_end":
			content[i] = { type: "text", text: str(ev.content) ?? cur?.text ?? "" };
			break;
		case "thinking_start":
			content[i] = { type: "thinking", thinking: "" };
			break;
		case "thinking_delta":
			content[i] = { type: "thinking", thinking: (cur?.thinking ?? "") + delta };
			break;
		case "thinking_end":
			content[i] = { type: "thinking", thinking: str(ev.content) ?? cur?.thinking ?? "" };
			break;
		case "toolcall_start":
			// Arguments stream as partial JSON; the card shows a pending call until `toolcall_end`.
			content[i] = { type: "toolCall", id: `pending-${i}`, name: "tool", arguments: {} };
			break;
		case "toolcall_end": {
			const call = rec(ev.toolCall);
			content[i] = { type: "toolCall", id: str(call.id), name: str(call.name), arguments: rec(call.arguments) };
			break;
		}
		default:
			return msg;
	}
	return { ...msg, content };
}

/** The recovery omp recorded on each failed message a successful retry got past: `retryErrors` of `auto_retry_end`. */
function recoveriesOf(retryErrors: unknown): Map<string, RetryRecovery> {
	const out = new Map<string, RetryRecovery>();
	if (!Array.isArray(retryErrors)) return out;
	for (const update of retryErrors) {
		const { entryId, retryRecovery } = rec(update);
		if (typeof entryId !== "string" || !retryRecovery || typeof retryRecovery !== "object") continue;
		const r = rec(retryRecovery);
		out.set(entryId, {
			kind: str(r.kind),
			status: str(r.status) ?? "recovered",
			attempt: typeof r.attempt === "number" ? r.attempt : undefined,
			recovery: str(r.recovery),
			note: str(r.note),
		});
	}
	return out;
}

/**
 * Mark failed messages as recovered. omp rewrites them on disk, but the entries already fetched are not fetched
 * again (`get_entries` goes on from the last one), so the page applies what the frame says.
 */
function markRecovered(entries: SessionEntry[], recoveries: Map<string, RetryRecovery>): SessionEntry[] {
	return entries.map((e) => {
		const retryRecovery = recoveries.get(e.id);
		return retryRecovery && isAgentMessage(e.message) ? { ...e, message: { ...e.message, retryRecovery } } : e;
	});
}

/** The conversation holds a result of the tool call `id`, saved or announced (the call is over). */
function hasResult(s: LiveState, id: string): boolean {
	const resultOf = (m: AgentMessage | null) => m?.role === "toolResult" && m.toolCallId === id;
	return s.overlay.some((o) => resultOf(o.message)) || s.entries.some((e) => resultOf(messageOf(e)));
}

/** The newest message of the conversation: the one still streaming in, else the last saved one. */
function newestMessage(s: LiveState): AgentMessage | null {
	const streamed = s.overlay.at(-1)?.message;
	if (streamed) return streamed;
	for (let i = s.entries.length - 1; i >= 0; i--) {
		const m = messageOf(s.entries[i]);
		if (m) return m;
	}
	return null;
}

function todosOf(v: unknown): TodoTask[] {
	return Array.isArray(v)
		? v.flatMap((t) => {
				const task = rec(t);
				const content = str(task.content);
				return content === undefined
					? []
					: [{ content, status: str(task.status) ?? "pending", blocker: str(task.blocker) }];
			})
		: [];
}

/**
 * What the TUI says when automatic compaction ends, in its order: cancelled; a shake's failure or completion; a result
 * (the compaction itself, which the transcript shows); omp's own error; a handoff's completion; a benign skip says
 * nothing; any other failure carries on without maintenance.
 */
function compactionOutcome(f: OmpFrame): CompactionOutcome | null {
	const action = str(f.action);
	const at = Date.now();
	const message = str(f.errorMessage);
	if (f.aborted === true) return { kind: "cancelled", action, at };
	if (action === "shake") {
		if (message) return { kind: "failed", action, message, at };
		return f.skipped === true ? null : { kind: "completed", action, at };
	}
	const result = rec(f.result);
	if (f.result && typeof f.result === "object") {
		return {
			kind: "completed",
			action,
			tokensBefore: typeof result.tokensBefore === "number" ? result.tokensBefore : undefined,
			at,
		};
	}
	if (message) return { kind: "failed", action, message, at };
	if (action === "handoff") return { kind: "completed", action, at };
	return f.skipped === true ? null : { kind: "failed", action, at };
}

/** Fold one frame into live state. Side effects (refetching entries) are the caller's job. */
export function applyFrame(s: LiveState, f: OmpFrame): LiveState {
	switch (f.type) {
		case "settings_changed": {
			// What a command changed that omp does not announce (see `settingFrame` of the server): the fields of its state.
			const settings = rec(f.settings);
			return s.state ? { ...s, state: { ...s.state, ...settings } } : s;
		}
		case "thinking_level_changed": {
			// `configured` is the user's selector when it differs from the level (`auto`); an explicit level has none.
			const thinking = str(f.configured) ?? str(f.thinkingLevel) ?? "off";
			return thinking === s.thinking ? s : { ...s, thinking };
		}
		case "goal_updated": {
			const goal = (f.goal as Goal | null) ?? null;
			// A goal that is no longer active has no next turn coming; one that has just become active (created, resumed)
			// starts its turn a moment later, and omp counts the session as busy until it does.
			const started = goal?.status === "active" && s.goal?.status !== "active";
			return {
				...s,
				goal,
				settled: s.settled && !started,
				idleAnnounced: s.idleAnnounced && !started,
				continuing: s.continuing && goal?.status === "active",
			};
		}
		case "agent_start":
			// A turn starting leaves behind a retry that gave up; one that is waiting stays until omp reports its end, as
			// the retried turn that is now running.
			return {
				...s,
				streaming: true,
				turnMarks: s.turnMarks + 1,
				settled: false,
				idleAnnounced: false,
				continuing: false,
				lastError: null,
				retry:
					s.retry?.phase === "failed" ? null : s.retry?.phase === "waiting" ? { ...s.retry, resumed: true } : s.retry,
				todoReminder: s.todoReminder ? { ...s.todoReminder, resumed: true } : null,
			};
		case "agent_end": {
			const terminal = f.isTerminal !== false;
			return {
				...s,
				// Turns follow one another for as long as an active goal is not stopped: omp says so with `session_settled`.
				continuing: terminal ? s.goal?.status === "active" : s.continuing,
				streaming: terminal ? false : s.streaming,
				turnMarks: terminal ? s.turnMarks + 1 : s.turnMarks,
				// The turn the reminder asked for is over; a reminder that came before it started still waits for it.
				todoReminder: terminal && s.todoReminder?.resumed ? null : s.todoReminder,
			};
		}
		case "session_settled":
			// Nothing is live any more: a retry or compaction whose end frame never arrived is not still going on.
			return {
				...s,
				continuing: false,
				streaming: false,
				turnMarks: s.turnMarks + 1,
				settled: true,
				idleAnnounced: true,
				retry: s.retry?.phase === "waiting" ? null : s.retry,
				compacting: null,
				todoReminder: null,
			};
		case "todo_reminder":
			return {
				...s,
				todoReminder: {
					todos: todosOf(f.todos),
					attempt: num(f.attempt),
					maxAttempts: num(f.maxAttempts),
					resumed: false,
				},
			};
		case "todo_auto_clear":
			// omp cleared a finished list: the page's copy goes at once, before the state is asked for again.
			return { ...s, todoReminder: null, state: s.state ? { ...s.state, todoPhases: [] } : s.state };
		case "message_start":
		case "message_update":
		case "message_end": {
			const id = str(f.messageId);
			const ev = rec(f.assistantMessageEvent);
			if (!id) return s;
			// Delta projection (`set_event_filter … messageUpdates: "delta"`): no `partial` snapshot.
			if (f.type === "message_update" && !isAgentMessage(ev.partial)) {
				const role = str(rec(f.message).role) ?? "assistant";
				const known = s.overlay.find((o) => o.messageId === id)?.message;
				const base = known ?? { role, content: [] };
				const next = applyDelta(base, ev);
				// What a tool call's arguments stream (`toolcall_delta`) is not shown until the call ends: such a delta leaves the message, and so the state, as it is.
				if (known && next === known) return s;
				return { ...s, overlay: upsertOverlay(s.overlay, id, next, false) };
			}
			const msg = isAgentMessage(f.message) ? f.message : isAgentMessage(ev.partial) ? ev.partial : null;
			if (!msg) return s;
			return { ...s, overlay: upsertOverlay(s.overlay, id, msg, f.type === "message_end") };
		}
		case "tool_execution_start": {
			const id = str(f.toolCallId);
			if (!id) return s;
			return {
				...s,
				tools: {
					...s.tools,
					[id]: {
						toolCallId: id,
						toolName: str(f.toolName) ?? "tool",
						args: f.args,
						intent: str(f.intent),
						done: false,
						startedAt: Date.now(),
					},
				},
			};
		}
		case "tool_execution_update":
		case "tool_stream_update": {
			const id = str(f.toolCallId);
			if (!id) return s;
			const seen = s.tools[id];
			// `tool_stream_update` is a tool's arguments being written, before it runs (omp's `edit` sends it while the model
			// is still typing the call): only the tool's own output starts a record.
			if (!seen && f.type === "tool_stream_update") return s;
			// A page that attached while the tool ran missed its start (a `wait` or a `task` runs for minutes, and a page
			// opens the conversation at any moment): what the tool prints is the first the page hears of it, and is shown
			// as the output of a running tool, as it is on the page that saw it start. A call that is over (its result is
			// saved, or announced) and was forgotten since (`trimTools`) does not start again for a late update.
			if (!seen && hasResult(s, id)) return s;
			const cur: ToolExec = seen ?? unseen(id, f);
			return { ...s, tools: { ...s.tools, [id]: { ...cur, partial: f.partialResult ?? f.partial ?? f.update } } };
		}
		case "tool_execution_end": {
			const id = str(f.toolCallId);
			if (!id) return s;
			const cur: ToolExec = s.tools[id] ?? unseen(id, f);
			return {
				...s,
				tools: trimTools(
					{
						...s.tools,
						[id]: { ...cur, done: true, endedAt: Date.now(), result: f.result, isError: Boolean(f.isError) },
					},
					KEEP_DONE_TOOLS,
				),
			};
		}
		case "queue_update":
			return {
				...s,
				queue: {
					steering: Array.isArray(f.steering) ? (f.steering as string[]) : [],
					followUp: Array.isArray(f.followUp) ? (f.followUp as string[]) : [],
					liveSteered: typeof f.liveSteered === "number" ? f.liveSteered : 0,
				},
			};
		case "available_commands_update":
			return Array.isArray(f.commands) ? { ...s, commands: f.commands as SlashCommand[] } : s;
		case "command_output": {
			const note: CommandNote = {
				kind: "command",
				seq: (s.commandOutput.at(-1)?.seq ?? 0) + 1,
				at: Date.now(),
				after: s.entries.at(-1)?.id ?? null,
				file: s.info.sessionFile,
				text: commandText(f),
			};
			return { ...s, commandOutput: [...s.commandOutput.slice(-49), note] };
		}
		case "host_tool_call": {
			// The one tool the web UI gives omp: its call is a goal proposal the user decides on, shown like a dialog.
			const id = str(f.id);
			const proposal = f.toolName === PROPOSE_GOAL_TOOL ? readProposal(f.arguments) : null;
			if (!id || !proposal || s.uiRequests.some((r) => r.id === id)) return s;
			return withUiRequests(s, [...s.uiRequests, { id, method: "propose_goal", proposal }]);
		}
		case "host_tool_cancel": {
			// omp gave up on the call (the turn was stopped): nothing is waiting for the user's answer any more.
			const target = str(f.targetId);
			if (!s.uiRequests.some((r) => r.id === target)) return s;
			return withUiRequests(
				s,
				s.uiRequests.filter((r) => r.id !== target),
			);
		}
		case "extension_ui_request": {
			const req = f as unknown as UIRequest;
			if (DIALOG_METHODS[req.method]) {
				// The server replays pending dialogs on attach; a tab that still shows one keeps it once.
				if (s.uiRequests.some((r) => r.id === req.id)) return s;
				// The server stamps omp's deadline on its own clock (`expiresAt`, which a replay keeps); a frame that came
				// straight from omp counts from now.
				const timeout = num(req.timeout);
				const deadline =
					timeout > 0
						? typeof f.expiresAt === "number"
							? f.expiresAt - serverOffsetMs()
							: Date.now() + timeout
						: undefined;
				return withUiRequests(s, [...s.uiRequests, deadline === undefined ? req : { ...req, deadline }]);
			}
			if (req.method === "open_url" && typeof f.url === "string") {
				return { ...s, loginUrl: { url: f.url, launchUrl: str(f.launchUrl), instructions: str(f.instructions) } };
			}
			if (req.method === "cancel") {
				const target = str(f.targetId);
				const closed = s.uiRequests.find((r) => r.id === target);
				const left = withUiRequests(
					s,
					s.uiRequests.filter((r) => r.id !== target),
				);
				// omp's own deadline closed a dialog the user had not answered, and omp went on without them.
				return closed && f.timedOut === true
					? addNotice(left, {
							kind: "dialogTimeout",
							title: (closed.title ?? "").split("\n")[0] || null,
							chosen: chosenOnTimeout(closed),
						})
					: left;
			}
			if (req.method === "setStatus") {
				const { key, text } = statusOf(f);
				const statuses = { ...s.statuses };
				if (text) statuses[key] = text;
				else delete statuses[key];
				return { ...s, statuses };
			}
			if (req.method === "setWidget") {
				const { key, lines } = widgetOf(f);
				const widgets = { ...s.widgets };
				if (lines.length) widgets[key] = lines;
				else delete widgets[key];
				return { ...s, widgets };
			}
			return s;
		}
		case "subagent_lifecycle":
		case "subagent_progress":
		case "subagent_event":
			return { ...s, subagents: applySubagentFrame(s.subagents, f) };
		case "btw_record": {
			const r = f.record as BtwRecord | undefined;
			if (!r?.id) return s;
			// omp's own frames do not name the model: what the server said of it when the question was taken stays.
			const model = r.model ?? s.btw[r.id]?.model;
			return { ...s, btw: { ...s.btw, [r.id]: model ? { ...r, model } : r } };
		}
		case "btw_delta": {
			const id = str(f.recordId);
			const cur = id ? s.btw[id] : undefined;
			if (!id || !cur) return s;
			const delta = str(f.delta) ?? "";
			// The turn that is answering is the last follow-up when the topic has any, else the question that began it.
			const ups = cur.followUps;
			if (ups?.length) {
				const last = ups[ups.length - 1];
				return {
					...s,
					btw: {
						...s.btw,
						[id]: { ...cur, followUps: [...ups.slice(0, -1), { ...last, answer: last.answer + delta }] },
					},
				};
			}
			return { ...s, btw: { ...s.btw, [id]: { ...cur, answer: cur.answer + delta } } };
		}
		case "auto_retry_start":
			// A wait announced after omp's own `session_settled` is one it has lost (omp 18.12 does, when two failures
			// overlap): no retry will come, so there is nothing to count down to. What the turn failed with stays on screen.
			return s.idleAnnounced ? s : { ...s, retry: waitFromFrame(f, Date.now()) };
		case "auto_retry_end": {
			const recoveries = recoveriesOf(f.retryErrors);
			return {
				...s,
				entries: recoveries.size ? markRecovered(s.entries, recoveries) : s.entries,
				retry: f.success === true ? null : { phase: "failed", attempt: num(f.attempt), finalError: str(f.finalError) },
			};
		}
		case "auto_compaction_start":
			return { ...s, compacting: { reason: str(f.reason), action: str(f.action) }, compactionOutcome: null };
		case "auto_compaction_end":
			return { ...s, compacting: null, compactionOutcome: compactionOutcome(f) };
		case "ttsr_triggered": {
			const rules = rulesOf(f.rules);
			if (rules.length === 0) return s;
			// What the transcript looks like now: a rule that arrives while it is the same came right after the last. The newest
			// tool says whether one started since (their number does not: the finished ones are forgotten, see KEEP_DONE_TOOLS).
			const newestTool = Object.keys(s.tools).at(-1) ?? "";
			const sig = `${s.entries.length}:${s.overlay.length}:${newestTool}`;
			const last = s.notices.at(-1);
			if (last?.kind !== "rules" || last.sig !== sig) return addNotice(s, { kind: "rules", sig, rules });
			// Rules that arrive one after another, with nothing between them, are one row.
			const added = rules.filter((r) => !last.rules.some((x) => x.name === r.name));
			if (added.length === 0) return s;
			return { ...s, notices: [...s.notices.slice(0, -1), { ...last, rules: [...last.rules, ...added] }] };
		}
		case "retry_fallback_applied": {
			const to = str(f.to);
			if (!to) return s;
			return addNotice(s, {
				kind: "fallback",
				from: str(f.from) ?? "",
				to,
				role: str(f.role),
				reason: str(f.reason)?.trim(),
			});
		}
		case "retry_fallback_succeeded": {
			const model = str(f.model);
			return model ? addNotice(s, { kind: "fallbackDone", model, role: str(f.role) }) : s;
		}
		case "irc_message": {
			const message = f.message;
			if (!isAgentMessage(message) || !ircMode(message.customType)) return s;
			// omp may announce the same message twice (the relay and the delivery): it is one card.
			const key = ircKey(message.customType, message.details, message.timestamp);
			const seen = s.notices.some(
				(n) => n.kind === "irc" && ircKey(n.message.customType, n.message.details, n.message.timestamp) === key,
			);
			return seen ? s : addNotice(s, { kind: "irc", message });
		}
		case "prompt_result": {
			if (f.status !== "error") return s;
			const message = str(rec(f.error).message) ?? "Prompt failed";
			// A failure that ended the turn is already on screen as the failed message (with its Retry): the box
			// is for the failures that left no message, or say something else.
			const last = newestMessage(s);
			const shown = last?.role === "assistant" && last.stopReason === "error" && last.errorMessage === message;
			return shown ? s : { ...s, lastError: message };
		}
		default:
			return s;
	}
}

/** After a durable refresh, drop overlays whose messages are now in `entries`. */
export function settleOverlay(s: LiveState, endedBefore: Set<string>): OverlayMessage[] {
	return s.overlay.filter((o) => !(o.ended && endedBefore.has(o.messageId)));
}
