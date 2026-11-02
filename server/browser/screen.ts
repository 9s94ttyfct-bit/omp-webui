import {
	type BrowserInput,
	type ConsoleEntry,
	DESKTOP_SIZE,
	encodeFrame,
	type PageInfo,
	type PageMode,
	pageSizeFor,
	type ScreenClientMessage,
	type ScreenServerMessage,
	type Size,
} from "../../shared/browser-protocol.ts";
import type { Engine, EngineHost } from "./engine.ts";
import type { PageRegistry, TargetInfo } from "./registry.ts";

/**
 * The Browser tab's socket (`/ws/browser`, see shared/browser-protocol.ts): the page list of the conversation it shows,
 * the screencast and console of the page it shows, and the person's input to that page.
 *
 * The server keeps one CDP session of its own on each page a tab has shown (through the engine's own client, never a
 * conversation's proxy): it holds the page's size (an emulation lasts as long as the session that set it), listens to
 * its console, and runs the screencast while at least one tab shows the page. Frames go straight to the socket and are
 * dropped, not queued, while it is behind.
 */

export interface ScreenSocket {
	sendText(text: string): void;
	sendBinary(data: Uint8Array): void;
	/** Bytes the socket has not sent yet. */
	buffered(): number;
	close(code?: number, reason?: string): void;
}

/** A socket further behind than this misses frames until it catches up. */
const FRAME_BACKLOG = 1 << 20;
/** Console entries kept per page, for a tab that starts showing it. */
const CONSOLE_KEPT = 200;
/** Requests remembered per page for the address a failed one was for. */
const REQUESTS_KEPT = 500;

interface ConsoleArg {
	type: string;
	value?: unknown;
	description?: string;
	unserializableValue?: string;
}

function consoleLevel(type: string): ConsoleEntry["level"] {
	if (type === "error" || type === "assert") return "error";
	if (type === "warning" || type === "warn") return "warn";
	if (type === "info") return "info";
	return "log";
}

function argText(a: ConsoleArg): string {
	if (a.value !== undefined) return typeof a.value === "string" ? a.value : JSON.stringify(a.value);
	return a.unserializableValue ?? a.description ?? a.type;
}

/** An address as typed: a scheme is added when it has none. */
export function addressOf(text: string): string {
	const t = text.trim();
	if (/^[a-z][a-z0-9+.-]*:/i.test(t)) return t;
	if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(t)) return `http://${t}`;
	return `https://${t}`;
}

/**
 * What a page in the phone size says it is (`Emulation.setUserAgentOverride`): Chrome on an Android phone, of the browser's
 * own major version (`product`: `Browser.getVersion`'s, `Chrome/131.0.6778.85`), in the reduced form Chrome itself sends
 * (`Android 10; K`, the minor parts zero), with the client hints to match. An engine whose version cannot be read says 130.
 */
export function phoneAgent(product: string): {
	userAgent: string;
	platform: string;
	userAgentMetadata: {
		brands: { brand: string; version: string }[];
		fullVersionList: { brand: string; version: string }[];
		fullVersion: string;
		platform: string;
		platformVersion: string;
		architecture: string;
		model: string;
		mobile: boolean;
	};
} {
	const full = /(?:Chrome|Chromium|HeadlessChrome)\/(\d+(?:\.\d+)*)/.exec(product)?.[1] ?? "130.0.0.0";
	const major = full.split(".")[0] as string;
	const brands = [
		{ brand: "Chromium", version: major },
		{ brand: "Not?A_Brand", version: "99" },
	];
	return {
		userAgent: `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Mobile Safari/537.36`,
		platform: "Linux armv81",
		userAgentMetadata: {
			brands,
			fullVersionList: [
				{ brand: "Chromium", version: full },
				{ brand: "Not?A_Brand", version: "99.0.0.0" },
			],
			fullVersion: full,
			platform: "Android",
			platformVersion: "10.0.0",
			architecture: "",
			model: "K",
			mobile: true,
		},
	};
}

