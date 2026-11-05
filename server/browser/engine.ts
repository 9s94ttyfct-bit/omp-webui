import type { PageRegistry, TargetInfo } from "./registry.ts";
import { CdpClient, CdpMux, type CdpTransport } from "./transport.ts";

/**
 * The browser engine the server drives, started on first need and kept running: its CDP connection split into channels
 * (`CdpMux`), the server's own channel on the root session (target discovery for the registry, creating and closing
 * pages), and the registry told what the engine has.
 */

export interface EngineStart {
	transport: CdpTransport;
	/** A new random id at each start of the engine; the same id when the server met an engine that was running. */
	generation: string;
	/** Pages without an owner are closed (an engine just started: its first blank tab is nobody's). */
	fresh: boolean;
	/**
	 * The engine is Chrome for Testing, not the app's CEF: the server holds a session of its own on every page
	 * (`ownSession` below), which keeps it as if it were its window's active one (the pages are tabs of one headless
	 * window, and all but the newest would be hidden; CEF's pages are each a view of their own) and hears the title it
	 * sets (Chrome's target discovery does not tell of it; the app tells CEF's).
	 */
	cft?: boolean;
}

/** How long a tab with no page yet is given after it was asked (one that is closing, or crashed, has none to give). */
const LINK_MS = 150;

/**
 * The isolated world, and its binding, in which the server hears a Chrome for Testing page's title: Chrome's target
 * discovery tells of a page's new address (its title then is that address) but never of the title the page sets then or
 * later. The world's script calls the binding whenever `document.title` changes; the page's own scripts see neither.
 */
const TITLE_WORLD = "ompw-title";
const TITLE_BINDING = "ompwTitle";
const TITLE_SCRIPT = `(() => {
	let last = null;
	const tell = () => {
		if (document.title === last) return;
		last = document.title;
		globalThis.${TITLE_BINDING}(last);
	};
	new MutationObserver(tell).observe(document, { subtree: true, childList: true, characterData: true });
	tell();
})();`;

export class Engine {
	readonly mux: CdpMux;
	readonly client: CdpClient;
	/** Settles when the engine's connection has ended and the browser it started (CfT) has exited: its profile is free. */
	readonly ended: Promise<string>;
	private readonly ensuring = new Map<string, Promise<void>>();
	/** Pages the server holds a session of its own on (Chrome for Testing), and the page of each such session. */
	private readonly owned = new Set<string>();
	private readonly ownedBySession = new Map<string, string>();

	constructor(
		private readonly transport: CdpTransport,
		private readonly registry: PageRegistry,
		private readonly cft = false,
	) {
		this.ended = new Promise<string>((resolve) => transport.onClose(resolve)).then(async (why) => {
			await transport.exited?.catch(() => {});
			return why;
		});
		this.mux = new CdpMux(transport);
		this.client = new CdpClient(this.mux.open({ root: true }));
	}

	/** Starts tracking the engine's targets; closes nobody's pages of a fresh engine. */
	async init(fresh: boolean): Promise<void> {
		this.client.on<{ targetInfo: TargetInfo }>("Target.targetCreated", (p) => {
			this.registry.track(p.targetInfo);
			if (this.cft && p.targetInfo.type === "page") void this.ownSession(p.targetInfo.targetId);
		});
		this.client.on<{ targetInfo: TargetInfo }>("Target.targetInfoChanged", (p) => this.registry.track(p.targetInfo));
		this.client.on<{ targetId: string }>("Target.targetDestroyed", (p) => {
			this.registry.untrack(p.targetId);
			this.owned.delete(p.targetId);
			for (const [session, page] of this.ownedBySession) if (page === p.targetId) this.ownedBySession.delete(session);
		});
		// The page's title changed: Chrome's own information on the page has it.
		this.client.on<{ name: string }>("Runtime.bindingCalled", (p, session) => {
			const targetId = session === undefined ? undefined : this.ownedBySession.get(session);
			if (p.name !== TITLE_BINDING || !targetId) return;
			void this.client
				.call<{ targetInfo: TargetInfo }>("Target.getTargetInfo", { targetId })
				.then(({ targetInfo }) => {
					if (this.registry.info(targetId)) this.registry.track(targetInfo);
				})
				.catch(() => {});
		});
		this.registry.setEngine(this);
		await this.client.call("Target.setDiscoverTargets", { discover: true });
		if (!fresh) return;
		const { targetInfos } = await this.client.call<{ targetInfos: TargetInfo[] }>("Target.getTargets");
		for (const t of targetInfos)
			if (t.type === "page" && this.registry.ownerOfTarget(t.targetId) === null)
				await this.close(t.targetId).catch(() => {});
	}

