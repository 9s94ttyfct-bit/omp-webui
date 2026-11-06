import type { DownloadState } from "../../shared/browser-protocol.ts";
import type { TargetInfo } from "./registry.ts";
import { type CdpMessage, type CdpTransport, TransportListeners } from "./transport.ts";

/**
 * The CEF engine of the Mac app (docs/agents/browser.md): the app holds the pages (macos/cef/CEFHost.mm) and is connected
 * to the server on `/browser-engine` (macos/browserlink.swift); each page has a DevTools channel of its own there, and
 * the app opens no debugging port. This presents that to the server as the browser-level CDP connection Chrome for
 * Testing gives (`CdpTransport`), so the engine host, the registry, the conversations' proxy and the Browser tab work as
 * they do with CfT.
 *
 * The browser-level `Target` domain is answered here, from the app's list of pages: discovery, auto-attach, browser
 * sessions (`attachToBrowserTarget`, one per conversation's connection, and a flat session of the browser target, which
 * Puppeteer's `browser.target().createCDPSession()` makes), flat page sessions. A page is made by the app
 * (`create`), never by CEF's `Target.createTarget`, which would open a window of its own. Everything said on a page
 * session goes to that page's channel, its ids renumbered so that the sessions of one page never clash, and every event
 * of a page goes to every session on it. A browser-level command that is not about targets goes through the first
 * page's channel (CEF answers the browser domains there), or is refused when there is no page.
 *
 * Downloads: on a page's channel `Browser.setDownloadBehavior` sets where every page's downloads go, but the download
 * events come only on the channel of the page that downloads. So the behaviour a browser session sets is given to every
 * page (pages made later too, and again after a page that held it closes, which resets it), and the download events of
 * every page go to each browser session that asked for them. The latest session still holding one wins; when none is
 * left the browser's default is back.
 */

/** A page as the app tells it. */
export interface AppPage {
	targetId: string;
	url: string;
	title: string;
	/** The page that opened it (`window.open`, a link to a new tab). */
	openerId?: string;
}

/** What the app says on `/browser-engine`. */
export type AppMessage =
	/** First, on every connection: its CEF run (a new id each time CEF starts), CEF's version, the pages it has. */
	| { t: "hello"; run: string; version: string; pages: AppPage[] }
	/** A page appeared (made on request, or opened by a page) or its address or title changed. */
	| { t: "page"; page: AppPage }
	| { t: "closed"; targetId: string }
	/** The page asked for by `create` (`req`) is made (null: it could not be). */
	| { t: "created"; req: number; targetId: string | null }
	/** A message of the page's DevTools channel (JSON text). */
	| { t: "cdp"; targetId: string; message: string }
	/** A download a page started: when it begins, as it goes (a few times a second at most) and how it ended. */
	| { t: "download"; download: AppDownload };

/** A download as the app tells it (`macos/cef/CEFHost.mm`). */
export interface AppDownload {
	/** CEF's id of the download, for this run of the app. */
	id: string;
	/** The page that started it. */
	targetId: string;
	name: string;
	/** Where it is saved on this Mac (the Downloads folder, or the folder an agent asked for). */
	path: string;
	state: DownloadState;
	received: number;
	/** Its size in bytes; 0 or less while it is not known. */
	total: number;
	/** Why it failed. */
	error?: string;
}

/** What the server says to the app. */
export type ServerToApp =
	| { t: "create"; req: number; url: string }
	| { t: "close"; targetId: string }
	| { t: "cdp"; targetId: string; message: string }
	/** Stop a download that is running. */
	| { t: "download_cancel"; id: string };

export interface AppSocket {
	send(text: string): void;
}

/** The browser target's id in what is said of it. */
const BROWSER_TARGET = "ompw-cef-browser";

/** The app's side of the engine: its pages, kept across the engine transports made on it. */
export class CefLink {
	readonly pages = new Map<string, AppPage>();
	run = "";
	version = "";
	transport: CefTransport | null = null;
	private ended: string | null = null;

