/**
 * Wire contract between the omp-webui server and the browser.
 *
 * omp frames (RPC responses, session events, extension UI requests, subagent
 * frames…) are forwarded verbatim as `OmpFrame` so new omp event kinds reach
 * the browser without server changes. The server only adds its own envelope.
 */

import type { ApprovalMode } from "./approval.ts";
import type { CompactAt } from "./compact-at.ts";
import type { CompactEnded, CompactQueued, CompactWhere } from "./compact-queue.ts";
import type { ErrorInfo, ErrorParams } from "./error-info.ts";
import type { ExitReport } from "./exit.ts";
import type { Goal } from "./goal.ts";
import type { GuardConfig, GuardDecision, GuardOverride, LiveGuard } from "./guard.ts";
import type { GuardRules } from "./guard-policy.ts";
import type { AttachedHold } from "./held-state.ts";
import type { HostPoint, HostProc } from "./host.ts";
import type { ConversationModels } from "./model-config.ts";
import type { LiveGuidance, SessionGuidance } from "./model-guidance.ts";
import type { LightModels, Mode, ModeState } from "./offline.ts";
import type { OmpState } from "./omp-install.ts";
import type { PanelState } from "./panel-state.ts";
import type { PrefsSnapshot } from "./prefs.ts";
import type { LiveQuotaHold } from "./quota-floor.ts";
import type { RemoteStatus } from "./remote.ts";
import type { SessionSettings } from "./session-defaults.ts";
import type { SleepNote } from "./sleep.ts";
import type { LiveUnattended, QuestionCounts, QuestionDropNote } from "./unattended.ts";
import type { AppUpdateState } from "./update.ts";

export type OmpFrame = { type: string; [key: string]: unknown };

/**
 * How a live omp process is started. `model` (`provider/id`) overrides the
 * session's saved model, like `omp --resume <file> --model <model>`.
 *
 * `mode`: Full or Light for the process (see `shared/offline.ts`). Absent, a new conversation starts in the mode the
 * server keeps for new chats (`ModeState.mode`), and a resumed one in the mode the conversation last ran in (kept by the
 * server per session file), else in that same default.
 */
export type OpenTarget =
	/**
	 * `cwd`: where the conversation's process ran. omp writes a session file only with the
	 * first assistant message; if it never was, a fresh session starts there instead.
	 * `folder`: the folder the user chose to continue in when the one the conversation recorded is gone (the
	 * server refuses to open it otherwise, see `sessionFolderGone`); ignored while the recorded folder exists.
	 */
	| { kind: "resume"; sessionFile: string; model?: string; cwd?: string; folder?: string; mode?: Mode }
	/**
	 * `approvalMode`: how the conversation starts out; the user's default applies without it. `guard`: the conversation's
	 * own settings of "Guard dangerous commands", over the global ones (see `GuardOverride`); the server refuses it from
	 * a page that is not on this computer, and the global settings apply without it.
	 *
	 * `guidance`: what the main agent is told of how to use models for subagents in this conversation (#641), by template
	 * id or as text (see `SessionGuidance`); absent, or empty, is none. It is kept with the conversation, so a resumed one
	 * carries what it was given without the page saying it again.
	 */
	| {
			kind: "new";
			cwd: string;
			args?: string[];
			approvalMode?: ApprovalMode;
			guard?: GuardOverride;
			guidance?: SessionGuidance;
			/** Whether the conversation starts unattended (#646); absent: it does not. */
			unattended?: boolean;
			mode?: Mode;
	  };

/**
 * What a `set_mode` asked of a conversation came to. `switched`: its omp was restarted in the new mode, and `liveId` is the
 * process that runs it now. `pending`: it works or waits for an answer, so the switch is made when the turn has ended
 * (`LiveInfo.modeSwitch`). `unchanged`: it already runs in that mode (a switch that waited is cancelled).
 */
export type ModeSwitchReply =
	| { state: "switched"; liveId: string }
	| { state: "pending"; mode: Mode }
	| { state: "unchanged" };

/**
 * omp backing off before it retries a failed turn (`auto_retry_start` until `auto_retry_end`): what omp announced,
 * kept by the server so that a tab that attaches meanwhile shows the same countdown.
 */
export interface LiveRetry {
	attempt: number;
	maxAttempts: number;
	/** How long omp waits before the retry, as it announced. */
	delayMs: number;
	/** Epoch ms at which the server was told of the wait: the countdown runs from here. */
	startedAt: number;
	/** The failure was the provider's usage limit (omp's `errorId` flag): the wait is for its quota to reset. */
	usageLimit: boolean;
	/**
	 * omp has started the retried turn (`agent_start` after the announcement): the wait is over and only its end frame is
	 * still to come. Not `LiveInfo.streaming`, which omp reports as true for the whole backoff.
	 */
	resumed: boolean;
}

