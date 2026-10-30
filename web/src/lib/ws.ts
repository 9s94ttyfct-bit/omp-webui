import type { ErrorParams } from "@shared/error-info.ts";
import type { ClientMessage, ServerMessage } from "@shared/protocol.ts";
import { ReplyAssembler } from "@shared/reply-parts.ts";
import { t } from "../i18n/index.ts";
import { FrameBatcher } from "./frame-batch.ts";
import { noteMessageSent } from "./usage-days.ts";

type Listener = (msg: ServerMessage) => void;
type Outgoing = ClientMessage extends infer M ? (M extends { req: string } ? Omit<M, "req"> : never) : never;

/** A connection nothing has been heard on for this long is asked something it must answer (see `Socket.look`). */
export const QUIET_MS = 20_000;
/** A connection that does not answer within this long is given up on, and made again. */
export const PONG_MS = 10_000;
/** A connection that has not opened within this long is given up on, and tried again: a handshake can be lost for good. */
export const CONNECT_MS = 10_000;
/** How often the connection is looked at. */
const LOOK_MS = 5_000;
/**
 * How long a request of a kind that is answered at once waits for its answer. Past it the page stops waiting: Send
 * gets its draft back with an error, Stop says it failed, and nothing disables a button for good.
 */
export const REPLY_MS = 45_000;
/** Starting a process (a resume restores a model, reads a conversation) takes longer than a click's request. */
const OPEN_MS = 120_000;
/** The close code with which the server ends a remote page's socket once its Cloudflare Access token has expired. */
const ACCESS_EXPIRED_CLOSE = 4401;

/** The omp commands a click's answer is waited for: they reply as soon as omp has taken them. */
const QUICK_COMMANDS = /^(get_|set_|predict_word|abort|cancel_subagent$|remove_queued_message$|fork$|branch$|goal$)/;

/**
 * How long a request waits. `reply`: for the answer, null for as long as it takes. `ack`: for the server to say it
 * handed the command to omp (`ack` of `ClientMessage`); once it has, the answer is waited for as `reply` says. A
 * request that waits for as long as it takes still ends when the connection does: the liveness check (`Socket.look`)
 * gives up on one that is dead and everything that waits on it fails.
 *
 * Except what the server has acknowledged: omp has that command, and a connection that ends before omp answers says
 * nothing of how it went. Such a request resolves with no answer rather than failing, so that what the user typed is not
 * given back to be sent twice: what omp made of it shows in the entries the page reads when it attaches again.
 */
export interface Bound {
	ack?: number;
	reply: number | null;
}

/**
 * How long to wait for `msg`. A `!command` replies when it exits, `/compact` and the other slash commands when they are
 * done, `retry_now` when omp has redone the turn: no bound. A prompt (and a steer) is answered when omp has taken it
 * in, which is at once unless omp holds it: behind a compaction or a handoff for minutes, and for other reasons that are
 * omp's to add. So only the server's acknowledgement is bounded, which says the message is where it can be answered;
 * a server that never took it still ends in an error, and Send gets its draft back. Starting a goal is answered at once,
 * but it is what the user typed too, so it is acknowledged as well.
 */
function replyBound(msg: Outgoing): Bound {
	// A switch of mode restarts the conversation's omp and resumes it: as long as a start takes.
	if (msg.t === "open" || msg.t === "set_mode") return { reply: OPEN_MS };
	if (msg.t === "retry_now") return { reply: null };
	if (msg.t !== "rpc") return { reply: REPLY_MS };
	const type = String(msg.command.type);
	if (type === "prompt") {
		return String(msg.command.message ?? "").startsWith("/") ? { reply: null } : { ack: REPLY_MS, reply: null };
	}
	if (type === "steer") return { ack: REPLY_MS, reply: null };
	if (type === "goal" && msg.command.op === "create") return { ack: REPLY_MS, reply: REPLY_MS };
	return { reply: QUICK_COMMANDS.test(type) ? REPLY_MS : null };
}

