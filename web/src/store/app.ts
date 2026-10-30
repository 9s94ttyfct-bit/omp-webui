import type { ApprovalMode } from "@shared/approval.ts";
import type { ExitInfo, ExitReport } from "@shared/exit.ts";
import type { Goal } from "@shared/goal.ts";
import { hostResult, PROPOSE_GOAL_TOOL, readProposal } from "@shared/guided-goal.ts";
import { bashRunOf, EMPTY_HOLD } from "@shared/held-state.ts";
import type { PanelState } from "@shared/panel-state.ts";
import { PREF } from "@shared/prefs.ts";
import type { ProjectGroup } from "@shared/project-groups.ts";
import type {
	LiveAttached,
	LiveInfo,
	LiveListing,
	OmpFrame,
	OpenTarget,
	ServerMessage,
	SessionEntry,
	SessionSummary,
} from "@shared/protocol.ts";
import { create } from "zustand";
import { t } from "../i18n/index.ts";
import { api, type Meta, sessionActions } from "../lib/api.ts";
import { loadCommandNotes, rememberCommandNotes } from "../lib/command-notes.ts";
import { moveDraft } from "../lib/drafts.ts";
import { whenFree } from "../lib/leave-guard.ts";
import { appended } from "../lib/lineage.ts";
import { noticeToast } from "../lib/notice.ts";
import { enterEntry, entryIdOf, entryState, keepReading, newEntryId, type Reading, readingOf } from "../lib/reading.ts";
import { onLoginNotice, onRemoteMessage, remoteApi } from "../lib/remote.ts";
import { noteServerTime, serverOffsetMs } from "../lib/server-clock.ts";
import { isSettingsPage, type SettingsPageId } from "../lib/settings-pages.ts";
import { applySessionChanges, shareGroups, shareSessions, shareStrings } from "../lib/share.ts";
import { type Palette, storedPalette, storedTheme } from "../lib/theme.ts";
import { webUrl } from "../lib/web-url.ts";
import { ReplyError, socket } from "../lib/ws.ts";
import { onAppUpdateMessage } from "./app-update.ts";
import { onGuardMessage } from "./guard.ts";
import {
	applyAttached,
	applyFrame,
	denial,
	initialLive,
	isApproval,
	type LiveState,
	leaveSession,
	type RpcState,
	reconcileRetry,
	type SlashCommand,
	withApprovalsDenied,
	withInfo,
	withUiRequests,
	withWork,
} from "./live.ts";
import { ompApi, onOmpMessage } from "./omp.ts";
import { endAll, mergeSnapshot } from "./subagents-live.ts";
import { clearTurnClock, noteTurnFrame, seedTurnClock } from "./turn-clock.ts";

export type View =
	| {
			kind: "chat";
			file: string | null;
			liveId: string | null;
			leaf?: string /** Entry to scroll to and highlight. */;
			focus?: string;
			/** When `focus` was asked for: picking the same search hit again names the same entry, and only this says it is a new request. */
			focusAt?: number;
			/** The file this view followed its process away from (branch, fork, /new): the page carries on, not remounted. */
			from?: string;
			/** Where the reader was in it when they left it, when this is Back to it (see `lib/reading.ts`). */
			reading?: Reading;
			/** A subagent of this conversation shown full screen over the page (its id, as omp names it): a route of its own. */
			agent?: string;
	  }
	| { kind: "new" }
	| { kind: "usage" }
	| { kind: "memory" }
	| { kind: "guard" }
	/** The agent graph (#719); `file`: the conversation whose graph is drawn (none: the page picks one). */
	| { kind: "agents"; file?: string }
	/** The questions of unattended mode (#646); `file`: only the ones of this conversation. */
	| { kind: "questions"; file?: string }
	| { kind: "cli"; command?: string; run?: string[] }
	/** `page`: one of Settings' pages (`#/settings/<page>`); none opens the page last shown. */
	| { kind: "settings"; page?: SettingsPageId };

export interface ToastAction {
	label: string;
	run(): void;
}

export interface Toast {
	id: number;
	level: "info" | "success" | "warning" | "error";
	text: string;
	/** A button on the toast, e.g. to open the conversation it is about. */
	action?: ToastAction;
}

/** A user `!command` omp is running. */
export interface RunningBash {
	/** The server's name for it: tells apart the same command line run twice (`bash_started`). */
	id: string;
	command: string;
	startedAt: number;
}

/** What a process with no `!command` running has in `bash`. */
export const NO_BASH: RunningBash[] = [];

interface AppState {
	meta: Meta | null;
	connected: boolean;
	sessions: SessionSummary[];
	sessionsLoaded: boolean;
	/** Why the first load of the list failed (`sessionsLoaded` stays false); null while it loads or once it has. */
	sessionsError: string | null;
	/** Session files pinned to the top of the sidebar (a web UI preference). */
	pins: string[];
	/** Archived session files: hidden from the main list (a web UI preference). */
	archived: string[];
	/** The sidebar's project groups (#636), in their order: the folders the person put in them, kept by the server. */
	projectGroups: ProjectGroup[];
	/** Why the groups could not be read as they were kept (null: they were, or there are none). */
	projectGroupsProblem: string | null;
	/** `provider/id` of loved models, shown first in the model picker (a web UI preference). */
	favoriteModels: string[];
	view: View;
	lives: Record<string, LiveState>;
	/**
	 * The conversation files the page does not know yet whether a process runs: from the page being loaded on one (the
	 * connection is not made), or opening one, until the server has said which process runs it (see `attachLiveForFile`),
	 * or `FIND_MS` has passed. A conversation that ends in a tool call nobody answered is not shown as stopped meanwhile.
	 */
	finding: Record<string, true>;
	/** The user `!commands` each process is running, oldest first (omp replies when one exits; Stop sends `abort_bash`). */
	bash: Record<string, RunningBash[]>;
	/** omp's word predictor failed because its prompt history (TUI `history` table) does not exist yet. */
	predictionUnavailable: boolean;
	toasts: Toast[];
	sidebarOpen: boolean;
	/** The sidebar lists the archived conversations instead of the others (its Archived button, or the palette's *Go to › Archived conversations*, #707). */
	sidebarArchived: boolean;
	/** Keep thinking blocks expanded instead of folding them once the reply arrives. */
	keepThinkingOpen: boolean;
	panelOpen: boolean;
	paletteOpen: boolean;
	/** The Feedback dialog (sidebar, palette, the shortcuts page). */
	feedbackOpen: boolean;
	/** "Set a goal" asked for from outside the page showing a conversation (palette, shortcut, the guided-goal bar). */
	goalRequest: { id: number; mode: "guided" | "direct" } | null;
	/** The server requires its access token and this browser has none. */
	locked: boolean;
	theme: "dark" | "light" | "system";
	/** The colour palette (lib/theme.ts), chosen apart from `theme`; not the command palette. */
	colorPalette: Palette;
	setView(v: View, opts?: { replace?: boolean }): void;
	loadSessions(): Promise<void>;
	toast(level: Toast["level"], text: string, action?: ToastAction): void;
	dismissToast(id: number): void;
	/** Stop a toast's countdown while someone reads it (pointer over it, focus inside it); `resumeToast` restarts it. */
	pauseToast(id: number): void;
	resumeToast(id: number): void;
	set(partial: Partial<AppState>): void;
}

/**
 * What is left of each toast's auto-dismiss countdown. A timer only counts while its `run` is still the clock's:
 * pausing, restarting or dismissing bumps it, so the timer already scheduled does nothing when it fires.
 */
const toastClocks = new Map<number, { left: number; since: number; run: number; paused: boolean }>();
/** A toast someone read to the end of its countdown stays this long after they let go of it. */
const TOAST_GRACE_MS = 2000;
/** How long the page waits before asking omp for a goal again, when the read was refused because it was not running. */
const GOAL_RETRY_MS = 250;
/** How many times the page asks again for a goal it was refused: a conversation that stays frozen is not asked for ever. */
const GOAL_TRIES = 8;

function runToastClock(id: number): void {
	const clock = toastClocks.get(id);
	if (!clock) return;
	const run = ++clock.run;
	clock.since = Date.now();
	setTimeout(() => {
		if (clock.run === run) useApp.getState().dismissToast(id);
	}, clock.left);
}

