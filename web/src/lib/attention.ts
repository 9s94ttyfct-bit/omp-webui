import { attentionOf, isLookingAt, type Shown } from "@shared/attention.ts";
import { PREF, PUSH_DEVICE_KEY } from "@shared/prefs.ts";
import { create } from "zustand";
import { t } from "../i18n/index.ts";
import { useApp, type View } from "../store/app.ts";
import type { LiveState } from "../store/live.ts";
import { setPref } from "./prefs.ts";
import {
	inRemoteShell,
	inShell,
	onShellEvent,
	reportShown,
	type ShellEvent,
	shellRequest,
	shellStatus,
} from "./shell-notify.ts";

/**
 * Telling someone who is not looking at a conversation that it needs them: the tab's title carries a count of the conversations
 * waiting for an answer and a mark for a turn that finished while the tab was hidden, and, in a browser, when Settings has
 * it on, the system shows a notification for either, unless the person is looking at that conversation (`isLookingAt`: this
 * window is in use and shows it). In the macOS app the page does not notify at all: the app shows the notifications itself,
 * from what the server streams to it (`shared/attention.ts`, `server/shell-events.ts`), so that they do not depend on a page
 * that may not exist (Run in Background closes the window); the page only tells the shell which conversation it shows.
 */

/** The tab title: `(2) omp` for two conversations waiting for an answer, `✓ omp` once a turn finished unseen, or both. */
export function tabTitle(base: string, asking: number, finished: boolean): string {
	return `${asking > 0 ? `(${asking}) ` : ""}${finished ? "✓ " : ""}${base}`;
}

type Lives = Record<string, LiveState>;

/** Conversations whose omp process waits for an answer to a dialog (a tool approval, a question). */
export function askingCount(lives: Lives): number {
	return Object.values(lives).filter((l) => l.needsInput && !l.info.exited).length;
}

export interface Changes {
	/** Processes that started waiting for an answer. */
	asking: string[];
	/** Processes whose run ended (not ones that died): a turn, or a goal's whole run, which is many turns. */
	finished: string[];
}

/** What happened to the processes between two states of the store. */
export function attentionChanges(prev: Lives, next: Lives): Changes {
	const changes: Changes = { asking: [], finished: [] };
	for (const [id, now] of Object.entries(next)) {
		if (now.info.exited || now.exited) continue;
		const kinds = attentionOf(prev[id], now);
		if (kinds.includes("asking")) changes.asking.push(id);
		if (kinds.includes("finished")) changes.finished.push(id);
	}
	return changes;
}

// ------------------------------------------------------------------ notifications

interface NotifyState {
	/** Whether the person turned notifications on in Settings. */
	enabled: boolean;
	/** What the browser allows (in the macOS app: what macOS allows it); "unsupported" where there are no notifications at all. */
	permission: NotificationPermission | "unsupported";
}

const browserPermission = (): NotifyState["permission"] =>
	typeof Notification === "undefined" ? "unsupported" : Notification.permission;

/**
 * In the macOS app only Settings uses this: what macOS allows is told by the shell (`followShell`), so it starts as not
 * asked yet. The app's notifications are not the page's to show, whatever this says.
 */
export const useNotify = create<NotifyState>(() => ({
	// Not every importer is a page: the unit tests load this before any browser stand-in exists.
	enabled: typeof localStorage !== "undefined" && localStorage.getItem(PREF.notify) === "on",
	permission: inShell() ? "default" : browserPermission(),
}));

/**
 * Turn notifications on or off. Turning them on asks for permission the first time (the browser, or macOS through the app
 * shell, shows its own prompt); without it they stay off.
 */
export async function setNotifications(on: boolean): Promise<void> {
	let permission: NotifyState["permission"];
	if (inShell()) {
		// Ask even when the store says it is settled: macOS prompts only while the person has not decided, and its answer is
		// what it allows now (a change made in System Settings meanwhile included).
		permission = on ? await shellRequest() : useNotify.getState().permission;
	} else {
		if (on && typeof Notification !== "undefined" && Notification.permission === "default") {
			await Notification.requestPermission();
		}
		permission = browserPermission();
	}
	const enabled = on && permission === "granted";
	setPref(PREF.notify, enabled ? "on" : "off");
	useNotify.setState({ enabled, permission });
}

function chatTitle(live: LiveState): string {
	const st = useApp.getState();
	const file = live.info.sessionFile;
	const summary = file ? st.sessions.find((s) => s.file === file) : undefined;
	return (
		live.state?.sessionName ||
		summary?.title ||
		summary?.preview ||
		(file ? t("chat.untitledSession") : t("chat.newConversation"))
	);
}

/**
 * Whether this browser has Web Push on (`lib/push-presence.ts`, which only such a browser loads): the push tells it, so its own
 * notification would be a second one.
 */
const pushOn = (): boolean => {
	try {
		return localStorage.getItem(PUSH_DEVICE_KEY) !== null;
	} catch {
		return false;
	}
};

/**
 * Whether this window is the one the person is using: its tab is shown and the window has the focus. A page that cannot say
 * whether it has the focus (a test's stand-in) counts as having it.
 */
export function windowInUse(): boolean {
	if (document.visibilityState !== "visible") return false;
	return typeof document.hasFocus !== "function" || document.hasFocus();
}