/** The server's session on one page. */
class PageView {
	readonly watchers = new Set<ScreenClient>();
	readonly console: ConsoleEntry[] = [];
	readonly requests = new Map<string, string>();
	mode: PageMode = "desktop";
	size = pageSizeFor("desktop", DESKTOP_SIZE);
	canBack = false;
	canForward = false;
	/**
	 * The number of the view's last frame. It starts at the time in µs, not at 0: a tab keeps the newest number it drew and
	 * drops anything not above it, and the same page gets a new view when the engine's connection or the server restarts
	 * (CEF keeps its pages), whose frames must not be taken for old ones. A page sends far fewer than a frame per µs.
	 */
	seq = Math.floor((performance.timeOrigin + performance.now()) * 1000);
	/** The screencast's size now; null while it does not run. */
	casting: Size | null = null;
	/** Where the Mac app's own view draws the page (`fit` of the protocol); null: only screencasts show it. */
	fit: Size | null = null;
	/** The tab that said so: the fit ends with it. */
	fitBy: ScreenClient | null = null;

	constructor(
		readonly engine: Engine,
		readonly targetId: string,
		readonly session: string,
	) {}

	call<T = unknown>(method: string, params: object = {}): Promise<T> {
		return this.engine.client.call<T>(method, params, this.session);
	}

	/**
	 * The page's device. A phone is one to the sites as well as in its layout: it is laid out at a phone's size with touch,
	 * and says it is a phone (`phoneAgent`: the user agent, and the client hints `Sec-CH-UA-Mobile` and `Sec-CH-UA-Platform`
	 * that many sites decide by), and the page is loaded again when it changes between a phone and a computer, so that a site
	 * that serves phones another page sends that one, as it would to a real phone. Without this a site that chooses on its
	 * server sent its desktop page, drawn squeezed onto the phone's width.
	 */
	async setSize(mode: PageMode, panel: Size, desktop: Size): Promise<void> {
		const wasMobile = this.size.mobile;
		this.mode = mode;
		this.size = pageSizeFor(mode, panel, desktop);
		await this.emulate();
		await this.call("Emulation.setTouchEmulationEnabled", {
			enabled: this.size.mobile,
			...(this.size.mobile ? { maxTouchPoints: 5 } : {}),
		});
		if (this.size.mobile === wasMobile) return;
		// An empty user agent ends the override: the browser's own is sent again.
		await this.call(
			"Emulation.setUserAgentOverride",
			this.size.mobile ? phoneAgent(await this.engineProduct()) : { userAgent: "" },
		);
		const h = await this.call<{ currentIndex: number; entries: { url: string }[] }>("Page.getNavigationHistory").catch(
			() => null,
		);
		const url = h?.entries?.[h.currentIndex]?.url ?? "";
		if (/^https?:/i.test(url)) await this.call("Page.reload");
	}

	/** The browser's product (`Chrome/131.0.6778.85`), asked once per page view. */
	private product: Promise<string> | null = null;
	private engineProduct(): Promise<string> {
		this.product ??= this.engine.client
			.call<{ product?: string }>("Browser.getVersion")
			.then((v) => v.product ?? "")
			.catch(() => "");
		return this.product;
	}

	async setFit(room: Size | null, by: ScreenClient | null): Promise<void> {
		this.fit = room;
		this.fitBy = room ? by : null;
		await this.emulate();
	}

	/**
	 * The layout size. A view of the page's own (the Mac app's) lays it out at its own size and draws it at the screen's
	 * pixel ratio unless told otherwise: it is given the size, and a scale that fits the page into the view, centred there
	 * at the same scale by the app (macos/browserlink.swift). A phone keeps its pixel ratio.
	 */
	private async emulate(): Promise<void> {
		const { w, h, scale, mobile } = this.size;
		const fit = this.fit;
		await this.call("Emulation.setDeviceMetricsOverride", {
			width: w,
			height: h,
			deviceScaleFactor: fit && !mobile ? 0 : scale,
			mobile,
			...(fit ? { scale: Math.min(1, fit.w / w, fit.h / h) } : {}),
		});
	}

