/**
 * How the server speaks the Chrome DevTools Protocol to the browser engine it owns: one browser-level connection
 * (`CdpTransport`), whatever carries it (CfT's `--remote-debugging-pipe`, the Mac app's CEF channel), and a client over it
 * that matches answers to calls.
 */

/** One CDP message either way: a call (`id` + `method`), its answer (`id` + `result`/`error`), or an event (`method`). */
export type CdpMessage = {
	id?: number;
	method?: string;
	params?: unknown;
	result?: unknown;
	error?: { code: number; message: string };
	sessionId?: string;
};

/** A browser-level CDP connection. `onMessage`/`onClose` return the function that stops listening. */
export interface CdpTransport {
	send(message: object): void;
	onMessage(fn: (m: CdpMessage) => void): () => void;
	/** Called once, when the connection ends for any reason (closed here, the engine exited, the channel broke). */
	onClose(fn: (why: string) => void): () => void;
	close(): void;
	/** A browser this connection started: settles once its process has exited (none: nothing outlives the connection). */
	readonly exited?: Promise<unknown>;
}

/** A CDP error answer, as an Error. */
export class CdpError extends Error {
	constructor(
		readonly method: string,
		readonly code: number,
		message: string,
	) {
		super(`${method}: ${message}`);
	}
}

/**
 * Calls over a transport, each answered by the message with its id; calls still waiting when it closes are refused, and
 * so are the calls on a session when the session is detached (its page closed: no answer will come).
 */
export class CdpClient {
	private next = 1;
	private readonly pending = new Map<
		number,
		{ method: string; sessionId?: string; resolve: (v: unknown) => void; reject: (e: Error) => void }
	>();
	private readonly listeners = new Map<string, Set<(params: unknown, sessionId?: string) => void>>();
	private closed: string | null = null;

	constructor(private readonly transport: CdpTransport) {
		transport.onMessage((m) => this.receive(m));
		transport.onClose((why) => {
			this.closed = why;
			const waiting = [...this.pending.values()];
			this.pending.clear();
			for (const p of waiting) p.reject(new Error(`${p.method}: the browser connection closed (${why})`));
		});
	}

	call<T>(method: string, params?: object, sessionId?: string): Promise<T> {
		if (this.closed !== null)
			return Promise.reject(new Error(`${method}: the browser connection closed (${this.closed})`));
		const id = this.next++;
		return new Promise<T>((resolve, reject) => {
			this.pending.set(id, { method, sessionId, resolve: resolve as (v: unknown) => void, reject });
			this.transport.send({ id, method, params: params ?? {}, ...(sessionId ? { sessionId } : {}) });
		});
	}

	/** Listens to an event; returns the function that stops listening. */
	on<P = Record<string, unknown>>(method: string, fn: (params: P, sessionId?: string) => void): () => void {
		let set = this.listeners.get(method);
		if (!set) {
			set = new Set();
			this.listeners.set(method, set);
		}
		const listener = fn as (params: unknown, sessionId?: string) => void;
		set.add(listener);
		return () => set.delete(listener);
	}

	private receive(m: CdpMessage): void {
		if (m.id !== undefined) {
			const p = this.pending.get(m.id);
			if (!p) return;
			this.pending.delete(m.id);
			if (m.error) p.reject(new CdpError(p.method, m.error.code, m.error.message));
			else p.resolve(m.result);
			return;
		}
		if (m.method === "Target.detachedFromTarget" && m.sessionId === undefined) {
			const gone = (m.params as { sessionId?: unknown } | undefined)?.sessionId;
			for (const [id, p] of [...this.pending]) {
				if (p.sessionId === undefined || p.sessionId !== gone) continue;
				this.pending.delete(id);
				p.reject(new Error(`${p.method}: the page's session ended`));
			}
		}
		if (m.method) for (const fn of this.listeners.get(m.method) ?? []) fn(m.params, m.sessionId);
	}
}

/**
 * A transport's listeners and its once-only close, for transports to build on: `deliver` hands a message to every
 * listener, `end` tells the close listeners once.
 */
export class TransportListeners {
	private readonly messages = new Set<(m: CdpMessage) => void>();
	private readonly closes = new Set<(why: string) => void>();
	ended: string | null = null;

	onMessage(fn: (m: CdpMessage) => void): () => void {
		this.messages.add(fn);
		return () => this.messages.delete(fn);
	}

