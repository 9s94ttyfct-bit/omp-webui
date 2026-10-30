import "../unit/browser-globals.ts";
import { spyOn } from "bun:test";
import type { ClientMessage, ServerMessage } from "../../shared/protocol.ts";
import { partOf } from "../../shared/reply-parts.ts";
import { socket } from "../../web/src/lib/ws.ts";
import { onServer, useApp } from "../../web/src/store/app.ts";
import { request } from "./ws.ts";

/**
 * The page's own store (`web/src/store/app.ts`, with everything it does for a frame or an attach) wired to a real
 * server over a WebSocket, in place of a browser: the store's requests go out as the page's would, and every message
 * the server sends is folded in by `onServer`. For contract tests that must show the page and the real omp agree: what
 * the store holds is compared with what omp answers. The caller installs the browser stand-ins (`installGlobals` of
 * tests/unit/browser-globals.ts) in `beforeAll`, as the unit tests of the store do.
 */
export interface PageStore {
	/** Every request the store made, in order: what a page would have sent the server. */
	sent: ClientMessage[];
	/** Stop forwarding; the store's own methods are put back. */
	stop(): void;
}

export function pageStore(ws: WebSocket): PageStore {
	const sent: PageStore["sent"] = [];
	const ask = (msg: Record<string, unknown>) => {
		sent.push(msg as ClientMessage);
		return request<never>(ws, msg);
	};
	const spies = [
		spyOn(socket, "rpc").mockImplementation(((liveId: string, command: Record<string, unknown>, slim?: boolean) =>
			ask({ t: "rpc", liveId, command, ...(slim ? { slim: true } : {}) })) as typeof socket.rpc),
		spyOn(socket, "act").mockImplementation(((liveId: string, command: Record<string, unknown>, slim?: boolean) =>
			ask({ t: "rpc", liveId, command, user: true, ...(slim ? { slim: true } : {}) })) as typeof socket.act),
		spyOn(socket, "request").mockImplementation(((msg: Record<string, unknown>) => ask(msg)) as typeof socket.request),
		spyOn(socket, "post").mockImplementation(((msg: Record<string, unknown>) => {
			sent.push(msg as ClientMessage);
			ws.send(JSON.stringify(msg));
		}) as typeof socket.post),
	];
	const onMessage = (ev: MessageEvent) => {
		const text = String(ev.data);
		// A part of a big reply belongs to the request that waits for it (see `request`).
		if (partOf(text) !== null) return;
		const msg = JSON.parse(text) as ServerMessage;
		if (msg.t === "reply" || msg.t === "ack") return;
		onServer(msg);
	};
	ws.addEventListener("message", onMessage);
	return {
		sent,
		stop() {
			ws.removeEventListener("message", onMessage);
			for (const spy of spies) spy.mockRestore();
		},
	};
}

/** Show a conversation as the page does when it is open on it (so the store keeps it attached). */
export function viewLive(liveId: string, file: string | null): void {
	useApp.setState({ view: { kind: "chat", file, liveId } });
}
