import { isRecord } from "@shared/guards.ts";
import { PUSH_DEVICE_KEY } from "@shared/prefs.ts";
import { PUSH_API, PUSH_HEARTBEAT_MS, type PushList } from "@shared/push.ts";
import { useApp } from "../store/app.ts";
import { shownConversation, windowInUse } from "./attention.ts";
import { socket } from "./ws.ts";

/**
 * What a page that is open does for Web Push (#629), kept apart from the card that turns it on (`components/PushSettings.tsx`,
 * lazy) because it runs on every page of a device that has it on: the device's name, what this page shows (the server does not
 * push a conversation to a device whose page is in use and shows that conversation, `isLookingAt`), a click on a notification
 * that came while this page was open, and whether the server still has the device. Loaded only by a browser that has Web Push on
 * (`startAttention` asks `PUSH_DEVICE_KEY` first), so that no other page carries it.
 */

/** This browser as the server knows it: its own name for itself (what presence says) and the id the server gave it (what revoke names). */
export interface PushDeviceRef {
	device: string;
	id: string;
}

export function pushDevice(): PushDeviceRef | null {
	try {
		const raw = localStorage.getItem(PUSH_DEVICE_KEY);
		const stored: unknown = raw === null ? null : JSON.parse(raw);
		if (!isRecord(stored)) return null;
		const { device, id } = stored;
		return typeof device === "string" && typeof id === "string" ? { device, id } : null;
	} catch {
		return null;
	}
}

/** Remember this browser as subscribed (or, with null, as not), and start or stop what a subscribed page does. */
export function rememberPushDevice(ref: PushDeviceRef | null): void {
	try {
		if (ref === null) localStorage.removeItem(PUSH_DEVICE_KEY);
		else localStorage.setItem(PUSH_DEVICE_KEY, JSON.stringify(ref));
	} catch {
		// No storage: the page cannot say who it is, and push is as if it were off here.
	}
	if (ref === null) stopPushPage();
	else startPushPage();
}

/**
 * Tell the server, while this page is in use (its tab shown and its window focused), that it is, and which conversation it
 * shows: when either changes, when the connection is made again, and every `PUSH_HEARTBEAT_MS` (the server believes it for 2.8
 * of them). Returns the way to stop.
 */
function startPresence(device: string): () => void {
	let last = "";
	const say = (on: boolean, force: boolean) => {
		if (!socket.connected) return;
		const { view, lives } = useApp.getState();
		const shown = on ? shownConversation(view, lives) : null;
		const message = {
			t: "presence",
			device,
			visible: on,
			liveId: shown?.liveId ?? null,
			file: shown?.file ?? null,
		} as const;
		// What is said again unchanged is only the heartbeat's: the store changes with every streamed token.
		const key = JSON.stringify(message);
		if (!force && key === last) return;
		last = key;
		socket.post(message);
	};
	const now = (force: boolean) => say(windowInUse(), force);
	const beat = setInterval(() => {
		if (windowInUse()) say(true, true);
	}, PUSH_HEARTBEAT_MS);
	const forget = socket.onStatus((connected) => connected && now(true));
	const away = () => say(false, true);
	const changed = () => now(false);
	const returned = () => now(true);
	const unsubscribe = useApp.subscribe((state, prev) => {
		// A view that names a process shows it whatever the processes do; one that names only a file follows them.
		const follows = state.view.kind === "chat" && state.view.liveId === null && state.lives !== prev.lives;
		if (state.view !== prev.view || follows) changed();
	});
	document.addEventListener("visibilitychange", changed);
	window.addEventListener("focus", changed);
	window.addEventListener("blur", changed);
	// A page that iOS puts away may not get its `visibilitychange` through: `pagehide` is the other chance to say so.
	window.addEventListener("pagehide", away);
	window.addEventListener("pageshow", returned);
	now(true);
	return () => {
		clearInterval(beat);
		forget();
		unsubscribe();
		document.removeEventListener("visibilitychange", changed);
		window.removeEventListener("focus", changed);
		window.removeEventListener("blur", changed);
		window.removeEventListener("pagehide", away);
		window.removeEventListener("pageshow", returned);
		say(false, true);
	};
}

/** What a click on a notification names (`openHash` in `shared/push.ts`), as the view it opens; null for an address that is none. */
export function viewOfPushHash(hash: unknown): { file: string | null; liveId: string | null } | null {
	if (typeof hash !== "string") return null;
	try {
		const file = /^#\/s\/([^/]+)$/.exec(hash);
		if (file) return { file: decodeURIComponent(file[1]), liveId: null };
		const live = /^#\/live\/([^/]+)$/.exec(hash);
		if (live) return { file: null, liveId: live[1] };
	} catch {
		// An address that does not decode names nothing.
	}
	return null;
}

/**
 * What the service worker says to the page it brings forward after a click on a notification: open the conversation it named. A
 * conversation that has gone since is opened from its file. Returns the way to stop; without a service worker (the macOS app's
 * view has none) there is nothing to hear.
 */
export function followPushClicks(): () => void {
	if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) return () => {};
	const listener = (e: MessageEvent) => {
		const data: unknown = e.data;
		if (!isRecord(data) || data.type !== "ompw-open") return;
		const target = viewOfPushHash(data.hash);
		const st = useApp.getState();
		if (!target) return st.setView({ kind: "new" });
		const live = target.liveId === null ? undefined : st.lives[target.liveId];
		const file = live?.info.sessionFile ?? target.file;
		if (live || file !== null) st.setView({ kind: "chat", file, liveId: live ? live.info.liveId : null });
	};
	navigator.serviceWorker.addEventListener("message", listener);
	return () => navigator.serviceWorker.removeEventListener("message", listener);
}

/**
 * Whether the server still has this browser's device: one revoked from another page (or by "Revoke all") has no push left, and a
 * page that kept thinking it had would leave its own notifications off and show none. Asked once per page, when it opens.
 */
export async function reconcilePushDevice(): Promise<void> {
	const ref = pushDevice();
	if (ref === null) return;
	try {
		const res = await fetch(PUSH_API, { cache: "no-store" });
		if (!res.ok) return;
		const list: PushList = await res.json();
		if (!list.devices.some((d) => d.id === ref.id)) rememberPushDevice(null);
	} catch {
		// The server cannot be asked now: what is kept stays until it can.
	}
}

let stopPage: (() => void) | null = null;

/**
 * What a page of a browser that has Web Push on does, once and for as long as it has it on: say where it stands, hear a click on a
 * notification, and find out whether the server still has the device. Does nothing in a browser that has none. The same call
 * again changes nothing.
 */
export function startPushPage(): void {
	const ref = pushDevice();
	if (stopPage !== null || ref === null) return;
	const stops = [startPresence(ref.device), followPushClicks()];
	stopPage = () => {
		for (const stop of stops) stop();
		stopPage = null;
	};
	void reconcilePushDevice();
}

/** This page no longer does any of it (the device was forgotten). */
export function stopPushPage(): void {
	stopPage?.();
}