export interface LiveInfo {
	liveId: string;
	pid: number | null;
	cwd: string;
	sessionFile: string | null;
	sessionId: string | null;
	args: string[];
	startedAt: number;
	streaming: boolean;
	/**
	 * A dialog (a tool approval, a question) or a tool call of the web UI waits for the user's answer; absent otherwise.
	 * Only the pages that listen to a process hear its dialogs, so the server says when this changes in the `live` frame
	 * every page is told of: a page that listens to nothing of this process still lists it as waiting for an answer, and
	 * counts it in its tab title (#592).
	 */
	asking?: boolean;
	/**
	 * A turn of an active goal ended and the next one has not begun: `streaming` is false between them though the run
	 * goes on (omp says it is over with `session_settled`). Told for the same reason as `asking`; absent otherwise.
	 */
	continuing?: boolean;
	/**
	 * When the turn that runs began (server clock), absent between turns. A page that attached after the turn began has
	 * no clock of its own for it (`web/src/store/turn-clock.ts` takes its marks from the frames it hears), and without this
	 * would count the time worked up to the last saved entry only: two pages would show two figures for one turn (#587).
	 * A turn that omp continues by itself (`agent_end` with `isTerminal: false`) keeps the stamp of the one it continues.
	 */
	turnStartedAt?: number;
	exited: boolean;
	subscribers: number;
	/**
	 * The process runs without the gate of "Guard dangerous commands" (and "Confirm risky commands"), so its risky calls are not
	 * looked at: `inherited` when this server took the process over (it was started by an older version, or by a server that is gone:
	 * a paused conversation, a wait for a usage limit) and cannot give it the gate until it is opened again; `chosen` when this server
	 * started it without (the user's own `--trusted-extension`, or the gate's files could not be written). Absent: it is covered.
	 */
	ungated?: "inherited" | "chosen";
	/**
	 * What "Guard dangerous commands" does for this conversation: the global settings with the conversation's own choices over
	 * them (`LiveGuard`). Every page is told it, so that one that cannot change it (a page that is not this computer's) shows it;
	 * it moves when the global settings do, for a conversation that follows them. Absent where the app has no guard.
	 */
	guard?: LiveGuard;
	/** When the omp process tree was frozen (pause), else null. */
	pausedAt: number | null;
	/**
	 * When this process ran again after a pause (server clock), absent until it did and again once it is paused. A page
	 * that attached after the resume cannot have seen it, and omp's grace for what came due while it was frozen (a retry
	 * wait) starts here (#602).
	 */
	resumedAt?: number;
	/** Whether tool calls wait for the user (`tools.approvalMode`); absent where the server cannot say. */
	approvalMode?: ApprovalMode;
	/**
	 * omp's own `tools.approvalMode`, when the process runs in it and it is none of the modes the web UI can set (a
	 * newer omp's): `approvalMode` is absent then. Gone once the user picks a mode.
	 */
	approvalOmp?: string;
	/** The mode the process was started in (see shared/offline.ts); it keeps it for its whole life. */
	mode: Mode;
	/** What a Light process's models are (`local`: one local server's); absent in Full. */
	lightModels?: LightModels;
	/**
	 * A switch to the other mode, asked for in This session and waiting for the turn to end (`to`), or one that could not be
	 * made (`failed`: why; the conversation went on in the mode it had). Absent when none. Held by the server, so every page
	 * shows it, and the switch does not need a page to be open when the turn ends.
	 */
	modeSwitch?: { to: Mode; failed?: { message: string } & Partial<ErrorInfo> };
	/** Set while omp backs off before a retry of its own (see `LiveRetry`). */
	retry?: LiveRetry;
	/**
	 * The Mac slept while this worked (#647): its window, and what came of the turn. Process state, not a frame, so a page
	 * that attaches after the wake shows it too.
	 */
	slept?: SleepNote;
	/**
	 * Unattended mode could not keep the conversation's last filed question (#650): why, and what was asked ("" when the call
	 * named no question). Process state, not a frame, so a page that attaches after it — or one that was not listening — shows
	 * it too. One at a time: a second failure replaces it, and it goes with the next question that is kept, the mode's switch,
	 * or the process. The model was told it was recorded all the same, so this is the only word of it the person gets.
	 */
	questionDropped?: QuestionDropNote;
	/**
	 * What this process was told of `retry.waitForUsageReset`, omp's own switch for sleeping through a provider's usage
	 * limit: true or false where the conversation's choice differs from omp's setting; absent when omp's own decides.
	 */
	usageResetWait?: boolean;
	/**
	 * Where this conversation compacts (see `shared/compact-at.ts`), where that is its own point: a share of the model's
	 * window or a count of tokens, held by this process's overlay. Absent while omp's own configuration decides (Default).
	 */
	compactAt?: CompactAt;
	/**
	 * A compact asked for while the agent worked (#651), and the follow-ups held back behind it (see `shared/compact-queue.ts`):
	 * held by the server, so every page shows it, a reload keeps it and a handoff does not end it. Absent when none waits.
	 */
	compactQueued?: CompactQueued;
	/** How the last queued compact ended, until the next one ends (see `CompactEnded`); absent before the first. */
	compactEnded?: CompactEnded;
	/**
	 * A soft stop asked for (#658): when the turn that runs ends, the server ends the process (`ExitReason` "softStop"); the
	 * agent was asked to write a handoff as that turn's last message. Absent when none waits.
	 */
	softStop?: { at: number };
	/**
	 * What this process was told of the session controls omp cannot report (auto-retry, cache warming: see
	 * `UNREPORTED`), which it uses over what its configuration says. Only what was told is here, so a control that is
	 * absent follows the configuration. Every page is told with the rest of the info, so a value chosen on one page
	 * is the one the others show.
	 */
	sessionSettings?: SessionSettings;
	/**
	 * The model roles of a conversation that was switched to a preset (see `ConversationModels`); absent while it follows
	 * the global config. Held by this process's own settings overlay, so no other conversation sees them.
	 */
	models?: ConversationModels;
	/**
	 * What this conversation's main agent is told of how to use models for subagents (#641), when it was given anything:
	 * the template or the text, whether a change reaches this process without a restart, and why not when it does not
	 * (see `LiveGuidance`). Absent: the conversation carries none.
	 */
	guidance?: LiveGuidance;
	/**
	 * Whether this conversation is unattended (#646: the person is away, and what needs them is filed as a question), and
	 * whether its omp carries the instruction and the question tool (see `LiveUnattended`). Absent: it is not unattended.
	 */
	unattended?: LiveUnattended;
	/**
	 * This conversation reached the quota floor of its provider (#652, `shared/quota-floor.ts`): why it is held, which
	 * provider and window, when that frees up, and what happens to the prompt cache meanwhile. Process state, not a
	 * frame, so a page that attaches while it is held shows it too. Absent: the provider is above its floor, has none,
	 * or the conversation is not working.
	 */
	quotaHold?: LiveQuotaHold;
	/**
	 * Moves whenever omp does something that could change an entry it already wrote: every frame but the streamed ones that
	 * cannot (see `server/omp/in-flight.ts`). A page that attaches again on its connection (it came back to the
	 * conversation) and finds the revision it last saw knows no entry was rewritten while it was away and reads only what
	 * came after its last one (`get_entries since`); another revision, or none, and it reads everything again. So does a
	 * page whose connection was lost, whatever the revision says: a rewrite no frame announced is not in it. Only the
	 * equality means anything: it starts from the server's clock for each process. Absent where the server cannot say.
	 */
	revision?: number;
	/**
	 * How the process ended, when it has ended: who ended it (the server, or omp itself) and why the server did.
	 *
	 * The idle reaper closes the processes nobody watches, and the `live_exit` frame that says how it ended reaches only
	 * the subscribers — so it reaches nobody. The end is said here instead, in the `live` frame every page is told of,
	 * and in the reply to an `attach` for a process that is gone (#515). Absent while the process runs.
	 */
	exit?: ExitReport;
}