	/** `onHello`: the app said hello (its browser can be used from now on). `onDownload`: a page's download, as the app tells it. */
	constructor(
		private readonly socket: AppSocket,
		private readonly onHello: () => void = () => {},
		private readonly onDownload: (download: AppDownload) => void = () => {},
	) {}

	/** Whether the app has said hello (its pages are known). */
	get ready(): boolean {
		return this.run !== "";
	}

	/** A message of the app. */
	receive(text: string): void {
		let m: AppMessage;
		try {
			m = JSON.parse(text) as AppMessage;
		} catch {
			return;
		}
		switch (m.t) {
			case "hello":
				this.run = m.run;
				this.version = m.version;
				this.pages.clear();
				for (const page of m.pages) this.pages.set(page.targetId, page);
				this.onHello();
				return;
			case "page": {
				const known = this.pages.has(m.page.targetId);
				this.pages.set(m.page.targetId, { ...this.pages.get(m.page.targetId), ...m.page });
				this.transport?.pageChanged(m.page.targetId, !known);
				return;
			}
			case "closed":
				if (!this.pages.delete(m.targetId)) return;
				this.transport?.pageClosed(m.targetId);
				return;
			case "created":
				this.transport?.created(m.req, m.targetId);
				return;
			case "cdp":
				this.transport?.fromPage(m.targetId, m.message);
				return;
			case "download":
				if (m.download && typeof m.download.id === "string" && typeof m.download.targetId === "string")
					this.onDownload(m.download);
				return;
		}
	}

	send(m: ServerToApp): void {
		if (this.ended === null) this.socket.send(JSON.stringify(m));
	}

	/** The app went away: the engine on it ends. */
	end(why: string): void {
		if (this.ended !== null) return;
		this.ended = why;
		this.transport?.end(why);
	}
}

/** A browser-level session: the root one (`""`), a browser session of a connection, or a session of the browser target. */
interface Context {
	discover: boolean;
	autoAttach: boolean;
	/** A session of the browser target: the session it was attached in, told when it ends. */
	parent?: string;
}

interface PageSession {
	targetId: string;
	/** The browser-level session it was attached in. */
	context: string;
	/** It asked for the page's frames and workers (`Target.setAutoAttach`): their sessions are told to it. */
	autoAttach: boolean;
	/** It runs a screencast (`Page.startScreencast`): the page's frames go to it, and to no other session. */
	screencast: boolean;
}

/** A session of a page's frame or worker, made by the page's channel itself (a flat child session). */
interface ChildSession {
	targetId: string;
}

/** A command sent on into a page's channel: where its answer goes. */
interface Waiting {
	id: number;
	sessionId: string;
	targetId: string;
}

/** The domains a browser-level command may be of: the app's browser answers them on any page's channel. A page's own
 *  domains (`Runtime`, `Page`, `Input`, …) are not the browser's, and on a page they would reach whose page it is. */
const BROWSER_DOMAINS = ["Browser.", "Storage.", "SystemInfo."];

/** The screencast's events: for the session that runs it, never every session on the page. */
const SCREENCAST_EVENTS = new Set(["Page.screencastFrame", "Page.screencastVisibilityChanged"]);

/** A start for this connection's ids: answers the app still carries for a connection before it never match one of these. */
const freshIds = () => 1 + Math.floor(Math.random() * 2 ** 28);

/**
 * What a session can set on a page that lasts past the session (#27), and what undoes it. In Chrome each session is a
 * client of its own and what it set ends with it; over a page's one DevTools channel it would not: it would stay after the
 * session went, and apply to every other session on the page (the agent's puppeteer and the Browser tab's own size, or a
 * request interception left on with nobody to let the requests go). So what each session sets is remembered here, per page,
 * and when the session ends the page is given back what the session before it set (the latest one still there), or undone.
 *
 * `key`: the state the command sets; `clears`: the command (with these parameters) ends that state instead.
 */
interface Lasting {
	key: string;
	clears?: (p: Record<string, unknown>) => boolean;
}

