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

/** Calls over a transport, each answered by the message with its id; calls still waiting when it closes are refused. */
export class CdpClient {
	private next = 1;
	private readonly pending = new Map<
		number,
		{ method: string; resolve: (v: unknown) => void; reject: (e: Error) => void }
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
			this.pending.set(id, { method, resolve: resolve as (v: unknown) => void, reject });
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