	async history(): Promise<void> {
		const h = await this.call<{ currentIndex: number; entries: { id: number }[] }>("Page.getNavigationHistory").catch(
			() => null,
		);
		this.canBack = (h?.currentIndex ?? 0) > 0;
		this.canForward = h ? h.currentIndex < (h.entries?.length ?? 0) - 1 : false;
	}

	/** Runs the screencast at the largest room a watcher of its frames has, or stops it when none watches them. */
	async cast(): Promise<void> {
		const casting = [...this.watchers].filter((c) => c.frames);
		if (casting.length === 0) {
			if (this.casting) {
				this.casting = null;
				await this.call("Page.stopScreencast").catch(() => {});
			}
			return;
		}
		const room = { w: 1, h: 1 };
		for (const c of casting) {
			room.w = Math.max(room.w, Math.round(c.panel.w));
			room.h = Math.max(room.h, Math.round(c.panel.h));
		}
		if (this.casting && this.casting.w === room.w && this.casting.h === room.h) return;
		this.casting = room;
		await this.call("Page.startScreencast", {
			format: "jpeg",
			quality: 70,
			maxWidth: room.w,
			maxHeight: room.h,
			everyNthFrame: 1,
		}).catch(() => {});
	}

	note(entry: ConsoleEntry): void {
		this.console.push(entry);
		if (this.console.length > CONSOLE_KEPT) this.console.shift();
		const text = JSON.stringify({ t: "console", targetId: this.targetId, entry } satisfies ScreenServerMessage);
		for (const c of this.watchers) c.socket.sendText(text);
	}
}

export class ScreenHub {
	private readonly views = new Map<string, Promise<PageView>>();
	private readonly bySession = new Map<string, PageView>();
	private readonly clients = new Set<ScreenClient>();
	private readonly wired = new WeakSet<Engine>();

	constructor(
		readonly host: EngineHost,
		readonly registry: PageRegistry,
	) {
		registry.onChange(() => {
			for (const c of this.clients) c.sendPages();
		});
		host.onEnd((why) => {
			this.views.clear();
			this.bySession.clear();
			this.settledViews.clear();
			for (const c of this.clients) {
				c.tellUnavailable(why);
				c.sendPages();
			}
		});
	}

	/**
	 * The engine can be used again (the app's CEF said hello, or CfT started again after a Clear or an update): every tab
	 * that was told it could not be watches again what it last asked to, and is told the browser is back.
	 */
	engineBack(): void {
		for (const c of this.clients) c.retry();
	}

	connect(socket: ScreenSocket): ScreenClient {
		const client = new ScreenClient(this, socket);
		this.clients.add(client);
		return client;
	}

	/** @internal */
	forget(client: ScreenClient): void {
		this.clients.delete(client);
	}

	/** @internal The page's information for its conversation's tabs. */
	pageInfo(targetId: string): PageInfo {
		const info = this.registry.info(targetId);
		const view = this.known(targetId);
		const size = view?.size ?? pageSizeFor("desktop", DESKTOP_SIZE);
		return {
			targetId,
			url: info?.url ?? "",
			title: info?.title ?? "",
			mode: view?.mode ?? "desktop",
			w: size.w,
			h: size.h,
			canBack: view?.canBack ?? false,
			canForward: view?.canForward ?? false,
		};
	}

	private readonly settledViews = new Map<string, PageView>();

	private known(targetId: string): PageView | null {
		return this.settledViews.get(targetId) ?? null;
	}

	/** @internal The server's view of a page, made on first need. */
	view(engine: Engine, targetId: string): Promise<PageView> {
		let view = this.views.get(targetId);
		if (!view) {
			view = this.open(engine, targetId);
			this.views.set(targetId, view);
			view.catch(() => this.views.delete(targetId));
		}
		return view;
	}

	private async open(engine: Engine, targetId: string): Promise<PageView> {
		this.wire(engine);
		const { sessionId } = await engine.client.call<{ sessionId: string }>("Target.attachToTarget", {
			targetId,
			flatten: true,
		});
		const view = new PageView(engine, targetId, sessionId);
		this.bySession.set(sessionId, view);
		await Promise.all([
			view.call("Page.enable"),
			view.call("Runtime.enable"),
			view.call("Log.enable"),
			view.call("Network.enable"),
		]);
		await view.setSize("desktop", DESKTOP_SIZE, DESKTOP_SIZE);
		await view.history();
		this.settledViews.set(targetId, view);
		return view;
	}