const off = (name: string) => (p: Record<string, unknown>) => p[name] !== true;
const empty = (name: string) => (p: Record<string, unknown>) => {
	const v = p[name];
	return (
		v === undefined ||
		v === "" ||
		(Array.isArray(v) && v.length === 0) ||
		(typeof v === "object" && v !== null && Object.keys(v).length === 0)
	);
};

const LASTING: Record<string, Lasting> = {
	"Fetch.enable": { key: "fetch" },
	"Fetch.disable": { key: "fetch", clears: () => true },
	"Emulation.setDeviceMetricsOverride": { key: "metrics" },
	"Emulation.clearDeviceMetricsOverride": { key: "metrics", clears: () => true },
	"Emulation.setUserAgentOverride": { key: "agent", clears: empty("userAgent") },
	"Network.setUserAgentOverride": { key: "agent", clears: empty("userAgent") },
	"Emulation.setTouchEmulationEnabled": { key: "touch", clears: off("enabled") },
	"Emulation.setEmitTouchEventsForMouse": { key: "touchMouse", clears: off("enabled") },
	"Emulation.setGeolocationOverride": { key: "geolocation" },
	"Emulation.clearGeolocationOverride": { key: "geolocation", clears: () => true },
	"Emulation.setEmulatedMedia": { key: "media", clears: (p) => empty("media")(p) && empty("features")(p) },
	"Emulation.setTimezoneOverride": { key: "timezone", clears: empty("timezoneId") },
	"Emulation.setLocaleOverride": { key: "locale", clears: empty("locale") },
	"Emulation.setCPUThrottlingRate": { key: "cpu", clears: (p) => p.rate === 1 },
	"Emulation.setScriptExecutionDisabled": { key: "script", clears: off("value") },
	"Emulation.setDefaultBackgroundColorOverride": { key: "background", clears: empty("color") },
	"Emulation.setEmulatedVisionDeficiency": { key: "vision", clears: (p) => p.type === "none" },
	"Emulation.setFocusEmulationEnabled": { key: "focus", clears: off("enabled") },
	"Emulation.setIdleOverride": { key: "idle" },
	"Emulation.clearIdleOverride": { key: "idle", clears: () => true },
	"Network.setExtraHTTPHeaders": { key: "headers", clears: empty("headers") },
	"Network.emulateNetworkConditions": { key: "conditions" },
	"Network.setCacheDisabled": { key: "cache", clears: off("cacheDisabled") },
	"Network.setBlockedURLs": { key: "blocked", clears: empty("urls") },
	"Network.setBypassServiceWorker": { key: "serviceWorker", clears: off("bypass") },
	"Page.setInterceptFileChooserDialog": { key: "fileChooser", clears: off("enabled") },
	"Page.setBypassCSP": { key: "csp", clears: off("enabled") },
};

/** What gives a page back the state `key` as it is with nobody having set it. */
const UNDO: Record<string, { method: string; params: object }> = {
	fetch: { method: "Fetch.disable", params: {} },
	metrics: { method: "Emulation.clearDeviceMetricsOverride", params: {} },
	agent: { method: "Emulation.setUserAgentOverride", params: { userAgent: "" } },
	touch: { method: "Emulation.setTouchEmulationEnabled", params: { enabled: false } },
	touchMouse: { method: "Emulation.setEmitTouchEventsForMouse", params: { enabled: false } },
	geolocation: { method: "Emulation.clearGeolocationOverride", params: {} },
	media: { method: "Emulation.setEmulatedMedia", params: { media: "", features: [] } },
	timezone: { method: "Emulation.setTimezoneOverride", params: { timezoneId: "" } },
	locale: { method: "Emulation.setLocaleOverride", params: {} },
	cpu: { method: "Emulation.setCPUThrottlingRate", params: { rate: 1 } },
	script: { method: "Emulation.setScriptExecutionDisabled", params: { value: false } },
	background: { method: "Emulation.setDefaultBackgroundColorOverride", params: {} },
	vision: { method: "Emulation.setEmulatedVisionDeficiency", params: { type: "none" } },
	focus: { method: "Emulation.setFocusEmulationEnabled", params: { enabled: false } },
	idle: { method: "Emulation.clearIdleOverride", params: {} },
	headers: { method: "Network.setExtraHTTPHeaders", params: { headers: {} } },
	conditions: {
		method: "Network.emulateNetworkConditions",
		params: { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 },
	},
	cache: { method: "Network.setCacheDisabled", params: { cacheDisabled: false } },
	blocked: { method: "Network.setBlockedURLs", params: { urls: [] } },
	serviceWorker: { method: "Network.setBypassServiceWorker", params: { bypass: false } },
	fileChooser: { method: "Page.setInterceptFileChooserDialog", params: { enabled: false } },
	csp: { method: "Page.setBypassCSP", params: { enabled: false } },
};

