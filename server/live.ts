import { existsSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { type ApprovalMode, isApprovalMode } from "../shared/approval.ts";
import { COMPACT_KEYS, type CompactAt } from "../shared/compact-at.ts";
import { compactWhereOf, type HeldPrompt, instructionsOf, type StepUnavailable } from "../shared/compact-queue.ts";
import {
	COMPACT_STEP_DIALOG_CONTINUE,
	COMPACT_STEP_FILE_ENV,
	COMPACT_STEP_LOADED_SUFFIX,
} from "../shared/compact-step.ts";
import { CodedError, type ErrorInfo, errorInfoOf } from "../shared/error-info.ts";
import type { ExitReason, ExitReport } from "../shared/exit.ts";
import { type Goal, goalHeld, heldGoal } from "../shared/goal.ts";
import {
	applyGuardOverridePatch,
	type GuardOverride,
	type GuardOverridePatch,
	type GuardWord,
	type KeptGuard,
	type LiveGuard,
	NO_GUARD,
	parseGuardOverride,
	recordKept,
	resolveGuard,
	reviewerSelectors,
	stricterKept,
	strictOnly,
} from "../shared/guard.ts";
import { isRecord } from "../shared/guards.ts";
import { type HostToolDefinition, PROPOSE_GOAL_TOOL, proposeGoalTool } from "../shared/guided-goal.ts";
import { type ConversationModels, parseConversationModels, parseSelector } from "../shared/model-config.ts";
import { GUIDANCE_ID_MAX, guidanceText, type LiveGuidance, type SessionGuidance } from "../shared/model-guidance.ts";
import { isMode, type Mode, runsLocal } from "../shared/offline.ts";
import { panelStateOf } from "../shared/panel-state.ts";
import type {
	Holding,
	LiveAttached,
	LiveInfo,
	LiveListing,
	LiveRetry,
	ModeSwitchReply,
	OmpFrame,
	OpenTarget,
} from "../shared/protocol.ts";
import type { QuotaHoldReason } from "../shared/quota-floor.ts";
import { QUOTA_DIALOG_CONTINUE, QUOTA_FILE_ENV, QUOTA_LOADED_SUFFIX } from "../shared/quota-hold.ts";
import { isUsageLimitError } from "../shared/retry.ts";
import { type ConfigValue, isChoice, type Unreported } from "../shared/session-defaults.ts";
import { STOP_GRACE_MS } from "../shared/stop.ts";
import { isWorkingStatus } from "../shared/subagent-status.ts";
import {
	draftOfToolArgs,
	draftsOfAsk,
	type LiveUnattended,
	QUESTION_LIMITS,
	type QuestionDraft,
	type QuestionDropWhy,
	recordedAskAnswers,
	UNATTENDED_TOOL,
} from "../shared/unattended.ts";
import { AutoTitle } from "./auto-title.ts";
import { SubagentCoalescer } from "./coalesce.ts";
import type { Config } from "./config.ts";
import { FULL, type Launcher, type LaunchPlan } from "./offline/index.ts";
import {
	type ApprovalStore,
	NO_TOOL_POLICIES,
	type ProcessOverlay,
	removeOverlayFiles,
	sessionKey,
	stripApprovalFlags,
	type ToolPolicies,
} from "./omp/approval.ts";
import type { SideLaunch } from "./omp/btw-fork.ts";
import { CompactQueue } from "./omp/compact-queue.ts";
import type { CompactStepHooks } from "./omp/compact-step/service.ts";
import { watchOmpConfig } from "./omp/config-watch.ts";
import { type RiskGate, RiskState } from "./omp/gate/state.ts";
import { GUIDANCE_FILE_ENV, GUIDANCE_LOADED_SUFFIX } from "./omp/guidance/extension.ts";
import type { GuidanceHooks } from "./omp/guidance/hooks.ts";
import type { KeptGuidance } from "./omp/guidance/session.ts";
import { HeldState } from "./omp/held.ts";
import type { HostToolResult, HostToolServer } from "./omp/host-tools.ts";
import { InFlightMessage, mayRewriteEntries } from "./omp/in-flight.ts";
import { InterviewStore } from "./omp/interviews.ts";
import { hasCommand } from "./omp/loaded.ts";
import { type Absent, absentModels, conversationPreset } from "./omp/model-config.ts";
import {
	identitiesOf,
	identityOf,
	type ParkedRecord,
	ParkedStore,
	type ProcessRef,
	referenceTo,
	runsAs,
} from "./omp/parked.ts";
import { exists, processTree, processTrees, signalAll } from "./omp/process-tree.ts";
import type { QuotaFloorHooks } from "./omp/quota-floor/service.ts";
import { QuotaTracker } from "./omp/quota-floor/tracker.ts";
import { pruneRelayDir, relaySocket, runningRelays, sweepRelayDir } from "./omp/relay-client.ts";
import type { Resumed } from "./omp/resumed.ts";
import { RpcClient, type RpcLaunch, type RpcResponse } from "./omp/rpc-client.ts";
import { QUICK_MS } from "./omp/run.ts";
import { UNATTENDED_FILE_ENV, UNATTENDED_LOADED_SUFFIX } from "./omp/unattended/extension.ts";
import type { FileResult } from "./omp/unattended/questions.ts";
import type { UnattendedHooks } from "./omp/unattended/service.ts";
import { dialogLine, replyLine } from "./push/preview.ts";
import { SLEEP_FOLLOW_MS, sleepAftermath } from "./sleep.ts";

/** The commands after which the conversation is the same one in another file, so that its guard goes along (see `Live.followGuard`). */
const CARRIES_GUARD: Record<string, true> = { new_session: true, fork: true, branch: true, handoff: true };

/** The commands that move the process to another session file: sent one at a time, each settled before the next (see `Live.rpc`). */
const MOVES: Record<string, true> = {
	new_session: true,
	switch_session: true,
	fork: true,
	branch: true,
	open_session: true,
	handoff: true,
};

/** Commands after which the process may be bound to a different session file. */
const SESSION_CHANGING: Record<string, true> = {
	new_session: true,
	switch_session: true,
	fork: true,
	branch: true,
	open_session: true,
	handoff: true,
	prompt: true,
};

export interface Subscriber {
	send(msg: unknown): void;
}

/** extension_ui_request methods that block omp until answered. */
const DIALOG_METHODS: Record<string, true> = { select: true, confirm: true, input: true, editor: true, ask: true };

/**
 * What a call that names no question is filed as (#650): the store refuses it as `empty`, and the conversation is told that
 * a question could not be kept. `file_question` needs a title and an `ask` dialog needs its question, so this is the model's
 * mistake, not the file's.
 */
const EMPTY_DRAFT: QuestionDraft = { question: "", context: "", options: [] };

/**
 * How much earlier than the deadline stamped on a dialog (`expiresAt`) omp's cancel of it still counts as the deadline
 * having passed: omp started its own clock a little before the server read the request.
 */
const DEADLINE_SLACK_MS = 2000;
/** How long a soft stop lets the turn work before it reminds the agent once (#658). */
const SOFT_STOP_REMIND_MS = 10 * 60_000;
/** The reminder: the turn is still working long after a soft stop was asked for. */
const SOFT_STOP_REMINDER =
	"Reminder: a soft stop was requested. Stop starting new work, write the handoff now as your final message, and end your turn.";

interface StateSnapshot {
	sessionFile?: string;
	sessionId?: string;
	isStreaming?: boolean;
	isCompacting?: boolean;
	/** Nothing can wake the agent any more: no run, no queued message, no background job (omp's "Yield vs settled"). */
	isSettled?: boolean;
	hasPendingAsyncWork?: boolean;
	/** Goal mode: `{ enabled, mode, goal }`, where `goal` is the goal itself or null (see `heldGoal`). */
	goal?: unknown;
}

/** The session file a conversation was in and the one omp says it is in now (null: none yet): they differ when it moved. */
interface SessionMove {
	from: string | null;
	to: string | null;
}

/** What a request to omp is for. */
export interface RpcOptions {
	/** The user asked for it (an action, not a refresh the page makes by itself): a paused conversation answers it. */
	user?: boolean;
	/**
	 * Called once the command has been handed to omp's stdin, before omp answers: the page is told the server took it, and
	 * waits for the answer as long as omp holds the command (see `ack` of `ClientMessage`). Not called for a command that
	 * is refused (a paused conversation) or could not be written: its reply says so at once.
	 */
	written?: () => void;
}

/** How long omp keeps running after the answer to a user's action on a paused conversation, for what it sends just after. */
const THAW_SETTLE_MS = 100;
/** The longest the page's replies to that are waited for. */
const RIDERS_MAX_MS = 5000;
/** The longest the server, ending, waits for a user's action that has a paused conversation running to finish. */
const PARK_WAIT_MS = 3000;
/** The longest `retryNow` waits for omp to say it ended its backoff before it goes on. */
const RETRY_ABORT_MS = 5000;

/** What a Stop ends: a turn (with the retry wait and the subagents that keep it going), or a `!command`. */
export type StopKind = "turn" | "bash";

/** The omp commands the page's Stop sends, and what each of them stops: `Live.stop` carries them through. Null: not one of them. */
export function stopKindOf(command: Record<string, unknown>): StopKind | null {
	switch (command.type) {
		case "abort":
		case "abort_and_restore_queue":
			return "turn";
		case "abort_bash":
			return "bash";
		default:
			return null;
	}
}

/**
 * What a press that joined a Stop under way is told: how it went, and that it joined. Not what omp gave back of the queue: the
 * page that pressed first has it, and two pages would put the same text in two message boxes.
 */
function joinedStop(r: RpcResponse): RpcResponse {
	if (!r.success) return r;
	const ended = isRecord(r.data) && typeof r.data.ended === "string" ? { ended: r.data.ended } : {};
	return { type: "response", command: r.command, success: true, data: { ...ended, joined: true } };
}

/**
 * What Stop answers when messages were held behind a queued compact: they come back with the ones omp withdrew from its own
 * queue, for the page to put in the message box (see `CompactQueue.withdraw`). Also for a Stop that had to end omp: the
 * queue it held went with it, and these are the server's.
 */
function withWithdrawn(r: RpcResponse, held: HeldPrompt[]): RpcResponse {
	if (!r.success || held.length === 0) return r;
	const data = isRecord(r.data) ? r.data : {};
	const own = Array.isArray(data.followUp) ? data.followUp : [];
	const back = held.map((h) => ({ text: h.message, ...(h.images ? { images: h.images } : {}) }));
	return { ...r, data: { ...data, followUp: [...own, ...back] } };
}

/** After SIGTERM: how long omp, and what it started, get to end before they are killed. */
const STOP_TERM_MS = 1500;
/** After SIGKILL: how long the exit is waited for. */
const STOP_KILL_MS = 2000;
/** Between two rounds of what Stop sends again while omp has not ended the turn. */
const STOP_NUDGE_MS = 1000;
/** How often Stop looks at whether the turn is over. */
const STOP_POLL_MS = 25;
/** How long omp's answer to the abort is waited for once the turn is over (it carries what was taken out of the queue). */
const STOP_ANSWER_MS = 500;
/** omp answered the abort and still holds a retry wait this long afterwards: it lost the wait (see `endLostWait`). */
const STOP_LOST_MS = 2000;
/** How long omp gets to answer the `get_subagents` and each `cancel_subagent` that Stop sends. */
const STOP_ASK_MS = 2000;
/** How long a builtin command's printout is waited for after omp has answered it (`Live.command`); `/rename` asks a model. */
const OUTPUT_MS = 300;
const TITLE_OUTPUT_MS = 45_000;
/**
 * Commands that end omp's retry wait: `abort_retry`, and `abort`, which includes it. omp answers them once its sleep
 * is cancelled and announces the end (`auto_retry_end`) a moment later; a wait still held after the time to do that
 * has passed is one omp lost (see `Live.trackRetry`).
 */
const ENDS_RETRY: Record<string, true> = {
	abort_retry: true,
	abort: true,
	abort_and_restore_queue: true,
	abort_and_prompt: true,
};
/**
 * How soon before omp's retry wait ends a user's action stops being let run omp: the action, its settle and the page's
 * replies to what omp announces keep it running at most this long (`THAW_SETTLE_MS`, `RIDERS_MAX_MS`), and a thaw that
 * reaches the wait's end starts the retried turn.
 */
const RETRY_THAW_GUARD_MS = THAW_SETTLE_MS + RIDERS_MAX_MS;

/** A line typed as omp's `/modelpreset switch <name>`. */
const TYPED_PRESET_SWITCH = /^\s*\/modelpreset\s+switch\s+(\S+)\s*$/;

/** What a request that would end a busy conversation's omp says, by what it is busy with (`Live.holding`). */
export function refusal(holding: Holding): string {
	switch (holding) {
		case "working":
			return "This conversation is working in the web UI; wait for it to finish or stop it first.";
		case "asking":
			return "This conversation is waiting for your answer in the web UI; answer it first.";
		case "paused":
			return "This conversation is paused in the web UI; resume it or end it first.";
	}
}

/**
 * The frame that tells the pages what a settings command did, for the commands omp takes and announces nothing about
 * (#593): `thinking_level_changed` with the level, or `settings_changed` with the fields of omp's state that changed (the
 * names `get_state` gives them). Null for any other command, and for one that carries no value.
 */
export function settingFrame(command: Record<string, unknown>, answer: unknown): OmpFrame | null {
	const changed = (settings: Record<string, unknown>): OmpFrame | null => {
		const given = Object.fromEntries(Object.entries(settings).filter(([, value]) => value !== undefined));
		return Object.keys(given).length > 0 ? { type: "settings_changed", settings: given } : null;
	};
	switch (command.type) {
		case "set_thinking_level":
			return typeof command.level === "string"
				? {
						type: "thinking_level_changed",
						thinkingLevel: command.level,
						// A selector that is not a level is what the conversation is set to, and the level it resolves to comes by the state.
						...(command.level === "auto" ? { configured: "auto" } : {}),
					}
				: null;
		case "set_steering_mode":
			return changed({ steeringMode: command.mode });
		case "set_follow_up_mode":
			return changed({ followUpMode: command.mode });
		case "set_interrupt_mode":
			return changed({ interruptMode: command.mode });
		case "set_auto_compaction":
			return changed({ autoCompactionEnabled: command.enabled });
		case "set_fast_mode": {
			// omp answers with whether the mode is on and whether it is in effect (a model that has no fast mode: not).
			const said = isRecord(answer) ? answer : {};
			return changed({
				fastModeEnabled: typeof said.enabled === "boolean" ? said.enabled : command.enabled,
				fastModeActive: typeof said.active === "boolean" ? said.active : undefined,
			});
		}
		case "set_slow_mode":
			return changed({ slowModeEnabled: command.enabled });
		case "set_session_name":
			return changed({ sessionName: command.name });
		default:
			return null;
	}
}

export class Live {
	readonly info: LiveInfo;
	readonly client: RpcClient;
	readonly subscribers = new Set<Subscriber>();
	lastActivity = Date.now();
	/** Dialog requests omp is still waiting on, by request id (replayed to tabs that attach later). */
	private readonly pendingUI = new Map<string, OmpFrame>();
	/** The message omp is writing now, replayed to a tab that attaches in the middle of it (see `InFlightMessage`). */
	private readonly writing = new InFlightMessage();
	/** The last reply of this turn, as one line cut short (what a notification that opted in to a preview says: `previewText`); reset when a turn begins. */
	private lastReply: string | null = null;
	/** What omp said once that a tab that attaches later still shows: a compaction, extension status lines, `!commands` that run (see `HeldState`). */
	private readonly held = new HeldState();
	/**
	 * A compact asked for while the agent worked, and the messages held behind it until it is over (#651, see `CompactQueue`).
	 * What it sends goes to omp directly (`rpcNow`), not back through the hold.
	 */
	private readonly compactQueue = new CompactQueue({
		send: (command, options) => this.rpcNow(command, options ?? {}),
		working: () => this.info.streaming,
		paused: () => this.info.pausedAt !== null,
		changed: () => this.compactChanged(),
		ended: (outcome) => {
			// Said in the process's info, which every page is told (and the page that shows the conversation says it): no frame the first page would have to know.
			if (this.info.exited) return;
			this.info.compactEnded = { at: Date.now(), ...outcome };
			this.pool.announce(this);
		},
		stepUnavailable: () => this.compactStepUnavailable(),
		arm: (at) => this.armCompactStep(at),
		letGo: (id) => {
			if (!this.info.exited)
				this.client.send({ type: "extension_ui_response", id, value: COMPACT_STEP_DIALOG_CONTINUE });
		},
		refresh: () => this.refreshState(),
	});
	/** RPC commands awaiting omp's reply (a user `!command` replies only when it exits). */
	private inFlight = 0;
	/** omp holds the guided-goal tool, `propose_goal`: this conversation is in an interview (see `InterviewStore`). */
	private interviewing = false;
	/**
	 * What gives this process host tools the server answers itself, with no page in between (see `serveHostTools`); null
	 * while it gives none.
	 */
	private hostServer: HostToolServer | null = null;
	/** Every host tool name the server has given this process: a call of one is answered here and never put to a page. */
	private readonly servedNames = new Set<string>();
	/**
	 * The host tools a page gave this process (`propose_goal`): omp's `set_host_tools` replaces the whole set, so what the
	 * server serves is added to what the page set, and the page's own `set_host_tools` keeps what the server serves.
	 */
	private pageHostTools: unknown[] = [];
	/** The calls of served tools omp has no answer to yet, by call id: aborted when omp gives one up or the process ends. */
	private readonly serving = new Map<string, AbortController>();
	/**
	 * The goal omp holds, as the server last heard of it: every `goal_updated` frame and every `get_state` says it, and
	 * an attaching page is told it (`attached`). A paused omp is frozen and cannot be asked, so a page that opens it
	 * would otherwise show the goal its transcript leaves, which reads an active goal as paused. Only a goal omp still holds.
	 */
	private goal: Goal | null = null;
	/** A turn ended and no other has begun: with an active goal, the run goes on (`LiveInfo.continuing`). */
	private between = false;
	/** The reminder a soft stop sends a turn that is still working after `SOFT_STOP_REMIND_MS` (#658). */
	private softStopRemind: ReturnType<typeof setTimeout> | null = null;
	/** A turn ended that omp says is not the last (`agent_end` with `isTerminal: false`): it goes on by itself, so the process is still working. */
	private partial = false;
	/** What the pages were last told of the work (`LiveInfo.streaming`, `asking`, `continuing`): see `noteWork`. */
	private told: { streaming: boolean; asking: boolean; continuing: boolean };
	/**
	 * omp's registry of its subagents (`get_subagents`) as it was when it was frozen: a paused omp answers nothing, so a
	 * page that attaches to it (and the next server, from the record) has this to show them by. Null while omp runs.
	 */
	private subagents: Record<string, unknown>[] | null = null;
	/** Started for a new chat and not used since: no prompt, command, settings change or turn. */
	private untouched: boolean;
	/** `init()` has finished: the process answers requests. */
	private started = false;
	/** The environment the process was started with (Light on a local server points it at an agent directory of its own). */
	readonly env: Record<string, string>;
	/** Where the output of the builtin command the server runs itself (`command`) is collected, away from the viewers. */
	private capture: string[] | null = null;
	/** The server's own commands, one after the other: their output is told apart by when it arrives. */
	private commandQueue: Promise<unknown> = Promise.resolve();
	/** User actions running on this paused conversation: omp runs while there are any (see `thawed`). */
	private thaws = 0;
	/** The processes omp had when the current thaw began: what is stopped again if they cannot be listed afterwards. */
	private thawedTree: number[] = [];
	/** The pause the current thaw began in (see `epoch`). */
	private thawEpoch = 0;
	/** The thaw the user's actions that run now wait for (see `thaw`). */
	private thawing: Promise<void> = Promise.resolve();
	/**
	 * Pausing, resuming and the thaws of a user's action each signal omp and what it started, over a listing of the system
	 * that is awaited: one after another, or one would stop what another has just started again (see `serially`).
	 */
	private signalling: Promise<unknown> = Promise.resolve();
	/** Counts the pauses and the resumes: a freeze that waited for its turn belongs to the pause it was asked for in. */
	private epoch = 0;
	/** Pauses, resumes and ends asked for that are not over yet: what is sent behind them waits (see `shift`). */
	private shifts = 0;
	/** `park` has handed omp to the next server: it stays frozen, and no action of this one thaws it. */
	private parked = false;
	/** Requests answered while omp runs for a user's action: it is not frozen again before they are. */
	private readonly riders = new Set<Promise<unknown>>();
	/** Frames someone waits for (see `untilFrame`). */
	private readonly frameWaiters = new Set<{ type: string; resolve: () => void }>();
	/** This omp and its relay as first recorded: what tells a later server that those pids are still these processes. */
	private refs: { omp: ProcessRef; relay: ProcessRef } | null = null;
	/** This server as the record of a kept conversation names its owner (see `ParkedRecord.owner`). */
	private owner: ProcessRef | null = null;
	/** The record last written for this kept conversation, to write a change and not a repeat. */
	private recorded = "";
	/** What omp had started when it was last frozen, as the processes they were (see `ParkedRecord.descendants`). */
	private descendants: ProcessRef[] = [];
	/** omp reported `session_settled` and nothing has started since: it is idle, so it holds no retry wait. */
	private settled = false;
	/** The timer that gives up watching what followed a sleep (see `noteAfterSleep`). */
	private sleepFollow: ReturnType<typeof setTimeout> | null = null;
	/**
	 * omp has work that is not a turn: it is compacting, or reports the session not settled (a background job, a
	 * queued follow-up) between turns. Closing it would end that work (omp disposes the session on stdin EOF).
	 */
	private unsettled = false;
	/**
	 * The relay holds this process, its overlay is marked to outlive the server and its record is on disk: it is paused,
	 * or it waits out a usage limit (see `kept`). What `persist` brings in line with `kept`.
	 */
	private keeping = false;
	/**
	 * Why the server ended this process, when it did: null while the process is running, and after it ended on its own.
	 * The page is told, so that an end the server asked for is not read as a crash of omp's (#472).
	 */
	private endedBy: ExitReason | null = null;

	/**
	 * omp is doing or awaiting something: a turn, a running command, a dialog the user must answer, a retry backoff of
	 * its own (`auto_retry_start` to `auto_retry_end`: between turns, but the retry is still to come, which includes the
	 * hours omp sleeps through a usage limit), work it has not settled (compacting, background jobs that can wake the
	 * agent again), or it is paused.
	 */
	get busy(): boolean {
		return (
			this.info.streaming ||
			this.inFlight > 0 ||
			this.pendingUI.size > 0 ||
			this.info.retry !== undefined ||
			this.unsettled ||
			this.info.pausedAt !== null
		);
	}

	/** Why `busy`, when it is: paused wins (nothing runs), then a dialog waiting for the user, then work. */
	get holding(): Holding | null {
		if (this.info.pausedAt !== null) return "paused";
		if (this.pendingUI.size > 0) return "asking";
		return this.busy ? "working" : null;
	}

	/** A switch to the other mode is being made (the process is being replaced): a second one is not started. */
	private switching = false;

	/**
	 * Whether the process can be replaced now without cutting anything off: nothing runs, nothing waits for an answer, it is not
	 * paused, and no goal goes on between two turns (`holding` does not know of that one).
	 */
	get switchable(): boolean {
		return !this.info.exited && !this.client.closing && this.holding === null && !this.continuingNow();
	}

	/** The conversation goes on between two turns without a turn running: a turn ended that omp is to follow, or a goal's run goes on. */
	private continuingNow(): boolean {
		return !this.info.streaming && (this.partial || (this.between && this.goal?.status === "active"));
	}

	/** The switch to `to` (the other mode) is asked for and waits for the turn to end; every page is told. Taking it back is `cancelModeSwitch`. */
	requestModeSwitch(to: Mode): void {
		this.info.modeSwitch = { to };
		this.pool.announce(this);
	}

	/** A switch that waited is taken back (the person asked for the mode the conversation has). */
	cancelModeSwitch(): void {
		if (!this.info.modeSwitch) return;
		delete this.info.modeSwitch;
		this.pool.announce(this);
	}

	/** A switch to `to` could not be made, and this process took over to go on in the mode the conversation had: every page says why. */
	noteModeSwitchFailed(to: Mode, failure: { message: string } & Partial<ErrorInfo>): void {
		this.info.modeSwitch = { to, failed: failure };
		this.pool.announce(this);
	}

	/** Make the switch that waited, as soon as the process can be replaced (called wherever what keeps it busy may have ended). */
	private checkModeSwitch(): void {
		const wanted = this.info.modeSwitch;
		if (!wanted || wanted.failed || this.switching || !this.switchable) return;
		this.switching = true;
		void this.pool.finishModeSwitch(this, wanted.to).finally(() => {
			this.switching = false;
		});
	}

	/**
	 * A line of what this conversation says, for a notification of a device that opted in to a preview (`server/push`): what
	 * the dialog that waits asks, or the last reply of the turn, cut short. Null when there is nothing to say.
	 */
	previewText(kind: "asking" | "finished"): string | null {
		if (kind === "finished") return this.lastReply;
		for (const frame of this.pendingUI.values()) {
			const line = dialogLine(frame);
			if (line !== null) return line;
		}
		return null;
	}

	/**
	 * Tell every page when what a conversation is listed by changes: a turn starts or ends, a dialog opens or is answered,
	 * a goal's run goes on between two turns. Only the pages that listen to a process hear its frames, and none of these
	 * is a frame a page that does not could hear: the `live` frame every page is told of is how a conversation another
	 * page runs is listed as running, as waiting for an answer, or as open (#592). Nothing is said when nothing changed.
	 */
	private noteWork(): void {
		this.checkModeSwitch();
		const now = {
			streaming: this.info.streaming,
			asking: this.pendingUI.size > 0,
			continuing: this.continuingNow(),
		};
		if (
			now.streaming === this.told.streaming &&
			now.asking === this.told.asking &&
			now.continuing === this.told.continuing
		)
			return;
		this.told = now;
		if (now.asking) this.info.asking = true;
		else delete this.info.asking;
		if (now.continuing) this.info.continuing = true;
		else delete this.info.continuing;
		this.pool.announce(this);
	}

	/**
	 * The Mac slept, and this conversation was working when it did (#647): say so in its transcript, and watch the minute
	 * that follows for what became of the turn (`noteAfterSleep`). Called by `LivePool` for the conversations the sleep
	 * caught; nothing is sent to omp, nothing is retried on the person's behalf — omp does what it does on its own.
	 *
	 * The note stays until the conversation turns again, ends, or sleeps a second time: someone who comes back from an
	 * hour and a half away is the one it is for, and a line that had gone by the time they looked would be no line at all.
	 * It is not written to the parked record, so a server restart loses it (`Live.slept` is the server's own, as is the
	 * sleep it names).
	 */
	slept(from: number, to: number): void {
		this.info.slept = { from, to };
		// Told to every page as the process's own state, so that a page that attaches when the machine comes back shows the
		// note a page that was open already has.
		this.pool.announce(this);
		// What a stream that was cut leaves behind is omp's to report: a retry it starts, a turn that ends with an error, a
		// tool out of time. A minute is enough for the connection's own timeouts; after that the note stands as it is and the
		// watching stops.
		this.followSleep();
	}

	/**
	 * Watch for what came of a sleep, in place of any earlier watch: `sleepFollow` being set *is* the watching
	 * (`noteAfterSleep`), and clearing it when the window ends stops that and nothing else — the note stays.
	 */
	private followSleep(): void {
		clearTimeout(this.sleepFollow ?? undefined);
		this.sleepFollow = setTimeout(() => {
			this.sleepFollow = null;
		}, this.pool.sleepFollowMs);
		this.sleepFollow.unref?.();
	}

	/**
	 * A frame that came after the sleep: what it says of the turn is what the note's second line says. The first answer
	 * wins (a retry that then fails is a retry: omp did try again), and a frame that says nothing of it is left alone.
	 * Nothing is added once the minute of watching is over, and a turn that starts makes the note old news (`onFrame`).
	 */
	private noteAfterSleep(frame: OmpFrame): void {
		const note = this.info.slept;
		if (!note || note.followed || !this.sleepFollow) return;
		const followed = sleepAftermath(frame);
		if (!followed) return;
		note.followed = followed;
		this.pool.announce(this);
	}

	/**
	 * omp sleeps before a retry of its own that the provider's usage limit made it wait for, and has not started the
	 * retried turn (`LiveInfo.retry`). That wait is hours, and it is omp's own timer: the process has to be there when
	 * it is over, whatever becomes of this server meanwhile.
	 */
	private get waiting(): boolean {
		const r = this.info.retry;
		return r?.usageLimit === true && !r.resumed;
	}

	/**
	 * The process outlives this server: it is paused (frozen), it waits out a usage limit (running, its timer going), or it is held at
	 * the quota floor (running, waiting in the extension's dialog until the window resets). The next server takes it over again (see
	 * `LivePool.adopt`). Not one that is being closed, or has ended.
	 */
	get kept(): boolean {
		return (
			!this.info.exited &&
			!this.client.closing &&
			(this.info.pausedAt !== null || this.waiting || this.quota?.held === true)
		);
	}

	/**
	 * A process started for a new chat that nobody has used. It is what a new one would be, so the next new
	 * chat with the same folder and options can take it over instead of starting another omp (~300 MB each).
	 */
	get pristine(): boolean {
		return this.untouched && this.started && !this.info.exited && !this.client.closing && !this.busy;
	}

	/**
	 * Freeze omp and everything it started (subagents, advisor, running tools) with SIGSTOP —
	 * omp's TUI `/pause` has no RPC counterpart, so the process tree itself is held. Requests
	 * already sent wait; nothing runs until `resume()`.
	 *
	 * A paused conversation outlives the server (see parked.ts): before omp is frozen, its relay is told to keep it
	 * when the server goes, and the conversation is written down for the next server to find. A conversation that is
	 * being closed is not one to keep: it is on its way out, and frozen it would stay (#318).
	 *
	 * What omp started is listed by the system, which is awaited: the server serves everyone else meanwhile (#355).
	 */
	pause(): Promise<void> {
		return this.shift(() => this.freeze());
	}

	/** Whether omp can be paused now: false when it is not there or already is; it is an error while it is being closed. */
	private pausable(): boolean {
		if (this.info.pid === null || this.info.exited || this.info.pausedAt !== null) return false;
		if (this.client.closing) throw new Error("This conversation is not running");
		return true;
	}

	private async freeze(): Promise<void> {
		if (!this.pausable()) return;
		const pid = this.info.pid as number;
		// Who omp, its relay and this server are, for the record: asked of the system before anything is stopped or written.
		const owner = await this.pool.self();
		this.refs ??= await this.identify(pid);
		// Its subagents and its state, while omp can still say: from here on it is the record that does. Asked last, so that
		// the list is as near the freezing as it can be (a subagent that ends while the system is asked is not listed as
		// running); the state is the rows of the session panel, which a frozen omp cannot say (`askState`).
		const [subagents] = await Promise.all([this.listSubagents(), this.askState()]);
		// omp may have ended, or been closed, while the system or omp was asked.
		if (!this.pausable()) return;
		this.subagents = subagents;
		this.owner = owner;
		this.untouched = false;
		const at = Date.now();
		// One that waits out a usage limit is held and written down already.
		const held = this.keeping;
		if (!held) this.client.hold(true);
		if (this.save(at, owner)) {
			this.overlay?.park();
			this.keeping = true;
		}
		// Nothing could be written (no disk, no process listing): no server could find it again, so it ends with this
		// one, as a conversation did before there was a way to keep it.
		else if (!held) this.client.hold(false);
		try {
			// The parent first, so it cannot start anything new while its children are being stopped.
			process.kill(pid, "SIGSTOP");
		} catch (e) {
			this.subagents = null;
			this.persist();
			throw e;
		}
		// From here omp is frozen: record it, so that unfreeze() — or the failure path below — can undo it.
		this.info.pausedAt = at;
		delete this.info.resumedAt;
		this.epoch++;
		let tree: number[];
		try {
			tree = await processTree(pid);
		} catch (e) {
			await this.unfreeze();
			throw e;
		}
		stopBelow(tree, pid);
		await this.noteDescendants(tree, pid);
		// omp ended meanwhile: there is nothing to record or announce.
		if (this.info.pausedAt !== at) return;
		this.persist();
		this.pool.announce(this);
		// Nothing spends while it is frozen: the quota is not looked at meanwhile (the hold, if there is one, stands).
		this.quota?.onWork();
	}

	/** How long omp is given to list its subagents and to say its state before it is frozen: a process that does not answer is frozen without. */
	private static readonly FREEZE_ASK_MS = 2000;

	/** What omp lists of its subagents now (`get_subagents`), or null when it does not say. Never throws: pausing matters more. */
	private async listSubagents(): Promise<Record<string, unknown>[] | null> {
		try {
			const reply = await this.client.request({ type: "get_subagents" }, Live.FREEZE_ASK_MS);
			const listed = isRecord(reply.data) ? reply.data.subagents : undefined;
			return reply.success && Array.isArray(listed) ? listed.filter(isRecord) : null;
		} catch {
			return null;
		}
	}

	/**
	 * Take omp's state as it is now, for what is kept of it while omp is frozen (`lastState`). When omp does not answer the
	 * last one the server heard stays. Never throws: pausing matters more.
	 */
	private async askState(): Promise<void> {
		try {
			const reply = await this.client.request({ type: "get_state" }, Live.FREEZE_ASK_MS);
			if (reply.success && isRecord(reply.data)) this.lastState = reply.data;
		} catch {
			// the last state heard is what there is
		}
	}

	/** Run omp and everything it started again: the conversation is not paused any more. */
	resume(): Promise<void> {
		return this.shift(() => this.unfreeze()).then(() => this.compactQueue.resumed());
	}

	/**
	 * Compact when it loses no work (#651), with a note for the summary: when the turn that runs has ended, or, asked `step` and
	 * where the process can be held there, between two of its steps (see `CompactQueue.queue`); at once when no turn runs. Throws
	 * for a note that is too long, a place that is none, and when omp could not be asked for its queue.
	 */
	async queueCompact(instructions: unknown, where?: unknown): Promise<void> {
		if (this.info.exited) throw new Error("This conversation is not running");
		const place = where === undefined ? "turn" : compactWhereOf(where);
		if (!place) throw new Error("Bad value");
		await this.compactQueue.queue(instructionsOf(instructions), place);
	}

	/**
	 * Why a compact cannot be held between two steps in this process (see `StepUnavailable`), or null when it can: it was started with
	 * extensions of the person's own (omp refuses `--extension` beside `--trusted-extension`), the server's extension did not say it
	 * started (omp carries on without an extension it could not load, so the command line alone says nothing of that), or omp is set
	 * not to go on with a turn after a compaction, which the turn that is cut at the boundary needs.
	 */
	private async compactStepUnavailable(): Promise<StepUnavailable | null> {
		const hooks = this.pool.compactStep;
		const args = this.ownArgs.length > 0 ? this.ownArgs : this.info.args;
		if (args.some((a) => a === "--trusted-extension" || a.startsWith("--trusted-extension=")))
			return "trustedExtension";
		if (!hooks || !this.compactStepFile) return "notLoaded";
		const { args: all } = this.info;
		if (!all.some((a, i) => a === "--extension" && all[i + 1] === hooks.extension)) return "notLoaded";
		if (!this.compactStepLoaded)
			this.compactStepLoaded = existsSync(`${this.compactStepFile}${COMPACT_STEP_LOADED_SUFFIX}`);
		if (!this.compactStepLoaded) return "notLoaded";
		// An omp that cannot be asked is taken to go on (its default): a compact that stops the turn is then a failure it says.
		const key = COMPACT_KEYS.autoContinue;
		let goesOn: unknown = Object.hasOwn(this.overlaySettings, key) ? this.overlaySettings[key] : undefined;
		if (goesOn === undefined) {
			try {
				const cwd = existsSync(this.info.cwd) ? this.info.cwd : this.cfg.dataDir;
				// Loaded on first use: the controls panel's module is not one the server starts with.
				const { listPanelKeys, scopeOf } = await import("./omp/session-settings.ts");
				goesOn = (await listPanelKeys(this.cfg, cwd, scopeOf(this.ownArgs, this.env), QUICK_MS))[key];
			} catch (e) {
				console.error(`omp-webui: could not read ${key} for ${this.info.liveId}: ${(e as Error).message}`);
			}
		}
		if (goesOn === false) return "noContinue";
		return null;
	}

	/** Tell the extension that a compact waits for a step boundary (`at` names the request), or that none does (null). */
	private armCompactStep(at: number | null): void {
		const hooks = this.pool.compactStep;
		if (!hooks || !this.compactStepFile || this.info.exited) return;
		try {
			hooks.write(this.compactStepFile, at);
		} catch (e) {
			console.error(`omp-webui: could not write the step file of ${this.info.liveId}: ${(e as Error).message}`);
		}
	}

	/** Take back a queued compact that has not started; what was held behind it goes to omp. */
	cancelCompact(): Promise<void> {
		return this.compactQueue.cancel();
	}

	/**
	 * Soft stop (#658): end this process when the turn that runs (or the one the prompt sent with it starts) has ended, so
	 * that the handoff the agent was asked for is its last word. `on: false` takes the request back. A turn still working
	 * after `SOFT_STOP_REMIND_MS` is reminded once (a steer); Stop is always there for one that does not listen.
	 */
	setSoftStop(on: boolean): void {
		if (this.info.exited) throw new Error("This conversation is not running");
		clearTimeout(this.softStopRemind ?? undefined);
		this.softStopRemind = null;
		if (!on) {
			delete this.info.softStop;
			this.pool.announce(this);
			return;
		}
		this.info.softStop = { at: Date.now() };
		this.softStopRemind = setTimeout(() => {
			this.softStopRemind = null;
			if (!this.info.softStop || this.info.exited || !this.info.streaming) return;
			void this.client.request({ type: "steer", message: SOFT_STOP_REMINDER }).catch(() => {});
		}, SOFT_STOP_REMIND_MS);
		this.pool.announce(this);
	}

	/** The turn a soft stop waited for has ended: the process is ended, and the pages say why (`ExitReason` "softStop"). */
	private finishSoftStop(): void {
		clearTimeout(this.softStopRemind ?? undefined);
		this.softStopRemind = null;
		delete this.info.softStop;
		void this.end("softStop").catch(() => {});
	}

	/** What a queued compact holds changed: every page is told, and a kept conversation's record is written again. */
	private compactChanged(): void {
		if (this.info.exited) return;
		const queued = this.compactQueue.info;
		if (queued) this.info.compactQueued = queued;
		else delete this.info.compactQueued;
		this.pool.announce(this);
	}

	private async unfreeze(): Promise<void> {
		const pid = this.info.pid;
		if (pid === null || this.info.pausedAt === null) return;
		await this.continueTree(pid);
		// omp ended while the system was asked: its exit has let go of the pause.
		if (this.info.pausedAt === null) return;
		this.info.pausedAt = null;
		this.info.resumedAt = Date.now();
		this.subagents = null;
		this.epoch++;
		// The pause is over; a usage-limit wait, if there is one, still keeps the process.
		this.persist();
		this.lastActivity = Date.now();
		this.pool.announce(this);
		// The turn that was open goes on: what is looked at, and held, follows (a hold stood through the pause).
		this.quota?.onWork();
		this.checkModeSwitch();
	}

	/**
	 * Close this conversation's omp because the server wants it gone, and say why the page is told: an end the server
	 * asked for is not a crash of omp's (#472). The process is closed (its stdin), not killed: it finishes what it is
	 * doing, as a close of an idle process always did.
	 */
	closeBecause(why: ExitReason): void {
		if (this.info.exited || this.client.closing) return;
		this.endedBy = why;
		this.client.close();
	}

	/**
	 * End this conversation's omp (a user's Close, "Quit and end"). A paused omp runs again to read its closed stdin
	 * and exit, which is all an idle one needs. One that was working when it was paused (a turn, a command, a question it
	 * is waiting on, a retry it sleeps before) ignores a closed stdin until it is done, and would carry on, unattended,
	 * from where the user stopped it: it is stopped (`LivePool.shutdown` does the same for what is working). A
	 * conversation that was not paused closes as it always did, and is left to finish its turn; opening its file again
	 * waits for that and is refused if it takes too long (`LivePool.ended`): never a second omp on a file one still writes.
	 *
	 * `why` says why the server ended it, and the page is told (#472): an end the user asked for and one the server
	 * decided on are not the same as an omp that ended on its own.
	 */
	end(why: ExitReason = "closed"): Promise<void> {
		return this.shift(async () => {
			const wasPaused = this.info.pausedAt !== null;
			// Said before anything is waited for: the process may end while the pause is lifted, and the reason for
			// the end must be the one that was asked for, not omp's own.
			this.endedBy = why;
			await this.unfreeze();
			this.client.close();
			if (wasPaused && this.busy) this.client.kill();
			// Closing, it is not one to keep any more.
			this.persist();
		});
	}

	/** Run `job` when the pauses, resumes and thaws asked for before it are over (they all signal the same processes). */
	private serially<T>(job: () => Promise<T>): Promise<T> {
		const result = this.signalling.then(job);
		this.signalling = result.catch(() => {});
		return result;
	}

	/**
	 * `serially`, for what the page asks of the conversation as a whole. The page sends a Resume and then the prompt or
	 * the Stop that goes with it without waiting for the answer: a command that comes behind one (`rpc`, `command`,
	 * `whileRunning`) waits for it, so that it finds its effect as it did when these took no time (a prompt to a
	 * conversation that is still paused is refused).
	 */
	private shift<T>(job: () => Promise<T>): Promise<T> {
		this.shifts++;
		const result = this.serially(job);
		const over = () => void this.shifts--;
		result.then(over, over);
		return result;
	}

	/** omp and its relay as the system names them now, for the record (see `refs`); null when it does not list both. */
	private async identify(pid: number): Promise<{ omp: ProcessRef; relay: ProcessRef } | null> {
		const relayPid = this.client.relay?.pid ?? null;
		if (relayPid === null) return null;
		const found = await identitiesOf([pid, relayPid]);
		const omp = found.get(pid);
		const relay = found.get(relayPid);
		return omp && relay ? { omp: { pid, identity: omp }, relay: { pid: relayPid, identity: relay } } : null;
	}

	/**
	 * Who omp, its relay and this server are, as a record names them (see `refs`, `owner`): asked of the system, which
	 * is awaited. A pause asks first thing (`freeze`); a wait that begins while the conversation runs asks here.
	 */
	private async identified(): Promise<void> {
		const pid = this.info.pid;
		if (pid === null) return;
		this.owner ??= await this.pool.self();
		this.refs ??= await this.identify(pid);
	}

	private record(pausedAt: number | null, owner: ProcessRef | null): ParkedRecord | null {
		const relay = this.client.relay;
		const pid = this.info.pid;
		if (!relay || relay.pid === null || pid === null || !this.refs) return null;
		// What a frozen omp reported of the panel's settings; one that runs answers for itself.
		const state = pausedAt !== null ? panelStateOf(this.lastState) : undefined;
		const quota = this.quota?.record();
		const compactQueue = this.compactQueue.record;
		return {
			version: 2,
			liveId: this.info.liveId,
			omp: this.refs.omp,
			relay: this.refs.relay,
			socket: relay.socket,
			owner,
			cwd: this.info.cwd,
			args: this.info.args,
			ownArgs: [...this.ownArgs],
			env: this.env,
			mode: this.info.mode,
			...(this.info.lightModels ? { lightModels: this.info.lightModels } : {}),
			startedAt: this.info.startedAt,
			pausedAt,
			sessionFile: this.info.sessionFile,
			sessionId: this.info.sessionId,
			streaming: this.info.streaming,
			overlay: this.overlay
				? {
						file: this.overlay.file,
						mode: this.overlay.mode,
						wait: this.overlay.wait,
						models: this.overlay.models,
						absent: [...this.overlay.absent],
						absentAgents: [...this.overlay.absentAgents],
						pins: { ...this.overlay.pins },
						compact: this.overlay.compact,
					}
				: null,
			descendants: this.descendants,
			interviewing: this.interviewing,
			pendingUI: [...this.pendingUI.values()],
			...(this.info.sessionSettings ? { sessionSettings: { ...this.info.sessionSettings } } : {}),
			...(state ? { state } : {}),
			...(this.info.retry ? { retry: { ...this.info.retry } } : {}),
			...(this.goal ? { goal: this.goal } : {}),
			...(compactQueue ? { compactQueue } : {}),
			...(this.subagents ? { subagents: this.subagents } : {}),
			...(this.gated ? { gated: true } : {}),
			...(this.guardOverride ? { guard: { ...this.guardOverride } } : {}),
			...(this.guardDamaged ? { guardDamaged: true as const } : {}),
			...(quota ? { quota } : {}),
		};
	}

	/** What `open` and `attach` reply with: the process, and what the server holds of omp that a frozen omp cannot say (see `LiveAttached`). */
	attached(): LiveAttached {
		const state = this.info.pausedAt !== null ? panelStateOf(this.lastState) : undefined;
		return {
			...this.info,
			...(this.goal ? { goal: this.goal } : {}),
			...(this.info.pausedAt !== null && this.subagents ? { subagents: this.subagents } : {}),
			...(state ? { state } : {}),
		};
	}

	/** Write this conversation down (see parked.ts). A change is written, a repeat is not; false: it could not be. */
	private save(pausedAt: number | null, owner: ProcessRef | null): boolean {
		const record = this.record(pausedAt, owner);
		if (!record) return false;
		const text = JSON.stringify(record);
		if (text === this.recorded) return true;
		try {
			this.pool.parked.save(record);
		} catch {
			return false;
		}
		this.recorded = text;
		return true;
	}

	/**
	 * Bring what keeps this conversation across the server in line with `kept`: the relay's hold, the overlay's mark and
	 * the record on disk, and keep the record true to what is known of it. Called wherever one of those could change.
	 */
	persist(): void {
		if (this.info.pid === null) return;
		const kept = this.kept;
		if (!kept && !this.keeping) return;
		if (!kept) {
			this.keeping = false;
			this.client.hold(false);
			this.overlay?.unpark();
			this.pool.parked.remove(this.info.liveId);
			this.recorded = "";
			return;
		}
		// Who omp, its relay and this server are is asked of the system, which is awaited (see `identified`): until it is
		// known there is nothing to write, and nothing is held for it.
		if (!this.keeping && (!this.refs || !this.owner)) return;
		// Held before it is written down, as `freeze` does: a server that dies in between leaves a relay that keeps omp.
		if (!this.keeping) this.client.hold(true);
		if (this.save(this.info.pausedAt, this.owner)) {
			if (!this.keeping) this.overlay?.park();
			this.keeping = true;
		} else if (!this.keeping) this.client.hold(false);
	}

	/**
	 * omp ended, or its relay did, while the conversation was paused: what is still frozen under it has nobody to
	 * resume it and nothing else would ever end it.
	 */
	private endRemnants(): void {
		if (this.refs) void endRemnants(this.refs.omp, this.descendants);
	}

	/** SIGCONT omp and everything under it, the deepest first. Resolves to the processes it listed. */
	private async continueTree(pid: number): Promise<number[]> {
		let tree = [pid];
		try {
			tree = await processTree(pid);
		} catch {
			// no process listing: omp itself must run again regardless
		}
		for (const p of [...tree].reverse()) {
			try {
				process.kill(p, "SIGCONT");
			} catch {
				// already gone
			}
		}
		return tree;
	}

	/**
	 * Stop omp again, and everything under it now: a tool it started while it ran too. Only the pause that `epoch` names:
	 * one that was ended (a Resume, omp ending) while this waited for its turn, or while the system was asked what omp has
	 * started, is left alone, or the tools of a conversation that runs again would be stopped under it.
	 */
	private async refreeze(pid: number, epoch: number): Promise<void> {
		const over = () => this.epoch !== epoch || this.info.pausedAt === null || this.info.exited || this.parked;
		if (over()) return;
		try {
			process.kill(pid, "SIGSTOP");
		} catch {
			return; // omp is gone
		}
		let tree = this.thawedTree;
		try {
			tree = await processTree(pid);
		} catch {
			// no listing: what ran when the thaw began is what there is to stop
		}
		if (over()) return;
		stopBelow(tree, pid);
		await this.noteDescendants(tree, pid);
	}

	/** Write down what omp has started, to be ended with it if it goes while paused (see `ParkedRecord.descendants`). */
	private async noteDescendants(tree: number[], pid: number): Promise<void> {
		const found = await identitiesOf(tree.filter((p) => p !== pid));
		this.descendants = [...found].map(([child, identity]) => ({ pid: child, identity }));
	}

	/**
	 * Run `act` with omp running, for something the user asked of a paused conversation, then freeze it again. The
	 * pause is the user's to end, so `pausedAt` stays and nothing is announced. Actions at once share one thaw, which
	 * ends with the last one. A Resume while one runs ends the pause for good (omp is left running), and so does omp
	 * ending: nothing is frozen again then.
	 */
	private async thawed<T>(act: () => Promise<T>): Promise<T> {
		const pid = this.info.pid as number;
		const thawing = this.thaw(pid);
		try {
			await thawing;
			return await act();
		} finally {
			// What omp prints or announces right after its answer, and what the page asks of it in reply, comes first.
			if (!this.info.exited) await this.settle();
			if (--this.thaws === 0) await this.freezeAgain(pid);
		}
	}

	/** omp runs for the actions under way: the first one thaws it, those that come meanwhile wait for the same thaw. */
	private thaw(pid: number): Promise<void> {
		if (this.thaws++ === 0) {
			this.thawEpoch = this.epoch;
			this.thawing = this.serially(async () => {
				// Handed to the next server meanwhile: it is that one's to run.
				if (!this.parked) this.thawedTree = await this.continueTree(pid);
			});
		}
		return this.thawing;
	}

	/** The last action that thawed omp is answered: freeze it again, and write down what is known of it now. */
	private freezeAgain(pid: number): Promise<void> {
		const epoch = this.thawEpoch;
		return this.serially(async () => {
			await this.refreeze(pid, epoch);
			this.persist();
		});
	}

	/** Let omp keep running a moment after its answer: its last frames, and the page's replies to them, go through. */
	private async settle(): Promise<void> {
		await Bun.sleep(THAW_SETTLE_MS);
		const { promise: capped, resolve } = Promise.withResolvers<void>();
		let over = false;
		const timer = setTimeout(() => {
			over = true;
			resolve();
		}, RIDERS_MAX_MS);
		// Drained, not snapshotted: a reply the page sends to a frame omp printed meanwhile rides along too, or omp
		// would be frozen with it in flight.
		while (this.riders.size && !over) await Promise.race([Promise.allSettled([...this.riders]), capped]);
		clearTimeout(timer);
	}

	/**
	 * Who sent the last message that drives this conversation (a prompt, a steer, a follow-up): `remote` for a page that came
	 * in through the tunnel, `local` for one on this computer; null while no page has since the server took the process over.
	 * A page that only looks at the conversation (attached or not) changes nothing: sending is what makes a turn its own.
	 */
	private origin: "local" | "remote" | null = null;
	/** A conversation a former server left kept and this one took over (see `adopt`): this server did not start it, so that it has no gate is not its choice. */
	private readonly inherited: boolean;
	/** The word to this process's gate (see `syncRisk`); null where there is no gate, or no overlay to put the word beside. */
	private readonly risk: RiskState | null;
	/**
	 * What this conversation chose of "Guard dangerous commands" over the global settings (null: it follows them). Kept with
	 * the conversation, not the process (`LivePool.rememberGuard`, and the record of a paused one); the word to the gate and what
	 * the pages are told (`LiveInfo.guard`) are worked out from it and the global settings (see `guardWord`).
	 */
	private guardOverride: GuardOverride | null;
	/** What was kept of its choices could not be read: it is under the default at least, never Off (see `resolveGuard`). */
	private guardDamaged: boolean;
	/**
	 * What this conversation was given of the model guidance (#641; null: none), as it was when it was given. Kept with the
	 * conversation, not the process (`LivePool.rememberGuidance`), so that a resumed conversation carries it again.
	 */
	private guidanceKept: KeptGuidance | null;
	/** The file this process's omp reads its guidance from (`OMPW_GUIDANCE_FILE`); null when the server has no guidance. */
	private readonly guidanceFile: string | null;
	/** The extension's note that it started in this process was seen (once seen it stays so, as the gate's does). */
	private guidanceLoaded = false;
	/**
	 * Whether unattended mode is on for this conversation (#646). Kept with the conversation, not the process
	 * (`LivePool.rememberUnattended`), so that a resumed conversation is unattended again. The server answers its `ask`
	 * dialogs while it is (`recordAsk`), whether or not the process carries the extension.
	 */
	private unattendedOn: boolean;
	/** The file this process's omp reads the instruction from (`OMPW_UNATTENDED_FILE`); null when the server has no unattended mode. */
	private readonly unattendedFile: string | null;
	/** The extension's note that it started in this process was seen (once seen it stays so). */
	private unattendedLoaded = false;
	/**
	 * The quota floor (#652): the tracker that holds this conversation between two model requests while its provider is at the
	 * floor, the file the extension reads (`OMPW_QUOTA_FILE`), and the extension's note that it started in this process (once
	 * seen it stays so). Null where the server has no floor.
	 */
	private quota: QuotaTracker | null = null;
	private readonly quotaFile: string | null;
	private quotaLoaded = false;
	/**
	 * Compact between two steps (#651): the file the extension reads (`OMPW_COMPACT_STEP_FILE`), which says that a compact waits for a
	 * step boundary, and the extension's note that it started in this process (once seen it stays so). Null where the server has no
	 * such extension.
	 */
	private readonly compactStepFile: string | null;
	private compactStepLoaded = false;
	/** The command that moved the process, from the answer to it until its guard is settled (see `settleMove`). */
	private moving: string | null = null;
	/** The moves in order: one is sent when the one before has been settled (see `rpc`). */
	private moves: Promise<unknown> = Promise.resolve();

	constructor(
		liveId: string,
		private readonly cfg: Config,
		cwd: string,
		args: string[],
		private readonly pool: LivePool,
		/** The session file a `--resume` process is bound to; `get_state` confirms it once omp answers. */
		sessionFile: string | null = null,
		/** Started for a new chat (see `pristine`). */
		newChat = false,
		/** The mode this process is started in (and what Light's models are), and what that adds to its environment. */
		launch: LaunchPlan = FULL,
		/** This process's own settings overlay, which carries its approval mode; absent where modes are not managed. */
		private readonly overlay: ProcessOverlay | null = null,
		extra: {
			/** How omp is reached; default: a pipe of the server's own. */
			via?: RpcLaunch;
			/** A conversation a former server left paused, found again (see `adopt`). */
			restored?: ParkedRecord;
			/** omp's own approval mode when it decides and is none the web UI can set (see `LiveInfo.approvalOmp`). */
			approvalOmp?: string | null;
			/** What the conversation chose of the guard: the record of the process this server took over, else what was kept with the conversation. */
			guard?: KeptGuard;
			/** The flags the user chose for this conversation, without the ones the server adds (see `ownArgs`). */
			ownArgs?: readonly string[];
			/** What the conversation is given of the model guidance now (#641); absent: what was kept for its session file. */
			guidance?: KeptGuidance | null;
			/** Whether unattended mode (#646) is on for the conversation now; absent: what was kept for its session file. */
			unattended?: boolean;
		} = {},
	) {
		const restored = extra.restored;
		this.untouched = newChat;
		this.env = launch.env;
		this.ownArgs = extra.ownArgs ?? [];
		this.info = {
			liveId,
			pid: null,
			cwd,
			sessionFile,
			sessionId: restored?.sessionId ?? null,
			args,
			startedAt: restored?.startedAt ?? Date.now(),
			// Where this process's revision starts: a record of an earlier server, or of another process, never matches it.
			revision: Date.now(),
			streaming: restored?.streaming ?? false,
			exited: false,
			subscribers: 0,
			pausedAt: restored?.pausedAt ?? null,
			...(overlay?.mode ? { approvalMode: overlay.mode } : {}),
			...(extra.approvalOmp ? { approvalOmp: extra.approvalOmp } : {}),
			...(overlay && overlay.wait !== null ? { usageResetWait: overlay.wait } : {}),
			...(overlay?.models ? { models: overlay.models } : {}),
			...(overlay?.compact ? { compactAt: overlay.compact } : {}),
			// What it was told before it was frozen: omp reports neither of these controls, and a record is all there is.
			...(restored?.sessionSettings && Object.keys(restored.sessionSettings).length > 0
				? { sessionSettings: restored.sessionSettings }
				: {}),
			mode: launch.mode,
			...(launch.lightModels ? { lightModels: launch.lightModels } : {}),
			// omp was backing off when it was frozen: it still is, and Retry now has a backoff to end (see `retryNow`).
			...(restored?.retry ? { retry: restored.retry } : {}),
		};
		if (restored) {
			// What omp was told and what it asked before it was frozen is not repeated: it comes from the record.
			for (const frame of restored.pendingUI) this.pendingUI.set(String(frame.id), frame);
			this.interviewing = restored.interviewing;
			this.descendants = restored.descendants;
			this.goal = restored.goal ?? null;
			// A compact that waited when the conversation was frozen waits as it did, with the messages held behind it.
			this.compactQueue.restore(restored.compactQueue);
			const waiting = this.compactQueue.info;
			if (waiting) this.info.compactQueued = waiting;
			this.subagents = restored.subagents ?? null;
			// What omp reported of the panel's settings when it was frozen is all the server has of its state.
			if (restored.state) this.lastState = { ...restored.state };
			this.refs = { omp: restored.omp, relay: restored.relay };
			this.started = true;
		}
		this.inherited = restored !== undefined;
		const keptGuard = extra.guard ?? recordKept(restored);
		this.guardOverride = keptGuard.own;
		this.guardDamaged = keptGuard.damaged;
		// What the conversation carries of the model guidance: what it was given now, else what was kept for its session file.
		const guidance = pool.guidance;
		this.guidanceFile = guidance ? guidance.fileFor(liveId, overlay?.file ?? null) : null;
		this.guidanceKept =
			extra.guidance !== undefined ? extra.guidance : sessionFile ? keptGuidanceOf(guidance, sessionFile) : null;
		// Written before the process starts, so that its first turn carries it: omp reads the file at each turn. Not for a
		// process that was not started with the extension (a `--trusted-extension` one): nothing would read the file.
		if (guidance && this.guidanceFile && this.guidanceKept && this.guidanceNamed)
			try {
				guidance.write(this.guidanceFile, this.guidanceKept.text);
			} catch (e) {
				console.error(`omp-webui: could not write the guidance of ${liveId}: ${(e as Error).message}`);
			}
		// Unattended mode (#646) is kept the same way: what the conversation was given now, else what was kept for its session file.
		const unattended = pool.unattended;
		this.unattendedFile = unattended ? unattended.fileFor(liveId, overlay?.file ?? null) : null;
		this.unattendedOn =
			extra.unattended !== undefined
				? extra.unattended
				: Boolean(unattended && sessionFile && unattended.isOn(sessionKey(sessionFile)));
		if (unattended && this.unattendedFile && this.unattendedOn && this.unattendedNamed)
			try {
				unattended.write(this.unattendedFile, unattended.textFor(sessionFile ?? null));
			} catch (e) {
				console.error(`omp-webui: could not write the unattended instruction of ${liveId}: ${(e as Error).message}`);
			}
		// An agent that could change these could turn its own gate off: the settings overlay's folder holds the gate's word.
		this.risk =
			overlay && pool.gate
				? new RiskState(overlay.file, [...pool.gate.protect, dirname(overlay.file)], restored?.gated === true)
				: null;
		this.syncRisk();
		this.syncGuardInfo();
		this.syncGuidance();
		this.syncUnattended();
		// The quota floor (#652): the hold file the extension reads, and the tracker that decides what it says.
		const quotaFloor = pool.quotaFloor;
		this.quotaFile = quotaFloor ? quotaFloor.fileFor(liveId, overlay?.file ?? null) : null;
		if (quotaFloor && this.quotaFile) {
			const holdFile = this.quotaFile;
			this.quota = new QuotaTracker(
				{
					timings: quotaFloor.timings,
					now: () => Date.now(),
					after: (ms, fn) => {
						const timer = setTimeout(fn, ms);
						timer.unref?.();
						return () => clearTimeout(timer);
					},
					floorOf: (provider) => quotaFloor.floorOf(provider),
					reports: (provider, force) => quotaFloor.reports(provider, force),
					write: (hold) => quotaFloor.write(holdFile, hold),
					report: (message) => console.warn(`omp-webui: ${liveId}: ${message}`),
				},
				{
					// A local backend spends none of the cloud providers' quota, whatever its model is called.
					provider: () => (runsLocal(this.info) ? null : (this.modelParts()?.provider ?? null)),
					model: () => this.modelParts()?.id ?? null,
					active: () => this.info.streaming && !this.info.exited,
					working: () => this.info.streaming && this.info.pausedAt === null && !this.waiting && !this.info.exited,
					cannotHold: () => this.quotaCannotHold(),
					warmingOff: () => this.info.sessionSettings?.cacheWarming === "off",
					answer: (id) => {
						if (!this.info.exited)
							this.client.send({ type: "extension_ui_response", id, value: QUOTA_DIALOG_CONTINUE });
					},
					changed: () => this.quotaChanged(),
				},
				restored?.quota,
			);
			this.syncQuota();
		}
		// Compact between two steps (#651): the file the extension reads, and what it is told as a restored queue stands (a file a
		// former server left is rewritten or taken away, whichever the queue says).
		this.compactStepFile = pool.compactStep ? pool.compactStep.fileFor(liveId, overlay?.file ?? null) : null;
		this.compactQueue.rearm();
		// What a page is told of the work is what the process holds now (a conversation a former server left asking is asking).
		this.told = { streaming: this.info.streaming, asking: this.pendingUI.size > 0, continuing: false };
		if (this.told.asking) this.info.asking = true;
		this.client = new RpcClient({
			bin: cfg.ompBin,
			// Last, so that no overlay the user passed in the options can override it.
			args: overlay ? [...args, "--config", overlay.file] : args,
			cwd,
			env:
				this.guidanceFile || this.unattendedFile || this.quotaFile || this.compactStepFile
					? {
							...launch.env,
							...(this.guidanceFile ? { [GUIDANCE_FILE_ENV]: this.guidanceFile } : {}),
							...(this.unattendedFile ? { [UNATTENDED_FILE_ENV]: this.unattendedFile } : {}),
							...(this.quotaFile ? { [QUOTA_FILE_ENV]: this.quotaFile } : {}),
							...(this.compactStepFile ? { [COMPACT_STEP_FILE_ENV]: this.compactStepFile } : {}),
						}
					: launch.env,
			via: extra.via,
			onFrame: (f) => this.onFrame(f),
			onExit: (code, stderr, signal) => {
				const wasPaused = this.info.pausedAt !== null;
				this.info.exited = true;
				this.titles.stop();
				this.info.streaming = false;
				delete this.info.retry;
				this.info.pausedAt = null;
				this.pendingUI.clear();
				this.held.clear();
				this.compactQueue.gone();
				delete this.info.compactQueued;
				delete this.info.softStop;
				clearTimeout(this.softStopRemind ?? undefined);
				this.softStopRemind = null;
				delete this.info.turnStartedAt;
				delete this.info.asking;
				delete this.info.continuing;
				// A process that ended has no sleep to be told of: the note and its watch go with it (#647).
				delete this.info.slept;
				// Nothing holds a process that ended, and nothing is looked at for it (the hold file goes with its folder).
				this.quota?.end();
				delete this.info.quotaHold;
				clearTimeout(this.sleepFollow ?? undefined);
				this.sleepFollow = null;
				for (const call of this.serving.values()) call.abort();
				this.serving.clear();
				this.hostServer?.ended(liveId);
				this.hostServer = null;
				overlay?.remove();
				// A new chat nobody sent anything to leaves no file, and so nothing of its choices.
				if (this.untouched && this.info.sessionFile && !existsSync(this.info.sessionFile))
					this.pool.rememberGuard(this, null);
				this.pool.parked.remove(liveId);
				if (wasPaused) this.endRemnants();
				this.subagentFrames.flush();
				const exit: ExitReport = {
					code,
					...(signal ? { signal } : {}),
					stderr: stderr.slice(-8000),
					// The server asked for this end (the reaper, a Close, a restart, the terminal hand-off): the page is
					// told so, and not left to read a clean exit of the server's own making as a crash of omp's.
					...(this.endedBy === null ? { by: "omp" as const } : { by: "server" as const, reason: this.endedBy }),
				};
				// The frame reaches the subscribers only, and the reaper closes the processes nobody watches: the
				// server keeps the end itself, and hands it to a page that asks about the process afterwards (#515).
				this.pool.recordExit(this.info, exit);
				this.broadcast({ t: "live_exit", liveId, ...exit });
				this.pool.forget(this);
			},
		});
	}

	async init(): Promise<void> {
		// The relay says where omp is before omp says anything.
		await this.client.started;
		this.info.pid = this.client.pid;
		await this.client.ready;
		// Opt in to everything a full UI can render: subagent streams and the structured ask dialog.
		await this.client.request({
			type: "set_subagent_subscription",
			level: "events",
		});
		await this.client.request({ type: "set_ask_dialog", enabled: true });
		// Stream text as deltas instead of re-sending the whole message on every token.
		// Older omp versions ignore the option (no echo) and keep full snapshots; the client handles both.
		await this.client.request({ type: "set_event_filter", events: null, messageUpdates: "delta" });
		await this.refreshState();
		await this.restoreInterview();
		this.started = true;
	}

	async refreshState(followed?: () => void): Promise<void> {
		try {
			await this.takeMove(followed);
		} finally {
			followed?.();
		}
	}

	private async takeMove(followed?: () => void): Promise<void> {
		if (this.client.isExited) return;
		// What omp's answer describes is taken in where the answer stands among omp's frames, not here after the wait: a frame
		// read in the same chunk as the answer (a turn that began right after it) has been handled by then, and the answer
		// would be laid over it, a conversation that runs listed, and held, as one that does not.
		const taken: { move?: SessionMove } = {};
		const r = await this.client.request({ type: "get_state" }, 0, undefined, (answer) => {
			if (answer.success) taken.move = this.takeState(answer.data);
		});
		if (!r.success || !taken.move) return;
		const { from, to } = taken.move;
		if (from !== to) {
			// The conversation moved to another session file (branch, fork, a new session): what belongs to the
			// conversation, not to this process, goes along: the mode the user picked and an interview in progress.
			if (from && to) this.pool.carryApproval(from, to);
			if (from && to) this.pool.carryUsageWait(from, to);
			if (from && to) this.pool.carryModels(from, to);
			if (from && to) this.pool.carryCompact(from, to);
			if (from && to) this.pool.carryGuidance(from, to);
			if (from && to) this.pool.carryUnattended(from, to);
			if (from && to) this.pool.carryLaunchMode(from, to);
			if (to) this.followGuard(to, from);
			followed?.();
			if (this.interviewing) this.pool.noteInterview(to, true);
			if (from && to) await this.followFolder();
			this.pool.announce(this);
		}
		this.noteWork();
	}

	/** The state omp's answer describes is what the process holds now. Returns where the session file was, and where it is. */
	private takeState(data: unknown): SessionMove {
		if (isRecord(data)) {
			this.lastState = data;
			// A paused conversation's record carries the panel's settings: what omp says while it runs for an action is in it.
			if (this.info.pausedAt !== null) this.persist();
		}
		const s = data as StateSnapshot;
		const from = this.info.sessionFile;
		this.info.sessionFile = s.sessionFile ? sessionKey(s.sessionFile) : null;
		this.info.sessionId = s.sessionId ?? null;
		this.info.streaming = Boolean(s.isStreaming);
		this.unsettled = s.isSettled === false || s.hasPendingAsyncWork === true || s.isCompacting === true;
		// omp says it is done (its `session_settled` frame, or this answer: not streaming, nothing queued, no goal turn about to
		// start): no turn is coming, whatever frame a listener missed or omp did not send. The pages read it the same way.
		if (s.isSettled === true && !s.isStreaming) {
			this.between = false;
			this.partial = false;
			delete this.info.turnStartedAt;
		}
		// The goal is in goal mode's state (`{ enabled, mode, goal }`): what omp holds, whatever frames came before.
		if ("goal" in s) this.goal = heldGoal(isRecord(s.goal) ? s.goal.goal : null);
		return { from, to: this.info.sessionFile };
	}

	/**
	 * omp's `/move` and `/wt` take the conversation to another folder, and its session file along: that is how they show
	 * in `get_state`, which names no folder, so `info.cwd` would stay where the conversation started. omp says where it
	 * is in its `/session` printout (`CWD: <folder>`), which works for a conversation that has no file yet too. What
	 * is read from the folder (project presets and roles, the Loaded dialog, plugin and skill scopes) follows.
	 * Nothing changes when omp does not say.
	 */
	private async followFolder(): Promise<void> {
		if (this.info.pausedAt !== null || this.info.exited || this.client.closing) return;
		const printed = await this.command("/session").catch(() => null);
		const cwd = printed ? /^CWD: (.+)$/m.exec(printed)?.[1]?.trim() : undefined;
		if (!cwd || cwd === this.info.cwd) return;
		this.info.cwd = cwd;
		void this.refreshModelRoles().catch((e) => {
			console.error(`omp-webui: could not update the model settings of ${this.info.liveId}: ${(e as Error).message}`);
		});
	}

	/**
	 * A conversation that was in an interview when its last process ended (reaped as idle, closed for the terminal, or
	 * gone with the server) gets the interview's tool back, unless it has a goal by now (set in the terminal). A failure
	 * leaves an ordinary conversation: opening it matters more than the interview.
	 */
	private async restoreInterview(): Promise<void> {
		const file = this.info.sessionFile;
		if (!file || !this.pool.wasInterviewing(file)) return;
		try {
			const goal = await this.client.request({ type: "goal", op: "get" });
			const held = (goal.data as { goal?: { status?: string } | null } | undefined)?.goal;
			if (goal.success && goalHeld(held)) {
				this.pool.noteInterview(file, false);
				return;
			}
			const tools = [proposeGoalTool()];
			const tool = await this.client.request({ type: "set_host_tools", tools: this.hostTools(tools) });
			if (tool.success) this.pageHostTools = tools;
			this.interviewing = tool.success;
		} catch {
			// the process is going away: nothing to restore
		}
	}

	/**
	 * Keep `interviewing` and the server's memory of it true to what the web UI told omp: the interview opens when omp
	 * is given `propose_goal` and is over when the tool is taken away or a goal exists. Called for each command omp accepted.
	 */
	private trackInterview(command: Record<string, unknown>): void {
		if (command.type === "set_host_tools") {
			const tools = Array.isArray(command.tools) ? (command.tools as { name?: unknown }[]) : [];
			this.interviewing = tools.some((t) => t?.name === PROPOSE_GOAL_TOOL);
		} else if (command.type === "goal" && command.op === "create") {
			this.interviewing = false;
		} else {
			return;
		}
		this.pool.noteInterview(this.info.sessionFile, this.interviewing);
		this.persist();
	}

	/**
	 * Take over a process a former server left in the background (see `kept`). It must be the recorded one. A paused one
	 * is frozen again: a user's action may have been running it when that server went. One that waited out a usage limit
	 * runs; what omp did while no server was there (the relay hands it over in order) comes as frames, and omp's word
	 * on what it is doing now settles a wait that ended unseen: it reports a turn in progress for the whole backoff, so
	 * a wait it no longer reports is over, and is not shown.
	 */
	async adopt(expected: number): Promise<void> {
		await this.client.started;
		const pid = this.client.pid;
		if (pid !== expected) throw new Error(`The relay holds process ${pid}, not ${expected}`);
		this.info.pid = pid;
		this.client.hold(true);
		this.keeping = true;
		this.owner = await this.pool.self();
		if (this.info.pausedAt !== null) await this.refreeze(pid, this.epoch);
		else {
			await this.refreshState();
			if (!this.info.streaming) delete this.info.retry;
		}
		this.persist();
		// A conversation that was held at the quota floor when the last server went: the quota may have reset since, and it is looked
		// at again at once. The restored hold file is rewritten as it stands (the process's own folder may have been cleaned).
		if (!this.info.streaming) this.quota?.onWork();
		else this.quota?.resume();
	}

	/**
	 * The server is ending and this conversation stays. Waits out the user's actions that run omp, freezes it
	 * again if it is paused, writes its final record (no owner: whichever server comes next may take it) and lets go of
	 * the relay, which keeps omp. False: it cannot be kept (it is not kept any more, or the record could not be written).
	 */
	async park(): Promise<boolean> {
		const pid = this.info.pid;
		if (pid === null || !this.kept) return false;
		const deadline = Date.now() + PARK_WAIT_MS;
		while (this.thaws > 0 && Date.now() < deadline) await Bun.sleep(20);
		return this.serially(async () => {
			if (!this.kept) return false;
			// A paused one is frozen again: a user's action may have been running it. One that waits runs on.
			await this.refreeze(pid, this.epoch);
			// A wait that has only just begun may not have been identified yet.
			await this.identified();
			// omp may have ended while the system was asked, and the pause or the wait with it.
			if (!this.kept) return false;
			this.client.hold(true);
			if (!this.save(this.info.pausedAt, null)) {
				this.client.hold(false);
				return false;
			}
			this.parked = true;
			this.client.detach();
			// The relay keeps omp now and the next server decides when it is let go: this one must not undo it.
			this.keeping = false;
			return true;
		});
	}

	/**
	 * Follow omp's own retry of a failed turn: it announces the backoff (`auto_retry_start`, with how long it sleeps and
	 * whether the failure was a usage limit), starts the retried turn (`agent_start`: `resumed`) and ends the retry
	 * (`auto_retry_end`). The process is busy meanwhile, so that it is not reaped as idle in the middle of a wait of
	 * hours, and a tab that attaches meanwhile shows the same countdown (`LiveInfo.retry`). A usage-limit wait is also
	 * kept across this server (`kept`): omp's own timer is what resumes the turn, so the process must be there at the
	 * reset whether the app is restarted, crashes or is quit meanwhile.
	 *
	 * omp 18.12 can lose a retry it announced: when the failures of two turns overlap (messages queued during a wait,
	 * then `abort_retry` starts them one after another), the second failure's handler resets the counter the first
	 * one's sleep checks at its end, and that sleep ends with `agent.continue skipped … should-continue-false`: no
	 * request, no `auto_retry_end`. omp reports `session_settled` while no retry is going on (it never does during
	 * a real wait), so a wait is dropped when omp reports it (the page does the same), and one announced after it
	 * is never held: nothing will end it, and a countdown to a retry that does not come is worse than none.
	 */
	private trackRetry(frame: OmpFrame): void {
		if (frame.type === "session_settled") {
			this.settled = true;
			if (!this.info.retry) return;
			delete this.info.retry;
		} else if (frame.type === "auto_retry_start") {
			if (this.settled) return;
			this.info.retry = {
				attempt: Number(frame.attempt) || 1,
				maxAttempts: Number(frame.maxAttempts) || 1,
				delayMs: Number(frame.delayMs) || 0,
				startedAt: Date.now(),
				usageLimit: isUsageLimitError(frame.errorId),
				resumed: false,
			};
		} else if (frame.type === "auto_retry_end" && this.info.retry) {
			delete this.info.retry;
		} else if (frame.type === "agent_start") {
			this.settled = false;
			// A turn can end in a wait of hours, which is held the moment it is announced: who omp is, which the system has
			// to say, is asked now (once), not when the wait has already begun.
			if (!this.refs || !this.owner) void this.identified().catch(() => {});
			// omp slept through the backoff and started the retried turn; its `auto_retry_end` comes when that turn ends.
			if (!this.info.retry || this.info.retry.resumed) return;
			this.info.retry.resumed = true;
		} else {
			return;
		}
		// What keeps the process (a wait, a pause) and what the record says of it follow the change: a wait announced is
		// held and written down (once the system has said who omp is: `identified`), one that ended is let go, and a
		// paused conversation's record is kept true to what omp does for the user's actions.
		if (this.waiting && !this.keeping) {
			void this.identified()
				.then(() => this.persist())
				.catch((e) =>
					console.error(`omp-webui: could not keep ${this.info.liveId} through its wait: ${(e as Error).message}`),
				);
		}
		this.persist();
		this.pool.announce(this);
	}

	/**
	 * End the wait the server holds because omp did not: the tabs are told as omp would have (`auto_retry_end`), and
	 * drop it on the usual frame. Only `held` itself: a newer wait is omp's.
	 */
	private endWait(held: LiveRetry, reason: string): void {
		if (this.info.retry !== held) return;
		delete this.info.retry;
		this.persist();
		this.pool.announce(this);
		this.broadcast({
			t: "frame",
			liveId: this.info.liveId,
			frame: { type: "auto_retry_end", success: false, attempt: held.attempt, finalError: reason },
		});
	}

	/**
	 * omp answered a command that ends its retry wait (`ENDS_RETRY`). If the wait is still held when omp has had time to
	 * announce the end, omp had lost it and there is nothing to end: the page's Cancel, Stop and Retry now must not
	 * leave a countdown, a busy conversation and a button that does nothing behind.
	 */
	private async endLostWait(): Promise<void> {
		const held = this.info.retry;
		if (!held || (await this.untilFrame("auto_retry_end", RETRY_ABORT_MS))) return;
		this.endWait(held, "Retry cancelled");
	}

	/** Resolves with true once a frame of this `type` arrives, or false after `ms`. */
	private untilFrame(type: string, ms: number): Promise<boolean> {
		const { promise, resolve } = Promise.withResolvers<boolean>();
		const waiter = { type, resolve: () => finish(true) };
		const timer = setTimeout(() => finish(false), ms);
		const finish = (seen: boolean) => {
			clearTimeout(timer);
			this.frameWaiters.delete(waiter);
			resolve(seen);
		};
		this.frameWaiters.add(waiter);
		return promise;
	}

	/**
	 * Retry now what omp is backing off before, or what failed and waits for the user: the user's click, so a paused
	 * conversation runs for it. A backoff is ended with omp's own `abort_retry` (its `auto_retry_end` is waited for, so
	 * that omp is no longer retrying when the next command arrives), then omp's own `/retry` redoes the failed turn.
	 * Single-flight: a second click (another tab, a double click) while one is under way joins it and gets its outcome,
	 * instead of running `/retry` again on a turn the first already redid (omp's "Wait for the current response…").
	 */
	retryNow(): Promise<void> {
		this.retrying ??= this.runRetryNow().finally(() => {
			this.retrying = null;
		});
		return this.retrying;
	}

	/** The `retryNow` under way, if any. */
	private retrying: Promise<void> | null = null;
	/** What `endLostWait` is doing for the latest command that ends omp's wait. */
	private lostWait: Promise<void> = Promise.resolve();

	private async runRetryNow(): Promise<void> {
		if (this.info.exited || this.client.closing) throw new Error("This conversation is not running");
		await this.resume();
		if (this.info.retry) {
			const aborted = await this.rpc({ type: "abort_retry" });
			if (!aborted.success) throw new Error(aborted.error ?? "omp refused to stop the wait");
			// Until omp has announced the end of the wait, or, when it never does, the server has ended it (`endLostWait`).
			await this.lostWait;
		}
		const printed = await this.command("/retry");
		if (printed !== null) throw new Error(printed || "Nothing to retry.");
	}

	// ------------------------------------------------------------------ Stop

	/** The Stop under way, by what it stops: a press that comes while one runs joins it (another tab, a double click, Esc held down). */
	private readonly stops = new Map<StopKind, Promise<RpcResponse>>();

	/**
	 * The page's Stop, carried through until the conversation has stopped, or its omp has been ended. omp's `abort` ends
	 * the turn the model is in, and nothing else: not a subagent that waits on a provider's usage limit for hours (it
	 * is a background job of the session, which stays busy), not a turn omp does not answer the abort of (a process
	 * that stopped answering, a tool that will not end). So Stop sends what ends each of those, and when omp has not
	 * ended the turn within `STOP_GRACE_MS` it is ended itself: its process is terminated, then killed, with what it
	 * started. The conversation is kept (its file is what omp wrote so far) and the next message starts omp again on it.
	 * A paused conversation runs again for it. Single-flight per kind: a press that comes while one runs gets its answer,
	 * without what omp gave back of the queue (the page that pressed first has it, and puts it in its message box once).
	 *
	 * What Stop waits for is the turn: a stream, a retry wait, a subagent that works, and omp's answer to the abort. A
	 * background job of the session that is not a subagent (an auto-backgrounded `bash`, an `eval`) or a compaction keeps
	 * `unsettled` true, and is not the turn: omp's abort leaves them alone and so does Stop, which must not end omp
	 * (and the dev server it holds) for them.
	 */
	stop(kind: StopKind, command: Record<string, unknown>): Promise<RpcResponse> {
		const under = this.stops.get(kind);
		if (under) return under.then(joinedStop);
		// What waited for this turn to end does not go on without it: it is handed back with the rest of the queue.
		const withdrawn = kind === "turn" ? this.compactQueue.withdraw() : Promise.resolve([]);
		const run = this.runStop(kind, command)
			.then(async (r) => withWithdrawn(r, await withdrawn))
			.finally(() => void this.stops.delete(kind));
		this.stops.set(kind, run);
		return run;
	}

	private async runStop(kind: StopKind, command: Record<string, unknown>): Promise<RpcResponse> {
		const type = String(command.type);
		if (this.info.exited || this.client.closing)
			return { type: "response", command: type, success: false, error: "This conversation is not running" };
		const began = Date.now();
		// A frozen conversation has to run to take anything: the resume goes first, and what is sent next waits for it (`rpcNow`).
		void this.resume().catch(() => {});
		const got: { answer: RpcResponse | null; at: number } = { answer: null, at: 0 };
		const sent = this.sendStop(command).then(
			(r) => {
				got.answer = r;
				got.at = Date.now();
			},
			() => {},
		);
		// The turn is over when omp has answered the abort and nothing of it is left; ended, nothing is.
		const over = () =>
			this.info.exited ||
			(kind === "bash"
				? !this.held.bashRunning
				: got.answer !== null && !this.info.streaming && this.info.retry === undefined && !this.subagentsLeft);
		// The first abort does not touch subagents (they are jobs of the session): they are cancelled at once, and a subagent is
		// taken to work until a sweep has found none.
		if (kind === "turn") {
			this.subagentsLeft = true;
			void this.sweepSubagents();
		}
		let nudged = began;
		while (!over()) {
			const now = Date.now();
			if (now - began >= STOP_GRACE_MS) return this.endProcess(type);
			// omp said yes to the abort and has not ended its retry wait: it lost the wait, which only the server can end.
			if (kind === "turn" && got.answer?.success && this.info.retry && now - got.at >= STOP_LOST_MS)
				this.endWait(this.info.retry, "Retry cancelled");
			if (now - nudged >= STOP_NUDGE_MS) {
				this.nudgeStop(kind);
				nudged = now;
			}
			await Bun.sleep(STOP_POLL_MS);
		}
		if (this.info.exited) return this.endedAnswer(type);
		// Over; omp's answer, which carries what it took out of the queue, comes with it or a moment behind.
		await Promise.race([sent, Bun.sleep(STOP_ANSWER_MS)]);
		return got.answer ?? { type: "response", command: type, success: true, data: {} };
	}

	/** What Stop answers when omp's process is gone: it was ended for Stop (`stopped`), or ended while Stop waited (`exited`). The queue it held is gone with it. */
	private endedAnswer(type: string): RpcResponse {
		return {
			type: "response",
			command: type,
			success: true,
			data: { ended: this.endedBy === "stopped" ? "stopped" : "exited" },
		};
	}

	/** The page's own abort command, as the page sent it; a runtime that does not know `abort_and_restore_queue` is sent plain `abort`. */
	private async sendStop(command: Record<string, unknown>): Promise<RpcResponse> {
		const first = await this.rpc(command);
		if (!first.success && command.type === "abort_and_restore_queue" && /unknown command/i.test(first.error ?? ""))
			return this.rpc({ type: "abort" });
		return first;
	}

	/**
	 * What omp has not ended in a second gets what ends it, again: another abort (or the end of the retry wait, or of the
	 * `!command`), the subagents that work, and omp is asked its state, in case it ended the turn without saying so.
	 */
	private nudgeStop(kind: StopKind): void {
		if (kind === "bash") {
			void this.rpc({ type: "abort_bash" }).catch(() => {});
			return;
		}
		if (this.info.retry) void this.rpc({ type: "abort_retry" }).catch(() => {});
		else if (this.info.streaming) void this.rpc({ type: "abort" }).catch(() => {});
		void this.sweepSubagents();
		void this.refreshState().catch(() => {});
	}

	/** Whether a subagent that works was left by the last round of `cancelSubagents`; true while Stop has not heard of one. */
	private subagentsLeft = false;
	private sweeping: Promise<void> | null = null;

	/** `cancelSubagents`, one at a time: a round that is under way is not started again. */
	private sweepSubagents(): Promise<void> {
		this.sweeping ??= this.cancelSubagents()
			.then((left) => {
				this.subagentsLeft = left;
			})
			.finally(() => {
				this.sweeping = null;
			});
		return this.sweeping;
	}

	/**
	 * Cancel every subagent omp lists as working (`cancel_subagent`: it is parked, and a message to it brings it back), and say
	 * whether one still works after that. omp that does not list them says none: it is not Stop's to wait for. Never throws.
	 */
	private async cancelSubagents(): Promise<boolean> {
		const working = (list: Record<string, unknown>[] | null): string[] =>
			(list ?? []).flatMap((s) =>
				typeof s.id === "string" && isWorkingStatus(typeof s.status === "string" ? s.status : "running") ? [s.id] : [],
			);
		const ids = working(await this.listSubagents());
		if (ids.length === 0) return false;
		await Promise.all(
			ids.map(async (id) => {
				try {
					await this.client.request({ type: "cancel_subagent", subagentId: id }, STOP_ASK_MS);
				} catch {
					// omp does not answer: the grace runs out and its process is ended
				}
			}),
		);
		return working(await this.listSubagents()).length > 0;
	}

	/**
	 * omp did not end the turn in time: its process is ended, SIGTERM first, then SIGKILL, and what it started with it (a tool
	 * runs in a session of its own, and is not below omp once omp is gone: the tree is listed first, and only the processes
	 * that are still the ones that were listed are killed). The page is told why (`ExitReason` "stopped").
	 */
	private async endProcess(type: string): Promise<RpcResponse> {
		// Gone while Stop waited (omp ended, or another Stop ended it): nothing is left to signal, and a pid that is not omp's any more is not to be.
		if (this.info.exited || !this.client.running) return this.endedAnswer(type);
		this.endedBy ??= "stopped";
		const pid = this.client.pid;
		let tree = pid === null ? [] : [pid];
		let known = new Map<number, string>();
		let listed = false;
		if (pid !== null) {
			try {
				tree = await processTree(pid);
				known = await identitiesOf(tree);
				listed = true;
			} catch {
				// No process listing: omp and its group are ended all the same.
			}
		}
		// What froze it (a stop this server did not make) would hold back the signal: it runs for it.
		for (const p of [...tree].reverse()) {
			try {
				process.kill(p, "SIGCONT");
			} catch {
				// already gone
			}
		}
		this.client.kill("SIGTERM");
		await Promise.race([this.client.whenExited, Bun.sleep(STOP_TERM_MS)]);
		if (this.client.running) this.client.kill("SIGKILL");
		let now = new Map<number, string>();
		try {
			now = await identitiesOf(tree);
		} catch {
			// No listing now: what was listed is what there is to compare with.
			now = known;
		}
		// Only what is still the process that was listed. When the first listing failed there is nothing to tell them apart
		// by: omp's own group, if omp still runs, and nothing else (a pid that is gone is not to be signalled).
		const doomed = listed
			? tree.filter((p) => known.get(p) !== undefined && now.get(p) === known.get(p))
			: this.client.running
				? tree
				: [];
		signalAll(doomed, "SIGKILL");
		await Promise.race([this.client.whenExited, Bun.sleep(STOP_KILL_MS)]);
		if (!this.info.exited) return { type: "response", command: type, success: false, error: "omp did not end" };
		return this.endedAnswer(type);
	}

	private onFrame(frame: OmpFrame): void {
		this.lastActivity = Date.now();
		// What the Mac's sleep cut, if the server saw one: omp's frames that follow it say what became of the turn.
		if (this.info.slept) this.noteAfterSleep(frame);
		if (frame.type === "command_output" && typeof frame.text === "string" && this.capture) {
			this.capture.push(frame.text);
			return;
		}
		// The quota floor's extension waits in a dialog of its own and tells its cache decisions in a status: the tracker takes both,
		// and no page is shown either (#652). The frames that tell what a cache refresh cost are read and go on.
		if (this.quota?.onFrame(frame)) return;
		// Likewise the dialog the compact-between-steps extension holds a step boundary in (#651): the queue sends the compact, or lets go.
		if (frame.type === "extension_ui_request" && this.compactQueue.frame(frame)) return;
		if (mayRewriteEntries(frame)) this.info.revision = (this.info.revision ?? 0) + 1;
		this.writing.note(frame);
		this.held.note(frame);
		if (frame.type === "agent_start") {
			this.untouched = false;
			this.info.streaming = true;
			// The conversation turned again: the sleep is old news now, and its line goes with the turn it was about (#647).
			if (this.info.slept) {
				delete this.info.slept;
				clearTimeout(this.sleepFollow ?? undefined);
				this.sleepFollow = null;
				this.pool.announce(this);
			}
			// A turn that omp carries on (`agent_end` with `isTerminal: false`) is the one it continues: its clock goes on, as a page's does.
			if (!this.partial) this.info.turnStartedAt = Date.now();
			this.between = false;
			this.partial = false;
			this.lastReply = null;
		}
		this.lastReply = replyLine(frame) ?? this.lastReply;
		if (frame.type === "goal_updated") {
			this.goal = heldGoal(frame.goal);
			// A change made while the conversation is paused (a user's action thawed omp) is part of what a next server finds.
			this.persist();
		}
		if (frame.type === "agent_end" || frame.type === "session_settled") {
			this.info.streaming = false;
			this.between = frame.type === "agent_end" && frame.isTerminal !== false;
			this.partial = frame.type === "agent_end" && frame.isTerminal === false;
			if (!this.partial) delete this.info.turnStartedAt;
			// omp says it is done; the `get_state` below confirms it, and one that fails must not leave the process busy.
			if (frame.type === "session_settled") this.unsettled = false;
			void this.refreshState().catch(() => {});
			// The first exchange may be over: it is given a title (see `AutoTitle`), whether or not a page is open.
			if (frame.type === "agent_end" && frame.isTerminal !== false) {
				this.titles.turnEnded();
				// A soft stop waited for this: the handoff is written, and the process ends (#658).
				if (this.info.softStop) this.finishSoftStop();
			}
		}
		if (frame.type === "auto_compaction_start") this.unsettled = true;
		else if (frame.type === "auto_compaction_end") {
			this.unsettled = false;
			void this.refreshState().catch(() => {});
		}
		this.compactQueue.frame(frame);
		this.trackRetry(frame);
		// A turn that begins or ends, a usage-limit wait or its end: what the quota floor holds, and looks at, follows (#652).
		if (
			frame.type === "agent_start" ||
			frame.type === "agent_end" ||
			frame.type === "session_settled" ||
			frame.type === "auto_retry_start" ||
			frame.type === "auto_retry_end"
		)
			this.quota?.onWork();
		for (const waiter of [...this.frameWaiters]) if (waiter.type === frame.type) waiter.resolve();
		// Unattended mode (#646): an `ask` dialog is answered here and filed, and the agent's `file_question` call is filed.
		if (frame.type === "extension_ui_request" && frame.method === "ask" && this.recordAsk(frame)) return;
		if (frame.type === "tool_execution_start") this.noteToolCall(frame);
		let forwarded = frame;
		if (frame.type === "extension_ui_request") {
			if (DIALOG_METHODS[String(frame.method)]) {
				// omp stops waiting after `timeout` ms: its deadline on this clock, so that a tab that attaches later counts down to it too.
				if (typeof frame.timeout === "number" && frame.timeout > 0)
					forwarded = { ...frame, expiresAt: Date.now() + frame.timeout };
				this.pendingUI.set(String(frame.id), forwarded);
			} else if (frame.method === "cancel") {
				const closed = this.pendingUI.get(String(frame.targetId));
				this.pendingUI.delete(String(frame.targetId));
				// omp closes a dialog nobody answered when its own deadline passes (and answers it itself); any other time it
				// is the turn that was stopped. The pages say which it was to the user.
				if (typeof closed?.expiresAt === "number" && Date.now() >= closed.expiresAt - DEADLINE_SLACK_MS)
					forwarded = { ...frame, timedOut: true };
			}
		}
		if (frame.type === "host_tool_call" && this.servedNames.has(String(frame.toolName))) {
			// A tool the server gave omp itself: it answers, and no page is told (a page would answer it with an error).
			this.serveCall(frame);
			return;
		}
		if (frame.type === "host_tool_cancel" && this.serving.has(String(frame.targetId))) {
			this.serving.get(String(frame.targetId))?.abort();
			this.serving.delete(String(frame.targetId));
			return;
		}
		// A tool the web UI gave omp (`set_host_tools`) is being called: it waits for the user like a dialog does.
		if (frame.type === "host_tool_call") this.pendingUI.set(String(frame.id), frame);
		else if (frame.type === "host_tool_cancel") this.pendingUI.delete(String(frame.targetId));
		this.subagentFrames.push(forwarded);
		this.noteWork();
	}

	/**
	 * Give this process host tools the server answers itself, or take them away (null). A tool of the server's is
	 * served for this one conversation: it lives on its pipe, and nothing is handed to omp to call the server with, so
	 * the tools' arguments and results (kept in the session file, shown on pages, exported) carry no credential.
	 * Throws when omp does not accept the tools; nothing is served then.
	 */
	async serveHostTools(server: HostToolServer | null): Promise<void> {
		// A process that serves tools is no new chat to hand to another one.
		this.untouched = false;
		const before = this.hostServer;
		this.hostServer = server;
		for (const tool of server?.tools ?? []) this.servedNames.add(tool.name);
		const set = await this.client.request({ type: "set_host_tools", tools: this.hostTools(this.pageHostTools) });
		if (!set.success) {
			this.hostServer = before;
			throw new Error(set.error ?? "omp did not accept the tools");
		}
	}

	/**
	 * What omp is told its host tools are: the page's, and the ones the server serves. A page's tool that has the name of
	 * a served one is dropped, not merged: a page cannot replace what a served tool says it does (the call goes to the
	 * server whatever the definition, but the model reads the definition).
	 */
	private hostTools(page: readonly unknown[]): unknown[] {
		const served: readonly HostToolDefinition[] = this.hostServer?.tools ?? [];
		const taken = new Set(served.map((t) => t.name));
		return [...page.filter((t) => !(isRecord(t) && typeof t.name === "string" && taken.has(t.name))), ...served];
	}

	/** Answer a call of a served tool and send omp the result; a call omp has given up on is not answered. */
	private serveCall(frame: OmpFrame): void {
		const id = String(frame.id);
		const server = this.hostServer;
		const abort = new AbortController();
		this.serving.set(id, abort);
		const answer = async (): Promise<HostToolResult> => {
			if (!server)
				return {
					text: "This tool has been taken away from this conversation. Tell the person, and do not look for another way to do it.",
					isError: true,
				};
			try {
				return await server.call({
					liveId: this.info.liveId,
					name: String(frame.toolName),
					args: frame.arguments,
					signal: abort.signal,
				});
			} catch (e) {
				return { text: e instanceof Error ? e.message : String(e), isError: true };
			}
		};
		void answer().then((result) => {
			// Cancelled by omp or ended with the process: nothing waits for the answer.
			if (!this.serving.delete(id) || abort.signal.aborted) return;
			this.client.send({
				type: "host_tool_result",
				id,
				result: { content: [{ type: "text", text: result.text }] },
				...(result.isError === true ? { isError: true } : {}),
			});
		});
	}

	/** omp forwards every token of a subagent as a frame: those are merged before they reach the tabs. */
	private readonly subagentFrames = new SubagentCoalescer((frame) =>
		this.broadcast({ t: "frame", liveId: this.info.liveId, frame, rev: this.info.revision }),
	);

	/**
	 * Bring a tab that attached after things were sent up to date (a reload, a second tab, a reconnect): re-send the
	 * dialogs omp is still waiting on (ask, confirm, select, input, editor, a host tool call), the message omp is
	 * writing and what omp said once that still holds (a compaction, status lines and widgets of extensions, the
	 * `!commands` that run: see `HeldState`), then say that this is all there is, so that the tab drops what it still
	 * holds beyond it (a dialog settled while it was away). Call right after the attach reply: the tab must hear nothing
	 * in between.
	 */
	resync(sub: Subscriber): void {
		const liveId = this.info.liveId;
		for (const frame of this.pendingUI.values()) sub.send({ t: "frame", liveId, frame });
		for (const frame of this.writing.replay()) sub.send({ t: "frame", liveId, frame });
		for (const frame of this.held.replay()) sub.send({ t: "frame", liveId, frame });
		sub.send({
			t: "attached",
			liveId,
			dialogs: [...this.pendingUI.keys()],
			message: this.writing.messageId,
			held: this.held.hold(),
		});
	}

	/** Answer a dialog and tell every other tab it is settled. */
	respondUI(response: Record<string, unknown>): void {
		const id = String(response.id);
		this.untouched = false;
		const call = this.pendingUI.get(id);
		if (call?.type === "host_tool_call") {
			// The user's decision on a tool call the web UI serves goes back as that call's result.
			const { result, isError } = response;
			this.client.send({ type: "host_tool_result", id, result, ...(isError === true ? { isError } : {}) });
		} else if ("result" in response) {
			// A result for a call omp has already cancelled (the turn was stopped): nothing is waiting for it.
			return;
		} else {
			this.client.send({ ...response, type: "extension_ui_response" });
		}
		if (!this.pendingUI.delete(id)) return;
		this.broadcast({
			t: "frame",
			liveId: this.info.liveId,
			frame: { type: "extension_ui_request", method: "cancel", id: `answered-${id}`, targetId: id },
		});
		this.noteWork();
	}

	/**
	 * Change what this process asks approval for. The overlay is rewritten and omp reloads it by itself; this
	 * resolves once omp has had time to, so the mode every tab shows is the one in force. `remember`: the mode is
	 * the user's pick for this conversation, to be kept for when it is resumed (not merely what an unused spare
	 * process is put in).
	 */
	async setApprovalMode(mode: ApprovalMode, remember = true): Promise<void> {
		if (!this.overlay) throw new Error("This process does not take permission modes");
		if (this.info.exited || this.client.closing) throw new Error("This conversation is not running");
		if (this.overlay.mode === mode) return;
		const reloaded = this.overlay.set(mode);
		// The user's choice is kept now, whatever becomes of the process while omp reloads: the conversation resumes in it.
		if (remember) this.pool.rememberApproval(this, mode);
		await reloaded;
		// What the file says now: another change may have come in while this one waited.
		this.info.approvalMode = this.overlay.mode ?? undefined;
		delete this.info.approvalOmp;
		this.pool.announce(this);
	}

	/**
	 * A page sent this conversation a message that drives it (a prompt, a steer, a follow-up): from now on its turn is that
	 * page's, a remote page's or one on this computer's, and the gate is armed or not by it (see `syncRisk`). Called before
	 * the message is handed to omp, so that not one call of the turn it starts runs unarmed.
	 */
	noteOrigin(remote: boolean): boolean {
		this.origin = remote ? "remote" : "local";
		return this.syncRisk();
	}

	/**
	 * Tell this process's gate whether to ask: armed while "Confirm risky commands from remote pages" is on and the turn is
	 * not a page on this computer's. A conversation nobody has sent anything to since the server took it over (its turn may
	 * be a remote page's, from before) is armed too: a safety net that lets a call through when it does not know is none.
	 * The file changes at once and omp reads it before each tool call, so there is nothing to wait for (as there is for
	 * the settings overlay, which omp reloads after a debounce). The same word carries what "Guard dangerous commands"
	 * says now (see `guardWord`).
	 */
	syncRisk(confirm: boolean = this.pool.gate?.confirm() === true): boolean {
		if (!this.risk) return true;
		try {
			this.risk.set(
				confirm && this.origin !== "local",
				this.guardWord(),
				this.pool.gate?.ports?.(),
				this.pool.gate?.hosts?.(),
			);
			return true;
		} catch (e) {
			console.warn(`omp-webui: could not tell the gate of ${this.info.liveId} what to do: ${(e as Error).message}`);
			// The turn of a remote page is not started with a word the gate may not have: the caller refuses it.
			return false;
		}
	}

	/**
	 * What "Guard dangerous commands" does for this conversation now: the global settings with the conversation's own choices
	 * over them (see `GuardOverride`). It is worked out each time, so that a change of the global settings reaches the
	 * conversations that follow them at once. Absent where the app has no guard.
	 */
	effectiveGuard(): LiveGuard | undefined {
		const hooks = this.pool.gate?.guard;
		return hooks ? resolveGuard(hooks.config(), this.guardOverride, this.guardDamaged) : undefined;
	}

	/** `LiveInfo.guard` follows `effectiveGuard`; true when it changed, and the pages have to be told. */
	syncGuardInfo(): boolean {
		const now = this.effectiveGuard();
		if (JSON.stringify(this.info.guard) === JSON.stringify(now)) return false;
		if (now) this.info.guard = now;
		else delete this.info.guard;
		return true;
	}

	/**
	 * The conversation's own choices of the guard are `next` now (null: it follows the global settings again). The gate is told
	 * at once, so that the next call of the main agent and of each of its subagents (one process, one word) is judged by it,
	 * and the choice is kept with the conversation for when it is opened again (`LivePool.rememberGuard`). Throws, and
	 * changes nothing, when the gate cannot be told: a choice that did not reach the gate must not be shown as made.
	 */
	setGuard(next: GuardOverride | null): void {
		if (this.info.exited || this.client.closing) throw new Error("This conversation is not running");
		const before = { own: this.guardOverride, damaged: this.guardDamaged };
		this.guardOverride = next;
		// A choice made now replaces whatever was damaged.
		this.guardDamaged = false;
		if (!this.syncRisk()) {
			this.guardOverride = before.own;
			this.guardDamaged = before.damaged;
			this.syncRisk();
			throw new Error("The guard could not be told to this conversation's omp, so nothing was changed.");
		}
		this.pool.rememberGuard(this, next);
		this.syncGuardInfo();
		this.pool.announce(this);
	}

	/**
	 * `setGuard` with the change a page asked for on what the conversation chose before. Returns what it is under now. A
	 * conversation whose kept record was damaged is under the stricter of the settings and the default: an edit that does not
	 * name the mode or the switch (it is of the reviewer, say) makes what the conversation is under now its own choice of them, for
	 * it would otherwise end the damage and leave them following the settings, which may say Off or not to ask.
	 */
	changeGuard(patch: GuardOverridePatch): LiveGuard | undefined {
		const now = this.effectiveGuard()?.config;
		const edit: GuardOverridePatch = { ...patch };
		if (this.guardDamaged && now) {
			if (!("mode" in edit)) edit.mode = now.mode;
			if (!("askWhenUnavailable" in edit)) edit.askWhenUnavailable = now.askWhenUnavailable;
		}
		this.setGuard(applyGuardOverridePatch(this.guardOverride, edit));
		return this.effectiveGuard();
	}

	/**
	 * The process is bound to the session file `to`. A file that has choices of its own, or whose record is damaged, puts the
	 * process under them. One that has none takes along what this process had when it is the same conversation moved on
	 * (`proven`, below), damage included, which is kept for the new file as damage; after any other move only the fields that
	 * are stricter than what that conversation gets by following the settings go along (`strictOnly`), so that an Off never
	 * reaches a conversation that did not choose it, and one under Ask me is not turned into Reviewer model by the other's.
	 */
	private followGuard(to: string, from: string | null): void {
		const kept = this.pool.keptGuard(to);
		let next: KeptGuard;
		if (kept.own || kept.damaged) {
			next = kept;
		} else {
			const mine: KeptGuard = { own: this.guardOverride, damaged: this.guardDamaged };
			// Proven to be the same conversation moved on: a fork, a branch, a new session or a hand-off the server sent, or the first
			// file of a new chat (no command, and no file before). Any other move (omp's own `/move`, a compaction's hand-off, a
			// switch onto another conversation) is not proven.
			const type = this.moving;
			const proven = type !== null ? CARRIES_GUARD[type] === true : from === null;
			const global = this.pool.gate?.guard?.config();
			next = proven || !global ? mine : strictOnly(global, mine);
			if (next.own || next.damaged) this.pool.rememberKept(this, next);
		}
		if (JSON.stringify(next.own) === JSON.stringify(this.guardOverride) && next.damaged === this.guardDamaged) return;
		this.guardOverride = next.own;
		this.guardDamaged = next.damaged;
		this.syncRisk();
		this.syncGuardInfo();
	}

	/** The record of a kept conversation is the server's: it is written again when the file does not say what was last written. */
	reassertRecord(): void {
		if (!this.keeping || this.recorded === "") return;
		if (this.pool.parked.says(this.info.liveId, this.recorded)) return;
		this.recorded = "";
		this.persist();
	}

	/** What the conversation chose of the guard itself (null: it follows the global settings). */
	get guardChoice(): GuardOverride | null {
		return this.guardOverride ? { ...this.guardOverride } : null;
	}

	/** What this conversation was given of the model guidance (null: none), as it was given. */
	get guidanceChoice(): KeptGuidance | null {
		return this.guidanceKept;
	}

	/**
	 * What "Guard dangerous commands" tells this process's gate (`GuardWord`): what the guard does for this conversation
	 * (`effectiveGuard`), whether somebody will see a question to the person (a page is open on the conversation, or the
	 * macOS app runs in the background and will tell them: `GuardHooks.reachable`), where decisions are written down, and
	 * the app's own files, which no reviewer is asked about. Absent where the app has no guard. While the conversation is
	 * unattended a reviewer's denial is final, as it was before #747: putting it to the person would hold the turn until they
	 * come back, and unattended mode answers no dialog of the guard's (#752).
	 */
	private guardWord(): GuardWord | undefined {
		const hooks = this.pool.gate?.guard;
		const config = this.effectiveGuard()?.config;
		if (!hooks || !config || !this.risk) return undefined;
		// What the person tuned goes to every gate whatever the conversation chose of the mode: a conversation's own choice is the mode,
		// the reviewer and the switch, never the rules or a category's setting.
		const rules = hooks.rules?.() ?? {};
		return {
			mode: config.mode,
			reviewers: reviewerSelectors(config.reviewer),
			askWhenUnavailable: config.askWhenUnavailable,
			askWhenDenied: config.askWhenDenied && !(this.pool.unattended && this.unattendedOn),
			page: this.subscribers.size > 0 || hooks.reachable?.() === true,
			log: hooks.log,
			own: [...hooks.own, dirname(this.risk.file)],
			...(rules.thresholds && Object.keys(rules.thresholds).length > 0 ? { thresholds: rules.thresholds } : {}),
			...(rules.policy ? { policy: rules.policy.text } : {}),
		};
	}

	/**
	 * Whether this process runs the gate: its command line names it (a server that had it started the process) and the
	 * gate said it started (omp carries on without an extension it cannot read or run, so the command line alone says
	 * nothing of that) and the server can say when to ask.
	 */
	get gated(): boolean {
		const gate = this.pool.gate;
		if (!gate || !this.risk) return false;
		const { args } = this.info;
		return args.some((a, i) => a === "--extension" && args[i + 1] === gate.extension) && this.risk.loaded;
	}

	/**
	 * Why this process runs without the gate, when it does (see `LiveInfo.ungated`): `inherited` when this server took it
	 * over (its omp was started by an older version, or by a server that is gone, and cannot be given the gate until it is
	 * opened again), `chosen` when this server started it without (the user's own `--trusted-extension`, files that could
	 * not be written, an extension omp could not run). Undefined: it is covered, or the server has no gate to give.
	 */
	get ungated(): "inherited" | "chosen" | undefined {
		if (!this.pool.gate || this.gated) return undefined;
		return this.inherited ? "inherited" : "chosen";
	}

	/** `LiveInfo.ungated` follows `ungated`; true when it changed, and the pages have to be told. */
	syncUngated(): boolean {
		const now = this.ungated;
		if (this.info.ungated === now) return false;
		if (now) this.info.ungated = now;
		else delete this.info.ungated;
		return true;
	}

	/** Whether this process was started with the model-guidance extension: its command line names it (a server that had it started the process). */
	private get guidanceNamed(): boolean {
		const guidance = this.pool.guidance;
		if (!guidance) return false;
		const { args } = this.info;
		return args.some((a, i) => a === "--extension" && args[i + 1] === guidance.extension);
	}

	/**
	 * Whether this process runs the model-guidance extension (`server/omp/guidance/extension.ts`): its command line names it
	 * and the extension said it started (its note, `<guidance file>.loaded`: omp carries on without an extension it cannot
	 * load, so the command line alone says nothing of that). What the file holds is then read by the handler at each turn.
	 */
	get guided(): boolean {
		if (!this.guidanceNamed || !this.guidanceFile) return false;
		if (!this.guidanceLoaded) this.guidanceLoaded = existsSync(`${this.guidanceFile}${GUIDANCE_LOADED_SUFFIX}`);
		return this.guidanceLoaded;
	}

	/**
	 * A process that is given guidance is not announced as not carrying it for the moment before its extension has said it
	 * started: omp may answer the server before it has loaded its extensions. Waits (for a bounded time, and only for a
	 * process that is carrying guidance) for the note; one that never comes is announced as it is, as "not carried".
	 */
	async untilGuidanceSaid(ms = 5_000): Promise<void> {
		if (!this.guidanceKept) return;
		const deadline = Date.now() + ms;
		while (this.guidanceNamed && !this.guided && !this.info.exited && Date.now() < deadline) await Bun.sleep(20);
		this.syncGuidance();
	}

	/**
	 * Why this process does not carry the guidance it was given, when it does not: `trustedExtension` (the person's own
	 * `--trusted-extension`, which omp refuses together with `--extension`), `inherited` (this server took the process over
	 * and it was not started with the extension), `unavailable` (the extension's files could not be put in place). Undefined
	 * when it carries it, or when it was given none.
	 */
	private guidanceSkipped(): LiveGuidance["skipped"] {
		if (this.guided) return undefined;
		const args = this.ownArgs.length > 0 ? this.ownArgs : this.info.args;
		if (args.some((a) => a === "--trusted-extension" || a.startsWith("--trusted-extension=")))
			return "trustedExtension";
		return this.inherited ? "inherited" : "unavailable";
	}

	/** What this conversation carries of the guidance now, as the pages are told it (`LiveInfo.guidance`). */
	guidanceNow(): LiveGuidance | undefined {
		const guidance = this.pool.guidance;
		const kept = this.guidanceKept;
		if (!guidance || !kept || !guidanceText(kept.text)) return undefined;
		const found = kept.template ? guidance.templates().find((t) => t.id === kept.template) : undefined;
		return {
			template: found ? found.id : null,
			templateName: found ? found.name : null,
			// A template edited since shows the text it stands for now: what this process carries is its own copy (`kept`),
			// which the server rewrites at each change of the template.
			text: kept.text,
			live: this.guided,
			...(this.guidanceSkipped() ? { skipped: this.guidanceSkipped() } : {}),
		};
	}

	/** `LiveInfo.guidance` follows what the conversation carries; true when it changed, and the pages have to be told. */
	syncGuidance(): boolean {
		const now = this.guidanceNow();
		if (JSON.stringify(this.info.guidance) === JSON.stringify(now)) return false;
		if (now) this.info.guidance = now;
		else delete this.info.guidance;
		return true;
	}

	/**
	 * The conversation carries `next` from now on (null: none). The file its omp reads is rewritten, so the change reaches
	 * the next turn without a restart, and the choice is kept with the conversation for when it is opened again
	 * (`LivePool.rememberGuidance`). A process that does not read the file (it has no extension) keeps the new choice for
	 * its next opening, and its pages say so (`LiveGuidance.live`): nothing is thrown, for the person changed a setting of
	 * the conversation and not of the process.
	 */
	setGuidance(next: KeptGuidance | null): LiveGuidance | undefined {
		if (this.info.exited || this.client.closing) throw new Error("This conversation is not running");
		this.guidanceKept = next;
		if (this.guidanceNamed && this.guidanceFile) {
			try {
				this.pool.guidance?.write(this.guidanceFile, next?.text ?? null);
			} catch (e) {
				console.error(`omp-webui: could not write the guidance of ${this.info.liveId}: ${(e as Error).message}`);
			}
		}
		this.pool.rememberGuidance(this, next);
		this.syncGuidance();
		this.pool.announce(this);
		return this.info.guidance;
	}

	/** Whether unattended mode (#646) is on for this conversation. */
	get unattendedChoice(): boolean {
		return this.unattendedOn;
	}

	/** Whether this process was started with the unattended extension: its command line names it. */
	private get unattendedNamed(): boolean {
		const unattended = this.pool.unattended;
		if (!unattended) return false;
		const { args } = this.info;
		return args.some((a, i) => a === "--extension" && args[i + 1] === unattended.extension);
	}

	/**
	 * Whether this process runs the unattended extension (`server/omp/unattended/extension.ts`): its command line names it and
	 * the extension said it started (its note, `<instruction file>.loaded`: omp carries on without an extension it cannot
	 * load, so the command line alone says nothing of that). What the file holds is then read by the handler at each turn.
	 */
	get unattendedCarried(): boolean {
		if (!this.unattendedNamed || !this.unattendedFile) return false;
		if (!this.unattendedLoaded) this.unattendedLoaded = existsSync(`${this.unattendedFile}${UNATTENDED_LOADED_SUFFIX}`);
		return this.unattendedLoaded;
	}

	/**
	 * A process that is unattended is not announced as not carrying the instruction for the moment before its extension has
	 * said it started: omp may answer the server before it has loaded its extensions. Waits (for a bounded time, and only for a
	 * conversation that is unattended) for the note; one that never comes is announced as it is, as "not carried".
	 */
	async untilUnattendedSaid(ms = 5_000): Promise<void> {
		if (!this.unattendedOn) return;
		const deadline = Date.now() + ms;
		while (this.unattendedNamed && !this.unattendedCarried && !this.info.exited && Date.now() < deadline)
			await Bun.sleep(20);
		this.syncUnattended();
	}

	/**
	 * Why this process does not carry the instruction and the question tool, when the mode is on and it does not:
	 * `trustedExtension` (the person's own `--trusted-extension`, which omp refuses together with `--extension`), `inherited`
	 * (this server took the process over and it was not started with the extension), `unavailable` (the extension's files could
	 * not be put in place). Its `ask` dialogs are filed all the same: that is the server's own.
	 */
	private unattendedSkipped(): LiveUnattended["skipped"] {
		if (this.unattendedCarried) return undefined;
		const args = this.ownArgs.length > 0 ? this.ownArgs : this.info.args;
		if (args.some((a) => a === "--trusted-extension" || a.startsWith("--trusted-extension=")))
			return "trustedExtension";
		return this.inherited ? "inherited" : "unavailable";
	}

	/** What a page is told of this conversation's unattended mode (`LiveInfo.unattended`; undefined: off). */
	unattendedNow(): LiveUnattended | undefined {
		if (!this.pool.unattended || !this.unattendedOn) return undefined;
		const skipped = this.unattendedSkipped();
		return { live: this.unattendedCarried, ...(skipped ? { skipped } : {}) };
	}

	/** `LiveInfo.unattended` follows the mode; true when it changed, and the pages have to be told. */
	syncUnattended(): boolean {
		const now = this.unattendedNow();
		if (JSON.stringify(this.info.unattended) === JSON.stringify(now)) return false;
		if (now) this.info.unattended = now;
		else delete this.info.unattended;
		return true;
	}

	/**
	 * The instruction file as the mode and the instruction say it now: the text while the mode is on (with the questions
	 * the conversation filed that still wait, #694, but `answering`, whose answer is on its way), no file when it is off. A
	 * process that was not started with the extension does not read it, so none is written for it.
	 */
	writeUnattended(answering?: string): void {
		const unattended = this.pool.unattended;
		if (!unattended || !this.unattendedFile || !this.unattendedNamed || this.info.exited) return;
		try {
			unattended.write(
				this.unattendedFile,
				this.unattendedOn ? unattended.textFor(this.info.sessionFile ?? null, answering) : null,
			);
		} catch (e) {
			console.error(
				`omp-webui: could not write the unattended instruction of ${this.info.liveId}: ${(e as Error).message}`,
			);
		}
	}

	/**
	 * Turn unattended mode on or off for this conversation. The instruction file is written (or taken away), so the change
	 * reaches the next turn without a restart; the choice is kept with the conversation for when it is opened again. The
	 * questions already filed stay in the list whichever way it goes.
	 */
	setUnattended(on: boolean): LiveUnattended | undefined {
		if (this.info.exited || this.client.closing) throw new Error("This conversation is not running");
		this.unattendedOn = on;
		this.writeUnattended();
		this.pool.rememberUnattended(this, on);
		this.syncUnattended();
		// Whether a reviewer's denial is put to the person follows the mode (see `guardWord`).
		this.syncRisk();
		this.pool.announce(this);
		return this.info.unattended;
	}

	/**
	 * Why this process cannot be held at the quota floor (#652): started with extensions of the person's own (omp refuses
	 * `--extension` beside `--trusted-extension`), or the server's extension did not say it started (omp carries on without an
	 * extension it could not load, so the command line alone says nothing of that). Null: it can.
	 */
	private quotaCannotHold(): QuotaHoldReason | null {
		const quota = this.pool.quotaFloor;
		if (!quota || !this.quotaFile) return "notLoaded";
		const args = this.ownArgs.length > 0 ? this.ownArgs : this.info.args;
		if (args.some((a) => a === "--trusted-extension" || a.startsWith("--trusted-extension=")))
			return "trustedExtension";
		const { args: all } = this.info;
		if (!all.some((a, i) => a === "--extension" && all[i + 1] === quota.extension)) return "notLoaded";
		if (!this.quotaLoaded) this.quotaLoaded = existsSync(`${this.quotaFile}${QUOTA_LOADED_SUFFIX}`);
		return this.quotaLoaded ? null : "notLoaded";
	}

	/** `LiveInfo.quotaHold` follows the tracker; true when it changed, and the pages have to be told. */
	private syncQuota(): boolean {
		const now = this.quota?.info();
		if (JSON.stringify(this.info.quotaHold) === JSON.stringify(now)) return false;
		if (now) this.info.quotaHold = now;
		else delete this.info.quotaHold;
		return true;
	}

	/**
	 * What the tracker changed is told to the pages, and kept: a conversation that is held at the quota floor outlives the server
	 * as a paused one does (`kept`), and what a next server needs to know of it goes into its record.
	 */
	private quotaChanged(): void {
		const changed = this.syncQuota();
		if (this.kept && !this.keeping) {
			void this.identified()
				.then(() => this.persist())
				.catch((e) =>
					console.error(
						`omp-webui: could not keep ${this.info.liveId} through its quota hold: ${(e as Error).message}`,
					),
				);
		}
		this.persist();
		if (changed) this.pool.announce(this);
	}

	/** "Continue anyway" past the provider's quota floor (`on`), or hold again. */
	setQuotaOverride(on: boolean): void {
		if (this.info.exited || this.client.closing) throw new Error("This conversation is not running");
		this.quota?.setOverride(on);
	}

	/** A floor was set, changed or taken away: a conversation that works looks at its provider again. */
	quotaFloorChanged(): void {
		this.quota?.refresh();
	}

	/** Where a question this conversation files is from: its session file (the list's key), its folder and its name. */
	private questionSource(): { session: string; cwd: string; title: string } {
		const name = this.lastState?.sessionName;
		return { session: this.info.sessionFile ?? "", cwd: this.info.cwd, title: typeof name === "string" ? name : "" };
	}

	/**
	 * File `drafts` as the conversation's questions; `call` names what asked, so that the same call is filed once.
	 *
	 * A question the list could not keep is said in the conversation (#650): the model's result is never touched (it must not
	 * wait or try again — the person reads the notice later). It is the process's own state (`LiveInfo.questionDropped`), which
	 * the transcript shows as a row and the page as a toast; a question that *is* kept clears it, and so does the mode's switch
	 * and the process ending.
	 */
	private fileQuestions(source: "tool" | "ask", drafts: readonly QuestionDraft[], call: string): void {
		const unattended = this.pool.unattended;
		if (!unattended) return;
		const from = this.questionSource();
		for (const [i, draft] of drafts.entries()) {
			let filed: FileResult;
			try {
				filed = unattended.questions.file(from, source, draft, drafts.length > 1 ? `${call}:${i}` : call);
			} catch (e) {
				console.error(`omp-webui: could not file a question of ${this.info.liveId}: ${(e as Error).message}`);
				this.noteQuestionDropped("unwritable", draft.question);
				continue;
			}
			// The list took it: the notice of an earlier failure is old news now.
			if (filed.ok) {
				this.clearQuestionDropped();
				continue;
			}
			if (filed.why === "duplicate") continue;
			if (filed.why === "full")
				console.warn(`omp-webui: ${this.info.liveId} has too many open questions; one was not filed`);
			// The same question failing the same way is in the list already, and the conversation says it once.
			if (filed.drop) this.noteQuestionDropped(filed.why, filed.drop.question);
		}
	}

	/** What the conversation said of a question it could not keep is done with (#650): nothing is announced when there was none. */
	private clearQuestionDropped(): void {
		if (!this.info.questionDropped) return;
		delete this.info.questionDropped;
		this.pool.announce(this);
	}

	/**
	 * Say in this conversation that a question could not be kept (#650), so a page that is open there shows it and the person
	 * finds it whether they look now or after the work ends. `why` is the store's reason; `question` is what was asked (empty
	 * when it had no text). It is the process's own state (`LiveInfo.questionDropped`), so a page that attaches later, or that
	 * was not listening while it happened, shows it too — and a page needs no code of its own to fold a frame of the server's:
	 * the info every page is told of a process carries it (`withInfo`).
	 */
	private noteQuestionDropped(why: QuestionDropWhy, question: string): void {
		this.info.questionDropped = { why, question: question.slice(0, QUESTION_LIMITS.title), at: Date.now() };
		this.pool.announce(this);
	}

	/**
	 * While the conversation is unattended, omp's own `ask` dialog (what the model uses when it wants a choice; a subagent's
	 * as much as the main agent's) is answered here at once with the fixed reply (`recordedAskAnswers`), and filed as a
	 * question for the person: the turn never waits for it, and no page is shown a dialog nobody is there to answer. True
	 * when it was answered.
	 *
	 * Only `ask`. Every other dialog (`select`, `confirm`, `input`, `editor`) is left as it is: omp's approvals of tools and
	 * what "Guard dangerous commands" asks the person are consent, not questions, and are never answered for them — a
	 * guard that has nobody to ask refuses on its own, as it does without this mode.
	 */
	private recordAsk(frame: OmpFrame): boolean {
		if (!this.pool.unattended || !this.unattendedOn) return false;
		const { questions } = frame;
		const answers = recordedAskAnswers(questions);
		// A call whose questions cannot all be answered by id is left to the page: omp would fail it on an answer that does not match.
		if (!Array.isArray(questions) || answers.length === 0 || answers.length !== questions.length) return false;
		this.client.send({ type: "extension_ui_response", id: String(frame.id), answers });
		const drafts = draftsOfAsk(questions);
		// A question the dialog showed no text for is not filed either: it is said as one empty question (#650).
		if (drafts.length < questions.length) drafts.push(EMPTY_DRAFT);
		this.fileQuestions("ask", drafts, String(frame.id));
		return true;
	}

	/**
	 * The agent called `file_question` (the tool the unattended extension gives it): the call's arguments are filed as a
	 * question. The tool itself returned at once (`extension.ts`); only a process that runs the extension has it, so a tool
	 * of that name from anywhere else is not this one.
	 */
	private noteToolCall(frame: OmpFrame): void {
		if (frame.toolName !== UNATTENDED_TOOL || !this.unattendedCarried) return;
		// The instruction asks for a title; a call without one has no question to show, and the person is told so (#650).
		const draft = draftOfToolArgs(frame.args) ?? EMPTY_DRAFT;
		this.fileQuestions("tool", [draft], String(frame.toolCallId ?? ""));
	}

	/**
	 * Tell this process whether to wait out a provider's usage limit (`retry.waitForUsageReset`; null: omp's own
	 * setting). Like the approval mode it is a rewrite of the process's overlay, which omp reloads by itself; it is
	 * read at each retry, so a wait already under way is not changed (the page's Cancel ends it).
	 */
	async setUsageWait(on: boolean | null): Promise<void> {
		if (!this.overlay) throw new Error("This process does not take settings");
		if (this.info.exited || this.client.closing) throw new Error("This conversation is not running");
		if (this.overlay.wait === on) return;
		await this.overlay.setWait(on);
		this.info.usageResetWait = this.overlay.wait ?? undefined;
		this.pool.announce(this);
	}

	/**
	 * Where this conversation compacts becomes `at` (null: omp's own configuration again). It is the process's overlay that
	 * says it, which omp reloads by itself and reads at each check, so it applies from the next turn; nothing is restarted.
	 * The conversation keeps it for when it is opened again (`ApprovalStore.rememberCompact`, by the caller).
	 */
	async setCompact(at: CompactAt | null): Promise<void> {
		if (!this.overlay) throw new Error("This process does not take settings");
		if (this.info.exited || this.client.closing) throw new Error("This conversation is not running");
		await this.overlay.setCompact(at);
		if (at) this.info.compactAt = at;
		else delete this.info.compactAt;
		this.pool.announce(this);
		this.persist();
	}

	/**
	 * omp took `set_auto_retry` or `set_cache_warming`, which it never reports back (see `UNREPORTED`): from now on the
	 * value is this process's own, over every file it reads, and the server keeps it for the pages (`LiveInfo.sessionSettings`).
	 * `answer` is omp's: for cache warming it is the mode the process runs in, which is what is kept.
	 */
	private noteSessionSetting(command: Record<string, unknown>, answer: unknown): void {
		let setting: Unreported;
		let choice: unknown;
		if (command.type === "set_auto_retry") {
			setting = "autoRetry";
			choice = typeof command.enabled === "boolean" ? (command.enabled ? "on" : "off") : undefined;
		} else if (command.type === "set_cache_warming") {
			setting = "cacheWarming";
			choice = isRecord(answer) ? answer.mode : command.mode;
		} else return;
		if (!isChoice(setting, choice) || this.info.sessionSettings?.[setting] === choice) return;
		this.info.sessionSettings = { ...this.info.sessionSettings, [setting]: choice };
		this.pool.announce(this);
	}

	/**
	 * omp took a command that changes a setting and says nothing of it (its RPC sends a frame for `set_model` and for
	 * nothing else here), so the pages that did not send it would show the old value until they happened to read the state:
	 * the server, which sees every command, tells them what changed (#593). The thinking level is what a
	 * `thinking_level_changed` frame carries; the rest is the state's own fields, which a page folds into what it holds
	 * (a paused omp cannot be asked) and reads again.
	 */
	private noteSettingChange(command: Record<string, unknown>, answer: unknown): void {
		const frame = settingFrame(command, answer);
		if (!frame) return;
		// What a page folds into what it holds is what the server keeps of omp's state too (omp's own answer replaces it,
		// as `askState` does at the pause).
		if (frame.type === "settings_changed" && this.lastState && isRecord(frame.settings))
			this.lastState = { ...this.lastState, ...frame.settings };
		this.broadcast({ t: "frame", liveId: this.info.liveId, frame });
	}

	/**
	 * The last `get_state` omp answered, by whoever asked, kept true to what the server saw changed since (`noteSettingChange`):
	 * what is known of a process that is frozen. A process taken over from a record has the panel's part of it (`PanelState`).
	 */
	private lastState: Record<string, unknown> | null = null;

	/**
	 * What omp says its state is. A paused conversation is run for it only when `user` asks (the page's own click, as
	 * every action is); otherwise, and when omp does not answer, the last state it gave, or null.
	 */
	async lookState(user: boolean): Promise<Record<string, unknown> | null> {
		if (this.info.exited || this.client.closing) return null;
		const r = await this.rpc({ type: "get_state" }, { user }).catch(() => null);
		return r?.success && isRecord(r.data) ? r.data : this.lastState;
	}

	/**
	 * Automatic titles (see `AutoTitle`): omp turns them off in RPC mode, so the server asks for one after the first
	 * exchange, if Settings has them on (`LivePool.autoTitle`).
	 */
	private readonly titles = new AutoTitle(
		{
			state: () => this.lookState(false),
			rename: () => this.askTitle(),
			gone: () => this.info.exited || this.client.closing,
		},
		() => this.pool.autoTitle?.() === true,
	);

	/**
	 * `/rename` with no title makes omp generate one with its title models, and takes what omp printed of it. An omp that does
	 * not list the command prints nothing (and is not asked again for this session); one that did not answer throws.
	 */
	private async askTitle(): Promise<string | null> {
		// A line omp does not know goes to the model as a message: only a command it lists is run.
		const catalog = await this.rpc({ type: "get_available_commands" });
		if (!catalog.success) throw new Error(catalog.error ?? "omp did not list its commands");
		if (!hasCommand(isRecord(catalog.data) ? catalog.data.commands : undefined, "rename")) return "";
		return this.command("/rename", {}, TITLE_OUTPUT_MS);
	}

	/**
	 * Keep these omp settings (key → value) as they are for this process, whatever the global config is changed to
	 * (see `ProcessOverlay.pin`). A process that has ended, or has no overlay, follows the config as before.
	 */
	async pinSettings(values: Readonly<Record<string, ConfigValue>>): Promise<void> {
		if (!this.overlay || this.info.exited || this.client.closing) return;
		await this.overlay.pin(values);
		// A paused conversation's record carries the overlay, which a server that adopts it again writes anew.
		this.persist();
	}

	/** Preset switches of this conversation, one at a time: each is a rewrite of the overlay and a change of model. */
	private presetQueue: Promise<unknown> = Promise.resolve();

	/**
	 * Switch this conversation to the preset `name`, and only this conversation. omp's own `/modelpreset switch` writes
	 * the preset's roles to the global config.yml, which every running omp reloads, so it changes the model every
	 * other conversation's subagents are given. Here the roles go into this process's own overlay (omp reloads that
	 * by itself, and its subagents resolve their models from it), and the model it runs on moves with the
	 * session-only `set_model` the model picker uses. The preset is remembered for the conversation, so it holds when the
	 * conversation is resumed. A switch that fails leaves the overlay as it was.
	 */
	setModelPreset(name: string, options: RpcOptions = {}): Promise<void> {
		const run = this.presetQueue.then(() => this.runModelPreset(name, options));
		this.presetQueue = run.catch(() => {});
		return run;
	}

	private async runModelPreset(name: string, options: RpcOptions): Promise<void> {
		const overlay = this.overlay;
		if (!overlay || runsLocal(this.info)) throw new Error("This process does not take presets");
		if (this.info.exited || this.client.closing) throw new Error("This conversation is not running");
		this.untouched = false;
		// What the conversation runs on now (`overlay.models`) keeps the subagent models of a preset that sets none.
		const { models, absent, fallbackLevel } = await conversationPreset(this.cfg, this.info.cwd, name, overlay.models);
		const before = { models: overlay.models, absent: overlay.absent, absentAgents: overlay.absentAgents };
		await overlay.setModels(models, absent.roles, absent.agents);
		try {
			await this.runOn(models, fallbackLevel, options);
		} catch (e) {
			await overlay.setModels(before.models, before.absent, before.absentAgents);
			throw e;
		}
		this.info.models = models;
		this.pool.rememberModels(this, models);
		this.pool.announce(this);
	}

	/**
	 * The configuration's model settings changed (a role or a subagent's model was added or removed in the global config or
	 * the folder's project): one the preset does not set must not reach this conversation, so the overlay's `null`s (for
	 * roles and for agents) are worked out again from the configuration as it is now. Serialized with preset switches; a
	 * paused conversation's overlay is rewritten too, which omp reads when it runs, and its record follows.
	 */
	refreshModelRoles(): Promise<void> {
		const run = this.presetQueue.then(() => this.runRefreshModelRoles());
		this.presetQueue = run.catch(() => {});
		return run;
	}

	private async runRefreshModelRoles(): Promise<void> {
		const overlay = this.overlay;
		const models = overlay?.models;
		if (!overlay || !models || this.info.exited || this.client.closing) return;
		const absent = await absentModels(this.cfg, this.info.cwd, models);
		const unchanged = [
			[absent.roles, overlay.absent],
			[absent.agents, overlay.absentAgents],
		].every(([now, held]) => now.length === held.length && now.every((x) => held.includes(x)));
		if (unchanged) return;
		await overlay.setModels(models, absent.roles, absent.agents);
		this.persist();
	}

	/**
	 * Move the conversation's own model and thinking level to what `models` give its default role, as omp's preset switch
	 * does: the level of the default role's selector, else the preset's, else the configured default. A selector that
	 * names one model is set with `set_model`; an alias, a list or a missing default is resolved by omp itself (`/model
	 * @default`, which sets the model for this session and writes nothing to the config), from the overlay it reloaded.
	 */
	private async runOn(models: ConversationModels, fallbackLevel: string, options: RpcOptions): Promise<void> {
		const selector = models.roles.default ? parseSelector(models.roles.default) : null;
		let level: string | undefined = models.defaultThinkingLevel ?? fallbackLevel;
		if (selector) {
			const set = await this.rpc({ type: "set_model", provider: selector.provider, modelId: selector.id }, options);
			if (!set.success) throw new Error(set.error ?? `omp could not switch to ${selector.provider}/${selector.id}`);
			level = selector.level ?? level;
		} else {
			// omp hands a line it does not know to the model as a prompt: only a command it lists is run.
			const catalog = await this.rpc({ type: "get_available_commands" }, options);
			if (!catalog.success || !hasCommand(isRecord(catalog.data) ? catalog.data.commands : undefined, "model")) {
				throw new Error(
					"This omp has no /model command, so a preset whose default model is an alias cannot be applied",
				);
			}
			const printed = await this.command("/model @default", options);
			if (printed === null || !printed.startsWith("Model set to")) {
				throw new Error(printed || "omp could not switch to the preset's default model");
			}
			// A level the default role's own selector carries is applied by omp; the preset's level goes on the rest.
			level =
				models.roles.default && /:(off|minimal|low|medium|high|xhigh|max|auto)$/.test(models.roles.default)
					? undefined
					: models.defaultThinkingLevel;
		}
		if (!level) return;
		const set = await this.rpc({ type: "set_thinking_level", level }, options);
		if (!set.success) throw new Error(set.error ?? `omp could not set the thinking level ${level}`);
	}

	private async typedPresetSwitch(name: string, options: RpcOptions): Promise<RpcResponse> {
		let text: string;
		try {
			await this.setModelPreset(name, options);
			text = `Switched to preset "${name}" for this conversation only; the global config is unchanged.`;
		} catch (e) {
			text = (e as Error).message;
		}
		this.broadcast({ t: "frame", liveId: this.info.liveId, frame: { type: "command_output", text } });
		return { type: "response", command: "prompt", success: true, data: { agentInvoked: false } };
	}

	broadcast(msg: unknown): void {
		for (const s of this.subscribers) s.send(msg);
	}

	/**
	 * The todo list was replaced from a page (`replaceTodos`, omp's `/todo import`), which omp announces with no frame of the
	 * kind a page folds in: every page that listens reads omp's state again, the one that edited it too (#587).
	 */
	announceTodos(): void {
		this.broadcast({ t: "frame", liveId: this.info.liveId, frame: { type: "todos_changed" } });
	}

	/**
	 * The flags the user chose for this conversation (New chat's options), without the ones the server adds for every
	 * process (its own `--config` overlay, the mode's own flags). A `--config` or `--profile` of the user's own is in
	 * here: the process's settings may come from it, and the server's own overlay is not the user's.
	 */
	readonly ownArgs: readonly string[];

	/**
	 * What this process's own settings overlay (the last `--config` of its command line) holds its settings at, by omp's
	 * key; nothing where none is managed. The server's own record of it, not the file's: the file is a temp file that
	 * can be taken away while the process runs.
	 */
	get overlaySettings(): Readonly<Record<string, ConfigValue>> {
		return this.overlay?.settings ?? {};
	}

	/**
	 * What a short-lived omp that answers a side question for this conversation is started from (see `BtwForks`): its
	 * folder and session file, the command line it was started with, the environment of its mode, and the process's own
	 * settings overlay, which is where it keeps its approval mode and the gate's word. The overlay is for the caller to
	 * copy, never to pass on: the gate writes a note beside the overlay it is started with, which says which process has
	 * the gate, and a second process with the same file would put its own pid there.
	 */
	sideLaunch(): SideLaunch {
		return {
			cwd: this.info.cwd,
			sessionFile: this.info.sessionFile,
			args: this.info.args,
			env: this.env,
			local: runsLocal(this.info),
			overlay: this.info.exited ? null : (this.overlay?.file ?? null),
		};
	}

	/** The model omp runs now, as `provider/id` (what the server last heard of omp's state); null when it is not known. */
	currentModel(): string | null {
		const model = this.lastState?.model;
		return isRecord(model) && typeof model.provider === "string" && typeof model.id === "string"
			? `${model.provider}/${model.id}`
			: null;
	}

	/** The model omp runs now, as its provider and its bare id; null when the server has not heard which (see `currentModel`). */
	private modelParts(): { provider: string; id: string } | null {
		const model = this.lastState?.model;
		return isRecord(model) && typeof model.provider === "string" && typeof model.id === "string"
			? { provider: model.provider, id: model.id }
			: null;
	}

	/**
	 * Send omp a command. A paused conversation cannot answer: a background request (a refresh the page makes by
	 * itself) is refused at once, and never runs omp. A `user` request — the page's answer to a click — runs omp
	 * just long enough to be answered and freezes it again (see `thawed`), so that no action needs a Resume first
	 * and the conversation stays paused. While omp runs for such an action, the requests that come in reply to what
	 * it announces (the page refreshing its state) are answered too; it is not frozen again before those are. Not while
	 * omp waits to retry a failed turn and that wait is over (see `retryDueRefusal`): running omp would start the turn.
	 * `user` is for commands that settle something. One that starts work (a prompt, a `!command`) first resumes the
	 * conversation, which the page asks for explicitly.
	 */
	async rpc(command: Record<string, unknown>, options: RpcOptions = {}): Promise<RpcResponse> {
		const kind = String(command.type);
		// A compact waits for this turn to end: what would be queued behind it, or start a turn before it, is held with it.
		if (this.compactQueue.active) {
			const held = await this.compactQueue.intercept(command, options);
			if (held) {
				options.written?.();
				return held;
			}
		}
		if (!MOVES[kind]) return this.rpcNow(command, options);
		// A command that moves the process to another session file is sent only when the one before has been seen to move it (and
		// the guard of the file it moved to is in force): what follows a move is a move of what that one left, not of what it found.
		const run = this.moves.then(() => this.rpcNow(command, options));
		this.moves = run.then(
			() => {},
			() => {},
		);
		return run;
	}

	/**
	 * The process has just answered `type`, a command that may have moved it: its state is read, and the guard of the file it is
	 * bound to is settled (`followGuard`) before this returns. The rest of what follows a move (the folder) is not waited for.
	 */
	private async settleMove(type: string): Promise<void> {
		this.moving = type;
		const followed = Promise.withResolvers<void>();
		void this.refreshState(followed.resolve).catch(() => {});
		try {
			await followed.promise;
		} finally {
			this.moving = null;
		}
	}

	private async rpcNow(command: Record<string, unknown>, options: RpcOptions = {}): Promise<RpcResponse> {
		if (this.shifts > 0) await this.signalling;
		// Only a look at the process leaves it as a new chat can use it; any other command, even a setting, uses it.
		const type = String(command.type);
		if (!(/^(get_|predict_word)/.test(type) || (type === "goal" && command.op === "get"))) this.untouched = false;
		// omp's own `/modelpreset switch` writes the preset's roles to the global config, for every conversation. Typed
		// into this one it is this conversation's switch (see `setModelPreset`), answered as omp answers a command.
		const typed =
			type === "prompt" && typeof command.message === "string" ? TYPED_PRESET_SWITCH.exec(command.message) : null;
		if (typed) {
			options.written?.();
			return this.typedPresetSwitch(typed[1], options);
		}
		const send = async (): Promise<RpcResponse> => {
			this.lastActivity = Date.now();
			this.inFlight++;
			// A `!command` is the conversation's, whichever page sent it: every page that listens is told it runs, and when it ends
			// (omp answers it when the command exits, or `abort_bash` ends it), so that Stop is on each of them.
			const bash = type === "bash" && typeof command.command === "string" ? this.held.startBash(command.command) : null;
			if (bash) this.broadcast({ t: "frame", liveId: this.info.liveId, frame: bash });
			try {
				// omp's `set_host_tools` replaces its whole set: what the server serves goes along with the page's.
				const sent =
					type === "set_host_tools" && Array.isArray(command.tools)
						? { ...command, tools: this.hostTools(command.tools) }
						: command;
				const r = await this.client.request(sent, 0, options.written);
				if (r.success) {
					if (type === "get_state" && isRecord(r.data)) this.lastState = r.data;
					if (MOVES[type]) {
						await this.settleMove(type);
						this.compactQueue.moved(type);
					} else if (SESSION_CHANGING[type]) void this.refreshState().catch(() => {});
					if (ENDS_RETRY[type]) this.lostWait = this.endLostWait();
					if (type === "set_host_tools") this.pageHostTools = Array.isArray(command.tools) ? command.tools : [];
					this.trackInterview(command);
					this.noteSessionSetting(command, r.data);
					this.noteSettingChange(command, r.data);
					// A model change while paused: the snapshot is refreshed here, before the brief thaw ends, so that it never keeps
					// the old model (the panel's fast-mode row reads the model's provider). Whatever a page asks next only confirms it.
					if (this.info.pausedAt !== null && (type === "set_model" || type === "cycle_model"))
						await this.refreshState().catch(() => {});
					// A paused conversation's record carries the panel's settings: what a user's action changed in it.
					if (this.info.pausedAt !== null) this.persist();
				}
				return r;
			} finally {
				this.inFlight--;
				this.checkModeSwitch();
				this.lastActivity = Date.now();
				const ended = bash ? this.held.endBash(String(bash.id)) : null;
				if (ended) this.broadcast({ t: "frame", liveId: this.info.liveId, frame: ended });
			}
		};
		if (this.info.pausedAt === null) return send();
		if (options.user) {
			const held = this.retryDueRefusal();
			if (held) return { type: "response", command: type, success: false, error: held.message, code: held.code };
			return this.thawed(send);
		}
		// A frozen omp cannot answer; say so at once instead of leaving the caller waiting.
		if (this.thaws === 0)
			return {
				type: "response",
				command: type,
				success: false,
				error: "This conversation is paused; resume it to continue.",
				code: "paused",
			};
		const rider = send();
		const done = () => void this.riders.delete(rider);
		this.riders.add(rider);
		rider.then(done, done);
		return rider;
	}

	/**
	 * Run `act` against omp's own client for something the user asked of this conversation (the sidebar's rename
	 * goes through the process that holds the conversation). A paused conversation is let run for that, and frozen
	 * again after (see `thawed`).
	 */
	async whileRunning<T>(act: () => Promise<T>): Promise<T> {
		if (this.shifts > 0) await this.signalling;
		if (this.info.pausedAt === null) return act();
		const held = this.retryDueRefusal();
		if (held) throw held;
		return this.thawed(act);
	}

	/**
	 * Why a user's action may not run this paused conversation's omp, or null when it may: omp is backing off before a
	 * retry, and the end of that wait is here or about to be. omp starts the retried turn the moment its timer is due,
	 * as soon as it runs, and nothing can stop that (`abort_retry` only ends a sleep that is still going on). So a
	 * picker, a rename or a thinking level would make a provider request while the conversation says it is paused.
	 * What a paused conversation promises, that nothing runs until it is resumed, holds, and Resume is what retries.
	 */
	private retryDueRefusal(): CodedError | null {
		const r = this.info.retry;
		if (this.info.pausedAt === null || !r || r.resumed) return null;
		if (Date.now() + RETRY_THAW_GUARD_MS < r.startedAt + r.delayMs) return null;
		return new CodedError(
			"This conversation is paused while omp waits to retry a failed turn, and that wait is over: running omp for this would start the retried turn. Resume it to let it retry.",
			"pausedRetryDue",
		);
	}

	/**
	 * Run one of omp's builtin slash commands and return what it printed, which the conversation's viewers do not
	 * see (the `command_output` frames are taken here). omp runs a builtin command at once, mid-turn too, and leaves
	 * the turn alone. The caller must know omp has the command: a line omp does not know goes to the model, and
	 * the reply says `agentInvoked`, which is `null` here. `user`: as for `rpc`. `outputMs`: how long the printout is waited
	 * for once omp has answered (a command that asks a model prints when it has its answer).
	 */
	command(message: string, options: RpcOptions = {}, outputMs: number = OUTPUT_MS): Promise<string | null> {
		const run = this.commandQueue.then(() => this.runCommand(message, options, outputMs));
		this.commandQueue = run.catch(() => {});
		return run;
	}

	private async runCommand(message: string, options: RpcOptions, outputMs: number): Promise<string | null> {
		if (this.shifts > 0) await this.signalling;
		if (this.info.pausedAt !== null && !options.user)
			throw new CodedError("This conversation is paused; resume it to continue.", "paused");
		const printed: string[] = [];
		const ask = async (): Promise<string | null> => {
			this.capture = printed;
			this.inFlight++;
			try {
				const reply = await this.client.call<{ agentInvoked?: boolean } | undefined>(
					{ type: "prompt", message },
					15_000,
				);
				if (reply?.agentInvoked !== false) return null;
				// The reply and the text it printed are separate frames, and the text may come second.
				for (const stop = Date.now() + outputMs; !printed.length && Date.now() < stop && !this.client.isExited; )
					await Bun.sleep(10);
				return printed.join("\n");
			} finally {
				this.capture = null;
				this.inFlight--;
				this.checkModeSwitch();
				this.lastActivity = Date.now();
			}
		};
		return this.whileRunning(ask);
	}
}

/** The mode a page asked for in an `OpenTarget`; undefined when it asked for none (or for something that is none). */
function pickedMode(mode: unknown): Mode | undefined {
	return isMode(mode) ? mode : undefined;
}

function canonical(p: string): string {
	try {
		return realpathSync(p);
	} catch {
		return p;
	}
}

/** The closest folder that exists above `path` (the home folder when none does): where a picker for a folder that is gone starts. */
function nearestFolder(path: string): string {
	for (let dir = path; dir; ) {
		if (existsSync(dir)) return dir;
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return homedir();
}

/** What a conversation's guidance is, as it was kept for its session file (null: none). */
function keptGuidanceOf(guidance: GuidanceHooks | null, sessionFile: string): KeptGuidance | null {
	if (!guidance || !sessionFile) return null;
	const kept = guidance.sessions.kept(sessionKey(sessionFile));
	return kept && guidanceText(kept.text) ? kept : null;
}

/** Whether a terminal's `omp` that opens `resumed` again could be opening this conversation (see `resumedSessions`). */
function holdsSession(live: Live, resumed: Resumed): boolean {
	switch (resumed.by) {
		case "file":
			return live.info.sessionFile === sessionKey(resumed.file);
		case "id":
			return live.info.sessionId?.startsWith(resumed.prefix) === true;
		case "folder":
			return canonical(live.info.cwd) === canonical(resumed.cwd);
	}
}

const IDLE_MS = 15 * 60_000;
/** A process younger than this may still be starting (omp, its MCP servers): it is not idle yet. */
const STARTING_MS = 30_000;
/** Unwatched idle processes kept warm for a quick return; each omp holds ~200 MB. */
const KEEP_SPARE = 4;
/** How many of the processes that ended recently the server remembers the end of (see `LivePool.exits`). */
const EXIT_RECORDS = 32;

type Closable = Pick<Live, "busy" | "lastActivity"> & { subscribers: { size: number } };

/**
 * The processes to close: unwatched idle ones beyond the `keep` most recently active, and any
 * idle for IDLE_MS. Never one somebody watches or one that is busy (see `Live.busy`).
 */
export function surplus<T extends Closable>(lives: T[], now: number, keep = KEEP_SPARE): T[] {
	return lives
		.filter((l) => l.subscribers.size === 0 && !l.busy)
		.sort((a, b) => b.lastActivity - a.lastActivity)
		.filter((l, i) => i >= keep || now - l.lastActivity > IDLE_MS);
}

/** How long an idle omp gets to finish writing once its stdin is closed. */
const CLOSE_GRACE_MS = 1500;
/** How long omp, and what it started, get to end after SIGTERM before they are killed. */
const TERM_GRACE_MS = 500;
/**
 * The longest a request waits for an omp that was closed to end: a user's Close, an idle process that was reaped, the one
 * a terminal is about to open the session of. omp writes its session file until it has ended, so no other process opens
 * that file before; one still running after this long is refused (`stillFinishing`), never raced.
 */
export const FINISH_WAIT_MS = 10_000;
/**
 * The longest a starting server waits for the relays of a server that was killed to stop the omp they held (see
 * `LivePool.untilOrphansEnd`): each does within its grace and its SIGTERM grace (relay.ts), about three seconds.
 */
const ORPHAN_WAIT_MS = 6_000;

/**
 * End what is left of a paused conversation whose omp or relay is gone: frozen, with nobody to resume it. If omp is
 * still the recorded process, it and everything under it. If it is gone, its process group, which outlives it while
 * any member does (the system does not reuse a pid that names a group). Either way the recorded descendants that are
 * still the processes they were: a tool runs in a session of its own, out of reach of a group signal, and is no longer
 * found below omp once omp is gone.
 */
async function endRemnants(omp: ProcessRef, descendants: ProcessRef[]): Promise<void> {
	const found = await identityOf(omp.pid);
	const doomed: number[] = [];
	if (found === omp.identity) {
		try {
			doomed.push(...(await processTree(omp.pid)));
		} catch {
			// no listing: omp itself
			doomed.push(omp.pid);
		}
	} else if (found === null) {
		try {
			process.kill(-omp.pid, "SIGKILL");
		} catch {
			// no member left
		}
	}
	const running = await identitiesOf(descendants.map((d) => d.pid));
	for (const d of descendants) if (running.get(d.pid) === d.identity) doomed.push(d.pid);
	signalAll(doomed, "SIGKILL");
}

/** SIGSTOP what is below omp (`pid`) in a listing of its tree; what has exited since the listing is not there to stop. */
function stopBelow(tree: number[], pid: number): void {
	for (const p of tree) {
		if (p === pid) continue;
		try {
			process.kill(p, "SIGSTOP");
		} catch {
			// exited since the listing: nothing left to freeze
		}
	}
}

/** The refusal of a conversation that is opened while an import (or its restore) is writing the files it would run on. */
export function heldByImport(): CodedError {
	return new CodedError(
		"An import is writing files: conversations can be opened when it has finished",
		"migrateRunning",
	);
}

export class LivePool {
	private lives = new Map<string, Live>();
	/** Whether something that writes the files conversations run on (an import) is under way: none is opened while it is. */
	private hold: (() => boolean) | null = null;
	/**
	 * Resumes still starting, by canonical session file. A process only reports which session it holds once
	 * it answers `get_state`, so a second open of the same file (a double click, another tab) would not find
	 * the first and start a second omp on the file — two writers. It joins the first one's promise instead.
	 */
	private resuming = new Map<string, Promise<Live>>();
	/** Spares being taken over by an `open` (see there): no other `open` may take them meanwhile. */
	private readonly claimed = new Set<Live>();
	private seq = 0;
	/** `shutdown()` has begun: nothing new may start. */
	private stopping = false;
	private listeners = new Set<(info: LiveInfo) => void>();
	/** The conversations in a guided interview, kept for when their process is gone (see `InterviewStore`). */
	private readonly interviews: InterviewStore;
	/** Paused conversations that outlive the server (see parked.ts). */
	readonly parked: ParkedStore;
	/**
	 * How long a sleep's note is added to (`Live.followSleep`): `SLEEP_FOLLOW_MS` unless a test shortens it, since waiting a
	 * real minute to see the watching end is a minute of every run.
	 */
	sleepFollowMs = SLEEP_FOLLOW_MS;
	private selfRef: Promise<ProcessRef | null> | undefined;
	/**
	 * The processes that ended recently, by their id: what they were (the info a page needs to show the
	 * conversation) and how they ended.
	 *
	 * The idle reaper closes the processes nobody watches, and the `live_exit` frame that says how one ended reaches
	 * only the subscribers — so it reaches nobody. The end is kept here instead, and handed to a page that asks about
	 * the process afterwards (`attach`), or that is told of it (`live`) (#515). The record is bounded: the oldest ends
	 * are dropped, and a page that asks about a process whose end has been dropped is told it is no longer running,
	 * without saying who ended it.
	 */
	private readonly exits = new Map<string, { info: LiveInfo; exit: ExitReport }>();

	constructor(
		private readonly cfg: Config,
		/** `--config` overlay applied to every process (see omp/overlay.ts). */
		private overlay: string | null = null,
		/** Starts each process in the selected mode (online/offline); none: always online. */
		private readonly modes: Launcher | null = null,
		/** Per-conversation approval modes; without it every process runs on omp's own settings. */
		private readonly approval: ApprovalStore | null = null,
		/** How long a request waits for a closed omp to end before it is refused (see `ended`). */
		private readonly finishMs = FINISH_WAIT_MS,
		/**
		 * Told about the folders a new conversation that runs in `cwd` keeps its transcript in (`--session-dir`,
		 * `--profile`), so that they are listed and reopened like omp's own sessions directory (see `SessionRoots`).
		 */
		private readonly noteRoots: (args: string[], cwd: string) => void = () => {},
		/**
		 * The flags an omp must be started with for the conversation in `file`: a profile's conversation runs with its
		 * own profile (its auth, settings and images are there), a `--session-dir` one with the directory it is kept in.
		 */
		private readonly flagsFor: (file: string) => string[] = () => [],
		/**
		 * How long a process is left alone while it may still be starting (omp, its MCP servers): the idle reaper
		 * does not close one that is younger (see `STARTING_MS`). A test that must see the reaper at work sets this
		 * to 0 rather than waiting for the process to grow old.
		 */
		private readonly startingMs = STARTING_MS,
	) {
		this.interviews = new InterviewStore(cfg.dataDir);
		this.parked = new ParkedStore(cfg.dataDir);
		setInterval(() => {
			this.reap();
			this.collectAgentDirs();
			void sweepRelayDir(this.cfg.dataDir);
		}, 60_000).unref();
	}

	/** omp was installed or updated: its overlay is written again, for the processes that start from now on. */
	setOverlay(file: string | null): void {
		this.overlay = file;
	}

	/**
	 * The gate of "Confirm risky commands from remote pages" (see `server/omp/gate/extension.ts`): omp is started with it
	 * from now on, and each conversation's gate is told when to ask (`Live.syncRisk`). Null: no process has it.
	 */
	gate: RiskGate | null = null;

	/**
	 * The model guidance a conversation can be given (#641): the extension omp is started with, the file it reads, and the
	 * templates the pages manage (`server/omp/guidance/`). Null: no conversation carries guidance, and the routes are not
	 * there.
	 */
	guidance: GuidanceHooks | null = null;

	/**
	 * Unattended mode (#646): the extension omp is started with, the file it reads, the conversations the mode is on for, the
	 * instruction and the questions (`server/omp/unattended/`). Null: no conversation has the mode, and the routes are not there.
	 */
	unattended: UnattendedHooks | null = null;

	/**
	 * The quota floor (#652): the extension omp is started with, the file it reads, the floors the person set and the look at the
	 * provider's usage (`server/omp/quota-floor/`). Null: no conversation is held, and the routes are not there.
	 */
	quotaFloor: QuotaFloorHooks | null = null;

	/**
	 * Compact between two steps (#651): the extension omp is started with and the file it reads (`server/omp/compact-step/`). Null: a
	 * compact waits for the end of the turn, and says so.
	 */
	compactStep: CompactStepHooks | null = null;

	/** A floor was set, changed or taken away: every conversation that works looks at its provider again. */
	quotaFloorChanged(): void {
		for (const live of this.lives.values()) if (!live.info.exited) live.quotaFloorChanged();
	}

	/**
	 * Whether Settings has automatic titles on (read each time a turn ends, see `AutoTitle`). Null: the server makes none.
	 */
	autoTitle: (() => boolean) | null = null;

	/** The setting may have changed: every conversation's gate is told again (it is read once, not once per conversation). */
	syncRisk(): void {
		const confirm = this.gate?.confirm() === true;
		// While an import writes the files conversations run on, the record of a kept conversation is not the server's to write
		// again: the import is replacing what is there, and `main.ts` writes each record down again once it has ended.
		const records = !this.importing;
		for (const live of this.lives.values()) {
			if (live.info.exited) continue;
			live.syncRisk(confirm);
			if (records) live.reassertRecord();
			// The gate's note may come after the process was announced: the pages learn that it has the gate (or has not) now.
			// And what the guard does for the conversation, which moves with the global settings when it follows them.
			const guarded = live.syncGuardInfo();
			// The guidance extension's note comes after the process was announced too: the page learns the guidance is live.
			const guided = live.syncGuidance();
			const unattended = live.syncUnattended();
			if (live.syncUngated() || guarded || guided || unattended) this.announce(live);
		}
	}

	/** Whether an import (or its restore) is writing the files conversations run on (see `setHold`). */
	get importing(): boolean {
		return this.hold?.() === true;
	}

	/** Project config watched for a change of roles, by folder: only folders a switched conversation runs in. */
	private readonly projectWatches = new Map<string, () => void>();

	/** The folders whose project config is watched now (see `syncProjectWatches`). */
	get watchedProjects(): string[] {
		return [...this.projectWatches.keys()];
	}

	/**
	 * Watch the project config of exactly the folders a live or paused switched conversation runs in: a folder's watcher
	 * starts with its first such conversation and stops with its last (it closed, exited, was reaped or is no longer
	 * switched), so a server that runs for days holds one per folder in use, not one per folder ever used.
	 */
	private syncProjectWatches(): void {
		const used = new Set<string>();
		if (!this.stopping) {
			for (const live of this.lives.values()) if (live.info.models && !live.info.exited) used.add(live.info.cwd);
		}
		for (const [cwd, stop] of this.projectWatches) {
			if (used.has(cwd)) continue;
			stop();
			this.projectWatches.delete(cwd);
		}
		for (const cwd of used) {
			if (this.projectWatches.has(cwd)) continue;
			this.projectWatches.set(
				cwd,
				watchOmpConfig(join(cwd, ".omp"), () => void this.refreshModelRoles()),
			);
		}
	}

	/**
	 * The global or a project config changed: every switched conversation, running or paused, has its overlay worked out
	 * again (see `Live.refreshModelRoles`). One that cannot be read now keeps what it has.
	 */
	async refreshModelRoles(): Promise<void> {
		await Promise.all(
			[...this.lives.values()].map((live) =>
				live.refreshModelRoles().catch((e) => {
					console.error(
						`omp-webui: could not update the model settings of ${live.info.liveId}: ${(e as Error).message}`,
					);
				}),
			),
		);
	}

	onAnnounce(fn: (info: LiveInfo) => void): void {
		this.listeners.add(fn);
	}

	announce(live: Live): void {
		live.info.subscribers = live.subscribers.size;
		// What a page is told of the gate is what the process holds now (a new process, or one taken over, is first announced here).
		if (!live.info.exited) {
			live.syncUngated();
			live.syncGuardInfo();
			live.syncGuidance();
			live.syncUnattended();
		}
		// A page that came or went changes whether a question to the person is seen (see `Live.guardWord`).
		if (!live.info.exited) live.syncRisk();
		// A paused conversation's record follows what is known of it (the session file, a mode change).
		live.persist();
		// A switched conversation's overlay follows the roles of its folder's project config too; a folder nobody
		// switched is in any more (this one closed, exited or was unswitched) stops being watched.
		this.syncProjectWatches();
		// A process that has ended is announced with how it ended: the `live_exit` frame reaches only the
		// subscribers, and the reaper closes the processes nobody watches, so without this a page that lets go of a
		// process would learn of its end only by asking, and would not know what to say (#515).
		const exit = live.info.exited ? this.exitOf(live.info.liveId)?.exit : undefined;
		for (const fn of this.listeners) fn(exit ? { ...live.info, exit } : live.info);
		// Watchers come and go, processes start and finish: each can leave a surplus.
		this.reap();
	}

	get(liveId: string): Live | undefined {
		return this.lives.get(liveId);
	}

	/**
	 * The processes the server holds. A process that has ended is not among them: it is gone, and the listing has
	 * always said so (`exited`). How it ended is a separate question, and it is asked of `exitOf` (#515).
	 */
	list(): LiveListing[] {
		return [...this.lives.values()].map((l) => ({
			...l.info,
			subscribers: l.subscribers.size,
			busy: l.busy,
			holding: l.holding,
		}));
	}

	/** The process ids of the omp processes this server holds and of the relays that hold their pipes, for the host load's share of each (`HostSampler`). */
	pids(): { omp: number[]; relay: number[] } {
		const omp: number[] = [];
		const relay: number[] = [];
		for (const l of this.lives.values()) {
			if (l.info.exited) continue;
			if (l.client.pid !== null) omp.push(l.client.pid);
			const relayPid = l.client.relay?.pid;
			if (relayPid != null) relay.push(relayPid);
		}
		return { omp, relay };
	}

	/** `fn` says whether an import is writing: while it does, no conversation is opened or resumed (`heldByImport`). */
	setHold(fn: () => boolean): void {
		this.hold = fn;
	}

	forget(live: Live): void {
		this.lives.delete(live.info.liveId);
		this.announce(live);
	}

	/**
	 * The Mac was asleep from `from` to `to`, and `working` were the conversations it caught at work (#647): each says so
	 * in its transcript, and watches what follows. One that is gone by now is none: it was working when the machine went
	 * away, and nothing of it is left to say anything in.
	 */
	noteSleep(from: number, to: number, working: readonly string[]): number {
		let told = 0;
		for (const id of working) {
			const live = this.lives.get(id);
			if (!live || live.info.exited) continue;
			live.slept(from, to);
			told++;
		}
		return told;
	}

	/**
	 * Keep how a process that ended ended, and what it was: the reaper closes the processes nobody watches, so the
	 * frame that says so reaches no page, and a page that asks about the process afterwards must be told here
	 * instead (#515). The record is bounded: the oldest ends are dropped, and a page that asks about a process whose
	 * end has been dropped is told it is no longer running, without saying who ended it.
	 */
	recordExit(info: LiveInfo, exit: ExitReport): void {
		this.exits.delete(info.liveId);
		this.exits.set(info.liveId, { info, exit });
		while (this.exits.size > EXIT_RECORDS) {
			const oldest = this.exits.keys().next();
			if (oldest.done) break;
			this.exits.delete(oldest.value);
		}
	}

	/** What a process that ended was, and how it ended, when the server still knows; null when it does not. */
	exitOf(liveId: string): { info: LiveInfo; exit: ExitReport } | null {
		return this.exits.get(liveId) ?? null;
	}

	/** The user picked `mode` for the conversation this process holds: keep it for when the conversation is resumed. */
	rememberApproval(live: Live, mode: ApprovalMode): void {
		const { sessionFile } = live.info;
		if (sessionFile) this.approval?.rememberSession(sessionFile, mode);
	}

	/** The conversation moved from one session file to another: the mode the user picked for it goes along. */
	carryApproval(from: string, to: string): void {
		const picked = this.approval?.sessionMode(from);
		// One that already has its own pick (a switch to another conversation) keeps it.
		if (picked && !this.approval?.sessionMode(to)) this.approval?.rememberSession(to, picked);
	}

	/** The conversation moved from one session file to another: where it compacts goes along. */
	carryCompact(from: string, to: string): void {
		const approval = this.approval;
		if (!approval) return;
		const picked = approval.sessionCompact(sessionKey(from));
		if (picked && !approval.sessionCompact(sessionKey(to))) approval.rememberCompact(sessionKey(to), picked);
	}

	/** The conversation moved from one session file to another: the choice made for it about waiting out usage limits goes along. */
	carryUsageWait(from: string, to: string): void {
		const approval = this.approval;
		if (!approval) return;
		const picked = approval.sessionUsageWait(sessionKey(from));
		if (picked !== null && approval.sessionUsageWait(sessionKey(to)) === null)
			approval.rememberUsageWait(sessionKey(to), picked);
	}

	/** The conversation this process holds was switched to a preset: keep it for when the conversation is resumed. */
	rememberModels(live: Live, models: ConversationModels): void {
		const { sessionFile } = live.info;
		if (sessionFile) this.approval?.rememberModels(sessionKey(sessionFile), models);
	}

	/** The conversation moved from one session file to another: the preset it was switched to goes along. */
	carryModels(from: string, to: string): void {
		const approval = this.approval;
		const picked = approval?.sessionModels(sessionKey(from));
		if (approval && picked && !approval.sessionModels(sessionKey(to))) approval.rememberModels(sessionKey(to), picked);
	}

	/**
	 * The mode this process runs in is the one its conversation is reopened in, until it is switched: kept for its session file
	 * (a conversation that was left Light is not reopened Full because the default for new chats is Full now).
	 */
	rememberLaunchMode(live: Live): void {
		const { sessionFile, mode } = live.info;
		if (!sessionFile || !this.approval) return;
		try {
			this.approval.rememberLaunchMode(sessionKey(sessionFile), mode);
		} catch (e) {
			// It holds for as long as the process runs: only what a later opening does is not kept.
			console.error(`omp-webui: could not keep the mode of ${sessionFile}: ${(e as Error).message}`);
		}
	}

	/** The conversation moved from one session file to another: the mode it runs in goes along. */
	carryLaunchMode(from: string, to: string): void {
		const approval = this.approval;
		const kept = approval?.sessionLaunchMode(sessionKey(from));
		if (approval && kept && !approval.sessionLaunchMode(sessionKey(to)))
			approval.rememberLaunchMode(sessionKey(to), kept);
	}

	/**
	 * The guidance a page asked for a new conversation (`OpenTarget.guidance`), as the store has its templates now: the
	 * template's text as it stands (so that editing it later reaches the conversation at its next turn), the text typed by
	 * hand, or null for none. A template the store no longer has is read as no guidance at all: the page picked something
	 * that is not there.
	 */
	pickedGuidance(guidance: SessionGuidance | null | undefined): KeptGuidance | null {
		if (!this.guidance || !guidance) return null;
		const text = this.guidance.sessions.textOf(guidance);
		if (!text) return null;
		return {
			...(guidance.template && guidance.template.length <= GUIDANCE_ID_MAX ? { template: guidance.template } : {}),
			text,
		};
	}

	/** What the conversation in `file` carries of the model guidance (null: none). */
	keptGuidance(file: string | null): KeptGuidance | null {
		return keptGuidanceOf(this.guidance, file ?? "");
	}

	/** The running process that holds the conversation in `file`, if any. */
	liveOfFile(file: string): Live | undefined {
		const key = sessionKey(file);
		for (const l of this.lives.values()) if (!l.info.exited && l.info.sessionFile === key) return l;
		return undefined;
	}

	/**
	 * Keep `guidance` (null: none) for the conversation in `file`, which has no process (#715): it is what the conversation
	 * carries when it is opened next, as a choice made while it ran would be. Throws when it cannot be written.
	 */
	keepGuidanceFor(file: string, guidance: KeptGuidance | null): KeptGuidance | null {
		if (!this.guidance) throw new Error("this server has no model guidance");
		this.guidance.sessions.remember(sessionKey(file), guidance);
		return this.keptGuidance(file);
	}

	/** What the conversation in `file` chose of the guard when it was last open (or that what was kept is damaged); none: it follows the global settings. */
	keptGuard(file: string | null): KeptGuard {
		return file ? (this.approval?.sessionGuard(sessionKey(file)) ?? NO_GUARD) : NO_GUARD;
	}

	/**
	 * The conversation this process holds was given `guidance` (null: none): keep it for when the conversation is resumed,
	 * by this server or a later one. Kept by the session file, as the permission mode is, so that it is there before a page
	 * says anything.
	 */
	rememberGuidance(live: Live, guidance: KeptGuidance | null): void {
		const { sessionFile } = live.info;
		if (!sessionFile || !this.guidance) return;
		try {
			this.guidance.sessions.remember(sessionKey(sessionFile), guidance);
		} catch (e) {
			// It holds for as long as the process runs: only what a later opening carries is not kept.
			console.error(`omp-webui: could not keep the model guidance of ${sessionFile}: ${(e as Error).message}`);
		}
	}

	/** The conversation moved from one session file to another: the guidance it was given goes along. */
	carryGuidance(from: string, to: string): void {
		try {
			this.guidance?.sessions.carry(sessionKey(from), sessionKey(to));
		} catch (e) {
			console.error(`omp-webui: could not keep the model guidance of ${to}: ${(e as Error).message}`);
		}
	}

	/** Whether unattended mode (#646) is on for the conversation in `file` (what was kept for it when it was last open). */
	keptUnattended(file: string | null): boolean {
		return Boolean(file && this.unattended?.isOn(sessionKey(file)));
	}

	/** The conversation this process holds was turned unattended, or back: keep it for when the conversation is resumed. */
	rememberUnattended(live: Live, on: boolean): void {
		const { sessionFile } = live.info;
		if (!sessionFile || !this.unattended) return;
		try {
			this.unattended.setOn(sessionKey(sessionFile), on);
		} catch (e) {
			// It holds for as long as the process runs: only what a later opening does is not kept.
			console.error(`omp-webui: could not keep unattended mode for ${sessionFile}: ${(e as Error).message}`);
		}
	}

	/** The conversation moved from one session file to another: unattended mode goes along (its questions stay where they were asked). */
	carryUnattended(from: string, to: string): void {
		try {
			this.unattended?.carry(sessionKey(from), sessionKey(to));
		} catch (e) {
			console.error(`omp-webui: could not keep unattended mode for ${to}: ${(e as Error).message}`);
		}
	}

	/**
	 * The instruction was edited, or a question filed, answered or dismissed: every process that is unattended reads the new
	 * text (with its questions that still wait, #694) at its next turn.
	 */
	rewriteUnattended(): void {
		for (const live of this.lives.values()) if (live.unattendedChoice) live.writeUnattended();
	}

	/** The conversation this process holds chose `guard` (null: the global settings again): keep it for when it is opened again. */
	rememberGuard(live: Live, guard: GuardOverride | null): void {
		this.keep(live, (file) => this.approval?.rememberGuard(file, guard));
	}

	/** The conversation this process holds is under `kept`, damage included: keep it, damage as damage, for when it is opened again. */
	rememberKept(live: Live, kept: KeptGuard): void {
		this.keep(live, (file) => this.approval?.rememberKept(file, kept));
	}

	private keep(live: Live, write: (file: string) => void): void {
		const { sessionFile } = live.info;
		if (!sessionFile || !this.approval) return;
		try {
			write(sessionKey(sessionFile));
		} catch (e) {
			// The choice holds for as long as the process runs, and goes with the record of a paused one; it is only not kept beyond.
			console.error(`omp-webui: could not keep the guard settings of ${sessionFile}: ${(e as Error).message}`);
		}
	}

	/**
	 * The user chose for the conversation in `file` whether it waits out its provider's usage limit (null: omp's own
	 * setting). The choice is kept for when the conversation is resumed, and a process that holds it now is told.
	 */
	async setUsageWait(file: string, on: boolean | null): Promise<void> {
		const key = sessionKey(file);
		this.approval?.rememberUsageWait(key, on);
		// A process names its file as omp said it, which is not its real path until the file is written.
		const holders = [...this.lives.values()].filter(
			(l) => !l.info.exited && l.info.sessionFile !== null && sessionKey(l.info.sessionFile) === key,
		);
		await Promise.all(holders.map((l) => l.setUsageWait(on)));
	}

	/**
	 * Where the conversation in `file` compacts becomes `at` (null: omp's own configuration again). The choice is kept for
	 * when the conversation is opened again, and a process that holds it now is told (its overlay, which omp reloads: the
	 * change applies from the next turn, nothing is restarted).
	 */
	async setCompact(file: string, at: CompactAt | null): Promise<void> {
		const key = sessionKey(file);
		this.approval?.rememberCompact(key, at);
		// A process names its file as omp said it, which is not its real path until the file is written.
		const holders = [...this.lives.values()].filter(
			(l) => !l.info.exited && l.info.sessionFile !== null && sessionKey(l.info.sessionFile) === key,
		);
		await Promise.all(holders.map((l) => l.setCompact(at)));
	}

	/**
	 * The other running conversations that follow the global config `agentDir` holds: the ones a change of it reaches
	 * (see `setSessionDefault`).
	 */
	otherLives(except: Live, agentDir: string): Live[] {
		return [...this.lives.values()].filter(
			(l) => l !== except && !l.info.exited && (l.env.PI_CODING_AGENT_DIR ?? this.cfg.agentDir) === agentDir,
		);
	}

	/** Whether this conversation was in a guided interview when its last process ended. */
	wasInterviewing(sessionFile: string): boolean {
		return this.interviews.has(sessionFile);
	}

	/** The conversation in `sessionFile` is now in an interview, or no longer. */
	noteInterview(sessionFile: string | null, interviewing: boolean): void {
		if (!sessionFile) return;
		if (interviewing) this.interviews.add(sessionFile);
		else this.interviews.remove(sessionFile);
	}

	/**
	 * Close this server's omp processes for the sessions a terminal's `omp` is about to open again (`resumedSessions`)
	 * before it does: two writers make omp save one history as a separate branch file. Refuses, closing none, while one
	 * of them is busy (working, asking or paused), and when one has not ended in time (see `ended`).
	 */
	async release(resumed: Resumed): Promise<void> {
		const holders = [...this.lives.values()].filter((l) => !l.info.exited && holdsSession(l, resumed));
		for (const l of holders) {
			const holding = l.holding;
			if (holding) throw new Error(refusal(holding));
		}
		for (const l of holders) l.closeBecause("handover");
		await this.ended(holders);
	}

	/**
	 * End this conversation's omp so that it can be started anew from its session file (what a changed MCP server or any
	 * other setting omp reads only at startup needs). Only an idle one: while it is busy nothing is done and what it is
	 * busy with is returned, since ending it would cut that off. Null once the process has exited; refused when it has not
	 * ended in time (see `ended`).
	 */
	async endIfIdle(live: Live): Promise<Holding | null> {
		const holding = live.holding;
		if (holding) return holding;
		live.closeBecause("restarted");
		await this.ended([live]);
		return null;
	}

	/**
	 * Switch the conversation `live` holds to `mode` (This session › Full / Light): its omp ends and the same session file is
	 * resumed in the new mode, the restart `endIfIdle` does for a changed MCP server. A conversation that works or waits for an
	 * answer is not cut off: the switch waits for the turn to end and every page is told (`LiveInfo.modeSwitch`); `finishModeSwitch`
	 * makes it then. A paused one is refused, with the reason (its omp is frozen: resume it first). Asking for the mode the process
	 * has takes back a switch that waits.
	 */
	async switchMode(live: Live, mode: Mode): Promise<ModeSwitchReply> {
		if (live.info.exited || live.client.closing) throw new Error("This conversation is not running");
		if (mode === live.info.mode) {
			live.cancelModeSwitch();
			return { state: "unchanged" };
		}
		if (!live.info.sessionFile)
			throw new CodedError("This conversation has no session yet; send a message first.", "modeSwitchUnsaved");
		if (live.holding === "paused")
			throw new CodedError("This conversation is paused; resume it first.", "modeSwitchPaused");
		if (!live.switchable) {
			live.requestModeSwitch(mode);
			return { state: "pending", mode };
		}
		return { state: "switched", liveId: (await this.restartIn(live, mode)).info.liveId };
	}

	/** The turn a switch waited for has ended: it is made now. A failure is said on the process that went on (see `restartIn`). */
	async finishModeSwitch(live: Live, to: Mode): Promise<void> {
		try {
			await this.restartIn(live, to);
		} catch (e) {
			console.error(`omp-webui: could not switch ${live.info.liveId} to ${to}: ${(e as Error).message}`);
		}
	}

	/**
	 * End `live`'s omp and resume its session file in `mode`; returns the process that runs the conversation now. A conversation
	 * is not left without a process because the other mode could not start it (the local server is down, a model cannot be
	 * restored): it is resumed in the mode it had, that process says why (`LiveInfo.modeSwitch`), and the error is thrown.
	 */
	private async restartIn(live: Live, mode: Mode): Promise<Live> {
		const { sessionFile, cwd, mode: from } = live.info;
		if (!sessionFile)
			throw new CodedError("This conversation has no session yet; send a message first.", "modeSwitchUnsaved");
		live.closeBecause("modeSwitch");
		await this.ended([live]);
		// The folder the process ran in is where the conversation goes on: nothing to look up.
		const reopen = (asked: Mode) =>
			this.open({ kind: "resume", sessionFile, cwd, mode: asked }, () => Promise.resolve(cwd));
		try {
			return await reopen(mode);
		} catch (e) {
			const back = await reopen(from).catch(() => null);
			back?.noteModeSwitchFailed(mode, {
				message: e instanceof Error ? e.message : String(e),
				...errorInfoOf(e),
			});
			throw e;
		}
	}

	/** How many of the processes are working, asking or paused: what ending them would cut off. */
	busyCount(): number {
		return [...this.lives.values()].filter((l) => !l.info.exited && l.holding).length;
	}

	/**
	 * End every process that is idle (what an import needs before it writes the files they hold). Refused, ending none,
	 * while any is busy. They start again from their session files when a conversation is opened.
	 */
	async endAllIdle(): Promise<number> {
		if (this.busyCount() > 0) throw new Error("A conversation is still working");
		const idle = [...this.lives.values()].filter((l) => !l.info.exited && !l.client.closing);
		for (const l of idle) l.closeBecause("restarted");
		await this.ended(idle);
		return idle.length;
	}

	/**
	 * Wait for the omp of each of `lives`, closed, to end. It writes its session file until it has, and a second omp on
	 * that file makes omp save the history as a branch file of its own. One still running after `finishMs` (a turn left to
	 * finish when the user closed the conversation, an omp that does not answer its closed stdin) is refused, not raced.
	 */
	private async ended(lives: Live[]): Promise<void> {
		let timer: NodeJS.Timeout | undefined;
		const expired = new Promise<void>((resolve) => {
			timer = setTimeout(resolve, this.finishMs);
		});
		await Promise.race([Promise.all(lives.map((l) => l.client.whenExited)), expired]);
		clearTimeout(timer);
		if (lives.some((l) => l.client.running))
			throw new CodedError(
				"omp is still finishing its work on this conversation after it was closed; try again once it has ended.",
				"stillFinishing",
			);
	}

	async open(target: OpenTarget, cwdOfSession: (file: string) => Promise<string | null>): Promise<Live> {
		if (this.stopping) throw new Error("The server is shutting down");
		if (this.hold?.()) throw heldByImport();
		if (target.kind === "new") {
			if (!existsSync(target.cwd)) throw new Error(`Directory does not exist: ${target.cwd}`);
			// The mode is the conversation's own switcher's business: a flag for the whole process would override it.
			const args = this.approval ? stripApprovalFlags(target.args ?? []) : (target.args ?? []);
			const requested = isApprovalMode(target.approvalMode) ? target.approvalMode : undefined;
			// What the page picked of the guard for this conversation: the global settings apply without it (a page that is not
			// this computer's is refused one before it gets here, see `main.ts`).
			const guard = parseGuardOverride(target.guard);
			// What the page picked of the model guidance, as the store has it now: a new conversation starts with none unless
			// the page says otherwise (see `OpenTarget`).
			const guidance = this.pickedGuidance(target.guidance);
			// And of unattended mode (#646): off unless the page says so (the person's default for new chats is the page's).
			const unattended = this.unattended !== null && target.unattended === true;
			const started = async (): Promise<Live> => {
				const live = await this.spawn(
					target.cwd,
					args,
					null,
					true,
					launch,
					requested,
					NO_TOOL_POLICIES,
					guidance,
					unattended,
				);
				if (guard) live.setGuard(guard);
				return live;
			};
			// A conversation started with `--session-dir` or `--profile` keeps its transcript in another folder: the
			// folder is remembered, so that the conversation is listed, searched and reopened like the others.
			this.noteRoots(args, target.cwd);
			const launch = await this.plan(args, null, pickedMode(target.mode));
			const spare = this.spare(target.cwd, args, launch);
			if (!spare) return started();
			// A process a reloaded page left unused is taken over, and put in the mode this page asks for: what the user
			// picked here, else what a new conversation starts in. Only a pick is kept for the conversation.
			// Held while that is looked up, so another page doesn't take the same one; the page that left it may still
			// close it meanwhile (its close and this open come over different sockets), and then a new one is started.
			this.claimed.add(spare);
			try {
				const mode = (await this.approval?.startingMode(target.cwd, null, requested, launch.env))?.mode;
				const gone = () => spare.info.exited || spare.client.closing;
				if (gone()) return started();
				if (mode)
					try {
						await spare.setApprovalMode(mode, false);
					} catch (e) {
						if (!gone()) throw e;
						return started();
					}
				if (gone()) return started();
			} finally {
				this.claimed.delete(spare);
			}
			if (requested) this.rememberApproval(spare, requested);
			// What this page picked for the conversation, not what a page that left the process picked.
			if (JSON.stringify(spare.guardChoice) !== JSON.stringify(guard)) spare.setGuard(guard);
			// The same of the guidance: a process left with another page's text is given this page's.
			if (JSON.stringify(spare.guidanceChoice) !== JSON.stringify(guidance)) spare.setGuidance(guidance);
			// And of unattended mode.
			if (spare.unattendedChoice !== unattended) spare.setUnattended(unattended);
			return spare;
		}
		const file = sessionKey(target.sessionFile);
		let opening = this.resuming.get(file);
		if (!opening) {
			opening = this.resume(file, target, cwdOfSession).finally(() => this.resuming.delete(file));
			this.resuming.set(file, opening);
		}
		return opening;
	}

	/**
	 * A new conversation in `cwd` that `server` gives host tools (see `Live.serveHostTools`). It is started for this and
	 * nothing else: never a spare another new chat would take over, and never one that another takes over. `requested`
	 * is the permission mode it starts in, as for `open`; the user's default applies without it. If omp does not accept
	 * the tools the process is closed and the error is thrown: a conversation without them would be one that was never
	 * asked for.
	 */
	async openServing(cwd: string, server: HostToolServer, requested?: ApprovalMode): Promise<Live> {
		if (this.stopping) throw new Error("The server is shutting down");
		if (!existsSync(cwd)) throw new Error(`Directory does not exist: ${cwd}`);
		// What the server changes is asked about by omp, in every permission mode: that is the overlay's, so without one
		// the conversation would run these tools on omp's own settings, which may be Auto-approve.
		if (!this.approval) throw new Error("This server cannot hold tools that must be asked about");
		const policies: ToolPolicies = {
			allow: server.readOnly,
			prompt: server.tools.map((t) => t.name).filter((name) => !server.readOnly.includes(name)),
		};
		const live = await this.spawn(cwd, [], null, false, await this.plan([], null), requested, policies);
		try {
			await live.serveHostTools(server);
		} catch (e) {
			live.closeBecause("server");
			throw e;
		}
		return live;
	}

	private async resume(
		file: string,
		target: Extract<OpenTarget, { kind: "resume" }>,
		cwdOfSession: (file: string) => Promise<string | null>,
	): Promise<Live> {
		for (const l of this.lives.values()) {
			if (l.info.exited || l.info.sessionFile !== file) continue;
			if (!l.client.closing) return l;
			// Being closed (surplus, or a Close while it was working): it writes to the file until it has ended, and a second
			// omp on it would make the history a branch file of its own. Never raced: waited for, or refused.
			await this.ended([l]);
		}
		const model = target.model ? ["--model", target.model] : [];
		// The mode the page asks for, else the one the conversation last ran in (kept per session file), else the one new
		// conversations start in: a conversation reopened later is in the mode it was left in, not in whatever the default is now.
		const mode = pickedMode(target.mode) ?? this.approval?.sessionLaunchMode(sessionKey(file)) ?? undefined;
		const start = async (cwd: string, args: string[], sessionFile: string | null): Promise<Live> =>
			this.spawn(cwd, args, sessionFile, false, await this.plan(args, sessionFile, mode));
		if (!existsSync(file)) {
			// Never written (omp died before the first reply): `--resume` would fail with "not found".
			if (target.cwd && existsSync(target.cwd)) return start(target.cwd, model, null);
			throw new Error(`Session "${file}" not found`);
		}
		const recorded = await cwdOfSession(file);
		// A conversation that lives in another folder is resumed the way it was started: a profile's own profile (its
		// auth, settings and images are there) or the directory it is kept in.
		const args = ["--resume", file, ...this.flagsFor(file), ...model];
		if (recorded && existsSync(recorded)) return start(recorded, args, file);
		// The folder it ran in is gone, or its file does not say: omp's tools (`bash`, `edit`, `write`) run wherever the
		// process is started, so never anywhere the user did not choose, least of all in omp's own session storage.
		if (target.folder !== undefined) {
			if (!existsSync(target.folder)) throw new Error(`Directory does not exist: ${target.folder}`);
			return start(target.folder, args, file);
		}
		const nearest = nearestFolder(recorded ?? "");
		throw recorded
			? new CodedError(`The folder this conversation ran in no longer exists: ${recorded}`, "sessionFolderGone", {
					folder: recorded,
					nearest,
				})
			: new CodedError("This conversation's file does not say which folder it ran in", "sessionFolderUnknown", {
					nearest,
				});
	}

	/**
	 * A process started for a new chat that nobody watches or has used — its page was reloaded or closed —
	 * with this folder, these options and this mode, if there is one (the newest first). A page
	 * reloaded five times in a row finds the same process each time instead of leaving five behind; a Full process is never
	 * handed to a Light chat or the other way round, nor does a change of the Light settings (another local server, other
	 * models) hand over a process that was started with the old ones: its environment says which files it was started with.
	 */
	private spare(cwd: string, args: string[], launch: LaunchPlan): Live | undefined {
		const full = this.launchArgs(launch, args, cwd);
		return [...this.lives.values()]
			.reverse()
			.find(
				(l) =>
					l.pristine &&
					!this.claimed.has(l) &&
					l.subscribers.size === 0 &&
					l.info.mode === launch.mode &&
					l.info.lightModels === launch.lightModels &&
					Object.keys(l.env).length === Object.keys(launch.env).length &&
					Object.entries(launch.env).every(([k, v]) => l.env[k] === v) &&
					l.info.cwd === cwd &&
					l.info.args.length === full.length &&
					l.info.args.every((a, i) => a === full[i]),
			);
	}

	/**
	 * The command line for `args`: the `--config` overlay, the gate and the model-guidance extension (see `gate`,
	 * `guidance`), then what the mode adds, in front of every process; and `--allow-home` where it starts in the user's home
	 * folder, which omp otherwise leaves for a temp directory (its tools would then run there while the page shows `~`).
	 */
	private launchArgs(launch: LaunchPlan, args: string[], cwd: string): string[] {
		const home = canonical(cwd) === canonical(homedir()) && !args.includes("--allow-home") ? ["--allow-home"] : [];
		// `--trusted-extension` cannot be combined with `--extension`: such a conversation runs without the gate and without
		// the guidance extension, and `Live.gated` and its `LiveInfo.guidance` say so.
		const trusted = args.some((a) => a === "--trusted-extension" || a.startsWith("--trusted-extension="));
		const extensions: string[] = [];
		// The quota floor's goes first (#652): a call that waits there does not come to the gate's question for the person until the
		// conversation is let go, so that a held conversation asks nothing. It does nothing for a conversation whose provider has no floor.
		if (this.quotaFloor && !trusted && this.quotaFloor.ensure()) extensions.push(this.quotaFloor.extension);
		// So is the one that holds a step boundary for a compact between two steps (#651): it does nothing while none is wanted.
		if (this.compactStep && !trusted && this.compactStep.ensure()) extensions.push(this.compactStep.extension);
		if (this.gate && this.approval !== null && !trusted && this.gate.ensure()) extensions.push(this.gate.extension);
		// The guidance extension is started with every process (it adds nothing when the conversation's file has no text).
		if (this.guidance && !trusted && this.guidance.ensure()) extensions.push(this.guidance.extension);
		// So is the unattended-mode one (#646): it does nothing for a conversation that is not unattended.
		if (this.unattended && !trusted && this.unattended.ensure()) extensions.push(this.unattended.extension);
		const flags = extensions.flatMap((extension) => ["--extension", extension]);
		return [...(this.overlay ? ["--config", this.overlay] : []), ...flags, ...launch.args, ...home, ...args];
	}

	/**
	 * How a process for `args` starts in `mode`: the one the caller asks for, else the one new conversations start in (the server
	 * keeps it: New chat's Full / Light).
	 */
	private async plan(args: string[], sessionFile: string | null, mode?: Mode): Promise<LaunchPlan> {
		return (await this.modes?.plan({ resume: sessionFile, args, mode: mode ?? this.modes.mode })) ?? FULL;
	}

	/**
	 * What `cwd`'s configuration sets that `models` clear for their conversation (see `ProcessOverlay.absent`). When omp
	 * cannot say, nothing: the conversation still has the preset's roles and subagent models, and sees a role or agent the
	 * preset lacks as the config has it.
	 */
	private async absentModels(cwd: string, models: ConversationModels): Promise<Absent> {
		try {
			return await absentModels(this.cfg, cwd, models);
		} catch (e) {
			console.error(`omp-webui: could not read the model settings of ${cwd}: ${(e as Error).message}`);
			return { roles: [], agents: [] };
		}
	}

	private async spawn(
		cwd: string,
		args: string[],
		sessionFile: string | null = null,
		newChat = false,
		planned?: LaunchPlan,
		/** The approval mode to start in; the conversation's earlier one or the user's default applies without it. */
		requested?: ApprovalMode,
		/** The policies of this process's own tools (see `ToolPolicies`). */
		policies: ToolPolicies = NO_TOOL_POLICIES,
		/** What a new conversation is given of the model guidance (see `OpenTarget`; undefined: what was kept for its file). */
		guidance?: KeptGuidance | null,
		/** Whether a new conversation starts unattended (see `OpenTarget`; undefined: what was kept for its file). */
		unattended?: boolean,
	): Promise<Live> {
		const launch = planned ?? (await this.plan(args, sessionFile));
		const liveId = `L${++this.seq}-${Date.now().toString(36)}`;
		// The preset the user switched this conversation to holds when it is resumed (a process on a local server has no presets).
		const models =
			this.approval && sessionFile && !runsLocal(launch) ? this.approval.sessionModels(sessionKey(sessionFile)) : null;
		const absent = models ? await this.absentModels(cwd, models) : { roles: [], agents: [] };
		const start = await this.approval?.startingMode(cwd, sessionFile, requested, launch.env);
		const overlay =
			this.approval && start
				? await this.approval.create(
						liveId,
						start.mode,
						sessionFile ? this.approval.sessionUsageWait(sessionKey(sessionFile)) : null,
						models,
						absent.roles,
						policies,
						absent.agents,
						sessionFile ? this.approval.sessionCompact(sessionKey(sessionFile)) : null,
					)
				: null;
		const live = new Live(
			liveId,
			this.cfg,
			cwd,
			this.launchArgs(launch, args, cwd),
			this,
			sessionFile,
			newChat,
			launch,
			overlay,
			// Every process is started behind a relay, so that a paused one can outlive the server.
			{
				via: { kind: "relay", socket: relaySocket(this.cfg.dataDir, liveId) },
				approvalOmp: start?.omp,
				// The flags of the user's own, without the server's overlay and the mode's flags.
				ownArgs: args,
				// What the conversation chose of the guard the last time it was open: a resumed one is under it again.
				guard: this.keptGuard(sessionFile),
				// What it is given of the model guidance (undefined: what was kept for its session file).
				guidance,
				// And of unattended mode (undefined: what was kept for its session file).
				unattended,
			},
		);
		this.lives.set(live.info.liveId, live);
		try {
			await live.init();
		} catch (e) {
			live.client.kill();
			this.lives.delete(live.info.liveId);
			this.syncProjectWatches();
			overlay?.remove();
			throw e;
		}
		// A mode the page asked for is what the user picked for this conversation; its file is known now.
		if (requested) this.rememberApproval(live, requested);
		// The mode it runs in is the one it is reopened in, until it is switched (the default for new chats is not).
		this.rememberLaunchMode(live);
		// What it was given of the model guidance is kept under that file too, so that it holds when the conversation is resumed.
		if (guidance) this.rememberGuidance(live, guidance);
		// The same of unattended mode (#646).
		if (unattended) this.rememberUnattended(live, true);
		await live.untilGuidanceSaid();
		await live.untilUnattendedSaid();
		this.announce(live);
		return live;
	}

	/**
	 * This server as a process: the owner of the records of the conversations it holds, which no other server may take
	 * while it runs (see `ParkedRecord.owner`).
	 */
	self(): Promise<ProcessRef | null> {
		this.selfRef ??= referenceTo(process.pid);
		return this.selfRef;
	}

	/**
	 * Take over the conversations a former server left running (see parked.ts), before anything is served. Each is
	 * connected to again and is as it was: a paused one frozen, one that was waiting out a usage limit going. One that
	 * cannot be — its relay is gone, so omp has lost its pipes — is ended: its conversation is an ordinary one again,
	 * resumed from its session file when opened.
	 * Then the relays a server that was killed left working are waited for (`untilOrphansEnd`).
	 * Returns how many were taken over.
	 */
	async adopt(): Promise<number> {
		const taken = await Promise.all(this.parked.list().map((record) => this.adoptRecord(record)));
		await this.untilOrphansEnd();
		this.collectAgentDirs();
		// Every relay that is still running (a kept conversation's, taken over above) has its socket on a command line.
		await sweepRelayDir(this.cfg.dataDir);
		return taken.filter(Boolean).length;
	}

	/**
	 * A server that was killed (SIGKILL, out of memory, a crash) leaves relays whose omp may be working: each stops it
	 * within seconds (relay.ts), and until it has, that omp writes to its session file. The page restores the conversation
	 * it showed, which is the one the killed server was running, so nothing is served before they have ended: the relays
	 * in the relay directory that hold no conversation of this server (or of another one that still runs) are waited for,
	 * at most `ORPHAN_WAIT_MS`. One that does not end is reported and left, not waited for any longer.
	 */
	private async untilOrphansEnd(): Promise<void> {
		const records = this.parked.list();
		const owned = await Promise.all(records.map((r) => (r.owner ? runsAs(r.owner) : false)));
		const held = new Set(records.filter((_, i) => owned[i]).map((r) => r.socket));
		for (const l of this.lives.values()) {
			const socket = l.client.relay?.socket;
			if (socket) held.add(socket);
		}
		const deadline = Date.now() + ORPHAN_WAIT_MS;
		for (;;) {
			const left = (await runningRelays(this.cfg.dataDir)).filter((socket) => !held.has(socket));
			if (left.length === 0) return;
			if (Date.now() >= deadline) {
				console.error(
					`omp-webui: ${left.length} omp relay(s) of an earlier server still run (${left.join(", ")}); starting anyway`,
				);
				return;
			}
			await Bun.sleep(100);
		}
	}

	/**
	 * Have the mode remove the agent directories that no process uses (see `writeOfflineAgent`): the ones of the
	 * processes running here, and of every paused conversation on record, which outlives the server and is resumed in
	 * the directory it was started in (one held by another running server counts too).
	 */
	private collectAgentDirs(): void {
		if (!this.modes?.collect) return;
		const inUse = [
			...[...this.lives.values()].filter((l) => !l.info.exited).map((l) => l.env.PI_CODING_AGENT_DIR),
			...this.parked.list().map((r) => r.env.PI_CODING_AGENT_DIR),
		].filter((dir): dir is string => typeof dir === "string");
		try {
			this.modes.collect(inUse);
		} catch (e) {
			console.error(`omp-webui: could not clean up the offline agent directories: ${(e as Error).message}`);
		}
	}

	private async adoptRecord(record: ParkedRecord): Promise<boolean> {
		const [owner, relay, omp] = await Promise.all([
			record.owner ? runsAs(record.owner) : false,
			runsAs(record.relay),
			runsAs(record.omp),
		]);
		// A server that is running holds its conversations: they are not left over.
		if (owner) return false;
		// Both must be the recorded processes, not whatever got their ids since.
		if (relay && omp) {
			try {
				await this.attach(record);
				return true;
			} catch (e) {
				console.error(`omp-webui: could not take over the kept conversation ${record.liveId}: ${(e as Error).message}`);
			}
		}
		await this.discard(record);
		return false;
	}

	private async attach(record: ParkedRecord): Promise<void> {
		const overlay =
			record.overlay && this.approval
				? this.approval.restore(
						record.overlay.file,
						record.overlay.mode,
						record.overlay.wait ?? null,
						parseConversationModels(record.overlay.models),
						record.overlay.absent ?? [],
						record.overlay.pins ?? {},
						record.overlay.absentAgents ?? [],
						record.overlay.compact ?? null,
					)
				: null;
		const live = new Live(
			record.liveId,
			this.cfg,
			record.cwd,
			record.args,
			this,
			record.sessionFile,
			false,
			{
				mode: record.mode,
				...(record.lightModels ? { lightModels: record.lightModels } : {}),
				args: [],
				env: record.env,
			},
			overlay,
			{
				via: { kind: "adopt", socket: record.socket },
				restored: record,
				ownArgs: record.ownArgs ?? [],
				// The record's own word, else what was kept with the conversation (a record that was damaged is read as having none).
				guard: stricterKept(recordKept(record), this.keptGuard(record.sessionFile)),
			},
		);
		try {
			await live.adopt(record.omp.pid);
		} catch (e) {
			live.client.detach();
			throw e;
		}
		this.lives.set(live.info.liveId, live);
		this.announce(live);
		// The roles of the config may have changed while the server was away: the record's are worked out again.
		if (overlay?.models) void live.refreshModelRoles().catch(() => {});
	}

	/** A recorded conversation that cannot be taken over: end what is left of it and forget it. */
	private async discard(record: ParkedRecord): Promise<void> {
		// Its relay is gone, and with it omp's stdin and stdout: nobody can talk to it. omp itself may be gone too.
		await endRemnants(record.omp, record.descendants);
		if (await runsAs(record.relay)) {
			try {
				process.kill(record.relay.pid, "SIGTERM");
			} catch {
				// already gone
			}
		}
		rmSync(record.socket, { force: true });
		if (record.overlay) removeOverlayFiles(record.overlay.file);
		this.parked.remove(record.liveId);
	}

	/**
	 * The server is ending: leave the conversations that outlive it running in the background for the next server to
	 * find — the paused ones frozen, the ones waiting out a usage limit going (see `Live.kept`). Returns how many stay;
	 * `shutdown` ends the rest.
	 */
	async parkKept(): Promise<number> {
		this.stopping = true;
		this.syncProjectWatches();
		const parked: Live[] = [];
		await Promise.all(
			[...this.lives.values()].map(async (live) => {
				if (await live.park()) parked.push(live);
			}),
		);
		for (const live of parked) this.lives.delete(live.info.liveId);
		return parked.length;
	}

	/**
	 * End every conversation that would outlive the server (see `Live.kept`): a paused one would stay frozen in the
	 * background and a waiting one would sleep through its usage limit and carry on unattended. A paused omp runs again to
	 * read its closed stdin and exit, and is stopped if it was working (see `Live.end`); one that waits is stopped.
	 */
	async endKept(): Promise<number> {
		const kept = [...this.lives.values()].filter((l) => l.kept);
		await Promise.all(
			kept.map(async (live) => {
				const waiting = live.info.pausedAt === null;
				await live.end("server");
				// Closing it would leave it asleep until the reset, and then it would retry the turn nobody is there for.
				if (waiting) live.client.kill();
			}),
		);
		return kept.length;
	}

	/** Close surplus processes (see `surplus`); they exit and leave the pool through `forget`. */
	private reap(): void {
		const now = Date.now();
		// Closing a process that is still starting fails the open that waits for it ("omp exited (code 0)").
		// A spare being taken over by an `open` is not surplus: closing it then fails that open ("not running").
		const open = [...this.lives.values()].filter(
			(l) => !l.info.exited && !l.client.closing && !this.claimed.has(l) && now - l.info.startedAt > this.startingMs,
		);
		// The reaper's end is the server's doing, and the page is told so (#472): a clean exit of the server's own
		// making must not read as a crash of omp's.
		for (const l of surplus(open, now)) l.closeBecause("idle");
	}

	/**
	 * Stop every omp process and what it started. An idle omp is closed (its stdin) and given time to
	 * finish writing; one that is working would ignore that until it is done, so it gets SIGTERM at once.
	 * Whatever still runs after that — omp itself, or the helpers and tools it left behind — is killed.
	 */
	async shutdown(closeGraceMs = CLOSE_GRACE_MS, termGraceMs = TERM_GRACE_MS): Promise<void> {
		this.stopping = true;
		this.syncProjectWatches();
		const lives = [...this.lives.values()];
		// What runs under each omp now: its tools start sessions of their own, out of reach of a group signal.
		let trees = new Map<number, number[]>();
		try {
			trees = await processTrees(lives.flatMap((l) => l.client.pid ?? []));
		} catch {
			// No process listing: the process groups are still stopped.
		}
		await Promise.all(
			lives.map(async (l) => {
				// A frozen process would never read the closed stdin.
				await l.resume();
				l.closeBecause("server");
			}),
		);
		const working = lives.filter((l) => l.busy);
		for (const l of working) l.client.kill();
		const idle = lives.filter((l) => !working.includes(l));
		await Promise.race([Promise.all(idle.map((l) => l.client.whenExited)), Bun.sleep(closeGraceMs)]);
		for (const l of idle) if (l.client.running) l.client.kill();

		const left = (l: Live): boolean => {
			const pid = l.client.pid;
			return l.client.running || (pid !== null && (exists(-pid) || (trees.get(pid) ?? []).some(exists)));
		};
		const deadline = Date.now() + termGraceMs;
		while (lives.some(left) && Date.now() < deadline) await Bun.sleep(20);
		const stragglers = lives.filter(left);
		// Still there: they may have started more since the listing.
		let fresh = new Map<number, number[]>();
		try {
			fresh = await processTrees(stragglers.flatMap((l) => (l.client.running ? (l.client.pid ?? []) : [])));
		} catch {
			// keep the earlier listing
		}
		for (const l of stragglers) {
			const pid = l.client.pid;
			const tree = pid === null ? [] : [...new Set([...(trees.get(pid) ?? [pid]), ...(fresh.get(pid) ?? [])])];
			l.client.kill("SIGKILL");
			signalAll(tree, "SIGKILL");
		}
		// The relays remove their sockets as they go (one that was killed cannot: `sweepRelayDir`); a directory left empty is not kept.
		if (lives.length) await Bun.sleep(100);
		await sweepRelayDir(this.cfg.dataDir);
		pruneRelayDir(this.cfg.dataDir);
	}
}