	onClose(fn: (why: string) => void): () => void {
		if (this.ended !== null) {
			const why = this.ended;
			queueMicrotask(() => fn(why));
			return () => {};
		}
		this.closes.add(fn);
		return () => this.closes.delete(fn);
	}

	deliver(m: CdpMessage): void {
		if (this.ended !== null) return;
		for (const fn of [...this.messages]) fn(m);
	}

	end(why: string): void {
		if (this.ended !== null) return;
		this.ended = why;
		const fns = [...this.closes];
		this.closes.clear();
		this.messages.clear();
		for (const fn of fns) fn(why);
	}
}

/**
 * Several CDP connections over the engine's one: each channel numbers its own calls, and is given the answers to them,
 * the events of the sessions it attached to (a session in a call's answer, or one an `attachedToTarget` event of its own
 * sessions names), and nothing else. The root channel also gets the events of the root session (no `sessionId`).
 */
export class CdpMux {
	private nextId = 1;
	private readonly calls = new Map<number, { channel: MuxChannel; id: number }>();
	private readonly sessions = new Map<string, MuxChannel>();
	private readonly channels = new Set<MuxChannel>();
	private root: MuxChannel | null = null;
	private ended: string | null = null;

	constructor(private readonly transport: CdpTransport) {
		transport.onMessage((m) => this.receive(m));
		transport.onClose((why) => {
			this.ended = why;
			for (const channel of [...this.channels]) channel.end(why);
		});
	}

	/** A new channel; `root`: the one that also gets the root session's events (the server's own). */
	open(opts: { root?: boolean } = {}): MuxChannel {
		const channel = new MuxChannel(this);
		if (this.ended !== null) {
			channel.end(this.ended);
			return channel;
		}
		this.channels.add(channel);
		if (opts.root) this.root = channel;
		return channel;
	}

	/** @internal */
	forward(channel: MuxChannel, message: CdpMessage): void {
		if (!this.channels.has(channel)) return;
		const id = this.nextId++;
		if (message.id !== undefined) this.calls.set(id, { channel, id: message.id });
		this.transport.send({ ...message, id });
	}

	/** @internal */
	owns(channel: MuxChannel, sessionId: string): boolean {
		return this.sessions.get(sessionId) === channel;
	}

	/** @internal */
	drop(channel: MuxChannel): void {
		if (!this.channels.delete(channel)) return;
		if (this.root === channel) this.root = null;
		for (const [id, call] of this.calls) if (call.channel === channel) this.calls.delete(id);
		for (const [session, owner] of this.sessions) if (owner === channel) this.sessions.delete(session);
	}

	private receive(m: CdpMessage): void {
		if (m.id !== undefined) {
			const call = this.calls.get(m.id);
			if (!call) return;
			this.calls.delete(m.id);
			const session = (m.result as { sessionId?: unknown } | undefined)?.sessionId;
			if (typeof session === "string") this.sessions.set(session, call.channel);
			call.channel.deliver({ ...m, id: call.id });
			return;
		}
		const channel = m.sessionId === undefined ? this.root : this.sessions.get(m.sessionId);
		if (!channel) return;
		const child = (m.params as { sessionId?: unknown } | undefined)?.sessionId;
		if (m.method === "Target.attachedToTarget" && typeof child === "string") this.sessions.set(child, channel);
		channel.deliver(m);
		if (m.method === "Target.detachedFromTarget" && typeof child === "string") this.sessions.delete(child);
	}
}

/** One connection of a `CdpMux`. */
export class MuxChannel implements CdpTransport {
	private readonly listeners = new TransportListeners();

	constructor(private readonly mux: CdpMux) {}

	send(message: object): void {
		this.mux.forward(this, message as CdpMessage);
	}

	/** Whether `sessionId` is a session this channel attached to. */
	owns(sessionId: string): boolean {
		return this.mux.owns(this, sessionId);
	}

	onMessage(fn: (m: CdpMessage) => void): () => void {
		return this.listeners.onMessage(fn);
	}

	onClose(fn: (why: string) => void): () => void {
		return this.listeners.onClose(fn);
	}

	close(): void {
		this.end("closed");
	}

	/** @internal */
	deliver(m: CdpMessage): void {
		this.listeners.deliver(m);
	}

	/** @internal */
	end(why: string): void {
		this.mux.drop(this);
		this.listeners.end(why);
	}
}