export class CefTransport implements CdpTransport {
	private readonly listeners = new TransportListeners();
	private readonly contexts = new Map<string, Context>([["", { discover: false, autoAttach: false }]]);
	private readonly sessions = new Map<string, PageSession>();
	private readonly children = new Map<string, ChildSession>();
	private readonly waiting = new Map<number, Waiting>();
	private readonly creating = new Map<number, { id: number; context: string }>();
	/** What each session set on each page that lasts (`LASTING`): page → state → session → its command, latest last. */
	private readonly lasting = new Map<string, Map<string, Map<string, { method: string; params: unknown }>>>();
	/** The download behaviour each browser session set (`Browser.setDownloadBehavior`), latest last. */
	private readonly downloads = new Map<string, Record<string, unknown>>();
	private nextSession = 1;
	private nextWire = freshIds();
	private nextReq = freshIds();

	constructor(private readonly link: CefLink) {
		link.transport?.end("Another engine connection took over");
		link.transport = this;
	}

	onMessage(fn: (m: CdpMessage) => void): () => void {
		return this.listeners.onMessage(fn);
	}

	onClose(fn: (why: string) => void): () => void {
		return this.listeners.onClose(fn);
	}

	/** The server is done with the engine: the app's pages stay, only this connection to them ends. */
	close(): void {
		this.end("closed");
	}

	/** @internal */
	end(why: string): void {
		if (this.link.transport === this) this.link.transport = null;
		// The app's pages stay (another connection may take them over): what this connection's sessions set on them goes.
		if (this.listeners.ended === null) for (const sessionId of [...this.sessions.keys()]) this.release(sessionId);
		this.listeners.end(why);
	}

	send(message: object): void {
		const m = message as CdpMessage;
		// Answered on a later turn, as a browser at the other end of a pipe answers.
		queueMicrotask(() => {
			if (this.listeners.ended !== null) return;
			if (m.sessionId !== undefined && this.sessions.has(m.sessionId)) return this.toPage(m, m.sessionId);
			const child = m.sessionId === undefined ? undefined : this.children.get(m.sessionId);
			if (child && m.sessionId !== undefined) return this.forward(child.targetId, m, m.sessionId, m.sessionId);
			const context = m.sessionId ?? "";
			if (!this.contexts.has(context)) return this.error(m, -32001, `Session with given id not found.`, m.sessionId);
			this.browserLevel(context, m);
		});
	}

	// ------------------------------------------------------------------ the app

	/** @internal A page appeared (`added`) or changed. */
	pageChanged(targetId: string, added: boolean): void {
		const info = this.info(targetId);
		if (!info) return;
		for (const [context, c] of this.contexts) {
			if (c.discover)
				this.emit(context, added ? "Target.targetCreated" : "Target.targetInfoChanged", { targetInfo: info });
			if (added && c.autoAttach) this.attach(context, targetId);
		}
		if (added && this.downloads.size > 0) this.applyDownloads([targetId]);
	}