/**
 * What `open` and `attach` reply with: the process, and the goal omp holds as the server last heard of it (from
 * `goal_updated` frames and `get_state`; absent when there is none). A page that attaches to a paused conversation cannot
 * ask omp, which is frozen, so this is what it shows until omp can say (see `Live.goal`).
 *
 * `subagents`: only for a paused conversation, omp's registry of its subagents (`get_subagents`) as it was when omp was
 * frozen: the page cannot ask, and a page that was not there when the conversation was paused has no frame to know them
 * by (see `Live.subagents`). Absent for one that runs, which the page asks itself.
 *
 * `state`: only for a paused conversation, what omp reported of the settings the session panel shows (`PanelState`) when
 * it was frozen, kept true to what a user's action changed meanwhile: a page that attaches cannot ask, and would show the
 * panel with no row chosen (see `Live.attached`). Absent for one that runs, which the page asks itself.
 */
export type LiveAttached = LiveInfo & { goal?: Goal; subagents?: unknown[]; state?: PanelState };

/**
 * Why a conversation is `busy`: it is `working` (a turn, a running command, a retry; it ends by itself), it is
 * `asking` (a dialog or an approval waits for the user's answer), or it is `paused` (frozen until resumed or ended).
 * What to do about each differs, so what an update waits for, or a restart refuses over, is told apart by it.
 */
export type Holding = "working" | "asking" | "paused";

/** A live process as `/api/lives` and `list_lives` report it. */
export interface LiveListing extends LiveInfo {
	/**
	 * omp is working or waiting for your answer — a turn, a running command, an open dialog, or the process is
	 * paused — so ending it now cuts something off. The macOS app asks before quitting while any is busy.
	 */
	busy: boolean;
	/** Which of those it is, null while it is not busy. A paused conversation is `paused` whatever else is open on it. */
	holding: Holding | null;
}

/**
 * What a usage window applies to (omp's `UsageScope`, the part that decides it). Absent or empty: the whole account.
 * `tier` is a model family (`opus`, `sonnet`, … for Anthropic) or a plan name, `modelId` one model; a window with
 * either that is not `shared` is spent by those models only.
 */
export interface UsageScope {
	shared?: boolean;
	tier?: string;
	modelId?: string;
}

