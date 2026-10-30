import { partOf, ReplyAssembler } from "../../shared/reply-parts.ts";
import type { TestServer } from "./server.ts";

/** A WebSocket to a server (the test server, or any with its url and access token), authenticated like the UI (same Origin, token cookie). Bun only. */
export function connect(s: Pick<TestServer, "url" | "accessToken">): Promise<WebSocket> {
	const ws = new WebSocket(`${s.url.replace("http", "ws")}/ws`, {
		headers: { Origin: s.url, Cookie: `ompw_token=${s.accessToken}` },
	} as unknown as string[]);
	return new Promise((resolve, reject) => {
		ws.onopen = () => resolve(ws);
		ws.onerror = () => reject(new Error("ws refused"));
	});
}

interface Pending {
	resolve: (data: unknown) => void;
	reject: (error: Error) => void;
}

/** The requests waiting for a reply on each socket, and what the one listener set on it needs to answer them. */
const sockets = new WeakMap<WebSocket, { pending: Map<string, Pending>; parts: ReplyAssembler }>();

/**
 * One set of listeners per socket, however many requests it carries: a frame is parsed once (and not at all while
 * nothing waits), a reply removes its request from the table, and the socket closing fails every request still
 * waiting, at once, instead of leaving each to its test's timeout.
 */
function dispatcherOf(ws: WebSocket) {
	const known = sockets.get(ws);
	if (known) return known;
	const pending = new Map<string, Pending>();
	const parts = new ReplyAssembler();
	const failAll = (reason: string) => {
		const waiting = [...pending.values()];
		pending.clear();
		parts.clear();
		for (const p of waiting) p.reject(new Error(reason));
	};
	ws.addEventListener("message", (ev) => {
		if (pending.size === 0) return;
		const text = String(ev.data);
		const partOfRequest = partOf(text);
		if (partOfRequest !== null) {
			const waiting = pending.get(partOfRequest);
			if (!waiting) return;
			const part = parts.push(text);
			if (!part || part.data === null) return;
			pending.delete(partOfRequest);
			waiting.resolve(JSON.parse(part.data));
			return;
		}
		const m = JSON.parse(text);
		if (m.t !== "reply") return;
		const waiting = pending.get(m.req);
		if (!waiting) return;
		pending.delete(m.req);
		if (m.ok) waiting.resolve(m.data);
		else waiting.reject(Object.assign(new Error(m.error), { code: m.code }));
	});
	ws.addEventListener("close", () => failAll("connection closed before the reply"));
	ws.addEventListener("error", () => failAll("connection error before the reply"));
	const made = { pending, parts };
	sockets.set(ws, made);
	return made;
}

/**
 * Send a request and resolve with its reply's data (reject with its error, or at once if the connection closes first). A
 * big reply comes in parts (see `shared/reply-parts.ts`); they are put back together here.
 */
export function request<T>(ws: WebSocket, msg: Record<string, unknown>): Promise<T> {
	const req = crypto.randomUUID();
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	// A socket that is closing or closed will never hear the reply, and no event is coming to say so.
	if (ws.readyState > WebSocket.OPEN) {
		reject(new Error("connection closed before the request was sent"));
		return promise;
	}
	dispatcherOf(ws).pending.set(req, { resolve: resolve as Pending["resolve"], reject });
	ws.send(JSON.stringify({ ...msg, req }));
	return promise;
}