	/** @internal */
	pageClosed(targetId: string): void {
		// What was asked of it and not answered never will be: it is answered here, as a browser answers for a target that went.
		for (const [wire, w] of [...this.waiting]) {
			if (w.targetId !== targetId) continue;
			this.waiting.delete(wire);
			this.deliver({
				id: w.id,
				error: { code: -32000, message: "Target closed" },
				...(w.sessionId ? { sessionId: w.sessionId } : {}),
			});
		}
		for (const [sessionId, c] of [...this.children]) if (c.targetId === targetId) this.children.delete(sessionId);
		for (const [sessionId, s] of [...this.sessions]) {
			if (s.targetId !== targetId) continue;
			this.sessions.delete(sessionId);
			this.emit(s.context, "Target.detachedFromTarget", { sessionId, targetId });
		}
		for (const [context, c] of this.contexts)
			if (c.discover) this.emit(context, "Target.targetDestroyed", { targetId });
		this.lasting.delete(targetId);
		// A page that held the download behaviour took it with it (Chrome resets it): the others are given it again.
		if (this.downloads.size > 0) this.applyDownloads(this.link.pages.keys());
	}

	/** @internal */
	created(req: number, targetId: string | null): void {
		const asked = this.creating.get(req);
		if (!asked) return;
		this.creating.delete(req);
		const ask = { id: asked.id, method: "Target.createTarget" };
		if (!targetId) {
			this.error(ask, -32000, "The page could not be made", asked.context || undefined);
			return;
		}
		// The page is known before the answer, whichever the app told first: an attach right after it finds it.
		if (!this.link.pages.has(targetId)) {
			this.link.pages.set(targetId, { targetId, url: "about:blank", title: "" });
			this.pageChanged(targetId, true);
		}
		this.reply(ask, { targetId }, asked.context || undefined);
	}

	/** @internal A message of a page's channel. */
	fromPage(targetId: string, text: string): void {
		let m: CdpMessage;
		try {
			m = JSON.parse(text) as CdpMessage;
		} catch {
			return;
		}
		if (m.id !== undefined) {
			const w = this.waiting.get(m.id);
			if (!w) return;
			this.waiting.delete(m.id);
			const sessionId = w.sessionId || undefined;
			this.deliver({ ...m, id: w.id, ...(sessionId ? { sessionId } : {}) });
			return;
		}
		if (!m.method) return;
		// An event of a frame's or worker's own session: to whoever holds that session.
		if (m.sessionId !== undefined) {
			if (this.children.has(m.sessionId)) this.deliver({ method: m.method, params: m.params, sessionId: m.sessionId });
			return;
		}
		const child = (m.params as { sessionId?: unknown } | undefined)?.sessionId;
		const isChild =
			(m.method === "Target.attachedToTarget" || m.method === "Target.detachedFromTarget") && typeof child === "string";
		if (isChild && m.method === "Target.attachedToTarget") this.children.set(child as string, { targetId });
		if (isChild && m.method === "Target.detachedFromTarget") this.children.delete(child as string);
		// The page's downloads: to each browser session that asked for download events (they come only on this channel).
		if (m.method.startsWith("Browser."))
			for (const [context, p] of this.downloads) if (p.eventsEnabled === true) this.emit(context, m.method, m.params);
		// A request held by an interception is the session's that holds the interception now: two that both let it go would clash.
		const fetching = m.method.startsWith("Fetch.") ? this.setter(targetId, "fetch") : null;
		for (const [sessionId, s] of this.sessions) {
			if (s.targetId !== targetId) continue;
			// A frame's session is the one session's that asked for them; the screencast's frames the one's that runs it.
			if (isChild && !s.autoAttach) continue;
			if (SCREENCAST_EVENTS.has(m.method) && !s.screencast) continue;
			if (m.method.startsWith("Fetch.") && sessionId !== fetching) continue;
			this.deliver({ method: m.method, params: m.params, sessionId });
		}
	}

