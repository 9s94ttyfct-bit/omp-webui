import type { EngineHost } from "./engine.ts";
import type { PageRegistry, TargetInfo } from "./registry.ts";
import type { CdpMessage, MuxChannel } from "./transport.ts";

/**
 * The per-conversation CDP endpoint omp is given as `browser.cdpUrl` (`<origin>/browser-cdp/<token>`): a view of the
 * built-in browser that holds only the conversation's pages.
 *
 * Each connection gets a browser session of its own in the engine (`Target.attachToBrowserTarget`), so its target
 * discovery and auto-attach are its own, and passes through what it says unchanged but for:
 *
 * - target events, `Target.getTargets` and auto-attached sessions of the browser session: only the conversation's pages
 *   (a session attached to another's page is resumed and detached at once, so it is never held waiting for this one);
 * - a command naming another conversation's page or session: refused with `-32000 "Not this conversation's page"`;
 * - a page it creates, or one its pages open, becomes the conversation's; while any page is being created, events of a
 *   page with no owner yet are held until it is known whose it is, then given or dropped, in order;
 * - `Browser.close` ends this connection, not the browser, and a browser session of a browser session is refused.
 *
 * A connection with no page gets a blank one before anything is answered. Whole-browser commands (cookies, downloads)
 * pass through: the agent is the person's own.
 */

export const NOT_THIS_CONVERSATION = "Not this conversation's page";

/** Where a connection's words go: the WebSocket, through its outbox. */
export interface ProxySocket {
	send(text: string): void;
	close(code?: number, reason?: string): void;
}

/** Refused whatever they name: a session that would see the whole browser, or ends of the browser itself. */
const REFUSED = new Set([
	"Target.attachToBrowserTarget",
	"Target.exposeDevToolsProtocol",
	"Browser.crash",
	"Browser.crashGpuProcess",
]);

/** Events of a browser session that name a target, and how to find it. */
const TARGET_EVENTS = new Set([
	"Target.targetCreated",
	"Target.targetInfoChanged",
	"Target.attachedToTarget",
	"Target.targetDestroyed",
	"Target.targetCrashed",
	"Target.detachedFromTarget",
]);

type Decision = "deliver" | "drop" | "hold";

export class CdpProxy {
	private readonly connections = new Set<ProxyConnection>();

	constructor(
		private readonly host: EngineHost,
		private readonly registry: PageRegistry,
	) {
		host.onEnd((why) => {
			for (const c of [...this.connections]) c.end(why);
		});
		registry.onSettled(() => {
			for (const c of this.connections) c.pump();
		});
	}

	/**
	 * `/json/version` and `/json/list` (`/json`) of the conversation's endpoint; `base` is its WebSocket address
	 * (`ws://<host>/browser-cdp/<token>`).
	 */
	async http(owner: string, rest: string, base: string): Promise<Response> {
		try {
			const engine = await this.host.ready();
			if (rest === "/json/version" || rest === "/json/version/") {
				const v = await engine.client.call<{
					product: string;
					protocolVersion: string;
					userAgent: string;
					jsVersion: string;
				}>("Browser.getVersion");
				return Response.json({
					Browser: v.product,
					"Protocol-Version": v.protocolVersion,
					"User-Agent": v.userAgent,
					"V8-Version": v.jsVersion,
					webSocketDebuggerUrl: `${base}/devtools/browser`,
				});
			}
			if (rest === "/json" || rest === "/json/list" || rest === "/json/list/") {
				await engine.ensurePage(owner);
				return Response.json(
					this.registry.pagesOf(owner).map((id) => {
						const info = this.registry.info(id);
						return {
							id,
							type: "page",
							title: info?.title ?? "",
							url: info?.url ?? "",
							webSocketDebuggerUrl: `${base}/devtools/page/${id}`,
						};
					}),
				);
			}
			return new Response("Not found", { status: 404 });
		} catch (e) {
			return new Response(`The built-in browser is not available: ${(e as Error).message}`, { status: 503 });
		}
	}

	/** A WebSocket of the conversation: the whole (filtered) browser, or one of its pages (`target`). */
	connect(owner: string, socket: ProxySocket, target: string | null = null): ProxyConnection {
		const connection = new ProxyConnection(this.host, this.registry, owner, socket, target, () =>
			this.connections.delete(connection),
		);
		this.connections.add(connection);
		void connection.start();
		return connection;
	}

	/** Ends the conversation's connections (its pages were closed). */
	endOwner(owner: string, why: string): void {
		for (const c of [...this.connections]) if (c.owner === owner) c.end(why);
	}
}