/** The conversation a view shows: by its process, which a view may leave out (a saved conversation names its file), and by its file. */
export function shownConversation(view: View, lives: Lives): Shown | null {
	if (view.kind !== "chat") return null;
	const running =
		view.liveId ??
		(view.file === null
			? undefined
			: Object.values(lives).find((l) => !l.info.exited && l.info.sessionFile === view.file)?.info.liveId);
	return { liveId: running ?? null, file: view.file };
}

/** Whether the person is looking at this conversation now: this window is in use and shows it. */
function lookingAt(live: LiveState): boolean {
	const { view, lives } = useApp.getState();
	return isLookingAt(windowInUse(), shownConversation(view, lives), {
		liveId: live.info.liveId,
		file: live.info.sessionFile,
	});
}

function notify(liveId: string, kind: keyof Changes): void {
	const live = useApp.getState().lives[liveId];
	if (!live || !useNotify.getState().enabled) return;
	// A browser that has Web Push on is told by the push (which the server does not send while a page of the device is on screen).
	if (pushOn()) return;
	if (browserPermission() !== "granted") return;
	// Nothing for what the person is looking at: a conversation in a window that is in use, and on screen in it.
	if (lookingAt(live)) return;
	try {
		const note = new Notification(chatTitle(live), {
			body: t(kind === "asking" ? "chat.notifyAsking" : "chat.notifyFinished"),
			// One notification per conversation: a newer one replaces the older.
			tag: liveId,
		});
		note.onclick = () => {
			window.focus();
			note.close();
			useApp.getState().setView({ kind: "chat", file: live.info.sessionFile, liveId });
		};
	} catch {
		// The browser refuses to construct notifications here (some mobile browsers want a service worker).
	}
}

/** A click on a notification the app showed: its conversation opens. One that has gone since (the app was started again) is opened from its file. */
function openFromShell(event: Extract<ShellEvent, { type: "open" }>): void {
	const st = useApp.getState();
	const live = event.liveId === null ? undefined : st.lives[event.liveId];
	const file = live?.info.sessionFile ?? event.file;
	if (live || file !== null) st.setView({ kind: "chat", file, liveId: live ? live.info.liveId : null });
}

/**
 * What the macOS app says on its own: what macOS allows now (asked at start, and told again whenever the app comes to the
 * front, for it may have been changed in System Settings), and a click on a notification the app showed, which opens its
 * conversation (the page it opens in is a new one, so the click is handed over once the page has asked `status`).
 */
function followShell(): () => void {
	// Listening comes first: a click that started the app is handed over right after the shell has answered the status.
	const stop = onShellEvent((event) => {
		if (event.type === "permission") return useNotify.setState({ permission: event.permission });
		openFromShell(event);
	});
	void shellStatus().then((permission) => useNotify.setState({ permission }));
	return stop;
}

/** The window of another Mac: only a click on one of that Mac's notifications is heard (the page is up once it has said what it shows). */
function followRemoteShell(): () => void {
	return onShellEvent((event) => {
		if (event.type === "open") openFromShell(event);
	});
}

/**
 * Tell the shell which conversation is on screen, now and whenever that changes: with the window's own state, which only the
 * shell knows, it is what decides that a conversation is not looked at. Returns the way to stop.
 */
function tellShellWhatIsShown(): () => void {
	let said: string | undefined;
	const tell = (view: View, lives: Lives) => {
		const shown = shownConversation(view, lives);
		const key = JSON.stringify(shown);
		if (key === said) return;
		said = key;
		reportShown(shown);
	};
	tell(useApp.getState().view, useApp.getState().lives);
	return useApp.subscribe((state, prev) => {
		if (state.view !== prev.view || state.lives !== prev.lives) tell(state.view, state.lives);
	});
}

// ------------------------------------------------------------------ the page

/**
 * Keep the tab's title and the notifications up to date with the processes in the store; returns the way to stop.
 * A turn that ends while the tab is hidden marks the title until the tab is shown again.
 */
export function startAttention(): () => void {
	const base = document.title;
	const unseen = new Set<string>();
	const show = () => {
		const title = tabTitle(base, askingCount(useApp.getState().lives), unseen.size > 0);
		if (document.title !== title) document.title = title;
	};
	const stopShell = inShell() ? followShell() : inRemoteShell() ? followRemoteShell() : undefined;
	// The shell shows the notifications; what it cannot know is which conversation this page shows.
	const stopTelling = stopShell ? tellShellWhatIsShown() : undefined;
	// Web Push, for a browser that turned it on: where this page stands (on screen or not), and a click on a notification.
	let closed = false;
	if (pushOn()) void import("./push-presence.ts").then((m) => closed || m.startPushPage());
	const stop = useApp.subscribe((state, prev) => {
		// Only `lives` matters, and a streamed token changes it: what follows is a loop over a few processes.
		if (state.lives === prev.lives) return;
		const changes = attentionChanges(prev.lives, state.lives);
		if (document.visibilityState === "hidden") for (const id of changes.finished) unseen.add(id);
		show();
		// The macOS app notifies by itself (see the top of this file), and so does the app for another Mac's window.
		if (stopShell) return;
		for (const id of changes.asking) notify(id, "asking");
		for (const id of changes.finished) notify(id, "finished");
	});
	const onVisibility = () => {
		if (document.visibilityState !== "visible") return;
		unseen.clear();
		show();
	};
	document.addEventListener("visibilitychange", onVisibility);
	show();
	return () => {
		stop();
		stopShell?.();
		stopTelling?.();
		closed = true;
		document.removeEventListener("visibilitychange", onVisibility);
		document.title = base;
	};
}
