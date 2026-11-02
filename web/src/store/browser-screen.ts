import {
	type ConsoleEntry,
	decodeFrame,
	type FrameHeader,
	type PageInfo,
	type ScreenClientMessage,
	type ScreenServerMessage,
} from "@shared/browser-protocol.ts";
import { create } from "zustand";

/**
 * The Browser tab's socket (`/ws/browser`, see shared/browser-protocol.ts): one per page, opened while a Browser tab is
 * shown and opened again when it closes. What it was last asked to watch is asked again on a new connection. The page
 * list and console are kept here; frames go straight to whoever draws them (`onFrame`), never through the store.
 */

/** Console entries kept per page. */
const CONSOLE_KEPT = 200;
/** How long after a closed socket it is opened again. */
const RECONNECT_MS = 1000;

interface ScreenStore {
	/** Whose pages `pages` are (null: nobody's yet). */
	owner: string | null;
	pages: PageInfo[];
	console: Record<string, ConsoleEntry[]>;
	/** Why the browser cannot be used, as the server last said; null once it was asked again. */
	unavailable: string | null;
	/** The server answered the current watch (a page list, or why it cannot): until then nothing is known. */
	answered: boolean;
}

export const useScreen = create<ScreenStore>(() => ({
	owner: null,
	pages: [],
	console: {},
	unavailable: null,
	answered: false,
}));

export interface Frame {
	header: FrameHeader;
	jpeg: Uint8Array;
}

let ws: WebSocket | null = null;
let holders = 0;
let retry: ReturnType<typeof setTimeout> | undefined;
let lastWatch: Extract<ScreenClientMessage, { t: "watch" }> | null = null;
/** The pages drawn by the Mac app's own view, and their room (`fit`): said again, after the watch, on a new connection. */
const fits = new Map<string, Extract<ScreenClientMessage, { t: "fit" }>>();
const frameListeners = new Set<(frame: Frame) => void>();

function open(): void {
	clearTimeout(retry);
	const proto = location.protocol === "https:" ? "wss" : "ws";
	const socket = new WebSocket(`${proto}://${location.host}/ws/browser`);
	socket.binaryType = "arraybuffer";
	ws = socket;
	socket.onopen = () => {
		if (lastWatch) {
			// A new connection is told the page's console from the start: the list starts over.
			const shown = lastWatch.targetId;
			if (shown) useScreen.setState((s) => ({ console: { ...s.console, [shown]: [] } }));
			socket.send(JSON.stringify(lastWatch));
		}
		for (const fit of fits.values()) socket.send(JSON.stringify(fit));
	};
	socket.onmessage = (e) => {
		if (e.data instanceof ArrayBuffer) {
			const frame = decodeFrame(new Uint8Array(e.data));
			for (const fn of frameListeners) fn(frame);
			return;
		}
		let msg: ScreenServerMessage;
		try {
			msg = JSON.parse(String(e.data)) as ScreenServerMessage;
		} catch {
			return;
		}
		received(msg);
	};
	socket.onclose = () => {
		if (ws !== socket) return;
		ws = null;
		if (holders > 0) retry = setTimeout(open, RECONNECT_MS);
	};
}

function received(msg: ScreenServerMessage): void {
	switch (msg.t) {
		case "pages":
			if (msg.owner !== lastWatch?.owner) return;
			useScreen.setState({ owner: msg.owner, pages: msg.pages, answered: true });
			return;
		case "console":
			useScreen.setState((s) => {
				const list = [...(s.console[msg.targetId] ?? []), msg.entry].slice(-CONSOLE_KEPT);
				return { console: { ...s.console, [msg.targetId]: list } };
			});
			return;
		case "unavailable":
			useScreen.setState({ unavailable: msg.reason, answered: true });
			return;
		case "available":
			useScreen.setState({ unavailable: null });
			return;
	}
}

/** A Browser tab is shown: the socket is open while one is. Returns the way to let go. */
export function holdScreen(): () => void {
	holders++;
	if (!ws) open();
	let held = true;
	return () => {
		if (!held) return;
		held = false;
		holders--;
		if (holders > 0) return;
		clearTimeout(retry);
		lastWatch = null;
		fits.clear();
		const socket = ws;
		ws = null;
		socket?.close();
	};
}

/** Send a message to the server, if the socket is open (a watch, and the fits, are sent again whenever it opens). */
export function sendScreen(msg: ScreenClientMessage): void {
	if (msg.t === "watch") {
		const ownerChanged = msg.owner !== lastWatch?.owner;
		const pageChanged = msg.targetId !== lastWatch?.targetId;
		lastWatch = msg;
		// The server ends the fits of a conversation the tab stops watching.
		if (ownerChanged) fits.clear();
		useScreen.setState(
			ownerChanged ? { owner: null, pages: [], unavailable: null, answered: false } : { unavailable: null },
		);
		// The server sends what it kept of a page's console to a tab that starts showing it: the list starts over.
		if (pageChanged && msg.targetId)
			useScreen.setState((s) => ({ console: { ...s.console, [msg.targetId as string]: [] } }));
	}
	if (msg.t === "unwatch") fits.clear();
	if (msg.t === "fit") {
		if (msg.room) fits.set(msg.targetId, msg);
		else fits.delete(msg.targetId);
	}
	if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

/** Empty the console shown for a page (the server's copy stays). */
export function clearConsole(targetId: string): void {
	useScreen.setState((s) => ({ console: { ...s.console, [targetId]: [] } }));
}

/** Hear the frames of the page watched; returns the way to stop. */
export function onFrame(fn: (frame: Frame) => void): () => void {
	frameListeners.add(fn);
	return () => frameListeners.delete(fn);
}