export const useApp = create<AppState>((set, get) => ({
	meta: null,
	connected: false,
	sessions: [],
	favoriteModels: [],
	archived: [],
	projectGroups: [],
	projectGroupsProblem: null,
	sessionsLoaded: false,
	sessionsError: null,
	pins: [],
	view: { kind: "new" },
	lives: {},
	finding: {},
	bash: {},
	predictionUnavailable: false,
	toasts: [],
	sidebarOpen: true,
	sidebarArchived: false,
	keepThinkingOpen: localStorage.getItem(PREF.keepThinking) === "on",
	panelOpen: false,
	paletteOpen: false,
	feedbackOpen: false,
	goalRequest: null,
	locked: false,
	theme: storedTheme(),
	colorPalette: storedPalette(),
	setView(v, opts) {
		const replace = opts?.replace ?? false;
		// What is unsaved in the Files tab's editor is asked about first, when the view shown is not its conversation's (`lib/leave-guard.ts`).
		whenFree(v, () => {
			// Where the reader is in the view being left is kept before another is shown, for Back (see `lib/reading.ts`).
			if (!replace && location.hash !== hashOf(v)) keepReading();
			set({ view: v });
			writeHash(v, replace);
		});
	},
	async loadSessions() {
		// One load at a time, in the order asked: each asks for what changed since the answer before it, and whoever
		// awaits a load finds its answer in the list.
		const turn = sessionsTurn;
		const mine = Promise.withResolvers<void>();
		sessionsTurn = mine.promise;
		// A retry starts clean: the sidebar shows its spinner again until the list or the error arrives.
		if (get().sessionsError !== null) set({ sessionsError: null });
		await turn;
		try {
			// Once there is a list, the server is asked only for what changed since its last answer.
			const since = get().sessionsLoaded ? sessionsCursor : null;
			const [answer, pins, archived, groups] = await Promise.all([
				api.sessions(since),
				sessionActions.pins().catch(() => get().pins),
				sessionActions.archived().catch(() => get().archived),
				// The project groups (#636) come with the list they group: one read for the sidebar's list and its groups.
				// A server that does not know them (`[]`, or nothing that is a list) leaves the groups as they are: the
				// sidebar is the list's, and no page keeps a conversation from opening for want of a project group.
				api
					.projectGroups()
					.then((answer) => (Array.isArray(answer?.groups) ? answer : null))
					.catch(() => null),
			]);
			sessionsCursor = answer.cursor;
			// Rows that did not change keep their objects (and an unchanged list its array), so only what changed renders again.
			set({
				sessions:
					answer.kind === "full"
						? shareSessions(get().sessions, answer.sessions)
						: applySessionChanges(get().sessions, answer.changed, answer.removed),
				pins: shareStrings(get().pins, pins),
				archived: shareStrings(get().archived, archived),
				projectGroups: groups ? shareGroups(get().projectGroups, groups.groups) : get().projectGroups,
				projectGroupsProblem: groups ? groups.problem : get().projectGroupsProblem,
				sessionsLoaded: true,
				sessionsError: null,
			});
		} catch (e) {
			const error = (e as Error).message;
			// Without a first list the sidebar says what failed (with a Retry); once there is one, it stays and a toast says so.
			if (get().sessionsLoaded) get().toast("error", t("shell.storeLoadSessionsFailed", { error }));
			else set({ sessionsError: error });
		} finally {
			mine.resolve();
		}
	},
	toast(level, text, action) {
		const id = Date.now() + Math.random();
		// The stack keeps five: beyond that the oldest toast that is not an error goes (its countdown too). An error is
		// never pushed out, as it may not have been shown yet (two are on the screen, the rest wait): it waits its turn.
		let over = get().toasts.length + 1 - 5;
		for (const old of get().toasts) {
			if (over <= 0) break;
			if (old.level === "error") continue;
			get().dismissToast(old.id);
			over--;
		}
		set((s) => ({ toasts: [...s.toasts, { id, level, text, action }] }));
		// A toast with a button stays long enough to be used.
		toastClocks.set(id, { left: action ? 15_000 : level === "error" ? 9000 : 4500, since: 0, run: 0, paused: false });
		runToastClock(id);
	},
	pauseToast(id) {
		const clock = toastClocks.get(id);
		if (!clock || clock.paused) return;
		clock.paused = true;
		clock.run++;
		clock.left -= Date.now() - clock.since;
	},
	resumeToast(id) {
		const clock = toastClocks.get(id);
		if (!clock?.paused) return;
		clock.paused = false;
		clock.left = Math.max(clock.left, TOAST_GRACE_MS);
		runToastClock(id);
	},
	dismissToast(id) {
		const clock = toastClocks.get(id);
		if (clock) clock.run++;
		toastClocks.delete(id);
		set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
	},
	set(partial) {
		set(partial);
	},
}));

// ------------------------------------------------------------------ routing

export function hashOf(v: View): string {
	// The conversation's address, then the full screen's: a file name is encoded, so it never holds `/agent/` itself.
	const agent = v.kind === "chat" && v.agent ? `/agent/${encodeURIComponent(v.agent)}` : "";
	if (v.kind === "chat" && v.file) return `#/s/${encodeURIComponent(v.file)}${agent}`;
	if (v.kind === "chat" && v.liveId) return `#/live/${v.liveId}${agent}`;
	if (v.kind === "settings" && v.page) return `#/settings/${v.page}`;
	if (v.kind === "agents") return v.file ? `#/agents/${encodeURIComponent(v.file)}` : "#/agents";
	if (["usage", "memory", "guard", "questions", "settings"].includes(v.kind)) return `#/${v.kind}`;
	if (v.kind === "cli") return v.command ? `#/cli/${encodeURIComponent(v.command)}` : "#/cli";
	return "#/";
}

/** A conversation's address (`<file>` or `<liveId>`) with the subagent it shows full screen, if the address names one. */
function splitAgent(rest: string): { target: string; agent?: string } {
	const at = rest.indexOf("/agent/");
	if (at < 0) return { target: rest };
	const agent = decodeURIComponent(rest.slice(at + "/agent/".length));
	return agent ? { target: rest.slice(0, at), agent } : { target: rest.slice(0, at) };
}

function writeHash(v: View, replace: boolean): void {
	const h = hashOf(v);
	if (location.hash === h) return;
	// Each history entry has an id in its state: Back finds what was kept for the entry it returns to.
	if (replace) history.replaceState(history.state, "", h);
	else {
		const id = newEntryId();
		history.pushState(entryState(id), "", h);
		enterEntry(id);
	}
}