interface Pending {
	resolve: (v: unknown) => void;
	reject: (e: Error) => void;
	/** Ends the wait when no acknowledgement or answer comes (see `replyBound`). */
	timer?: ReturnType<typeof setTimeout>;
	/** The server took the command: from here the wait is for the answer. Set for a request that asked for it. */
	acked?: () => void;
	/** The server has handed the command to omp (`acked` ran): the connection ending does not fail it (see `Bound`). */
	handedOver?: boolean;
	/** A part of the reply came in (see `shared/reply-parts.ts`): the wait for it starts again. */
	progress?: () => void;
}

export class ReplyError extends Error {
	constructor(
		message: string,
		readonly code?: string,
		readonly params?: ErrorParams,
	) {
		super(message);
	}
}

/** Reconnecting WebSocket with request/reply correlation. */
export class Socket {
	private ws: WebSocket | null = null;
	private seq = 0;
	private pending = new Map<string, Pending>();
	private listeners = new Set<Listener>();
	/** Sent on the next open; `req` marks requests, which are dropped once rejected. */
	private queue: { text: string; req?: string }[] = [];
	private retry = 0;
	connected = false;
	private statusListeners = new Set<(c: boolean) => void>();
	/** Streamed tokens wait here for the next paint, so a burst of them is one store write (see `FrameBatcher`). */
	private inbox = new FrameBatcher((msg) => this.dispatch(msg));
	/** The parts of big replies that have come in, until their last one does. */
	private parts = new ReplyAssembler();
	private watching = false;
	/** When something last came in on the connection (`Date.now()`). */
	private heard = 0;
	/** The question a quiet connection was asked, while it has not been answered. */
	private asking = false;
	/** Whether the page is finding out if its sign-in has ended (see `signedOut`). */
	private checking = false;

	connect(): void {
		if (!this.watching) {
			this.watching = true;
			setInterval(() => this.look(), LOOK_MS);
			// A tab that is hidden never paints: what was held for the paint goes out the moment it is hidden or shown again.
			// A page that was away (a laptop asleep) finds out at once whether its connection survived.
			if (typeof document !== "undefined")
				document.addEventListener("visibilitychange", () => {
					this.inbox.flush();
					if (document.visibilityState === "visible") this.look();
				});
		}
		const proto = location.protocol === "https:" ? "wss" : "ws";
		const ws = new WebSocket(`${proto}://${location.host}/ws`);
		let opened = false;
		this.ws = ws;
		// A socket whose handshake is lost neither opens nor closes: without this the page would wait for it for good.
		const opening = setTimeout(() => {
			if (this.ws === ws && !this.connected) this.giveUp(ws);
		}, CONNECT_MS);
		ws.onopen = () => {
			opened = true;
			clearTimeout(opening);
			this.retry = 0;
			this.heard = Date.now();
			this.setConnected(true);
			for (const m of this.queue.splice(0)) ws.send(m.text);
		};
		ws.onmessage = (ev) => {
			this.heard = Date.now();
			// A part of a big reply is heard when it arrives, which is how a slow connection is told from a dead one.
			const part = typeof ev.data === "string" ? this.parts.push(ev.data) : null;
			if (part) {
				this.pending.get(part.req)?.progress?.();
				if (part.data !== null) this.inbox.push(this.replyOf(part.req, part.data));
				return;
			}
			let msg: ServerMessage;
			try {
				msg = JSON.parse(ev.data);
			} catch {
				return;
			}
			this.inbox.push(msg);
		};
		ws.onclose = (ev) => {
			clearTimeout(opening);
			if (this.ws !== ws) return;
			// Through the tunnel the server ends the socket when the Cloudflare Access token has run out. Opening the socket
			// again with that token is refused until Cloudflare issues a new one, which it does for a page load (or shows
			// its sign-in): so the page is loaded again, not retried.
			if (ev.code === ACCESS_EXPIRED_CLOSE) {
				location.reload();
				return;
			}
			// A socket that never opened was refused, which behind Cloudflare Access is also what a sign-in that has ended
			// looks like.
			if (!opened) void this.signedOut();
			this.lost();
		};
	}