/** One usage window from `omp usage --json` (fields omp may omit are optional). */
export interface UsageLimit {
	id: string;
	label: string;
	window?: { id?: string; label?: string; durationMs?: number; resetsAt?: number };
	amount: {
		used?: number;
		limit?: number;
		remaining?: number;
		usedFraction?: number;
		remainingFraction?: number;
		unit?: string;
	};
	status?: string;
	scope?: UsageScope;
}

export interface UsageReport {
	provider: string;
	fetchedAt?: number;
	limits: UsageLimit[];
	/** Which account of the provider this report is for (`omp usage` returns one report per account). */
	metadata?: { email?: string };
}

/**
 * The largest WebSocket message the server accepts: Bun closes the socket on anything bigger (its default
 * is 16 MiB). A prompt carries its images base64-encoded in one message, so the composer keeps the total
 * of its attachments below this.
 */
export const MAX_WS_MESSAGE_BYTES = 32 * 1024 * 1024;

// ---------------------------------------------------------------- client → server

export type ClientMessage =
	| { t: "open"; req: string; target: OpenTarget }
	| { t: "attach"; req: string; liveId: string }
	| { t: "detach"; liveId: string }
	| { t: "close"; req: string; liveId: string }
	/**
	 * `user`: the command is the page's answer to a click, which a paused conversation answers (see `Live.rpc`).
	 * `ack`: tell the page, by an `ack` message, as soon as the command is in omp's hands. For commands omp may hold
	 * before it answers (a prompt behind a compaction): the page then bounds the acknowledgement, not the answer.
	 * `slim`: the answer is stripped of what the page does not read of it — the system prompt and the bodies of the
	 * tool schemas (their names are kept). A routine state read asks for it: the whole prompt and every schema are
	 * tens of KB over the WebSocket and parsed on the browser's main thread for a page that reads neither. A consumer
	 * that reads them (a tool's schema) asks without it and gets the whole answer (see `shared/slim.ts`).
	 * `stop`: the command (`abort`, `abort_and_restore_queue`, `abort_bash`) is the Stop button's: the server carries it through
	 * until the conversation has stopped, or its omp has been ended (`Live.stop`). Any other `abort` is omp's plain command.
	 */
	| {
			t: "rpc";
			req: string;
			liveId: string;
			command: Record<string, unknown>;
			user?: true;
			ack?: true;
			slim?: true;
			stop?: true;
	  }
	| { t: "ui_response"; liveId: string; response: Record<string, unknown> }
	| { t: "list_lives"; req: string }
	/** Freeze / continue the omp process and everything it started (all agents, running tools). */
	| { t: "pause"; req: string; liveId: string }
	| { t: "resume"; req: string; liveId: string }
	/** Change what the process asks approval for; takes effect on its next tool call. Replies with its `LiveInfo`. */
	| { t: "approval_mode"; req: string; liveId: string; mode: ApprovalMode }
	/**
	 * Switch this conversation to Full or Light (This session): its omp ends and the same session file is resumed in the new
	 * mode. While the conversation works or waits for an answer the switch waits for the turn to end (`LiveInfo.modeSwitch`);
	 * a paused one is refused. Replies with a `ModeSwitchReply`; asking for the mode the process has cancels a switch that waits.
	 */
	| { t: "set_mode"; req: string; liveId: string; mode: Mode }
	/**
	 * Switch this conversation to the global preset `name`: its model and the roles its subagents resolve change for this
	 * conversation only, and omp's global config is left as it is. Replies with its `LiveInfo`.
	 */
	| { t: "model_preset"; req: string; liveId: string; name: string }
	/**
	 * Retry the turn omp is backing off before now, without waiting for the countdown: omp's `abort_retry`, then its own
	 * `/retry`. Also for a conversation whose failed turn is waiting for the user to retry it. Replies with its `LiveInfo`.
	 */
	| { t: "retry_now"; req: string; liveId: string }
	/**
	 * "Continue anyway" (`on`) past the provider's quota floor, or hold again (`off`): a conversation that was told to
	 * continue ignores the floor until the provider is above it again (#652). Replies with its `LiveInfo`.
	 */
	| { t: "quota_override"; req: string; liveId: string; on: boolean }
	/**
	 * Compact when it loses no work (#651), with the note the summary must keep: held by the server until then (`Live.compactQueue`).
	 * `where` says where: when the turn that runs has ended (`turn`, the default), or between two of its steps (`step`), as far as
	 * the conversation can be held there (`CompactQueued.stepUnavailable` says when it cannot). When no turn runs it is sent at
	 * once. Replies with its `LiveInfo`.
	 */
	| { t: "compact_queue"; req: string; liveId: string; customInstructions?: string; where?: CompactWhere }
	/** Take back a queued compact that has not started; what was held behind it is sent to omp. Replies with its `LiveInfo`. */
	| { t: "compact_cancel"; req: string; liveId: string }
	/** Soft stop (#658): end the process when the turn that runs has ended (`on: false` takes it back). Replies with its `LiveInfo`. */
	| { t: "soft_stop"; req: string; liveId: string; on: boolean }
	/**
	 * Start a terminal: `omp <args>`, or with `shell` (and no `args`) the person's login shell, for the panel's Terminal
	 * tab. A page that is not on this computer is refused a shell when Settings › Remote access turned them off.
	 */
	| {
			t: "pty_open";
			req: string;
			args: string[];
			cwd?: string;
			cols: number;
			rows: number;
			shell?: boolean;
			/** For a shell: the conversation it is for, given back by `pty_held` after Run in Background. */
			tag?: string;
	  }
	/**
	 * The terminals the macOS app's last Run in Background left for this window to take over (`PtyManager.held`): replies
	 * `{ terminals: [{ ptyId, args, cwd, shell?, tag?, exited? }] }`. Only a page of this computer is given any.
	 */
	| { t: "pty_held"; req: string }
	/**
	 * Take over a held terminal: replies `{ replay, exited? }`, the tail of what it printed (to draw) and how it ended when it did.
	 * The page is told what it prints from then on; `pty_input` and `pty_resize` are its own. Refused for one that is not held.
	 */
	| { t: "pty_attach"; req: string; ptyId: string }
	| { t: "pty_input"; ptyId: string; data: string }
	| { t: "pty_resize"; ptyId: string; cols: number; rows: number }
	| { t: "pty_kill"; ptyId: string }
	/** Forget what the terminal printed that a page attaching later is given (the Terminal tab's Clear): empties the kept tail. */
	| { t: "pty_clear"; ptyId: string }
	/**
	 * The Files tab shows these folders (relative to the conversation's own, "" for it): the server watches them and says
	 * `folder_changed` when something in one changes. Replaces the earlier set of this page; an empty one (the tab closed)
	 * watches nothing. A conversation is named as `GET /api/folder/*` names one.
	 */
	| { t: "folder_watch"; live?: string; file?: string; dirs: string[] }
	/**
	 * Whether this page shows the host's load (the sidebar's indicator, the Host tab), and is to be told each look.
	 * `detail`: this page shows the graphs of the load (the sidebar's popover, the Host tab), not only the line of figures
	 * (the sidebar's indicator alone): the server samples at its live pace while some page does, and at its background
	 * pace for one that shows only the line (or for nobody), so that a page left open is no reason to look every 2 s. The
	 * first look after a page starts watching comes within a pace either way; what the server already has is `GET
	 * /api/host`. `procs`: this page also shows what omp, the relays and the server use, which costs a listing of
	 * processes per sample (the pace is `detail`'s, not this). Replaces what this page said before; `on: false` (the
	 * page is hidden, or the indicator is gone) watches nothing.
	 */
	| { t: "host_watch"; on: boolean; detail?: boolean; procs?: boolean }
	/**
	 * Whether this page is in use, and which conversation it shows, for a device that has Web Push turned on (`shared/push.ts`):
	 * the server does not push a conversation to a device while one of its pages is in use (`visible`: its tab shown and its window
	 * focused) and shows that conversation (`liveId`, `file`: by its process and by its file, `null` for none; neither key: a page
	 * that does not say, which counts as showing every conversation), and believes a page that said `visible` for
	 * `PUSH_PRESENCE_TTL_MS` after the last time it did. Said when the page's focus, visibility or view changes, when the socket
	 * opens, and every `PUSH_HEARTBEAT_MS` while in use.
	 */
	| { t: "presence"; device: string; visible: boolean; liveId?: string | null; file?: string | null };