	/**
	 * A session of the server's own on a Chrome for Testing page, for as long as it lives. It keeps the page as if it
	 * were its window's active one (focus emulation): Chrome for Testing holds the pages as tabs of one headless window,
	 * so every page but the newest would be hidden (`document.visibilityState` "hidden", no animation frames, no
	 * IntersectionObserver), and an older conversation's page would stall what its agent and its Browser tab do there.
	 * And it hears the page's title (`TITLE_SCRIPT`): in every document the page loads from now on, and in the one it may
	 * have loaded already (a world of that name made in it now). Chrome runs the script only with the Page domain on, and
	 * tells of the binding's calls only with the Runtime domain on.
	 */
	private async ownSession(targetId: string): Promise<void> {
		if (this.owned.has(targetId)) return;
		this.owned.add(targetId);
		try {
			const { sessionId } = await this.client.call<{ sessionId: string }>("Target.attachToTarget", {
				targetId,
				flatten: true,
			});
			this.ownedBySession.set(sessionId, targetId);
			await this.client.call("Emulation.setFocusEmulationEnabled", { enabled: true }, sessionId);
			await this.client.call("Page.enable", {}, sessionId);
			await this.client.call("Runtime.enable", {}, sessionId);
			await this.client.call(
				"Runtime.addBinding",
				{ name: TITLE_BINDING, executionContextName: TITLE_WORLD },
				sessionId,
			);
			const { frameTree } = await this.client.call<{ frameTree: { frame: { id: string } } }>(
				"Page.getFrameTree",
				{},
				sessionId,
			);
			await this.client.call(
				"Page.createIsolatedWorld",
				{ frameId: frameTree.frame.id, worldName: TITLE_WORLD },
				sessionId,
			);
			await this.client.call(
				"Page.addScriptToEvaluateOnNewDocument",
				{ source: TITLE_SCRIPT, worldName: TITLE_WORLD, runImmediately: true },
				sessionId,
			);
		} catch {
			// Closed before it was reached: nothing to keep.
			this.owned.delete(targetId);
			for (const [session, page] of this.ownedBySession) if (page === targetId) this.ownedBySession.delete(session);
		}
	}

	/** A new page for `owner`; its id. */
	async createPage(owner: string, url = "about:blank"): Promise<string> {
		this.registry.creatingPage();
		let targetId: string | null = null;
		try {
			({ targetId } = await this.client.call<{ targetId: string }>("Target.createTarget", { url }));
			return targetId;
		} finally {
			this.registry.created(targetId, targetId ? owner : null);
		}
	}

	/** The conversation has a page: a blank one is made when it has none (two connections at once make one). */
	ensurePage(owner: string): Promise<void> {
		if (this.registry.pagesOf(owner).length > 0) return Promise.resolve();
		let running = this.ensuring.get(owner);
		if (!running) {
			running = this.createPage(owner)
				.then(() => {})
				.finally(() => this.ensuring.delete(owner));
			this.ensuring.set(owner, running);
		}
		return running;
	}

	async close(targetId: string): Promise<void> {
		await this.client.call("Target.closeTarget", { targetId });
	}

	/**
	 * Finds the page a tab holds: a session on the tab is auto-attached to it, then let go. Chrome attaches what a tab
	 * already holds before it answers `setAutoAttach`; a tab with nothing then (closing, crashed) is given a moment more.
	 */
	async link(tabId: string): Promise<void> {
		const { sessionId } = await this.client.call<{ sessionId: string }>("Target.attachToTarget", {
			targetId: tabId,
			flatten: true,
		});
		let found: TargetInfo | null = null;
		let arrived = () => {};
		const off = this.client.on<{ targetInfo: TargetInfo }>("Target.attachedToTarget", (p, from) => {
			if (from !== sessionId || p.targetInfo.type !== "page") return;
			found = p.targetInfo;
			arrived();
		});
		try {
			await this.client.call(
				"Target.setAutoAttach",
				{ autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
				sessionId,
			);
			if (!found)
				await new Promise<void>((resolve) => {
					arrived = resolve;
					setTimeout(resolve, LINK_MS);
				});
			if (found) this.registry.linkTab(tabId, found);
		} finally {
			off();
			await this.client.call("Target.detachFromTarget", { sessionId }).catch(() => {});
		}
	}

	stop(): void {
		this.transport.close();
	}
}

/** The engine, started when first needed and again after it ended. */
export class EngineHost {
	private engine: Engine | null = null;
	private starting: Promise<Engine> | null = null;
	private readonly endFns = new Set<(why: string) => void>();

	constructor(
		private readonly registry: PageRegistry,
		private readonly start: () => Promise<EngineStart>,
	) {}

	/** The running engine, started now if none runs. */
	ready(): Promise<Engine> {
		if (this.engine) return Promise.resolve(this.engine);
		this.starting ??= (async () => {
			const { transport, generation, fresh, cft } = await this.start();
			this.registry.load(generation);
			const engine = new Engine(transport, this.registry, cft);
			transport.onClose((why) => {
				if (this.engine === engine) this.engine = null;
				this.registry.setEngine(null);
				const reason = this.stopping ?? why;
				for (const fn of [...this.endFns]) fn(reason);
			});
			try {
				await engine.init(fresh);
			} catch (e) {
				engine.stop();
				throw e;
			}
			this.engine = engine;
			return engine;
		})().finally(() => {
			this.starting = null;
		});
		return this.starting;
	}

	/** The engine now, if one runs. */
	get running(): Engine | null {
		return this.engine;
	}

	/** Whether an engine runs or is starting (an update must not change what it runs from under it). */
	get active(): boolean {
		return this.engine !== null || this.starting !== null;
	}

	/** Ends the engine (Clear, an update, the server stopping); `onEnd` listeners hear `why`. */
	async stop(why: string): Promise<void> {
		const engine = this.engine ?? (this.starting ? await this.starting.catch(() => null) : null);
		if (!engine) return;
		this.stopping = why;
		try {
			engine.stop();
			await engine.ended;
		} finally {
			this.stopping = null;
		}
	}

	/** Why the engine is being stopped here, for the connections it ends. */
	private stopping: string | null = null;

	/** Called when the engine ends, with why. */
	onEnd(fn: (why: string) => void): () => void {
		this.endFns.add(fn);
		return () => this.endFns.delete(fn);
	}
}