	/**
	 * Behind Cloudflare Access a sign-in that has ended answers every request, the socket's included, with a redirect to
	 * Access's own sign-in: another origin, which a socket cannot follow and a `fetch` is not allowed to read. All the
	 * socket learns is that its handshake failed, the same as when the network is down, and it would be retried for ever
	 * with a token that is no good. A request told not to follow redirects tells the two apart: the redirect comes back
	 * as an opaque response, a network that is down as an error. The page is then loaded again, which Access sends to
	 * its sign-in and, once signed in, back here.
	 */
	private async signedOut(): Promise<void> {
		if (this.checking) return;
		this.checking = true;
		try {
			const answer = await fetch("/api/meta", { redirect: "manual", cache: "no-store" });
			if (answer.type === "opaqueredirect") location.reload();
		} catch {
			// The network is out: the next try finds out when it is back.
		} finally {
			this.checking = false;
		}
	}

	/** The reply a big answer's parts made up: its `data` is read once, from the whole text. A text that is not JSON fails the request. */
	private replyOf(req: string, data: string): ServerMessage {
		try {
			return { t: "reply", req, ok: true, data: JSON.parse(data) };
		} catch {
			return { t: "reply", req, ok: false, error: t("common.badReply"), code: "bad-reply" };
		}
	}

	/** The connection ended (or is given up on): everything that waited on it fails, and a new one is made. */
	private lost(): void {
		// What the connection said before it closed is applied before anything reacts to it closing.
		this.inbox.flush();
		this.setConnected(false);
		for (const p of this.pending.values()) {
			clearTimeout(p.timer);
			// What the server handed to omp is not "not sent": see `Bound`.
			if (p.handedOver) p.resolve(undefined);
			else p.reject(new ReplyError(t("common.connectionLost"), "connection-lost"));
		}
		// A rejected request must never be sent later: the UI already reported it as failed.
		this.queue = this.queue.filter((m) => !m.req || !this.pending.has(m.req));
		this.pending.clear();
		this.parts.clear();
		this.asking = false;
		const delay = Math.min(10_000, 300 * 2 ** this.retry++);
		setTimeout(() => this.connect(), delay);
	}

	/**
	 * A connection can be dead without saying so: a path that drops what it carries, a server that stopped answering, a
	 * laptop that woke up elsewhere. Nothing then ever answers a request, and the page waits for good. So a connection
	 * nothing has been heard on for `QUIET_MS` is asked something the server answers at once, and is given up on (as
	 * if it had closed) when `PONG_MS` pass without the answer. Anything the server says counts as hearing from it.
	 */
	private look(): void {
		const ws = this.ws;
		if (!ws || !this.connected || this.asking || Date.now() - this.heard < QUIET_MS) return;
		this.asking = true;
		this.request({ t: "list_lives" }, { reply: PONG_MS }).then(
			() => {
				this.asking = false;
			},
			(e: unknown) => {
				// Only this connection's silence ends it: one that closed meanwhile has been dealt with.
				if (e instanceof ReplyError && e.code === "timeout" && this.ws === ws) this.giveUp(ws);
				this.asking = false;
			},
		);
	}

	/** Stop using a connection that does not answer, whether or not it ever says it is closed. */
	private giveUp(ws: WebSocket): void {
		ws.onopen = ws.onmessage = ws.onerror = ws.onclose = null;
		try {
			ws.close();
		} catch {
			// a socket that cannot be closed is as good as closed
		}
		this.lost();
	}

	/** Hand one message from the server to whoever waits for it: the caller of a request, or the listeners. */
	private dispatch(msg: ServerMessage): void {
		if (msg.t === "ack") {
			this.pending.get(msg.req)?.acked?.();
			return;
		}
		if (msg.t === "reply") {
			const p = this.pending.get(msg.req);
			if (p) {
				clearTimeout(p.timer);
				this.pending.delete(msg.req);
				if (msg.ok) p.resolve(msg.data);
				else p.reject(new ReplyError(msg.error, msg.code, msg.params));
			}
			return;
		}
		for (const l of this.listeners) l(msg);
	}

	private setConnected(c: boolean): void {
		this.connected = c;
		for (const l of this.statusListeners) l(c);
	}

	onStatus(fn: (c: boolean) => void): () => void {
		this.statusListeners.add(fn);
		return () => this.statusListeners.delete(fn);
	}

	on(fn: Listener): () => void {
		this.listeners.add(fn);
		return () => this.listeners.delete(fn);
	}