	/** The engine's page events, for the pages the server holds a session on. */
	private wire(engine: Engine): void {
		if (this.wired.has(engine)) return;
		this.wired.add(engine);
		const on = <P>(method: string, fn: (view: PageView, p: P) => void) =>
			engine.client.on<P>(method, (p, session) => {
				const view = session ? this.bySession.get(session) : undefined;
				if (view) fn(view, p);
			});
		// A page that closed (or its session that ended) is forgotten: its console, its requests, its size.
		engine.client.on<{ sessionId: string }>("Target.detachedFromTarget", (p, session) => {
			const view = session === undefined ? this.bySession.get(p.sessionId) : undefined;
			if (!view) return;
			this.bySession.delete(p.sessionId);
			this.views.delete(view.targetId);
			if (this.settledViews.get(view.targetId) === view) this.settledViews.delete(view.targetId);
		});
		on<{ data: string; sessionId: number }>("Page.screencastFrame", (view, p) => {
			void view.call("Page.screencastFrameAck", { sessionId: p.sessionId }).catch(() => {});
			if (view.watchers.size === 0) return;
			const frame = encodeFrame(
				{ targetId: view.targetId, w: view.size.w, h: view.size.h, scale: view.size.scale, seq: ++view.seq },
				Buffer.from(p.data, "base64"),
			);
			for (const c of view.watchers) if (c.frames && c.socket.buffered() <= FRAME_BACKLOG) c.socket.sendBinary(frame);
		});
		on<{ type: string; args: ConsoleArg[]; timestamp: number }>("Runtime.consoleAPICalled", (view, p) => {
			view.note({
				level: consoleLevel(p.type),
				text: p.args.map(argText).join(" "),
				source: "console",
				time: Date.now(),
			});
		});
		on<{ entry: { source: string; level: string; text: string; url?: string } }>("Log.entryAdded", (view, p) => {
			view.note({
				level: consoleLevel(p.entry.level),
				text: p.entry.text,
				source: p.entry.source === "network" ? "network" : "console",
				...(p.entry.url ? { url: p.entry.url } : {}),
				time: Date.now(),
			});
		});
		on<{ requestId: string; request: { url: string } }>("Network.requestWillBeSent", (view, p) => {
			view.requests.set(p.requestId, p.request.url);
			if (view.requests.size > REQUESTS_KEPT) view.requests.delete(view.requests.keys().next().value as string);
		});
		on<{ requestId: string; errorText: string; canceled?: boolean }>("Network.loadingFailed", (view, p) => {
			const url = view.requests.get(p.requestId);
			view.requests.delete(p.requestId);
			if (p.canceled) return;
			view.note({ level: "error", text: p.errorText, source: "network", ...(url ? { url } : {}), time: Date.now() });
		});
		// Chrome tells target discovery of a new address, not of a new title: the title is asked for once the page has loaded
		// or moved, and the conversation's tabs are told through the registry's change.
		const retitle = (view: PageView) =>
			void engine.client
				.call<{ targetInfo: TargetInfo }>("Target.getTargetInfo", { targetId: view.targetId })
				.then(({ targetInfo }) => {
					if (this.registry.info(view.targetId)) this.registry.track(targetInfo);
				})
				.catch(() => {});
		const navigated = (view: PageView) => {
			retitle(view);
			void view.history().then(() => {
				for (const c of this.clients) if (c.owner === this.registry.ownerOfTarget(view.targetId)) c.sendPages();
			});
		};
		on<{ frame: { parentId?: string } }>("Page.frameNavigated", (view, p) => {
			if (!p.frame.parentId) navigated(view);
		});
		on("Page.navigatedWithinDocument", (view) => navigated(view));
		// The entry a navigation made may not be in the history yet when it is said: read again once the page has loaded.
		on("Page.loadEventFired", (view) => navigated(view));
	}
}