// ---------------------------------------------------------------- server → client

export type ServerMessage =
	/** `time`: the server's clock (epoch ms) as the connection opened, for times the server stamps (`LiveRetry.startedAt`). */
	| { t: "hello"; ompVersion: string; serverVersion: string; time: number }
	| { t: "reply"; req: string; ok: true; data?: unknown }
	/** `code` and `params`: what the page words an error from, when it is one the user is meant to read (`shared/error-info.ts`). */
	| { t: "reply"; req: string; ok: false; error: string; code?: string; params?: ErrorParams }
	/** The server handed request `req` to omp, which has not answered yet (the page asked for it with `ack`). */
	| { t: "ack"; req: string }
	/** `rev`: `LiveInfo.revision` as it stood when the server sent the frame (not on frames replayed to a tab that just attached). */
	| { t: "frame"; liveId: string; frame: OmpFrame; rev?: number }
	/**
	 * What a tab that attached has been sent of what the server holds for it is complete: the pending dialogs (`dialogs`:
	 * the ids of all of them) and the message omp is writing (`message`: its id, null when none) were replayed as frames
	 * before this. A dialog or a half-written message the tab holds beyond this was settled while it was away. `held`
	 * says the same of what omp announced once and the server keeps (a compaction, the extensions' status lines and
	 * widgets, the `!commands` that run: see `AttachedHold`): they were replayed too, and what the tab shows beyond them
	 * ended while it was away. `held` may be absent from a server that predates it, which the page reads as nothing held.
	 */
	| { t: "attached"; liveId: string; dialogs: string[]; message: string | null; held?: AttachedHold }
	| { t: "live"; info: LiveInfo }
	/**
	 * The process of a conversation ended. `code` is null when a signal ended it, which is then `signal`.
	 *
	 * `by` says who ended it: `omp` (it ended on its own — a crash, a signal, an exit of its own) or `server` (the
	 * server asked for it: the idle reaper, a Close, a restart, the terminal hand-off, the server going away). The two
	 * are told apart because they mean different things to the reader: an omp that ended by itself is a fault to look
	 * into, while one the server closed is the server's doing and the conversation is simply not running. `reason` names
	 * which of the server's reasons it was, for the same reason.
	 */
	| ({ t: "live_exit"; liveId: string } & ExitReport)
	| { t: "lives"; list: LiveInfo[] }
	| { t: "pty_data"; ptyId: string; data: string }
	| { t: "pty_exit"; ptyId: string; code: number | null }
	| { t: "sessions_changed" }
	/** The loved models changed, from any page: every page shows the list as it is now (`provider/id`, newest first). */
	| { t: "favorite_models"; models: string[] }
	/** The questions of unattended mode (#646) changed, from any page or any conversation: what every page shows of them, as counts (the list is `GET /api/questions`). */
	| { t: "questions"; counts: QuestionCounts }
	/** The sidebar's project groups changed, from any page: every page asks for them again (`/api/project-groups`). */
	| { t: "project_groups" }
	/** omp's global config.yml was written (model roles, presets, settings): views of it refetch. */
	| { t: "model_config_changed" }
	/**
	 * The mode or the offline settings changed (in this or another tab): the whole state as it is now, which a tab
	 * applies instead of what it holds, so that its next change is made on top of this one and not of what it saw before.
	 */
	| { t: "mode_settings"; state: ModeState }
	/** The UI preferences (shared/prefs.ts) changed, from any page: every page shows them. */
	| { t: "prefs"; snapshot: PrefsSnapshot }
	/**
	 * "Guard dangerous commands" (shared/guard.ts) decided a call, in any conversation: said to the pages on this computer
	 * only (a remote page has no use for what other conversations were asked, and is refused the guard's API). The tool card
	 * of the call shows it, and one for want of a reviewer (`verdict: "unavailable"`) is a notice that offers Ask me.
	 */
	| { t: "guard_decision"; decision: GuardDecision }
	/**
	 * The guard's settings changed, from any page on this computer: every such page shows them. `rules` (what the person
	 * tuned: the reviewer's rules, a threshold per category, their benchmark cases) comes with it when those changed.
	 */
	| { t: "guard_config"; config: GuardConfig; rules?: GuardRules }
	/** omp itself changed: found or installed, a newer release known, an install or update's progress. */
	| { t: "omp"; state: OmpState }
	/** Output of the install or update that is running (its `job` id). */
	| { t: "omp_log"; job: string; text: string }
	/** The tunnel changed state (it started, connected or failed): the card in Settings says so without asking again. */
	| { t: "remote"; status: RemoteStatus }
	/** The list of saved Macs changed (`/api/meta` has it): the sidebar's machine switcher asks again, on every page. */
	| { t: "macs_changed" }
	/** The app's own updates changed (a check answered, an install moved on): sent to local pages only. */
	| { t: "app_update"; state: AppUpdateState }
	/** Something changed in a folder this page watches (`folder_watch`); `root` is the folder of the conversation, as `GET /api/folder/list` names it. */
	| { t: "folder_changed"; root: string }
	/**
	 * A look at the host's load, to the pages that watch it (`host_watch`). `minute`: the minute this look finished, as the
	 * coarse series holds it. `procs`: only to the pages that asked for them.
	 */
	| { t: "host_sample"; point: HostPoint; minute?: HostPoint; procs?: HostProc[] };