	private raw(msg: ClientMessage, req?: string): void {
		const text = JSON.stringify(msg);
		if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(text);
		else this.queue.push({ text, req });
	}

	/** Fire-and-forget message (no reply expected). */
	post(msg: Exclude<ClientMessage, { req: string }>): void {
		this.raw(msg);
	}

	/**
	 * Send a request and wait for its answer, as long as `bound` says (by default, what `replyBound` says of its kind):
	 * past it the request fails with code `timeout` and an answer that comes later is ignored. A bound with `ack` makes
	 * the server say when it has handed the command to omp: until then the wait is `ack`, after it `reply`.
	 */
	request<T = unknown>(msg: Outgoing, bound: Bound = replyBound(msg)): Promise<T> {
		const req = `r${++this.seq}`;
		const { promise, resolve, reject } = Promise.withResolvers<T>();
		const entry: Pending = { resolve: resolve as (v: unknown) => void, reject };
		/** What is being waited for now, in ms (null: as long as it takes). */
		let waiting: number | null = null;
		/** Wait `ms` from now, in place of what was being waited for. */
		const wait = (ms: number | null) => {
			waiting = ms;
			clearTimeout(entry.timer);
			entry.timer = undefined;
			if (ms === null) return;
			entry.timer = setTimeout(() => {
				this.pending.delete(req);
				// Not sent after all, if the connection never came back to send it.
				this.queue = this.queue.filter((m) => m.req !== req);
				reject(new ReplyError(t("common.noAnswer", { s: Math.round(ms / 1000) }), "timeout"));
			}, ms);
		};
		const asked = bound.ack !== undefined && msg.t === "rpc";
		if (asked) {
			entry.acked = () => {
				entry.handedOver = true;
				wait(bound.reply);
			};
		}
		// A reply that comes in parts is on its way as long as parts come: each one starts the wait again.
		entry.progress = () => wait(waiting);
		wait(asked ? (bound.ack ?? null) : bound.reply);
		this.pending.set(req, entry);
		this.raw({ ...msg, ...(asked ? { ack: true } : {}), req } as ClientMessage, req);
		return promise;
	}

	/**
	 * Forward one omp RPC command to a live session: a refresh the page makes by itself, which a paused one refuses.
	 * `slim`: the answer comes without what the page does not read of it — the system prompt and the bodies of the
	 * tool schemas (their names are kept). A state read asks for it: the whole prompt and every schema are tens of KB
	 * over the connection and parsed on the main thread for a page that reads neither (see `shared/slim.ts`).
	 */
	rpc<T = unknown>(liveId: string, command: Record<string, unknown>, slim = false): Promise<T> {
		return this.countMessage(command, this.request<T>({ t: "rpc", liveId, command, ...(slim ? { slim: true } : {}) }));
	}

	/** A prompt omp accepted is a day of use (the GitHub star prompt counts days); the reply goes on unchanged. */
	private countMessage<T>(command: Record<string, unknown>, reply: Promise<T>): Promise<T> {
		if (command.type === "prompt") reply.then(noteMessageSent, () => {});
		return reply;
	}

	/**
	 * Like `rpc`, for a command that is the answer to a click (a setting, a goal button, a rename…): a paused
	 * conversation answers it, and stays paused (see `Live.rpc` on the server). Never for polls and refreshes.
	 * `slim`: as for `rpc`.
	 */
	act<T = unknown>(liveId: string, command: Record<string, unknown>, slim = false): Promise<T> {
		return this.countMessage(
			command,
			this.request<T>({ t: "rpc", liveId, command, user: true, ...(slim ? { slim: true } : {}) }),
		);
	}

	/**
	 * The Stop button's command (`abort`, `abort_and_restore_queue`, `abort_bash`): the server carries it through until the
	 * conversation has stopped, or omp's process has been ended (see `Live.stop`), and answers then. Any other `abort` sent
	 * with `rpc` or `act` is omp's plain command.
	 */
	stop<T = unknown>(liveId: string, command: Record<string, unknown>): Promise<T> {
		return this.request<T>({ t: "rpc", liveId, command, stop: true });
	}
}

export const socket = new Socket();