export class ProxyConnection {
	private channel: MuxChannel | null = null;
	/** The engine session that stands for this connection's root: its browser session, or the page's. */
	private root: string | null = null;
	private ready = false;
	private ended = false;
	private readonly inbox: string[] = [];
	private readonly outbox: CdpMessage[] = [];
	/** Calls of the client still waiting for their answer, and what they were. */
	private readonly asked = new Map<number, string>();
	/** Calls of the proxy itself (negative ids, never the client's). */
	private readonly own = new Map<number, (m: CdpMessage) => void>();
	private nextOwn = -1;
	/** Targets and sessions this connection was told of: what ends them is told too. */
	private readonly seenTargets = new Set<string>();
	private readonly seenSessions = new Set<string>();
	/** Sessions let go of (`release`): another conversation's pages, of which nothing more is passed on. */
	private readonly released = new Set<string>();

	constructor(
		private readonly host: EngineHost,
		private readonly registry: PageRegistry,
		readonly owner: string,
		private readonly socket: ProxySocket,
		private readonly target: string | null,
		private readonly forget: () => void,
	) {}

	async start(): Promise<void> {
		try {
			const engine = await this.host.ready();
			if (this.ended) return;
			if (this.target === null) await engine.ensurePage(this.owner);
			else if (this.registry.ownerOfTarget(this.target) !== this.owner) throw new Error(NOT_THIS_CONVERSATION);
			if (this.ended) return;
			const channel = engine.mux.open();
			this.channel = channel;
			channel.onMessage((m) => this.fromEngine(m));
			channel.onClose((why) => this.end(why));
			const attached =
				this.target === null
					? await this.call("Target.attachToBrowserTarget", {})
					: await this.call("Target.attachToTarget", { targetId: this.target, flatten: true });
			const session = (attached.result as { sessionId?: string } | undefined)?.sessionId;
			if (!session) throw new Error(attached.error?.message ?? "the browser gave no session");
			this.root = session;
			this.ready = true;
			for (const text of this.inbox.splice(0)) this.message(text);
		} catch (e) {
			this.end(`The built-in browser is not available: ${(e as Error).message}`);
		}
	}

	/** A message from the client. */
	message(text: string): void {
		if (this.ended) return;
		if (!this.ready) {
			this.inbox.push(text);
			return;
		}
		let msg: CdpMessage;
		try {
			msg = JSON.parse(text) as CdpMessage;
		} catch {
			return;
		}
		if (typeof msg !== "object" || msg === null || typeof msg.id !== "number" || typeof msg.method !== "string") return;
		const refusal = this.refusal(msg);
		if (refusal) {
			this.reply({ id: msg.id, error: { code: -32000, message: refusal }, sessionId: msg.sessionId });
			return;
		}
		if (msg.method === "Browser.close" && msg.sessionId === undefined) {
			this.reply({ id: msg.id, result: {} });
			this.end("Browser.close");
			return;
		}
		if (msg.method === "Target.createTarget") this.registry.creatingPage();
		this.asked.set(msg.id, msg.method);
		this.channel?.send({ ...msg, sessionId: msg.sessionId ?? this.root ?? undefined });
	}

	/** The client went away: its browser session is detached, and the pages stay. */
	close(): void {
		this.end(null);
	}

	/** Ends the connection; `why` is told to the client when it is still there. */
	end(why: string | null): void {
		if (this.ended) return;
		this.ended = true;
		// A page this client asked for and will not hear of: nobody's (hidden), and creations are not waited on for it.
		for (const method of this.asked.values()) if (method === "Target.createTarget") this.registry.created(null, null);
		this.asked.clear();
		const channel = this.channel;
		if (channel && this.root)
			channel.send({ id: this.nextOwn--, method: "Target.detachFromTarget", params: { sessionId: this.root } });
		channel?.close();
		this.forget();
		if (why !== null) this.socket.close(why === "Browser.close" ? 1000 : 1011, why.slice(0, 120));
	}

	/** Decides held events whose page now has an owner (a creation settled). */
	pump(): void {
		while (this.outbox.length > 0) {
			const head = this.outbox[0];
			const decision = this.decide(head);
			if (decision === "hold") {
				// Every tab waiting behind it is asked about now, not one after the other.
				for (const m of this.outbox) {
					const info = (m.params as { targetInfo?: TargetInfo } | undefined)?.targetInfo;
					if (m.id === undefined && m.sessionId === undefined && info?.type === "tab") this.registry.resolve(info);
				}
				return;
			}
			this.outbox.shift();
			if (decision === "deliver") this.reply(head);
		}
	}

