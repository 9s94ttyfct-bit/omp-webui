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
 * - target events, `Target.getTargets` and auto-attached sessions of its browser sessions: only the conversation's pages
 *   (a session attached to another's page is resumed and detached at once, so it is never held waiting for this one);
 * - its own browser target (the one its browser session is, which Puppeteer's `browser.target()` is): told of and
 *   attachable (flat), for what is said on a session of the browser itself (`Browser.setDownloadBehavior` and the
 *   download events, which omp's downloads use). Such a session is another browser session of the connection, filtered
 *   as the first is; another connection's browser target is never told of nor attachable;
 * - a command naming another conversation's page or session is refused with `-32000 "Not this conversation's page"`;
 * - a page it creates, or one its pages open, becomes the conversation's; while any page is being created, events of a
 *   page with no owner yet are held until it is known whose it is, then given or dropped, in order;
 * - `Browser.close` ends this connection, not the browser, and a browser session of a browser session is refused.
 *
 * A connection with no page gets a blank one before anything is answered. Whole-browser commands (cookies, downloads,
 * permissions) pass through: the agent is the person's own.
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
	/** When a conversation last asked for the browser, or a connection of one ended (ms since the epoch; 0: never). */
	lastUse = 0;

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
		this.lastUse = Date.now();
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
		this.lastUse = Date.now();
		const connection = new ProxyConnection(this.host, this.registry, owner, socket, target, () => {
			this.connections.delete(connection);
			this.lastUse = Date.now();
		});
		this.connections.add(connection);
		void connection.start();
		return connection;
	}

	/** The conversations' connections open now. */
	get open(): number {
		return this.connections.size;
	}

	/** Ends the conversation's connections (its pages were closed). */
	endOwner(owner: string, why: string): void {
		for (const c of [...this.connections]) if (c.owner === owner) c.end(why);
	}
}

/** Commands that may name the connection's own browser target. */
const ON_BROWSER_TARGET = new Set(["Target.attachToTarget", "Target.getTargetInfo"]);

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
	/** Targets and sessions this connection was told of, per browser session: what ends them is told too. */
	private readonly seenTargets = new Map<string, Set<string>>();
	private readonly seenSessions = new Set<string>();
	/** Sessions let go of (`release`): another conversation's pages, of which nothing more is passed on. */
	private readonly released = new Set<string>();
	/** The browser target its root session is (null for a page's connection). */
	private browserTarget: string | null = null;
	/** Its browser sessions: the root, and sessions attached to its browser target. What they say of targets is filtered. */
	private readonly browserSessions = new Set<string>();
	/** Calls of the client attaching to its browser target: the session in the answer is a browser session. */
	private readonly browserAttaches = new Set<number>();

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
			if (this.target === null) {
				this.browserSessions.add(session);
				const own = await this.call("Target.getTargetInfo", {}, session);
				this.browserTarget = (own.result as { targetInfo?: TargetInfo } | undefined)?.targetInfo?.targetId ?? null;
			}
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
		// Said on any of its sessions (a session of the browser target is one too), it ends this connection only.
		if (msg.method === "Browser.close") {
			this.reply({ id: msg.id, result: {}, sessionId: msg.sessionId });
			this.end("Browser.close");
			return;
		}
		if (msg.method === "Target.createTarget") this.registry.creatingPage();
		const named = (msg.params as { targetId?: unknown } | undefined)?.targetId;
		if (msg.method === "Target.attachToTarget" && named !== undefined && named === this.browserTarget)
			this.browserAttaches.add(msg.id);
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
					if (m.id === undefined && this.browserLevel(m.sessionId) && info?.type === "tab") this.registry.resolve(info);
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
		const params = (msg.params ?? {}) as { targetId?: unknown; sessionId?: unknown; flatten?: unknown };
		if (params.targetId !== undefined && params.targetId === this.browserTarget) {
			// The browser itself: read, or attached to as a flat session (another browser session of this connection).
			if (!ON_BROWSER_TARGET.has(msg.method ?? "")) return `${msg.method} is not available for the browser`;
			if (msg.method === "Target.attachToTarget" && params.flatten !== true)
				return "The browser can be attached to only as a flat session (flatten: true)";
			return null;
		}
		if (typeof params.targetId === "string" && this.registry.ownerOfTarget(params.targetId) !== this.owner)
			return NOT_THIS_CONVERSATION;
		if (typeof params.sessionId === "string" && !this.channel?.owns(params.sessionId)) return NOT_THIS_CONVERSATION;
		return null;
	}

	/** Whether a message on `sessionId` (none: the root) is said on one of the connection's browser sessions. */
	private browserLevel(sessionId: string | undefined): boolean {
		const session = sessionId ?? this.root;
		return session !== null && this.browserSessions.has(session);
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
				if (targetId) this.seen(m.sessionId).add(targetId);
			}
			if (this.browserAttaches.delete(m.id)) {
				const session = (m.result as { sessionId?: string } | undefined)?.sessionId;
				if (session) this.browserSessions.add(session);
			}
			if (method === "Target.getTargets" && m.result) {
				const infos = (m.result as { targetInfos: TargetInfo[] }).targetInfos ?? [];
				m = {
					...m,
					result: {
						...(m.result as object),
						targetInfos: infos.filter(
							(t) => t.targetId === this.browserTarget || this.registry.resolve(t) === this.owner,
						),
					},
				};
			}
		}
		const atRoot = m.sessionId === this.root;
		const out: CdpMessage = atRoot ? { ...m, sessionId: undefined } : m;
		if (m.id === undefined && this.browserLevel(m.sessionId) && TARGET_EVENTS.has(m.method ?? "")) {
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

	/** The targets told of on a browser session (none: the root). */
	private seen(sessionId: string | undefined): Set<string> {
		const key = sessionId ?? this.root ?? "";
		let set = this.seenTargets.get(key);
		if (!set) {
			set = new Set();
			this.seenTargets.set(key, set);
		}
		return set;
	}

	/** What becomes of a held message: target events by their page's owner, anything else in its turn. */
	private decide(m: CdpMessage): Decision {
		if (m.sessionId !== undefined && this.released.has(m.sessionId)) return "drop";
		if (m.id !== undefined || !this.browserLevel(m.sessionId) || !TARGET_EVENTS.has(m.method ?? "")) return "deliver";
		const p = (m.params ?? {}) as { targetInfo?: TargetInfo; targetId?: string; sessionId?: string };
		const targetId = p.targetInfo?.targetId ?? p.targetId;
		const seen = this.seen(m.sessionId);
		if (m.method === "Target.detachedFromTarget" && p.sessionId) {
			// A session let go of is detached now: nothing more can be said on it.
			this.released.delete(p.sessionId);
			if (this.browserSessions.delete(p.sessionId)) this.seenTargets.delete(p.sessionId);
			if (!this.seenSessions.delete(p.sessionId)) return "drop";
			return "deliver";
		}
		if (!targetId) return "deliver";
		if (m.method === "Target.targetDestroyed" || m.method === "Target.targetCrashed") {
			if (m.method === "Target.targetDestroyed" ? seen.delete(targetId) : seen.has(targetId)) return "deliver";
			return "drop";
		}
		// The browser itself: its own browser target, never another connection's (each browser session is one).
		const browser = p.targetInfo?.type === "browser" || targetId === this.browserTarget;
		const owner = browser
			? null
			: p.targetInfo
				? this.registry.resolve(p.targetInfo)
				: this.registry.ownerOfTarget(targetId);
		if (browser ? targetId === this.browserTarget : owner === this.owner) {
			seen.add(targetId);
			if (m.method === "Target.attachedToTarget" && p.sessionId) {
				this.seenSessions.add(p.sessionId);
				if (browser) this.browserSessions.add(p.sessionId);
			}
			return "deliver";
		}
		if (!browser && owner === null && this.registry.pending) return "hold";
		if (m.method === "Target.attachedToTarget" && p.sessionId) this.release(p.sessionId, m.sessionId ?? this.root);
		return "drop";
	}

	/** Lets go of a session auto-attached (on browser session `parent`) to a page that is not this conversation's. */
	private release(sessionId: string, parent: string | null): void {
		this.released.add(sessionId);
		this.channel?.send({ id: this.nextOwn--, method: "Runtime.runIfWaitingForDebugger", sessionId });
		this.channel?.send({
			id: this.nextOwn--,
			method: "Target.detachFromTarget",
			params: { sessionId },
			sessionId: parent ?? undefined,
		});
	}

	private call(method: string, params: object, sessionId?: string): Promise<CdpMessage> {
		const id = this.nextOwn--;
		return new Promise((resolve) => {
			this.own.set(id, resolve);
			this.channel?.send({ id, method, params, ...(sessionId ? { sessionId } : {}) });
		});
	}

	private reply(m: CdpMessage): void {
		if (this.ended) return;
		const clean: CdpMessage = { ...m };
		if (clean.sessionId === undefined) delete clean.sessionId;
		this.socket.send(JSON.stringify(clean));
	}
}