	/** The session whose setting of `key` the page has now (the latest one that set it), or null. */
	private setter(targetId: string, key: string): string | null {
		const by = this.lasting.get(targetId)?.get(key);
		let last: string | null = null;
		if (by) for (const sessionId of by.keys()) last = sessionId;
		return last;
	}

	/** `m`, sent on the page by `sessionId`: what it sets that lasts is remembered (`LASTING`). */
	private remember(targetId: string, sessionId: string, m: CdpMessage): void {
		const rule = m.method ? LASTING[m.method] : undefined;
		if (!rule) return;
		const p = (m.params ?? {}) as Record<string, unknown>;
		const page = this.lasting.get(targetId) ?? new Map<string, Map<string, { method: string; params: unknown }>>();
		this.lasting.set(targetId, page);
		// One channel, one state: a session that clears it clears it for every session on the page.
		if (rule.clears?.(p)) {
			page.delete(rule.key);
			return;
		}
		const by = page.get(rule.key) ?? new Map<string, { method: string; params: unknown }>();
		page.set(rule.key, by);
		by.delete(sessionId);
		by.set(sessionId, { method: m.method as string, params: m.params ?? {} });
	}

	/**
	 * The session ended: on its page, each state it was the latest to set is given what the session before it set, or undone.
	 * Sent without an id: its answer is nobody's.
	 */
	private release(sessionId: string): void {
		const s = this.sessions.get(sessionId);
		this.sessions.delete(sessionId);
		if (!s) return;
		const page = this.lasting.get(s.targetId);
		if (!page) return;
		for (const [key, by] of [...page]) {
			if (!by.has(sessionId)) continue;
			const wasLatest = this.setter(s.targetId, key) === sessionId;
			by.delete(sessionId);
			if (by.size === 0) page.delete(key);
			if (!wasLatest) continue;
			const back = [...by.values()].at(-1) ?? UNDO[key];
			if (back) this.forward(s.targetId, { method: back.method, params: back.params }, sessionId);
		}
		if (page.size === 0) this.lasting.delete(s.targetId);
	}

	// ------------------------------------------------------------------ CDP

	private info(targetId: string): (TargetInfo & Record<string, unknown>) | null {
		const page = this.link.pages.get(targetId);
		if (!page) return null;
		return {
			targetId,
			type: "page",
			title: page.title,
			url: page.url,
			attached: [...this.sessions.values()].some((s) => s.targetId === targetId),
			canAccessOpener: false,
			browserContextId: "default",
			...(page.openerId ? { openerId: page.openerId } : {}),
		};
	}

	/** The browser itself, as a target: what Puppeteer's `browser.target()` is. */
	private browserInfo(): TargetInfo & Record<string, unknown> {
		return { targetId: BROWSER_TARGET, type: "browser", title: "", url: "", attached: true, canAccessOpener: false };
	}

