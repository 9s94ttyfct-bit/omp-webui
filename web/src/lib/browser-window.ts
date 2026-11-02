import { useEffect, useState } from "react";

/**
 * A window popped out for a conversation's browser (BrowserFull.tsx) says that it is open to the app's other pages of the
 * same address, so that they show it there only: one page shown in two places is drawn at one size (the Mac app's own
 * view of it is one view, in one window), and the larger one would be blurred. The window says so every second while it
 * shows the browser, and that it closed when it does; a page that asks is told at once. A window that ends without
 * saying it (a crash) is taken as closed a few seconds later.
 *
 * Every window has an id of its own, and a conversation may have more than one (**Open in a new window** from two pages):
 * the browser is back in the panel only when none of them is open, not when one of them closes (#26).
 */

type Note =
	| { t: "open"; owner: string; id: string }
	| { t: "closed"; owner: string; id: string }
	/** A page asks which windows are open. */
	| { t: "ask" }
	/** A page asks the windows popped out for `owner` to close: the browser is shown there again. */
	| { t: "close"; owner: string };

const CHANNEL = "ompw-browser-window";
const BEAT_MS = 1000;
const STALE_MS = 3500;

/** Which windows are open for each conversation, by when each said last that it is. */
export class WindowPresence {
	private readonly seen = new Map<string, Map<string, number>>();

	constructor(
		private readonly now: () => number = Date.now,
		private readonly staleMs = STALE_MS,
	) {}

	open(owner: string, id: string): void {
		const windows = this.seen.get(owner) ?? new Map<string, number>();
		this.seen.set(owner, windows);
		windows.set(id, this.now());
	}

	closed(owner: string, id: string): void {
		const windows = this.seen.get(owner);
		windows?.delete(id);
		if (windows?.size === 0) this.seen.delete(owner);
	}

	/** Every window of `owner` is gone (it was asked to close them). */
	closedAll(owner: string): void {
		this.seen.delete(owner);
	}

	/** Whether a window of `owner` said it is open recently enough. */
	isOpen(owner: string): boolean {
		for (const at of this.seen.get(owner)?.values() ?? []) if (this.now() - at < this.staleMs) return true;
		return false;
	}
}

let channel: BroadcastChannel | null | undefined;
const presence = new WindowPresence();
const listeners = new Set<() => void>();
/** This window's own id, made when it first announces itself. */
const windowId = crypto.randomUUID();
/** The conversation whose browser this window shows, when it is one popped out for it. */
let shown: string | null = null;

function post(note: Note): void {
	open()?.postMessage(note);
}

function open(): BroadcastChannel | null {
	if (channel !== undefined) return channel;
	channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);
	channel?.addEventListener("message", (e: MessageEvent<Note>) => {
		const note = e.data;
		if (typeof note !== "object" || note === null) return;
		if (note.t === "ask") {
			if (shown !== null) post({ t: "open", owner: shown, id: windowId });
			return;
		}
		if (typeof note.owner !== "string") return;
		if (note.t === "close") {
			if (note.owner === shown) window.close();
			return;
		}
		if (typeof note.id !== "string") return;
		if (note.t === "open") presence.open(note.owner, note.id);
		else presence.closed(note.owner, note.id);
		for (const fn of listeners) fn();
	});
	return channel;
}

function isOpen(owner: string): boolean {
	return presence.isOpen(owner);
}

/** In a window popped out for `owner`'s browser: say that it is open, while it is. */
export function useAnnounceBrowserWindow(owner: string | null): void {
	useEffect(() => {
		if (owner === null || !open()) return;
		shown = owner;
		const beat = () => post({ t: "open", owner, id: windowId });
		beat();
		const timer = setInterval(beat, BEAT_MS);
		const closed = () => post({ t: "closed", owner, id: windowId });
		window.addEventListener("pagehide", closed);
		return () => {
			clearInterval(timer);
			window.removeEventListener("pagehide", closed);
			if (shown === owner) shown = null;
			closed();
		};
	}, [owner]);
}

/** Whether a window popped out for `owner`'s browser is open (in this browser, or this Mac app). */
export function useBrowserWindowOpen(owner: string): boolean {
	const [now, setNow] = useState(() => isOpen(owner));
	useEffect(() => {
		if (!open()) return;
		const check = () => setNow(isOpen(owner));
		check();
		listeners.add(check);
		post({ t: "ask" });
		const timer = setInterval(check, BEAT_MS);
		return () => {
			listeners.delete(check);
			clearInterval(timer);
		};
	}, [owner]);
	return now;
}

/** Ask the window popped out for `owner`'s browser to close (the browser is shown here again). */
export function closeBrowserWindow(owner: string): void {
	post({ t: "close", owner });
	presence.closedAll(owner);
	for (const fn of listeners) fn();
}
