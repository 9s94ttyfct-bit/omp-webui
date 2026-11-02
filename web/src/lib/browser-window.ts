import { useEffect, useState } from "react";

/**
 * A window popped out for a conversation's browser (BrowserFull.tsx) says that it is open to the app's other pages of the
 * same address, so that they show it there only: one page shown in two places is drawn at one size (the Mac app's own
 * view of it is one view, in one window), and the larger one would be blurred. The window says so every second while it
 * shows the browser, and that it closed when it does; a page that asks is told at once. A window that ends without
 * saying it (a crash) is taken as closed a few seconds later.
 */

type Note =
	| { t: "open"; owner: string }
	| { t: "closed"; owner: string }
	/** A page asks which windows are open. */
	| { t: "ask" }
	/** A page asks the window of `owner` to close: the browser is shown there again. */
	| { t: "close"; owner: string };

const CHANNEL = "ompw-browser-window";
const BEAT_MS = 1000;
const STALE_MS = 3500;

let channel: BroadcastChannel | null | undefined;
/** When each conversation's window said last that it is open. */
const seen = new Map<string, number>();
const listeners = new Set<() => void>();
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
			if (shown !== null) post({ t: "open", owner: shown });
			return;
		}
		if (typeof note.owner !== "string") return;
		if (note.t === "close") {
			if (note.owner === shown) window.close();
			return;
		}
		if (note.t === "open") seen.set(note.owner, Date.now());
		else seen.delete(note.owner);
		for (const fn of listeners) fn();
	});
	return channel;
}

function isOpen(owner: string): boolean {
	const at = seen.get(owner);
	return at !== undefined && Date.now() - at < STALE_MS;
}

/** In a window popped out for `owner`'s browser: say that it is open, while it is. */
export function useAnnounceBrowserWindow(owner: string | null): void {
	useEffect(() => {
		if (owner === null || !open()) return;
		shown = owner;
		const beat = () => post({ t: "open", owner });
		beat();
		const timer = setInterval(beat, BEAT_MS);
		const closed = () => post({ t: "closed", owner });
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
	seen.delete(owner);
	for (const fn of listeners) fn();
}