	private browserLevel(context: string, m: CdpMessage) {
		const p = (m.params ?? {}) as Record<string, unknown>;
		const c = this.contexts.get(context) as Context;
		const at = context || undefined;
		switch (m.method) {
			case "Target.setDiscoverTargets":
				c.discover = p.discover === true;
				if (c.discover) {
					this.emit(context, "Target.targetCreated", { targetInfo: this.browserInfo() });
					for (const targetId of this.link.pages.keys())
						this.emit(context, "Target.targetCreated", { targetInfo: this.info(targetId) });
				}
				return this.reply(m, {}, at);
			case "Target.setAutoAttach":
				c.autoAttach = p.autoAttach === true;
				if (c.autoAttach)
					for (const targetId of this.link.pages.keys())
						if (![...this.sessions.values()].some((s) => s.context === context && s.targetId === targetId))
							this.attach(context, targetId);
				return this.reply(m, {}, at);
			case "Target.getTargets":
				return this.reply(m, { targetInfos: [...this.link.pages.keys()].map((id) => this.info(id)) }, at);
			case "Target.getTargetInfo": {
				if (typeof p.targetId !== "string" || p.targetId === BROWSER_TARGET)
					return this.reply(m, { targetInfo: this.browserInfo() }, at);
				const info = this.info(p.targetId);
				return info ? this.reply(m, { targetInfo: info }, at) : this.noTarget(m, at);
			}
			case "Target.createTarget": {
				const req = this.nextReq++;
				this.creating.set(req, { id: m.id as number, context });
				this.link.send({ t: "create", req, url: typeof p.url === "string" && p.url ? p.url : "about:blank" });
				return;
			}
			case "Target.closeTarget":
				if (typeof p.targetId !== "string" || !this.link.pages.has(p.targetId)) return this.noTarget(m, at);
				this.link.send({ t: "close", targetId: p.targetId });
				return this.reply(m, { success: true }, at);
			case "Target.activateTarget":
				return this.link.pages.has(String(p.targetId)) ? this.reply(m, {}, at) : this.noTarget(m, at);
			case "Target.attachToTarget": {
				if (p.targetId === BROWSER_TARGET) {
					// A session of the browser itself: a browser session made in this one, and told there.
					const sessionId = `B${this.nextSession++}`;
					this.contexts.set(sessionId, { discover: false, autoAttach: false, parent: context });
					this.emit(context, "Target.attachedToTarget", {
						sessionId,
						targetInfo: this.browserInfo(),
						waitingForDebugger: false,
					});
					return this.reply(m, { sessionId }, at);
				}
				if (typeof p.targetId !== "string" || !this.link.pages.has(p.targetId)) return this.noTarget(m, at);
				const sessionId = this.attach(context, p.targetId);
				return this.reply(m, { sessionId }, at);
			}
			case "Target.detachFromTarget": {
				const sessionId = String(p.sessionId);
				// A browser session: it goes, with the sessions made in it.
				if (sessionId !== "" && this.contexts.has(sessionId)) {
					this.dropContext(sessionId);
					return this.reply(m, {}, at);
				}
				const s = this.sessions.get(sessionId);
				if (!s) return this.error(m, -32602, "No session with given id", at);
				this.release(sessionId);
				this.emit(s.context, "Target.detachedFromTarget", { sessionId, targetId: s.targetId });
				return this.reply(m, {}, at);
			}
			case "Target.attachToBrowserTarget": {
				const sessionId = `B${this.nextSession++}`;
				this.contexts.set(sessionId, { discover: false, autoAttach: false });
				return this.reply(m, { sessionId }, at);
			}
			case "Target.getBrowserContexts":
				return this.reply(m, { browserContextIds: [] }, at);
			case "Browser.getVersion": {
				const chromium = /chromium-([\d.]+)/.exec(this.link.version)?.[1] ?? this.link.version;
				return this.reply(
					m,
					{ protocolVersion: "1.3", product: `Chrome/${chromium}`, revision: "", userAgent: "", jsVersion: "" },
					at,
				);
			}
			// The browser is the app's: a connection that closes it ends only itself (the proxy says so to its client).
			case "Browser.close":
				return this.reply(m, {}, at);
			case "Browser.setDownloadBehavior": {
				const first = this.link.pages.keys().next();
				if (first.done) return this.error(m, -32000, "The built-in browser has no page to carry this", at);
				this.downloads.delete(context);
				if (p.behavior !== "default") this.downloads.set(context, p);
				// Answered by the first page; every other page is set alike, for its own download events.
				this.forward(first.value, { id: m.id, method: m.method, params: this.downloadBehavior() }, context);
				this.applyDownloads([...this.link.pages.keys()].slice(1));
				return;
			}
			default: {
				if (!m.method || !BROWSER_DOMAINS.some((d) => m.method?.startsWith(d)))
					return this.error(m, -32601, `'${m.method}' wasn't found`, at);
				const first = this.link.pages.keys().next();
				if (first.done) return this.error(m, -32000, "The built-in browser has no page to carry this", at);
				this.forward(first.value, m, context);
			}
		}
	}