// ---------------------------------------------------------------- REST payloads

export interface SessionSummary {
	/** Absolute path of the session JSONL file (stable key). */
	file: string;
	id: string;
	title: string | null;
	/** First user prompt, used when there is no title. */
	preview: string;
	cwd: string;
	project: string;
	createdAt: string;
	modifiedAt: number;
	size: number;
	messageCount: number;
	userMessageCount: number;
	parentSession: string | null;
	models: string[];
	/**
	 * Everything the conversation spent: its own requests plus those of every subagent (nested ones included)
	 * and of its advisors (the passive reviewers omp runs beside the agent).
	 */
	usage: UsageTotals;
	/** The share of `usage` that subagents spent (the conversation's own is `usage` minus this and `advisorUsage`). */
	subagentUsage: UsageTotals;
	subagentCount: number;
	/** The share of `usage` that advisors spent: omp keeps their requests in `__advisor*.jsonl`, outside the transcript. */
	advisorUsage: UsageTotals;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: number;
	requests: number;
}

/** The most hits one search answers with (for the sidebar, which asks one a conversation: the most conversations). */
export const SEARCH_LIMIT_MAX = 200;

export interface SearchHit {
	file: string;
	entryId: string;
	role: string;
	snippet: string;
	timestamp: string;
	title: string | null;
	cwd: string;
	/** On a conversation's last returned hit: how many more of its messages match but are not in the response. */
	more?: number;
}