export class ScreenClient {
	owner: string | null = null;
	targetId: string | null = null;
	panel: Size = { w: 1, h: 1 };
	/** Whether the tab draws the frames of the page it watches; not in the Mac app's own view, which wants its console only. */
	frames = true;
	private view: PageView | null = null;
	private closed = false;
	/** The pages this tab said it draws in the Mac app's own view (`fit`). */
	private readonly fitted = new Set<PageView>();
	/** The tab's messages are handled one after the other, in order (a press before its release, watch before size). */
	private queue: Promise<void> = Promise.resolve();
	/** The tab's last watch, and whether it was told the browser cannot be used since that watch was carried out. */
	private lastWatch: Extract<ScreenClientMessage, { t: "watch" }> | null = null;
	private stale = false;

	constructor(
		private readonly hub: ScreenHub,
		readonly socket: ScreenSocket,
	) {}

	/** A message of the tab. */
	message(text: string): void {
		let msg: ScreenClientMessage;
		try {
			msg = JSON.parse(text) as ScreenClientMessage;
		} catch {
			return;
		}
		if (typeof msg !== "object" || msg === null) return;
		this.enqueue(msg);
	}

	private enqueue(msg: ScreenClientMessage): void {
		this.queue = this.queue.then(() =>
			this.handle(msg).then(
				() => {
					if (msg.t !== "watch" || this.closed) return;
					this.lastWatch = msg;
					if (!this.stale) return;
					this.stale = false;
					this.socket.sendText(JSON.stringify({ t: "available" } satisfies ScreenServerMessage));
				},
				(e: unknown) => {
					if (msg.t === "watch") this.lastWatch = msg;
					this.tellUnavailable(e instanceof Error ? e.message : String(e));
				},
			),
		);
	}

	/** The engine is back: a tab that was told it could not be used watches what it last asked to again. */
	retry(): void {
		if (this.stale && this.lastWatch && !this.closed) this.enqueue(this.lastWatch);
	}

	close(): void {
		this.closed = true;
		this.unwatch();
		this.unfit();
		this.hub.forget(this);
	}

	sendPages(): void {
		if (this.closed || this.owner === null) return;
		const pages = this.hub.host.running ? this.hub.registry.pagesOf(this.owner).map((id) => this.hub.pageInfo(id)) : [];
		this.socket.sendText(JSON.stringify({ t: "pages", owner: this.owner, pages } satisfies ScreenServerMessage));
	}

	tellUnavailable(reason: string): void {
		this.stale = true;
		this.socket.sendText(JSON.stringify({ t: "unavailable", reason } satisfies ScreenServerMessage));
	}

	private unwatch(): void {
		const view = this.view;
		this.view = null;
		this.targetId = null;
		if (view) {
			view.watchers.delete(this);
			void view.cast();
		}
	}

	/** The pages this tab draws in the Mac app's own view: they are not (it stopped watching their conversation). */
	private unfit(): void {
		for (const view of this.fitted) if (view.fitBy === this) void view.setFit(null, null).catch(() => {});
		this.fitted.clear();
	}

	/**
	 * The page `targetId`, when it is one of the conversation this tab watches: a tab acts on its own conversation's pages
	 * only, whatever it names.
	 */
	private async page(engine: Engine, targetId: string): Promise<PageView> {
		if (this.owner === null || this.hub.registry.ownerOfTarget(targetId) !== this.owner)
			throw new Error("That page is not this conversation's");
		return this.hub.view(engine, targetId);
	}