export function viewFromHash(): View {
	const h = location.hash.replace(/^#/, "");
	try {
		if (h.startsWith("/s/")) {
			const { target, agent } = splitAgent(h.slice(3));
			return { kind: "chat", file: decodeURIComponent(target), liveId: null, ...(agent ? { agent } : {}) };
		}
		if (h.startsWith("/live/")) {
			const { target, agent } = splitAgent(h.slice(6));
			return { kind: "chat", file: null, liveId: target, ...(agent ? { agent } : {}) };
		}
		if (["/usage", "/memory", "/guard", "/questions", "/settings"].includes(h)) return { kind: h.slice(1) } as View;
		if (h === "/agents") return { kind: "agents" };
		if (h.startsWith("/agents/")) {
			const file = decodeURIComponent(h.slice("/agents/".length));
			return file ? { kind: "agents", file } : { kind: "agents" };
		}
		if (h.startsWith("/settings/")) {
			const page = h.slice("/settings/".length);
			return isSettingsPage(page) ? { kind: "settings", page } : { kind: "settings" };
		}
		if (h.startsWith("/cli"))
			return { kind: "cli", command: h.length > 5 ? decodeURIComponent(h.slice(5)) : undefined };
	} catch {
		// A truncated or hand-edited address (`#/s/%`) names nothing to open.
	}
	return { kind: "new" };
}

// ------------------------------------------------------------------ live sessions

/** Change one conversation's state. A change that leaves it as it was is no change: nothing that reads the store is told. */
function patchLive(liveId: string, fn: (s: LiveState) => LiveState): void {
	useApp.setState((st) => {
		const cur = st.lives[liveId];
		if (!cur) return st;
		const next = fn(cur);
		return next === cur ? st : { lives: { ...st.lives, [liveId]: next } };
	});
}

export function liveFor(file: string | null): LiveState | undefined {
	if (!file) return undefined;
	return Object.values(useApp.getState().lives).find((l) => !l.info.exited && l.info.sessionFile === file);
}

/** The end of a process the server no longer has and does not remember: it is simply not running any more. */
const UNKNOWN_EXIT: ExitInfo = { code: null, stderr: "", by: "unknown" };

/**
 * A process ended (its own exit, or the server no longer has it): its dialogs can never be answered, what it was running
 * died with it, nothing streams. `exited` is how it ended, when that is known.
 *
 * A cause that is known wins over one that is not: the page learns first that a process is gone (the server does not
 * remember how it ended, or has not said yet) and later what ended it, and the later word is the true one (#515).
 */
function markExited(liveId: string, exited: ExitReport | null): void {
	clearTurnClock(liveId);
	setBash(liveId, () => []);
	patchLive(liveId, (s) => {
		// A report that does not say who ended the process is read as an end whose cause the server does not know,
		// not as one of omp's own (#515).
		const known = exited ? { ...exited, by: exited.by ?? "unknown" } : null;
		if (s.info.exited && s.exited && (!known || s.exited.by !== "unknown")) return s;
		return withUiRequests(
			{
				...s,
				exited: known ?? s.exited ?? UNKNOWN_EXIT,
				info: { ...s.info, exited: true, streaming: false },
				streaming: false,
				continuing: false,
				subagents: endAll(s.subagents),
				// A tool that was running is not any more, and has no result to come: its card is an interrupted one, as for a
				// conversation opened from its file (nothing of it is held, so the step is not read as answered).
				tools: Object.fromEntries(Object.entries(s.tools).filter(([, exec]) => exec.done)),
				retry: null,
				compacting: null,
			},
			[],
		);
	});
	releaseExited();
}

/**
 * Let go of what a process that has ended held, unless the page still shows it. A conversation falls back to its saved
 * file once its process is gone, and a process nobody looks at must not keep its transcript: a page is left open for days,
 * every `open` of a conversation is a new process, and omp's entries of a long one are tens of megabytes. The record stays,
 * so that the page still knows the process ended (and how), and what commands printed is still written from it.
 */
function releaseExited(): void {
	const { lives, view } = useApp.getState();
	const shown = view.kind === "chat" ? view.liveId : null;
	let kept = lives;
	for (const [id, live] of Object.entries(lives)) {
		if (!live.info.exited) continue;
		detached.delete(id);
		const heavy =
			live.entries.length > 0 ||
			live.state !== null ||
			live.overlay.length > 0 ||
			live.notices.length > 0 ||
			live.commands.length > 0 ||
			Object.keys(live.tools).length > 0 ||
			Object.keys(live.subagents).length > 0 ||
			Object.keys(live.btw).length > 0;
		if (!heavy || id === shown) continue;
		if (kept === lives) kept = { ...lives };
		kept[id] = {
			...initialLive({ ...live.info, retry: undefined, streaming: false }),
			exited: live.exited,
			lastError: live.lastError,
			commandOutput: live.commandOutput,
		};
	}
	if (kept !== lives) useApp.setState({ lives: kept });
}

/** The refresh of a conversation's entries that is under way. */
const refreshing = new Map<string, Promise<void>>();
/** The refresh that follows it, for everyone who asked while it ran; `full` if any of them needed the whole conversation. */
const refreshNext = new Map<string, { full: boolean; done: Promise<void> }>();

/**
 * The entries a page fetched over HTTP for a conversation file (the transcript it shows), newest last. A process that
 * starts on that file is continued from the last of them: asking omp for the whole conversation over the socket again
 * means tens of megabytes parsed twice for a long one.
 */
const savedEntries = new Map<string, SessionEntry[]>();
const SAVED_FILES = 3;

/** Remember what was fetched of `file` (see `savedEntries`); the oldest of the few kept is forgotten. */
export function noteSavedEntries(file: string, entries: SessionEntry[]): void {
	savedEntries.delete(file);
	savedEntries.set(file, entries);
	for (const old of [...savedEntries.keys()].slice(0, -SAVED_FILES)) savedEntries.delete(old);
}

/** How long a page waits for the session list before it reads a conversation without it. */
const LIST_WAIT_MS = 3000;

/**
 * Whether the session list holds `file`, once it has loaded. A file omp has named and not written (a new chat before its
 * first message) is not in it, and the server answers 404 for it, which the browser logs as a red error.
 */
async function listHolds(file: string): Promise<boolean> {
	if (!useApp.getState().sessionsLoaded) {
		await new Promise<void>((resolve) => {
			const done = () => {
				clearTimeout(timer);
				unsubscribe();
				resolve();
			};
			const timer = setTimeout(done, LIST_WAIT_MS);
			const unsubscribe = useApp.subscribe((st) => {
				if (st.sessionsLoaded) done();
			});
		});
	}
	return useApp.getState().sessions.some((x) => x.file === file);
}

/**
 * The end of a conversation's history, fetched for a process that attaches to a conversation the page holds none of: the
 * process then continues from its last entry (`get_entries since`) instead of sending the whole of it over the socket, which
 * for a long conversation is tens of megabytes parsed here. A conversation the server cannot answer for is read whole, as before.
 */
async function seedSavedEntries(file: string): Promise<void> {
	if (!(await listHolds(file))) return;
	try {
		const answer = await api.history(file, { kind: "tail" });
		const own = answer.members.find((m) => m.file === answer.file);
		const { view } = answer;
		if (own?.entries.length && !view.later && view.leaf === view.head) noteSavedEntries(file, own.entries);
	} catch {
		// Not known to the server (yet): omp is asked for everything it holds.
	}
}

/**
 * Pull durable entries (incrementally when possible) and drop settled overlays. Callers that arrive while a pull is
 * running share the one pull after it, which starts after they asked: each gets an answer no older than its asking, and
 * the page asks omp once for a burst of them (a step of a turn ends three ways within milliseconds).
 */
export function refreshEntries(liveId: string, full = false): Promise<void> {
	const running = refreshing.get(liveId);
	if (!running) {
		const p = pullEntries(liveId, full).finally(() => refreshing.delete(liveId));
		refreshing.set(liveId, p);
		return p;
	}
	const queued = refreshNext.get(liveId);
	if (queued) {
		queued.full ||= full;
		return queued.done;
	}
	const go = (): Promise<void> => {
		refreshNext.delete(liveId);
		return refreshEntries(liveId, next.full);
	};
	const next: { full: boolean; done: Promise<void> } = { full, done: running.then(go, go) };
	refreshNext.set(liveId, next);
	return next.done;
}

async function pullEntries(liveId: string, full: boolean): Promise<void> {
	const live = useApp.getState().lives[liveId];
	if (!live || live.exited) return;
	const endedBefore = new Set(live.overlay.filter((o) => o.ended).map((o) => o.messageId));
	// What omp holds is read from here on: the page is current as of this revision, or of an older one if more happens meanwhile.
	const revision = live.info.revision ?? null;
	// Where the page's copy ends: its own entries, or what it fetched of the file when it has none of its own yet.
	const file = live.info.sessionFile ?? "";
	if (!full && file && !live.entries.length && !savedEntries.has(file)) {
		await seedSavedEntries(file);
		// What came while the end was fetched (a frame's own update) is the page's own entries now.
		const now = useApp.getState().lives[liveId];
		if (!now || now.exited) return;
	}
	const own = useApp.getState().lives[liveId]?.entries ?? live.entries;
	const held = own.length ? own : (savedEntries.get(file) ?? []);
	const last = full ? undefined : held.at(-1)?.id;
	let res: { entries: SessionEntry[]; leafId: string | null };
	try {
		res = await socket.rpc(liveId, last ? { type: "get_entries", since: last } : { type: "get_entries" });
	} catch (e) {
		// omp no longer knows the entry we resume from (the process moved to another file): start over. This
		// runs inside the refresh `refreshEntries` registered, so it must not go back through that — it would
		// wait for itself.
		if (last && e instanceof ReplyError && e.code === "unknown_since") return pullEntries(liveId, true);
		return;
	}
	patchLive(liveId, (s) => {
		// What came while the reply was on its way (a frame's own update) is kept: only what omp sent is added.
		const base = last ? (s.entries.length ? s.entries : held) : [];
		// Made by appending, so what the page derived from `base` goes on from there (see lib/lineage.ts).
		const entries = !last ? res.entries : appended(base, res.entries);
		const overlay = s.overlay.filter((o) => !(o.ended && endedBefore.has(o.messageId)));
		// omp says nothing of plan mode itself: the hidden entry it writes when plan-yolo approves the plan ends it. Looked for
		// in everything the page holds, not only what omp just sent: the entries it held may be the ones that have it.
		const planMode =
			s.planMode && !entries.some((e) => e.type === "custom_message" && e.customType === "plan-yolo-handoff");
		// A conversation read whole (or never read) is current as of the revision it was read at; one that was read before
		// goes on from the revision its frames keep.
		const current = !last || s.revision === null ? revision : s.revision;
		if (
			entries === s.entries &&
			res.leafId === s.leafId &&
			overlay.length === s.overlay.length &&
			current === s.revision &&
			planMode === s.planMode
		)
			return s;
		return { ...s, entries, leafId: res.leafId, overlay, planMode, revision: current };
	});
}

/** The read of a conversation's state that is under way. */
const stateReading = new Map<string, Promise<RpcState | null>>();
/** The read that follows it, for everyone who asked while it ran; a `user` read if any of them was one. */
const stateNext = new Map<string, { user: boolean; done: Promise<RpcState | null> }>();

/**
 * omp accepted `set_thinking_level`: the conversation is set to `thinking` (see `LiveState.thinking`). omp announces a
 * change of the selector and nothing when it did not change (choosing `auto` on a process already on it), so a reply that
 * says it took the level is what the page goes by then.
 */
export function noteThinking(liveId: string, thinking: string): void {
	patchLive(liveId, (s) => (s.thinking === thinking ? s : { ...s, thinking }));
}

/**
 * Ask omp for its state. `user`: this follows something the user just did (a setting, a rename), so a paused
 * conversation answers it; the refreshes the page makes by itself leave a paused one alone. The state is big (the system
 * prompt and every tool's schema), and a goal's turn ends several ways within milliseconds, so there is one read at a
 * time per conversation: callers that arrive while it runs share the one read after it, which starts after they asked
 * (an answer already on its way may be older than what they did), as for `refreshEntries`.
 *
 * The read is slim: the answer comes without the system prompt and the bodies of the tool schemas, which the page
 * reads neither of (it wants the tool names alone, to know whether an interview is under way). What is left out is
 * tens of KB over the connection and on the main thread, for every read (see `shared/slim.ts`).
 */
export function refreshState(liveId: string, user = false): Promise<RpcState | null> {
	const running = stateReading.get(liveId);
	if (!running) {
		const p = readState(liveId, user).finally(() => stateReading.delete(liveId));
		stateReading.set(liveId, p);
		return p;
	}
	const queued = stateNext.get(liveId);
	if (queued) {
		queued.user ||= user;
		return queued.done;
	}
	const go = (): Promise<RpcState | null> => {
		stateNext.delete(liveId);
		return refreshState(liveId, next.user);
	};
	const next: { user: boolean; done: Promise<RpcState | null> } = { user, done: running.then(go, go) };
	stateNext.set(liveId, next);
	return next.done;
}

async function readState(liveId: string, user: boolean): Promise<RpcState | null> {
	try {
		const command = { type: "get_state" };
		// A turn that starts or ends while the read is on its way is newer than its answer: omp can answer a read it had
		// before its `agent_end` after that frame, and an answer that says a turn runs would then bring back a turn that is
		// over, for good (#680). Such an answer does not touch whether a turn runs, nor whether omp is settled.
		const marks = useApp.getState().lives[liveId]?.turnMarks;
		const state = await (user
			? socket.act<RpcState>(liveId, command, true)
			: socket.rpc<RpcState>(liveId, command, true));
		patchLive(liveId, (s) => {
			const current = s.turnMarks === marks;
			return {
				...s,
				state,
				queue: state.queuedMessages ?? s.queue,
				streaming: current ? state.isStreaming || s.streaming : s.streaming,
				// omp's own word that nothing will wake the session (same predicate as its `session_settled` frame). Only ever
				// set from here: a turn that starts clears it (`agent_start`), and an answer that was on its way meanwhile is older.
				settled: s.settled || (current && state.isSettled === true && !state.isStreaming && !s.streaming),
				// omp says it is done: no goal turn is coming, whatever frames this page missed.
				continuing: current && state.isSettled === true ? false : s.continuing,
			};
		});
		return state;
	} catch {
		return null;
	}
}

/**
 * Show the goal omp answered a `goal` request with. Most requests change the goal, and omp says so in a `goal_updated`
 * frame; `resume` on a goal that is already active changes nothing and sends none, so the answer is all there is.
 */
export function noteGoal(liveId: string, goal: Goal): void {
	patchLive(liveId, (s) => ({ ...s, goal }));
}

/**
 * Read the goal omp holds. A paused conversation refuses it: what the page shows stays — unless the conversation is
 * running again, in which case the read is asked for again: a refusal is not an answer, and a goal the page never
 * read is a goal the page shows wrongly (or not at all) until something else refreshes it (#500).
 *
 * The read is asked for again a few times only: a conversation that stays frozen is not asked for ever.
 */
function readGoal(liveId: string, tries = GOAL_TRIES): Promise<void> {
	return socket
		.rpc<{ goal: Goal | null }>(liveId, { type: "goal", op: "get" })
		.then((r) => patchLive(liveId, (s) => ({ ...s, goal: r?.goal ?? null })))
		.catch((e: unknown) => {
			// The conversation is paused again (or the server is gone): the page shows what it has.
			const refused = String((e as Error)?.message ?? e).includes("paused");
			if (!refused || tries <= 0) return;
			const live = useApp.getState().lives[liveId];
			if (!live || live.info.exited) return;
			// It is running again, and the read was refused because it was not: ask again, a moment later.
			setTimeout(() => void readGoal(liveId, tries - 1), GOAL_RETRY_MS);
		});
}

/** The reads of omp's registry of subagents under way, by process: a resume and a Retry now that come together read it once. */
const syncing = new Map<string, Promise<void>>();

/**
 * Read omp's registry of subagents and bring what the page holds up to it, waits included (see `mergeSnapshot`): on
 * attach, after a resume (omp retries what came due while it was frozen) and after Retry now (the conversation's
 * retry changes none of its subagents' waits, and the registry says which of them still wait). A frozen or ended
 * process answers nothing, and the page keeps what it holds.
 */
function syncSubagents(id: string): Promise<void> {
	const running = syncing.get(id);
	if (running) return running;
	const read = socket
		.rpc<{ subagents?: unknown[] }>(id, { type: "get_subagents" })
		.then((r) => {
			const list = Array.isArray(r) ? r : Array.isArray(r?.subagents) ? r.subagents : [];
			patchLive(id, (s) => ({ ...s, subagents: mergeSnapshot(s.subagents, list) }));
		})
		.catch(() => {})
		.finally(() => syncing.delete(id));
	syncing.set(id, read);
	return read;
}

/**
 * Read what omp holds of a process the page (re)subscribed to. `goal`: what the server holds of the conversation's goal,
 * for an attach that has it (see `LiveAttached`). `afterLoss`: the connection was lost and made again, so frames were
 * lost with it. `subagents`, `panel`: what the server kept of a paused omp, which the page cannot ask (see `LiveAttached`).
 */
async function hydrate(
	info: LiveInfo,
	goal?: Goal | null,
	afterLoss = false,
	subagents?: unknown[],
	panel?: PanelState,
): Promise<void> {
	const id = info.liveId;
	// Turn boundaries may have passed unseen; frames that arrive from here on start the clock again.
	clearTurnClock(id);
	// Entries the page pulled itself mean it was attached before, and a page that was away missed frames: omp rewrites
	// entries it already wrote (a failure a retry got past, what a shake shortened), and only a frame told a connected
	// page, so `since` the last entry would never show the change. Unless the server's revision is the one the page last
	// heard (see `LiveInfo.revision`), everything omp holds is read again, which for a long conversation is tens of
	// megabytes parsed and every entry a new object. A connection that was lost is read again whatever the revision says:
	// the revision moves with the frames the server saw omp send, and a rewrite that came with none, or whose frames the
	// page lost with the connection, is not in it (#473). A process that starts on a conversation the page only fetched
	// over HTTP has nothing of its own to go stale: it is continued from that, not fetched whole (see `savedEntries`).
	const held = useApp.getState().lives[id];
	const rejoined = (held?.entries.length ?? 0) > 0;
	const everything = rejoined && (afterLoss || info.revision === undefined || held?.revision !== info.revision);
	// What the server says now is the revision the read is made at; frames that arrive while it is read do not say the
	// page is current: the read does.
	patchLive(id, (s) => {
		const known = s.info.revision === info.revision ? s : { ...s, info: { ...s.info, revision: info.revision } };
		return everything && known.revision !== null ? { ...known, revision: null } : known;
	});
	// A paused omp is frozen and answers none of the reads below, so what the server last heard of its goal is what the
	// page shows until it can read it (see `LiveAttached`): without it the transcript's goal is shown, which says paused.
	if (goal !== undefined) patchLive(id, (s) => ({ ...s, goal }));
	// Nor does it answer `get_subagents`: the registry the server took before omp was frozen is what the Agents tab shows
	// of the subagents that were running, which a page that was not there when it was paused has no other way to know
	// (the transcripts on disk say all of them are over).
	if (subagents) patchLive(id, (s) => ({ ...s, subagents: mergeSnapshot(s.subagents, subagents) }));
	// Nor does it answer `get_state`: what the server kept of the settings the session panel shows is what omp had when it
	// was frozen (and what a user's action changed since), which is newer than anything this page may hold. Without it the
	// panel of a paused conversation has no row chosen. A read that omp does answer (it runs again) replaces it below.
	if (panel) patchLive(id, (s) => ({ ...s, state: { ...s.state, ...panel } }));
	await Promise.all([
		refreshEntries(id, everything),
		// A tab (re)attaching mid-stream may have missed agent_start/agent_end: get_state is authoritative here, and also
		// says that omp is idle (the page never saw its `session_settled`): an active goal then waits for the user. Not when a
		// frame that starts or ends a turn came while it was read: that frame is newer (#680).
		(async () => {
			const marks = useApp.getState().lives[id]?.turnMarks;
			const state = await refreshState(id);
			if (state) patchLive(id, (s) => (s.turnMarks === marks ? { ...s, streaming: Boolean(state.isStreaming) } : s));
		})(),
		readGoal(id),
		socket
			.rpc<{ commands: SlashCommand[] }>(id, { type: "get_available_commands" })
			.then((r) => patchLive(id, (s) => ({ ...s, commands: r.commands })))
			.catch(() => {}),
		syncSubagents(id),
	]);
	// A turn that began before the page listened has no clock of its own: the server says when it began (`LiveInfo.turnStartedAt`).
	if (info.turnStartedAt !== undefined && useApp.getState().lives[id]?.streaming) {
		// Read again: the awaits above patched what the page holds of this process (its entries among them).
		const now = useApp.getState().lives[id];
		seedTurnClock(id, info.turnStartedAt - serverOffsetMs(), info.turnStartedAt, now?.entries ?? []);
	}
}

function register(info: LiveInfo): void {
	useApp.setState((st) => {
		const known = st.lives[info.liveId];
		// A process this page has not seen (the page was loaded anew) shows what its conversation's commands printed before.
		const fresh = (): LiveState => ({ ...initialLive(info), commandOutput: loadCommandNotes(info.sessionFile) });
		return { lives: { ...st.lives, [info.liveId]: known ? reconcileRetry(known, info) : fresh() } };
	});
}

/**
 * How many processes this page is asking the server to open for each conversation file: the `live` frame that comes
 * before its answer is its own doing. Per file, since a frame for the conversation on screen is not made by an open of
 * another one (#602). A new conversation has no file the page could be showing yet.
 */
const opening = new Map<string, number>();

/** Start (or reuse) the omp process for a target and subscribe to it. */
export async function openLive(target: OpenTarget): Promise<string> {
	const file = target.kind === "resume" ? target.sessionFile : null;
	if (file) opening.set(file, (opening.get(file) ?? 0) + 1);
	const answer = await socket.request<LiveAttached>({ t: "open", target }).finally(() => {
		if (!file) return;
		const left = (opening.get(file) ?? 1) - 1;
		if (left > 0) opening.set(file, left);
		else opening.delete(file);
	});
	const { goal, subagents, state, ...info } = answer;
	register(info);
	detached.delete(info.liveId);
	await hydrate(info, goal ?? null, false, subagents, state);
	return info.liveId;
}

export async function attachLive(liveId: string, afterLoss = false): Promise<boolean> {
	detached.delete(liveId);
	try {
		const { goal, subagents, state, ...info } = await socket.request<LiveAttached>({ t: "attach", liveId });
		// The process has ended and the server still knows how: the idle reaper closes the processes nobody watches,
		// so the frame that says so reached no page, and this is where the page learns it (#515).
		if (info.exit) {
			register(info);
			markExited(liveId, info.exit);
			return false;
		}
		register(info);
		await hydrate(info, goal ?? null, afterLoss, subagents, state);
		return true;
	} catch (e) {
		// The server no longer has the process and does not remember how it ended (it was restarted, or the end has
		// been forgotten): the conversation is simply not running any more, and the page says so without blaming
		// the server for it — a process that crashed on its own must not be read as the server's doing (#515).
		if (String((e as Error)?.message ?? e).includes("Live session not found")) markExited(liveId, UNKNOWN_EXIT);
		return false;
	}
}

/**
 * The connection is back: attach again to every process the page was listening to, to resync what it missed. Answers once
 * each has (a process that ended while the page was away is found out here).
 */
export async function resubscribe(): Promise<void> {
	await Promise.all(
		Object.entries(useApp.getState().lives)
			.filter(([id, live]) => !live.info.exited && !detached.has(id))
			.map(([id]) => attachLive(id, true)),
	);
}

/**
 * Show the conversations the server runs that this page holds nothing of, as the page that started them does: the
 * processes another page started, and the paused ones that outlived the app (see server/omp/parked.ts), are in the
 * sidebar and Settings from the first load, with the dot they have. The page listens to one when it is shown, as it does
 * to any process it let go of.
 */
export async function showLives(): Promise<void> {
	let listed: LiveListing[];
	try {
		listed = await socket.request<LiveListing[]>({ t: "list_lives" });
	} catch {
		return; // nothing is lost: opening the conversation finds its process as usual
	}
	// A process this page let go of that the server does not list any more has ended: the server does not list the
	// processes that are gone, and the page is told how each of them ended in the `live` frame (which reaches every
	// page, not only the subscribers of that process — the `live_exit` frame does not, and the idle reaper closes
	// the processes nobody watches) (#515). A process whose end the page has not been told of yet is only said to
	// be gone: the cause arrives with the next `live` frame, and the notice then says it.
	const running = new Set(listed.filter((info) => !info.exited).map((info) => info.liveId));
	for (const id of detached) if (!running.has(id)) markExited(id, UNKNOWN_EXIT);
	for (const { busy: _busy, holding: _holding, ...info } of listed) {
		if (info.exited) continue;
		if (useApp.getState().lives[info.liveId]) {
			// What a process this page does not listen to did while the page was away is in no frame it heard.
			if (detached.has(info.liveId)) patchLive(info.liveId, (s) => withWork(withInfo(s, info), info));
			continue;
		}
		if (info.pausedAt === null) {
			// The one that runs the conversation on screen is looked for by `attachLiveForFile`, which reads it too; one that has
			// no file has no conversation to list.
			if (info.sessionFile !== null && info.sessionFile !== viewedFile()) listElsewhere(info);
			continue;
		}
		register(info);
		if (listenedLiveId() === info.liveId) void attachLive(info.liveId);
		else {
			detached.add(info.liveId);
			// A paused conversation can be asking too: what it says of that is all the page has of it.
			patchLive(info.liveId, (s) => withWork(s, info));
		}
	}
}

/**
 * A process this page holds nothing of is listed: its conversation has the dot the server last said (running, waiting for
 * an answer, open), and the page listens to it when it is shown, as to any process it let go of (`detached`). Nothing of it
 * is read: a list needs no conversation, and a page that listened to every process would be told every word each says (#592).
 */
function listElsewhere(info: LiveInfo): void {
	register(info);
	detached.add(info.liveId);
	patchLive(info.liveId, (s) => withWork(s, info));
	if (info.asking) toastNeedsInput(info.liveId);
}

/** The files whose process is being asked for (see `attachLiveForFile`). */
const looking = new Set<string>();

/**
 * The files the server has answered for (a process runs them, or none does): the page knows, and a lookup that comes
 * again (a reconnect, a view that is replaced) does not make it not know again, which would swap a stopped
 * conversation's Continue for a spinner. A process that appears for a file (a `live` frame) makes the answer stale.
 */
const answered = new Set<string>();

/**
 * How long a page goes on not knowing whether a process runs the conversation it shows (see `AppState.finding`): the
 * connection may still be being made, or be slow. Past it the page shows what the file says, and a lookup that comes
 * back later shows what it finds.
 */
export const FIND_MS = 10_000;

/** What ends the not knowing of each file at `FIND_MS`. */
const findTimers = new Map<string, ReturnType<typeof setTimeout>>();

/** The page does not know whether a process runs `file`, until `endFinding` or `FIND_MS`. */
function startFinding(file: string): void {
	clearTimeout(findTimers.get(file));
	findTimers.set(
		file,
		setTimeout(() => endFinding(file), FIND_MS),
	);
	if (!useApp.getState().finding[file]) useApp.setState((s) => ({ finding: { ...s.finding, [file]: true } }));
}

/** The page knows now (a process runs `file`, or none does), or has waited long enough. */
function endFinding(file: string): void {
	clearTimeout(findTimers.get(file));
	findTimers.delete(file);
	if (!useApp.getState().finding[file]) return;
	useApp.setState((s) => ({ finding: Object.fromEntries(Object.entries(s.finding).filter(([f]) => f !== file)) }));
}

/**
 * Listen to the process that runs `file`, when this page does not know it: a page loaded anew, one that shows a
 * conversation another page (or the app) started, or a window popped out for a subagent has only the paused processes,
 * and would show what the file holds and nothing of what is happening. This asks the server which process runs the
 * conversation (`liveId`: the page has been told already), so that what it streams, asks and queues is shown at once.
 * Nothing is started: a conversation that is not running stays as it is. Until the answer is in (and the process read),
 * `finding` says the page does not know yet.
 */
export async function attachLiveForFile(file: string, liveId?: string): Promise<void> {
	if (looking.has(file)) return;
	// A process this page listens to for the file ends the not knowing. One it only lists (`detached`: another page started
	// or resumed the conversation) is still to be listened to, and the view pointed at it.
	const held = liveFor(file);
	if (held && !detached.has(held.info.liveId)) {
		endFinding(file);
		return;
	}
	looking.add(file);
	// A page that has the server's answer for this file already (it is looking again after a reconnect, or its view was
	// replaced) goes on showing what that answer made of the conversation while it asks again.
	if (!held && !answered.has(file)) startFinding(file);
	try {
		const running =
			liveId ??
			held?.info.liveId ??
			(await socket.request<LiveListing[]>({ t: "list_lives" })).find((l) => !l.exited && l.sessionFile === file)
				?.liveId;
		answered.add(file);
		if (running && (!useApp.getState().lives[running] || detached.has(running))) {
			await attachLive(running);
			followToProcess(file, running);
			// The page may have moved on while the process was asked for: one it no longer shows is let go once it has
			// nothing going on (the one it shows is kept).
			maybeDetach(running);
		}
	} catch {
		// The server is away: the view reads the transcript from disk, as it does for a conversation that is not running.
	} finally {
		looking.delete(file);
		endFinding(file);
	}
}

/**
 * The page was loaded on a conversation: until the connection is made and the server has said which process runs it,
 * nothing says that a tool call nobody answered is not being run now. Called before the first render shows it.
 */
export function findViewedProcess(): void {
	const file = viewedFile();
	if (file) startFinding(file);
}

/** The conversation the page shows by its file, if it is one. */
function viewedFile(): string | null {
	const v = useApp.getState().view;
	// The agent graph's conversation is on screen too: its process is looked for and listened to as the chat view's is.
	if (v.kind === "agents") return v.file ?? null;
	return v.kind === "chat" ? v.file : null;
}

/**
 * The page shows `file` through a process that is over (the view names it), and another one now runs the conversation (a
 * resume from another page): the view is pointed at the one that runs it, so that what it streams is shown rather than
 * the end of the one before, and the page lets go of the process it shows only once it moves on. The page is not
 * remounted (the same conversation, see `nextChatKey`).
 */
function followToProcess(file: string, liveId: string): void {
	const { view, lives, setView } = useApp.getState();
	if (view.kind !== "chat" || view.file !== file || !view.liveId || view.liveId === liveId) return;
	const named = lives[view.liveId];
	const running = lives[liveId];
	if ((named && !named.info.exited) || !running || running.info.exited) return;
	setView({ ...view, liveId }, { replace: true });
}

/** The page shows a conversation it holds no process for: if one runs it, the page listens to it. */
function followViewedFile(): void {
	const file = viewedFile();
	if (file) void attachLiveForFile(file);
}

/**
 * The connection is up (or back): listen again to the processes this page held, and to the one that runs the conversation
 * on screen (a turn another page started while this one was away has no `live` frame for it to have heard), and load
 * what may have changed meanwhile. The conversation is looked for once the held processes have answered: the one the page
 * shows may have ended while it was away, and another one run it since.
 */
export function onConnected(): void {
	void resubscribe().then(followViewedFile);
	void useApp.getState().loadSessions();
	void showLives();
}

export function closeLive(liveId: string): void {
	void socket.request({ t: "close", liveId }).catch(() => {});
}

/** Answer a pending dialog: omp gets the response, and the dialog leaves the process's pending list. */
export function answerDialog(liveId: string, response: Record<string, unknown>): void {
	socket.post({ t: "ui_response", liveId, response });
	patchLive(liveId, (s) =>
		withUiRequests(
			s,
			s.uiRequests.filter((r) => r.id !== response.id),
		),
	);
}

/**
 * The user sent a message while tool approvals wait: each is denied first, as the terminal does. omp holds a message it is
 * sent behind an open approval (nothing delivers it until the approval is answered), so it would otherwise sit in the queue
 * with the turn stalled. A note in the conversation says the tools did not run because of the message.
 */
export function denyPendingApprovals(liveId: string): void {
	const pending = useApp.getState().lives[liveId]?.uiRequests.filter(isApproval) ?? [];
	if (pending.length === 0) return;
	for (const req of pending) socket.post({ t: "ui_response", liveId, response: denial(req) });
	patchLive(liveId, (s) => withApprovalsDenied(s, pending));
}

/**
 * A call omp makes to a tool of the web UI that nothing here can serve: another tool's name, or `propose_goal`
 * without an objective. It is answered with an error at once; left alone, the turn would wait for it for good.
 */
function bounceHostCall(liveId: string, call: OmpFrame): void {
	if (call.toolName === PROPOSE_GOAL_TOOL && readProposal(call.arguments)) return;
	const reason =
		call.toolName === PROPOSE_GOAL_TOOL
			? "propose_goal needs a non-empty objective."
			: `The web UI does not provide a tool named ${String(call.toolName)}.`;
	socket.post({ t: "ui_response", liveId, response: { id: call.id, ...hostResult(reason, true) } });
}

/** Change what this conversation asks approval for; omp applies it from its next tool call. */
export async function setApprovalMode(liveId: string, mode: ApprovalMode): Promise<void> {
	const info = await socket.request<LiveInfo>({ t: "approval_mode", liveId, mode });
	patchLive(liveId, (s) => withInfo(s, info));
}

/** Ask the page that shows a conversation (or New chat) to start setting a goal. */
export function requestGoal(mode: "guided" | "direct" = "guided"): void {
	useApp.setState((s) => ({ goalRequest: { id: (s.goalRequest?.id ?? 0) + 1, mode } }));
}

/**
 * Close the overlays the app keeps in its own state (feedback and search) and say whether any was open.
 *
 * Escape belongs to the overlay opened last, and Radix gives it so by registering each dialog as a layer, but only in
 * an effect, a render or two after the dialog is on the page. A key pressed in between reaches the layer underneath,
 * whose Escape would leave the full screen or close the side sheet with the new dialog still up. What is under an
 * overlay calls this first: an overlay that is open at that moment is the newer one, and the Escape is its.
 */
export function dismissOverlays(): boolean {
	const { feedbackOpen, paletteOpen, set } = useApp.getState();
	if (!feedbackOpen && !paletteOpen) return false;
	set({ feedbackOpen: false, paletteOpen: false });
	return true;
}

// ------------------------------------------------------------------ idle processes

/**
 * Lives this tab unsubscribed from because they were idle and off screen, so the
 * server's reaper can close them. Their state stays; showing one re-attaches it
 * (or finds it gone and resumes from the session file on the next send).
 */
const detached = new Set<string>();

/** The process of the conversation on screen, where its dialogs are answered (no toast is needed for them). */
function viewedLiveId(): string | null {
	const v = useApp.getState().view;
	if (v.kind !== "chat") return null;
	return v.liveId ?? liveFor(v.file)?.info.liveId ?? null;
}

/**
 * The process the page keeps listening to whatever it is doing: the conversation on screen, or the one the agent graph
 * draws (#719), whose subagents it shows as they run. The graph answers no dialog, so its conversation's still toast.
 */
function listenedLiveId(): string | null {
	const v = useApp.getState().view;
	if (v.kind === "agents") return v.file ? (liveFor(v.file)?.info.liveId ?? null) : null;
	return viewedLiveId();
}

/**
 * Stop listening to a process nobody looks at, once omp says it is done: `settled` (its `session_settled` frame, or
 * `get_state.isSettled`: not streaming, nothing queued, no background job that can wake the agent, no goal turn about
 * to start, no retry wait or compaction). The first terminal `agent_end` is not that: a goal's next turn starts a
 * moment after it, and a page that has let go of the process hears nothing of it, not even a dialog that waits for the
 * user. The server closes a process only when no page listens.
 */
function maybeDetach(liveId: string): void {
	const st = useApp.getState();
	const live = st.lives[liveId];
	if (!live || live.info.exited || detached.has(liveId) || liveId === listenedLiveId()) return;
	if (!live.settled || live.streaming || live.uiRequests.length || st.bash[liveId]?.length) return;
	detached.add(liveId);
	socket.post({ t: "detach", liveId });
}

export function onViewChange(): void {
	const shown = listenedLiveId();
	if (shown && detached.has(shown)) void attachLive(shown);
	for (const id of Object.keys(useApp.getState().lives)) maybeDetach(id);
	releaseExited();
	followViewedFile();
}

/**
 * Change the `!commands` a process is running, as a function of the ones the page holds: no change leaves the store alone
 * (nothing that reads it is told), and a process with none has no entry.
 */
function setBash(liveId: string, change: (runs: RunningBash[]) => RunningBash[]): void {
	const now = useApp.getState().bash[liveId] ?? NO_BASH;
	const next = change(now);
	if (next.length === now.length && next.every((r, i) => r === now[i])) return;
	useApp.setState((s) => {
		const { [liveId]: _gone, ...others } = s.bash;
		return { bash: next.length > 0 ? { ...others, [liveId]: next } : others };
	});
}

/** The server says a `!command` runs (`bash_started`, which every page that listens to the process hears, the one that sent it too). */
function noteBashStarted(liveId: string, frame: OmpFrame): void {
	const run = bashRunOf(frame);
	if (!run) return;
	setBash(liveId, (runs) =>
		runs.some((r) => r.id === run.id)
			? runs
			: [...runs, { id: run.id, command: run.command, startedAt: run.startedAt - serverOffsetMs() }],
	);
}

/**
 * Run a user `!command` without blocking. That it runs is the server's word, not this page's: a `!command` is the
 * conversation's, so the server says when one starts and when omp answers it (`bash_started`, `bash_ended`) to every page
 * that listens, which then shows it with its Stop; this page sends it and settles what comes of it in the background
 * (the transcript refreshes and a non-zero exit is reported). omp runs commands side by side, so one sent while another
 * runs does not wait for it.
 */
export function runBash(liveId: string, command: string): void {
	const { toast } = useApp.getState();
	void socket
		.rpc<{ exitCode?: number; cancelled?: boolean }>(liveId, { type: "bash", command })
		.then((r) => {
			if (r?.exitCode && !r.cancelled) toast("warning", t("chat.toastCommandExited", { code: r.exitCode }));
		})
		.catch((e) => toast("error", (e as Error).message))
		.finally(() => {
			void refreshEntries(liveId);
			maybeDetach(liveId);
		});
}

/** Stop the `!command`s that run; resolves when they have stopped, or when the server ended omp's process because they would not (see `Live.stop`). */
export function abortBash(liveId: string): Promise<void> {
	return socket.stop(liveId, { type: "abort_bash" }).then(
		() => {},
		() => {},
	);
}

/** Cancel the backoff before omp's next automatic retry of a failed turn. */
export function abortRetry(liveId: string): void {
	void socket.act(liveId, { type: "abort_retry" }).catch(() => {});
}

/**
 * Stop one running subagent with omp's `cancel_subagent` (a hard kill): it ends as `aborted`, and the other subagents of
 * its task call go on. Says what came of it; a subagent that was over by then is not an error.
 */
export async function stopSubagent(liveId: string, subagentId: string): Promise<void> {
	const { toast } = useApp.getState();
	try {
		const r = await socket.act<{ cancelled?: boolean }>(liveId, { type: "cancel_subagent", subagentId });
		toast(r.cancelled ? "success" : "info", t(r.cancelled ? "panel.agentStopped" : "panel.agentNotRunning"));
	} catch (e) {
		toast("error", (e as Error).message);
	}
}

/**
 * Retry now, without waiting for omp's countdown: the server ends the backoff with omp's `abort_retry` and has omp redo
 * the failed turn with its own `/retry`. A paused conversation runs again for it, as for any prompt. Resolves once omp
 * has taken it; a refusal says why. It is the conversation's own retry: omp has no command that retries a subagent
 * (see tests/contract/subagent-retry.test.ts; `continueSubagent` is the way round it: Stop, then the main agent brings
 * the subagent back, tests/contract/subagent-revive.test.ts), so what the page holds of their waits is read from omp's
 * registry again, which says which of them still wait.
 */
export async function retryNow(liveId: string): Promise<void> {
	const info = await socket.request<LiveInfo>({ t: "retry_now", liveId });
	patchLive(liveId, (s) => withInfo(s, info));
	void syncSubagents(liveId);
}

/** Freeze (or continue) omp and everything it started; the new state arrives as a `live` announce. */
export async function setPaused(liveId: string, paused: boolean): Promise<void> {
	const info = await socket.request<LiveInfo>({ t: paused ? "pause" : "resume", liveId });
	patchLive(liveId, (s) => withInfo(s, info));
	if (!paused) {
		// Anything omp produced while requests were refused shows up now.
		void refreshEntries(liveId);
		void refreshState(liveId);
		// A frozen omp refused the goal read, and `goal resume` on an active goal says nothing in a frame.
		void readGoal(liveId);
		// omp retries a subagent whose wait came due while it was frozen at once, and the frames that say so may have been
		// missed by a page that was away: its registry is read again, and a wait it no longer has goes.
		void syncSubagents(liveId);
	}
}

/**
 * Let a paused conversation run for work the user asks of it that only a running process does and that can take a
 * while (a prompt, Compact, a side question, starting a goal): held, it would not do it, and letting it run for the
 * whole of it would let everything else it holds run too. The click ends the pause; the caller says so. Resolves to
 * whether the conversation was paused.
 */
export async function continueConversation(liveId: string): Promise<boolean> {
	if (!useApp.getState().lives[liveId]?.info.pausedAt) return false;
	await setPaused(liveId, false);
	return true;
}

// ------------------------------------------------------------------ automatic titles

/**
 * Whether Settings has automatic titles on (the switch's state). omp disables them in RPC mode, so something has to ask for
 * one after a conversation's first exchange: the server does (`server/auto-title.ts`), for every conversation it holds, with a
 * page open on it or not. The page only keeps the choice, which the server reads from its copy of the preferences.
 */
export function autoTitleEnabled(): boolean {
	return localStorage.getItem(PREF.autoTitle) !== "off";
}

const ENTRY_REFRESH_EVENTS: Record<string, true> = {
	message_end: true,
	agent_end: true,
	turn_end: true,
	auto_compaction_end: true,
	session_info_update: true,
};

const STATE_REFRESH_EVENTS: Record<string, true> = {
	agent_end: true,
	model_changed: true,
	// A setting changed on another page, which omp does not announce (the server does: `settingFrame`).
	settings_changed: true,
	thinking_level_changed: true,
	session_info_update: true,
	config_update: true,
	auto_compaction_end: true,
	// omp reports the usage-limit stage and the fast mode with its state only: a slash command (`/fast`, `/slow`) changes them.
	command_output: true,
	// The todo list is cleared when it is finished: the state no longer has it.
	todo_auto_clear: true,
	// The list was replaced from another page (`announceTodos` of the server): omp says nothing of it itself.
	todos_changed: true,
	session_settled: true,
};

/**
 * A dialog arrived for a conversation the user is not looking at: omp waits for them, so say so.
 * The sidebar marks it (`needsInput`) and a toast offers to open it. A dialog the server replays to
 * a tab that already holds it is not new.
 */
function notifyNewDialogs(liveId: string, before: LiveState): void {
	const now = useApp.getState().lives[liveId];
	// Only a dialog frame replaces the pending list, so every other frame (a streamed token) stops here.
	if (!now || now.uiRequests === before.uiRequests || liveId === viewedLiveId()) return;
	if (!now.uiRequests.some((r) => !before.uiRequests.some((b) => b.id === r.id))) return;
	toastNeedsInput(liveId);
}

/** A conversation the user is not looking at waits for their answer: a toast says so, and opens it. */
function toastNeedsInput(liveId: string): void {
	const st = useApp.getState();
	const now = st.lives[liveId];
	if (!now) return;
	const file = now.info.sessionFile;
	const summary = file ? st.sessions.find((s) => s.file === file) : undefined;
	const title =
		now.state?.sessionName ||
		summary?.title ||
		summary?.preview ||
		(file ? t("chat.untitledSession") : t("chat.newConversation"));
	st.toast("warning", t("chat.toastNeedsInput", { title }), {
		label: t("chat.toastOpenChat"),
		run: () => useApp.getState().setView({ kind: "chat", file, liveId }),
	});
}

/** The list is reloaded at most this often: omp writes its session file several times a second while it answers. */
const SESSIONS_RELOAD_MS = 1500;
let sessionsReload: ReturnType<typeof setTimeout> | null = null;
let sessionsReloadedAt = 0;
/** The server's cursor for the list as shown: the next load asks for what changed since it. */
let sessionsCursor: string | null = null;
/** Ends when the load that last asked for its turn is done (see `loadSessions`). */
let sessionsTurn: Promise<void> = Promise.resolve();

/** A session file changed: reload the list now if it has been a while, otherwise once the wait is over (one reload for every change meanwhile). */
function scheduleSessionsReload(): void {
	if (sessionsReload) return;
	sessionsReload = setTimeout(
		() => {
			sessionsReload = null;
			sessionsReloadedAt = Date.now();
			void useApp.getState().loadSessions();
		},
		Math.max(0, sessionsReloadedAt + SESSIONS_RELOAD_MS - Date.now()),
	);
}

/** Fold one server message into the store. Exported for the unit tests; the socket is its only caller. */
export function onServer(msg: ServerMessage): void {
	switch (msg.t) {
		case "hello":
			// Times the server stamps (when omp's backoff began) are on its clock, which this page's may be far from.
			if (typeof msg.time === "number") noteServerTime(msg.time);
			return;
		case "app_update":
			onAppUpdateMessage(msg.state);
			return;
		case "omp":
		case "omp_log":
			onOmpMessage(msg);
			// Settings shows the version from here: an install or an update changes it.
			if (msg.t === "omp") {
				const ompVersion = msg.state.version ?? "unknown";
				useApp.setState((st) =>
					st.meta && st.meta.ompVersion !== ompVersion ? { meta: { ...st.meta, ompVersion } } : {},
				);
			}
			return;
		case "frame": {
			const { liveId, frame } = msg;
			const before = useApp.getState().lives[liveId];
			if (!before) return;
			// A `!command` begins or ends, which this page may not have sent: the list of what runs is the server's word.
			if (frame.type === "bash_started") {
				noteBashStarted(liveId, frame);
				return;
			}
			if (frame.type === "bash_ended") {
				const id = String(frame.id);
				setBash(liveId, (runs) => runs.filter((r) => r.id !== id));
				// What it printed is in the transcript now, on every page.
				void refreshEntries(liveId);
				maybeDetach(liveId);
				return;
			}
			noteTurnFrame(liveId, frame, before.entries);
			// Each frame says the revision it moved the process to: a page that has read the conversation is current as of it.
			const rev = msg.rev;
			patchLive(liveId, (s) => {
				const next = applyFrame(s, frame);
				return rev === undefined || next.revision === null || next.revision === rev ? next : { ...next, revision: rev };
			});
			notifyNewDialogs(liveId, before);
			if (frame.type === "host_tool_call") bounceHostCall(liveId, frame);
			if (ENTRY_REFRESH_EVENTS[frame.type]) void refreshEntries(liveId);
			// An answer nobody here is waiting for: a command (a `!command`) a former server sent, finishing in a
			// conversation it left paused (see server/omp/parked.ts). Its output is in the transcript now.
			if (frame.type === "response") void refreshEntries(liveId);
			if (STATE_REFRESH_EVENTS[frame.type]) void refreshState(liveId);
			// The todo tool changed the list; nothing else says so until the turn ends.
			if (frame.type === "tool_execution_end" && frame.toolName === "todo") void refreshState(liveId);
			// omp is done: the process is let go of when nobody looks at it (see `maybeDetach`).
			if (frame.type === "session_settled" || (frame.type === "agent_end" && frame.isTerminal !== false))
				maybeDetach(liveId);
			if (frame.type === "notice") {
				const shown = noticeToast(frame);
				if (shown) useApp.getState().toast(shown.level, shown.text);
			}
			if (frame.type === "extension_ui_request" && frame.method === "notify") {
				const level = frame.notifyType === "error" ? "error" : frame.notifyType === "warning" ? "warning" : "info";
				useApp.getState().toast(level, String(frame.message ?? ""));
			}
			if (frame.type === "extension_error") {
				useApp.getState().toast("error", t("shell.storeExtensionError", { error: String(frame.error ?? "") }));
			}
			return;
		}
		case "live": {
			const st = useApp.getState();
			const cur = st.lives[msg.info.liveId];
			if (cur) {
				const left = cur.info.sessionFile;
				const fileChanged = left !== msg.info.sessionFile;
				patchLive(msg.info.liveId, (s) => withInfo(s, msg.info));
				// A process this page does not listen to says what it does only here: its dot, the tab's count, a toast (#592).
				// Only a change of what the server says counts: the same word again (a page attached, a setting changed) is no news
				// of the work, and the page's own knowledge of it stands.
				const listed = detached.has(cur.info.liveId);
				const was = cur.info;
				const now = msg.info;
				const worked =
					was.streaming !== now.streaming ||
					Boolean(was.asking) !== Boolean(now.asking) ||
					Boolean(was.continuing) !== Boolean(now.continuing);
				if (listed && !now.exited && worked) {
					patchLive(now.liveId, (s) => withWork(s, now));
					if (now.asking && !cur.needsInput && now.liveId !== viewedLiveId()) toastNeedsInput(now.liveId);
				}
				// Another tab (or the server) resumed it: omp retries what came due while it was frozen at once, and what this
				// page holds of its subagents' waits is brought up to omp's registry, as for its own Resume (see `setPaused`).
				if (cur.info.pausedAt && !msg.info.pausedAt && !msg.info.exited && !listed) void syncSubagents(msg.info.liveId);
				// The process has ended, and this page is told how it ended: the `live_exit` frame reaches only the
				// subscribers, and the idle reaper closes the processes nobody watches, so a page that let go of one
				// learns of its end here (#515). A `live` frame without an end says only that the process is gone.
				if (msg.info.exited) markExited(msg.info.liveId, msg.info.exit ?? null);
				if (fileChanged) {
					// Another session in the same process (/new, fork, branch, resume): nothing of the one it left is this
					// conversation's, and everything is read from omp again. The first file of a new chat is no such change,
					// nor is the same session under another spelling of its path (a symlinked temp or home directory).
					const sameSession = cur.info.sessionId !== null && cur.info.sessionId === msg.info.sessionId;
					if (left !== null && !sameSession) {
						patchLive(msg.info.liveId, leaveSession);
						// Nothing of a process this page only lists is read: showing it listens to it, and that reads it.
						if (listed) patchLive(msg.info.liveId, (s) => withWork(s, now));
						else void hydrate(msg.info);
					} else if (!listed) {
						void refreshEntries(msg.info.liveId, true);
					}
					// The process moved on (branch, fork, /new…). A view that shows it follows: one that names the process,
					// or the file the process was running (a sidebar, search or deep-link entry names only the file).
					const to = msg.info.sessionFile;
					// A draft written while the conversation had no file is kept under its process: it follows to the file, also when nobody is looking.
					if (to && left === null) {
						moveDraft(msg.info.liveId, to);
						// What a command printed before the first message belongs to the conversation the file now names.
						patchLive(msg.info.liveId, (s) =>
							s.commandOutput.some((n) => n.file === null)
								? { ...s, commandOutput: s.commandOutput.map((n) => (n.file === null ? { ...n, file: to } : n)) }
								: s,
						);
					}
					const v = st.view;
					if (to && v.kind === "chat" && (v.liveId === msg.info.liveId || (left !== null && v.file === left))) {
						// The subagents of the session the process left are not this conversation's: only a conversation
						// that has just got its first file (or the same session under another spelling) keeps its full screen.
						const keeps = v.agent !== undefined && (left === null || sameSession);
						st.setView(
							{
								kind: "chat",
								file: to,
								liveId: msg.info.liveId,
								from: left ?? undefined,
								...(keeps ? { agent: v.agent } : {}),
							},
							{ replace: true },
						);
					}
					void st.loadSessions();
				} else {
					// The process had its file before this page held it: omp names it as the process starts, which can be before
					// the page's own start is answered, so no frame ever changes it. A view that names only the process takes
					// the file the first time a frame says it (the address is then the conversation's, `#/s/…`).
					const v = st.view;
					const to = msg.info.sessionFile;
					if (to && v.kind === "chat" && v.liveId === msg.info.liveId && v.file === null)
						st.setView({ ...v, file: to }, { replace: true });
				}
			} else if (!msg.info.exited && msg.info.sessionFile) {
				// A process this page does not hold has appeared for a file: what the server answered of it before is stale.
				answered.delete(msg.info.sessionFile);
				if (!opening.has(msg.info.sessionFile)) {
					if (msg.info.sessionFile === viewedFile()) {
						// A process started for the conversation this page shows (another page sent the message, or the server took it
						// over): the page was told because every page is, and listens to it from here.
						void attachLiveForFile(msg.info.sessionFile, msg.info.liveId);
					} else {
						// One for a conversation this page does not show (another page runs it): it is listed with what it is doing.
						listElsewhere(msg.info);
					}
				}
			}
			return;
		}
		case "live_exit":
			markExited(msg.liveId, {
				code: msg.code,
				...(msg.signal ? { signal: msg.signal } : {}),
				stderr: msg.stderr,
				by: msg.by ?? "omp",
				...(msg.reason ? { reason: msg.reason } : {}),
			});
			return;
		case "attached": {
			// A server that predates `held` names nothing it keeps, so the page drops what it shows of it (see `EMPTY_HOLD`).
			const held = msg.held ?? EMPTY_HOLD;
			patchLive(msg.liveId, (s) => applyAttached(s, msg.dialogs, msg.message, held));
			// A `!command` the page shows and the server does not hold ended while it was away.
			setBash(msg.liveId, (runs) => runs.filter((r) => held.bashes.includes(r.id)));
			return;
		}
		case "questions":
			// Unattended mode's counts (#646), as the sidebar's badge shows them.
			useApp.setState((s) => (s.meta ? { meta: { ...s.meta, questions: msg.counts } } : s));
			return;
		case "favorite_models":
			useApp.setState((s) => ({ favoriteModels: shareStrings(s.favoriteModels, msg.models) }));
			return;
		case "sessions_changed":
			scheduleSessionsReload();
			return;
		case "project_groups":
			// Another page (or this one's other tab) changed the groups: read them again, without waiting for a session change.
			void useApp.getState().loadSessions();
			return;
		case "remote":
			onRemoteMessage(msg.status);
			return;
		case "macs_changed":
			// `/api/meta` carries the list: the sidebar's machine switcher follows it.
			void loadMeta();
			return;
		case "guard_decision":
		case "guard_config":
			onGuardMessage(msg);
			return;
		default:
			return;
	}
}

/** The conversation a view shows: its file, or its process while it has no file. */
function sameConversation(a: View, b: View): boolean {
	return (
		a.kind === "chat" &&
		b.kind === "chat" &&
		((a.file !== null && a.file === b.file) || (a.liveId !== null && a.liveId === b.liveId))
	);
}

/**
 * The view a step through the history shows. An address says only the file and the subagent, so a step into or out of
 * a subagent's full screen (or between two) keeps the conversation as the page shows it — its process, branch and
 * focus — and changes only the full screen: the page under it is not shown again.
 */
export function viewOfStep(now: View, next: View): View {
	if (now.kind !== "chat" || next.kind !== "chat" || now.agent === next.agent || !sameConversation(now, next))
		return next;
	const { agent: _agent, ...conversation } = now;
	return next.agent ? { ...conversation, agent: next.agent } : conversation;
}

let started = false;
export async function startApp(): Promise<void> {
	if (started) return;
	started = true;
	// A Cloudflare login the AI started waits for the browser: its link is for the person, who finds it here (and on the card).
	onLoginNotice((url) => {
		const target = webUrl(url);
		if (!target) return;
		useApp.getState().toast("info", t("remote.loginReady"), {
			label: t("remote.loginOpen"),
			run: () => window.open(target, "_blank", "noopener,noreferrer"),
		});
	});
	useApp.setState({ view: viewFromHash() });
	findViewedProcess();
	// The page's first entry has no id yet: give it one, so that Back to it finds what is kept for it.
	const entry = entryIdOf(history.state) ?? newEntryId();
	if (entryIdOf(history.state) === null) history.replaceState({ ...history.state, ...entryState(entry) }, "");
	enterEntry(entry);
	window.addEventListener("popstate", (e) => {
		const id = entryIdOf(e.state);
		const next = viewFromHash();
		const view = viewOfStep(useApp.getState().view, next);
		whenFree(
			view,
			() => {
				// The page still shows what it is leaving: keep where the reader is in it, then show the entry it returns to.
				keepReading();
				enterEntry(id);
				const reading = readingOf(id);
				useApp.setState({ view: view === next && view.kind === "chat" && reading ? { ...view, reading } : view });
			},
			// The person stays: the address goes back to what is still shown, as a new entry (the one Back went to is kept).
			() => writeHash(useApp.getState().view, false),
		);
	});
	// The API needs the per-install token (cookie); without it show the unlock screen instead of connecting.
	const res = await fetch("/api/meta").catch(() => null);
	if (res?.status === 401) {
		useApp.setState({ locked: true });
		return;
	}
	socket.on(onServer);
	useApp.subscribe((s, prev) => {
		if (s.view !== prev.view) onViewChange();
		// What commands printed is kept by file (see `command-notes.ts`): written when a process's list changes, a note
		// added or one taken out (a preset switch's), and seeded back when the page is loaded anew.
		if (s.lives === prev.lives) return;
		for (const [id, live] of Object.entries(s.lives)) {
			const before = prev.lives[id]?.commandOutput;
			if (live.commandOutput !== before) rememberCommandNotes(live.commandOutput, before);
		}
	});
	let first = true;
	socket.onStatus((c) => {
		useApp.setState({ connected: c });
		if (!c) return;
		// Re-subscribe so streams resume, and resync what may have changed while disconnected
		// (or never loaded, when the page opened with the server down).
		onConnected();
		void sessionActions
			.favoriteModels()
			.then((favoriteModels) => useApp.setState({ favoriteModels }))
			.catch(() => {});
		if (!first || !useApp.getState().meta) void loadMeta();
		// Installed, updated or checked while the page was away.
		void ompApi.load().catch(() => {});
		if (!useApp.getState().meta?.remote) void remoteApi.load();
		first = false;
	});
	if (res?.ok) useApp.setState({ meta: await res.json() });
	// Before the page connects: whether omp is installed decides what it shows.
	await ompApi.load().catch(() => {});
	// The sidebar's indicator shows the tunnel; a page that came in through it is refused the routes and has no use for them.
	if (!useApp.getState().meta?.remote) void remoteApi.load();
	socket.connect();
}

async function loadMeta(): Promise<void> {
	const res = await fetch("/api/meta").catch(() => null);
	if (res?.ok) useApp.setState({ meta: await res.json() });
}