export interface SessionFileData {
	file: string;
	header: Record<string, unknown> | null;
	/**
	 * The file's entries. In a family (`/api/family`) a file after the first carries only those that no file before it has: a
	 * fork's file holds the whole path from the root, which is sent once.
	 */
	entries: SessionEntry[];
	/**
	 * Only in a family, and only for a file whose `entries` are fewer than it has: the id of every entry of the file, in the
	 * file's order (the entries themselves are in this file's `entries` or in an earlier one's). `restoreMembers` puts them back.
	 */
	order?: string[];
	/** Only in a family: the version of the file (and of its subagents' and advisors' transcripts) this was read at, which a client names in `x-family-have`. */
	tag?: string;
	/**
	 * Only in the answer to a request with `view`, for every member: the file's last entry (null: it has none), how many
	 * entries it has and the text of its last user prompt. A member of the family other than the one viewed has these and no
	 * entries; the one viewed has the window's entries as well.
	 */
	head?: string | null;
	total?: number;
	lastPrompt?: string;
	subagents: SubagentFile[];
	advisors: AdvisorFile[];
}

/**
 * The header a client of `/api/family` sets to be sent the entries the files of a family share only once: a fork holds
 * the whole path from the root copied, so a family of a long conversation and three of its forks is four times the
 * conversation. The client says it can put the shared entries back together (`restoreMembers`); the answer says so
 * too, so a client that did not ask for it is never given the shared path alone.
 */
export const FAMILY_DEDUP_HEADER = "x-family-dedup";

/**
 * The header a client of `/api/family` that sets `x-family-dedup` uses to say which members of the family it holds already:
 * the `tag` of each, comma separated. A member it names that has not changed is not sent again, only as a `KeptMember`: a
 * write to one fork of a conversation sends that fork, not the conversation and every other fork with it.
 */
export const FAMILY_HAVE_HEADER = "x-family-have";

/** A member of a family the client named in `x-family-have` and that is as it was: the client puts the one it holds, by `tag`, in its place. */
export interface KeptMember {
	file: string;
	tag: string;
	kept: true;
}

/**
 * What `/api/family` sends: the lineage's files, those the client holds as they are only by name.
 *
 * A request with `view` (`FamilyViewKind`) is answered with a window of the history instead of the lineage whole: see `FamilyView`.
 */
export interface FamilyDocument {
	/** The conversation's canonical path (symlinks resolved). */
	file: string;
	members: (SessionFileData | KeptMember)[];
	/** Only in the answer to a request with `view`: what the entries of the member `file` are of the conversation. */
	view?: FamilyView;
}

/**
 * The kinds of window of a conversation's history `/api/family?file=…&view=…` answers. Each is a stretch of one path of
 * the conversation's tree — entries oldest first, each the parent of the next — in the `entries` of the member whose
 * `file` is the document's; every other member has no entries, only what a list of the family needs.
 *
 * - `tail`: the end of the path to `leaf` (the file's last entry, unless `leaf` names another): what a conversation opens on.
 * - `before`: the stretch of the path just above the entry `at`, ending at its parent: the next older page.
 * - `after`: the stretch of the path from `at` towards `leaf` (the file's last entry unless named), starting at the child of `at`.
 * - `around`: the stretch that holds `at`, a few entries above it and some below, on the path to the last entry of the
 *   file when `at` is on it, else on the path to the newest entry under `at` (`leaf` names one anyway).
 * - `stats`: not a stretch: what the whole file's entries add up to (`FamilyStats`), as a `FamilyStatsDocument`.
 *
 * A stretch begins at a turn (a prompt) and ends before the next one, unless one turn is longer than a few windows, which is
 * cut before an assistant message: a tool call and its results are never apart.
 */
export type FamilyViewKind = "tail" | "before" | "after" | "around" | "stats";

/** The request parameters of a view, besides `file` and `view`. */
export interface FamilyViewParams {
	/** The entry `before`, `after` and `around` start from. */
	at?: string;
	/** The entry the path leads to; the file's last entry when absent. */
	leaf?: string;
	/** At most this many entries (the server's own budget when absent; bounded by it: a test narrows it). */
	limit?: number;
}

/**
 * What a window of the history says besides its entries. `earlier` and `later` are what the cursors are made of: the next
 * older page is `view=before&at=<first entry>`, the next newer one `view=after&at=<last entry>&leaf=<leaf>`.
 */