	private async handle(msg: ScreenClientMessage): Promise<void> {
		if (msg.t === "unwatch") {
			this.unwatch();
			this.unfit();
			this.owner = null;
			return;
		}
		const engine = await this.hub.host.ready();
		if (this.closed) return;
		switch (msg.t) {
			case "watch": {
				if (typeof msg.owner !== "string") return;
				// The page this tab watched until now, for the same conversation: watched again (its panel resized), it has
				// been told its console already. The tab starts its list over for another conversation.
				const before = msg.owner === this.owner ? this.view : null;
				this.unwatch();
				if (msg.owner !== this.owner) this.unfit();
				this.owner = msg.owner;
				this.panel = { w: Math.max(1, Number(msg.panel?.w) || 1), h: Math.max(1, Number(msg.panel?.h) || 1) };
				this.frames = msg.frames !== false;
				this.sendPages();
				if (!msg.targetId || this.hub.registry.ownerOfTarget(msg.targetId) !== msg.owner) return;
				this.targetId = msg.targetId;
				const view = await this.page(engine, msg.targetId);
				if (this.closed || this.targetId !== msg.targetId) return;
				this.view = view;
				view.watchers.add(this);
				if (view !== before)
					for (const entry of view.console)
						this.socket.sendText(
							JSON.stringify({ t: "console", targetId: view.targetId, entry } satisfies ScreenServerMessage),
						);
				this.sendPages();
				await view.cast();
				return;
			}
			case "open":
				if (msg.owner === this.owner && this.owner !== null)
					await engine.createPage(this.owner, addressOf(msg.url || "about:blank"));
				return;
			case "close":
				if (this.owner !== null && this.hub.registry.ownerOfTarget(msg.targetId) === this.owner)
					await engine.close(msg.targetId);
				return;
			case "navigate": {
				const view = await this.page(engine, msg.targetId);
				if (msg.action === "url" && msg.url) await view.call("Page.navigate", { url: addressOf(msg.url) });
				else if (msg.action === "reload") await view.call("Page.reload");
				else if (msg.action === "back" || msg.action === "forward") {
					const h = await view.call<{ currentIndex: number; entries: { id: number }[] }>("Page.getNavigationHistory");
					const entry = h.entries[h.currentIndex + (msg.action === "back" ? -1 : 1)];
					if (entry) await view.call("Page.navigateToHistoryEntry", { entryId: entry.id });
				}
				return;
			}
			case "size": {
				const view = await this.page(engine, msg.targetId);
				await view.setSize(msg.mode, msg.panel ?? this.panel, msg.desktop ?? DESKTOP_SIZE);
				for (const c of view.watchers) c.sendPages();
				this.sendPages();
				return;
			}
			case "fit": {
				// Said after the tab stopped watching (its view ending as it goes): the fit ended with the watch.
				if (this.owner === null || this.hub.registry.ownerOfTarget(msg.targetId) !== this.owner) return;
				const view = await this.page(engine, msg.targetId);
				const w = Number(msg.room?.w);
				const h = Number(msg.room?.h);
				const room = w >= 1 && h >= 1 ? { w, h } : null;
				if (!room && view.fitBy !== this) return;
				await view.setFit(room, this);
				if (room) this.fitted.add(view);
				return;
			}
			case "input": {
				const view = await this.page(engine, msg.targetId);
				await dispatch(view, msg.event);
				return;
			}
		}
	}
}

async function dispatch(view: PageView, e: BrowserInput): Promise<void> {
	switch (e.kind) {
		case "mouse":
			await view.call("Input.dispatchMouseEvent", {
				type: e.type,
				x: e.x,
				y: e.y,
				button: e.button,
				clickCount: e.clickCount,
				modifiers: e.modifiers,
			});
			return;
		case "wheel":
			await view.call("Input.dispatchMouseEvent", {
				type: "mouseWheel",
				x: e.x,
				y: e.y,
				deltaX: e.deltaX,
				deltaY: e.deltaY,
				modifiers: e.modifiers,
			});
			return;
		case "key":
			await view.call("Input.dispatchKeyEvent", {
				type: e.type === "keyUp" ? "keyUp" : e.text ? "keyDown" : "rawKeyDown",
				key: e.key,
				code: e.code,
				...(e.text && e.type !== "keyUp" ? { text: e.text, unmodifiedText: e.text } : {}),
				windowsVirtualKeyCode: e.keyCode,
				nativeVirtualKeyCode: e.keyCode,
				modifiers: e.modifiers,
			});
			return;
		case "text":
			await view.call("Input.insertText", { text: e.text });
			return;
	}
}