	/**
	 * The download behaviour the pages are to have: the latest one a browser session still holds, with the download events
	 * on while any session wants them; none: the browser's default.
	 */
	private downloadBehavior(): Record<string, unknown> {
		const held = [...this.downloads.values()];
		const latest = held.at(-1);
		if (!latest) return { behavior: "default", eventsEnabled: false };
		return { ...latest, eventsEnabled: held.some((p) => p.eventsEnabled === true) };
	}

	/** Gives `targets` the download behaviour (sent without an id: its answer is nobody's). */
	private applyDownloads(targets: Iterable<string>): void {
		const params = this.downloadBehavior();
		for (const targetId of targets) this.forward(targetId, { method: "Browser.setDownloadBehavior", params }, "");
	}

	/** A browser session ends: the sessions made in it go too, and the download behaviour it held. */
	private dropContext(context: string): void {
		const c = this.contexts.get(context);
		if (!c) return;
		this.contexts.delete(context);
		for (const [id, other] of [...this.contexts]) if (other.parent === context) this.dropContext(id);
		for (const [id, s] of [...this.sessions]) if (s.context === context) this.release(id);
		if (c.parent !== undefined && this.contexts.has(c.parent))
			this.emit(c.parent, "Target.detachedFromTarget", { sessionId: context, targetId: BROWSER_TARGET });
		if (this.downloads.delete(context)) this.applyDownloads(this.link.pages.keys());
	}

	/** A new flat session on the page, made in `context` and told there. */
	private attach(context: string, targetId: string): string {
		const sessionId = `S${this.nextSession++}`;
		this.sessions.set(sessionId, { targetId, context, autoAttach: false, screencast: false });
		this.emit(context, "Target.attachedToTarget", {
			sessionId,
			targetInfo: this.info(targetId),
			waitingForDebugger: false,
		});
		return sessionId;
	}

	private toPage(m: CdpMessage, sessionId: string) {
		const s = this.sessions.get(sessionId) as PageSession;
		// No page is ever held waiting here (pages are attached as they run).
		if (m.method === "Runtime.runIfWaitingForDebugger") return this.reply(m, {}, sessionId);
		const p = (m.params ?? {}) as Record<string, unknown>;
		if (m.method === "Target.setAutoAttach") s.autoAttach = p.autoAttach === true;
		if (m.method === "Page.startScreencast") s.screencast = true;
		if (m.method === "Page.stopScreencast") s.screencast = false;
		this.remember(s.targetId, sessionId, m);
		this.forward(s.targetId, m, sessionId);
	}

	/** Into the page's channel; `child`: a frame's or worker's session there, which the channel knows by its own id. */
	private forward(targetId: string, m: CdpMessage, sessionId: string, child?: string): void {
		const wire = this.nextWire++;
		if (m.id !== undefined) this.waiting.set(wire, { id: m.id, sessionId, targetId });
		this.link.send({
			t: "cdp",
			targetId,
			message: JSON.stringify({
				id: wire,
				method: m.method,
				params: m.params ?? {},
				...(child ? { sessionId: child } : {}),
			}),
		});
	}

	private emit(context: string, method: string, params: unknown): void {
		this.deliver({ method, params, ...(context ? { sessionId: context } : {}) });
	}

	private reply(m: CdpMessage, result: unknown, sessionId?: string): void {
		if (m.id === undefined) return;
		this.deliver({ id: m.id, result, ...(sessionId ? { sessionId } : {}) });
	}

	private error(m: CdpMessage, code: number, message: string, sessionId?: string): void {
		if (m.id === undefined) return;
		this.deliver({ id: m.id, error: { code, message }, ...(sessionId ? { sessionId } : {}) });
	}

	private noTarget(m: CdpMessage, sessionId?: string): void {
		this.error(m, -32602, "No target with given id found", sessionId);
	}

	private deliver(m: CdpMessage): void {
		this.listeners.deliver(m);
	}
}

/** The engine on the app's link: a browser-level connection to its pages. */
export function startCefEngine(link: CefLink): CdpTransport {
	return new CefTransport(link);
}