export interface FamilyView {
	kind: Exclude<FamilyViewKind, "stats">;
	/** The entry the path ends in: the file's last entry, or the one that was asked for, or that `around` found. Null: the file has no entries. */
	leaf: string | null;
	/** The file's last entry, whichever the path leads to. Null: it has no entries. */
	head: string | null;
	/** The path goes on above the first entry of the window. */
	earlier: boolean;
	/** The path goes on below the last entry of the window, to `leaf`. */
	later: boolean;
	/** What the path above the window leaves, for what a page derives from the whole path (see `PathAbove`). Not sent for `after`. */
	above?: PathAbove;
	/**
	 * What the whole path to `leaf` leaves, as `above` does for the path above the window: the last mode, thinking level and
	 * default model it was set to (the carry only, no prompts). For a page whose window stops short of `leaf` (`later`): the
	 * conversation's goal, model and thinking level are what its end leaves, not the window's. Sent for `tail` and `around`.
	 */
	end?: Pick<PathAbove, "carry">;
	/** The same for the file's last entry, when the window's leaf is another entry (a branch that is not the newest): what omp resumes with. */
	headEnd?: Pick<PathAbove, "carry">;
	/** The other versions of the window's entries (an edited prompt, a regenerated reply, another branch), by the parent they share. */
	versions: VersionGroup[];
}

/**
 * What the entries above a window leave, so that the page derives from the window what it derived from the whole path:
 * the conversation's goal, the model and thinking level it resumes with, and the history Up walks through.
 */
export interface PathAbove {
	/**
	 * Oldest first, of the path above the window only, and each the last of its kind: the last `mode_change`, the last
	 * `thinking_level_change`, the last `model_change` of the default role (absent role or `default`) and — only when
	 * there is none — the last assistant message, as a stub of its `role`, `provider` and `model`.
	 */
	carry: SessionEntry[];
	/** The prompts and `!commands` sent above the window, as `promptsOf` reads them (a repeat in a row once), oldest first; at most `PATH_ABOVE_PROMPTS`. */
	prompts: string[];
}

/** The most prompts `PathAbove` holds. */
export const PATH_ABOVE_PROMPTS = 100;

/**
 * The entries that share a parent with an entry of the window, and where each leads. Only parents with more than one child
 * in the family (any member file) are listed.
 */
export interface VersionGroup {
	/** The parent they share; null for the entries that have none. */
	parent: string | null;
	/** The versions that are not in the window, each as the entry itself (in the order they were written). */
	entries: SessionEntry[];
	/**
	 * For every version of the parent — those of `entries` and the one of the window — the newest entry under it in the family
	 * (the entry with the latest timestamp, the one written last among equals) and the files that hold that entry, which is
	 * where a page goes to show that version.
	 */
	leads: Record<string, { leaf: string; files: string[] }>;
}

/** What a file's entries add up to (`view=stats`), the figures the page cannot take from the window it holds. */
export interface FamilyStats {
	/** The last entry of the file these figures include (it keeps growing: the page adds the entries after this one). */
	through: string | null;
	/** What the requests of the file's assistant messages and `model_usage` entries used and cost. */
	usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number };
	/** By model (`provider/model`), in the order each first appeared: tokens (`totalTokens`), cost and requests. */
	byModel: [string, { tokens: number; cost: number; n: number }][];
	/** How long the agent worked, as `activeMs` counts: finished turns, and the one still open (`start`, and the latest time in it, `end`). */
	clock: { total: number; start: number | null; end: number };
}

/** What `/api/family?view=stats` sends. */
export interface FamilyStatsDocument {
	file: string;
	stats: FamilyStats;
}

/** One advisor's transcript (`__advisor.jsonl`, or `__advisor.<name>.jsonl` for a named one) and what it spent. */
export interface AdvisorFile {
	/** The advisor's name: `default` for the one without, else what follows `__advisor.` in the file name. */
	id: string;
	/** The subagent the advisor reviews, by id; empty for the conversation's own advisors. */
	agent: string;
	file: string;
	size: number;
	modifiedAt: number;
	/** When it started: its transcript header's timestamp (the modification time if it has none). */
	startedAt: number;
	/** What its requests used and cost, read from the transcript (once per revision of the file). */
	usage: UsageTotals;
	/** The providers its requests went to, from the same read; empty while it has not been read since providers were kept. */
	providers: string[];
}

export interface SubagentFile {
	/** Agent id (file stem), e.g. "EnvAudit"; a nested agent's id starts with its parent's: "Features.QuotaPill". */
	id: string;
	file: string;
	size: number;
	modifiedAt: number;
	/** When the subagent started: its transcript header's timestamp (the modification time if it has none). */
	startedAt: number;
	/** What its requests used and cost, read from the transcript (once per revision of the file). */
	usage: UsageTotals;
	/** The providers its requests went to, from the same read; empty while it has not been read since providers were kept. */
	providers: string[];
	/** How long it worked (#692): each of its turns from its prompt to its last entry before the next, summed. */
	activeMs: number;
}

export interface SessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	timestamp: string;
	[key: string]: unknown;
}

export interface CliFlag {
	name: string;
	short?: string;
	value?: string;
	description: string;
}

export interface CliCommand {
	name: string;
	description: string;
}

export interface CliInventory {
	version: string;
	commands: CliCommand[];
	flags: CliFlag[];
}

export interface CliHelp {
	command: string;
	description: string;
	usage: string;
	args: { name: string; description: string }[];
	flags: CliFlag[];
	subcommands: CliCommand[];
	raw: string;
}