	private refusal(msg: CdpMessage): string | null {
		if (REFUSED.has(msg.method ?? "")) return `${msg.method} is not available here`;
		if (msg.sessionId !== undefined && !this.channel?.owns(msg.sessionId)) return NOT_THIS_CONVERSATION;
		const params = (msg.params ?? {}) as { targetId?: unknown; sessionId?: unknown };
		if (typeof params.targetId === "string" && this.registry.ownerOfTarget(params.targetId) !== this.owner)
			return NOT_THIS_CONVERSATION;
		if (typeof params.sessionId === "string" && !this.channel?.owns(params.sessionId)) return NOT_THIS_CONVERSATION;
		return null;
	}

	private fromEngine(m: CdpMessage): void {
		if (m.id !== undefined && m.id < 0) {
			const done = this.own.get(m.id);
			this.own.delete(m.id);
			done?.(m);
			return;
		}
		// Whatever is still said on a session let go of (it is another conversation's page) goes nowhere.
		if (m.sessionId !== undefined && this.released.has(m.sessionId)) return;
		if (m.id !== undefined) {
			const method = this.asked.get(m.id);
			this.asked.delete(m.id);
			if (method === "Target.createTarget") {
				const targetId = (m.result as { targetId?: string } | undefined)?.targetId ?? null;
				// Owned before anything else is decided: held events of the page are this conversation's now.
				this.registry.created(targetId, targetId ? this.owner : null);
				if (targetId) this.seenTargets.add(targetId);
			}
			if (method === "Target.getTargets" && m.result) {
				const infos = (m.result as { targetInfos: TargetInfo[] }).targetInfos ?? [];
				m = {
					...m,
					result: {
						...(m.result as object),
						targetInfos: infos.filter((t) => this.registry.resolve(t) === this.owner),
					},
				};
			}
		}
		const atRoot = m.sessionId === this.root;
		const out: CdpMessage = atRoot ? { ...m, sessionId: undefined } : m;
		if (atRoot && m.id === undefined && this.target === null && TARGET_EVENTS.has(m.method ?? "")) {
			this.outbox.push(out);
			this.pump();
			return;
		}
		if (this.outbox.length > 0) {
			this.outbox.push(out);
			this.pump();
			return;
		}
		this.reply(out);
	}

	/** What becomes of a held message: target events by their page's owner, anything else in its turn. */
	private decide(m: CdpMessage): Decision {
		if (m.sessionId !== undefined && this.released.has(m.sessionId)) return "drop";
		if (m.id !== undefined || m.sessionId !== undefined || !TARGET_EVENTS.has(m.method ?? "")) return "deliver";
		const p = (m.params ?? {}) as { targetInfo?: TargetInfo; targetId?: string; sessionId?: string };
		const targetId = p.targetInfo?.targetId ?? p.targetId;
		if (m.method === "Target.detachedFromTarget" && p.sessionId) {
			// A session let go of is detached now: nothing more can be said on it.
			this.released.delete(p.sessionId);
			if (!this.seenSessions.delete(p.sessionId)) return "drop";
			return "deliver";
		}
		if (!targetId) return "deliver";
		if (m.method === "Target.targetDestroyed" || m.method === "Target.targetCrashed") {
			if (m.method === "Target.targetDestroyed" ? this.seenTargets.delete(targetId) : this.seenTargets.has(targetId))
				return "deliver";
			return "drop";
		}
		const owner = p.targetInfo ? this.registry.resolve(p.targetInfo) : this.registry.ownerOfTarget(targetId);
		if (owner === this.owner) {
			this.seenTargets.add(targetId);
			if (m.method === "Target.attachedToTarget" && p.sessionId) this.seenSessions.add(p.sessionId);
			return "deliver";
		}
		if (owner === null && this.registry.pending) return "hold";
		if (m.method === "Target.attachedToTarget" && p.sessionId) this.release(p.sessionId);
		return "drop";
	}

	/** Lets go of a session auto-attached to a page that is not this conversation's: resumed, then detached. */
	private release(sessionId: string): void {
		this.released.add(sessionId);
		this.channel?.send({ id: this.nextOwn--, method: "Runtime.runIfWaitingForDebugger", sessionId });
		this.channel?.send({
			id: this.nextOwn--,
			method: "Target.detachFromTarget",
			params: { sessionId },
			sessionId: this.root ?? undefined,
		});
	}

	private call(method: string, params: object): Promise<CdpMessage> {
		const id = this.nextOwn--;
		return new Promise((resolve) => {
			this.own.set(id, resolve);
			this.channel?.send({ id, method, params });
		});
	}

	private reply(m: CdpMessage): void {
		if (this.ended) return;
		const clean: CdpMessage = { ...m };
		if (clean.sessionId === undefined) delete clean.sessionId;
		this.socket.send(JSON.stringify(clean));
	}
}
