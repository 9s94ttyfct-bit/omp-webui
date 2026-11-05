import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { EngineKind } from "../../shared/browser.ts";
import type { RemoteIdentity } from "../remote-auth.ts";
import { BrowserAutoUpdater, type BrowserUse } from "./autoupdate.ts";
import { type AppSocket, CefLink, startCefEngine } from "./cef.ts";
import type { EngineHost, EngineStart } from "./engine.ts";
import type { BrowserInstaller } from "./install.ts";
import type { CdpProxy, ProxyConnection, ProxySocket } from "./proxy.ts";
import type { PageRegistry } from "./registry.ts";
import type { ScreenClient, ScreenHub, ScreenSocket } from "./screen.ts";

/**
 * The built-in browser, made on first use: nothing of it is loaded while no page and no conversation asks for it
 * (`/api/browser`, the Browser tab, Settings › Browser, a conversation's `/browser-cdp/<token>`).
 *
 * The engine is CEF when the Mac app started this server (it sets `OMP_WEBUI_BROWSER_ENGINE=cef`), else Chrome for
 * Testing, which the server starts itself when a conversation first needs it. The variable is one of the `OMP_WEBUI_*`
 * the server keeps from omp's environment.
 */

export interface LazyBrowserOptions {
	dataDir: string;
	/** The install state changed: tell every page (each with its own `canManage`). */
	changed(inst: BrowserInstaller): void;
	/** CEF: the app is to restart (shell events' `browserRestart`). */
	requestAppRestart(): void;
	/** CEF: the app's browser can be used now (the app said hello): the conversations' endpoints are named again. */
	engineLinked(): void;
}

export function engineHere(env: Record<string, string | undefined> = process.env): EngineKind {
	return env.OMP_WEBUI_BROWSER_ENGINE === "cef" ? "cef" : "cft";
}

/**
 * A conversation's endpoint request: `/browser-cdp/<token><rest>`, or the discovery at the server's root (`/json`,
 * `/json/version`…) with the token as the URL's user name. omp hands its `browser.cdpUrl` to Puppeteer as `browserURL`, which
 * resolves `/json/version` against it and so drops any path, but keeps a user name, and Bun's fetch sends it as Basic auth:
 * the endpoint is `http://<token>@127.0.0.1:<port>` (see `cdpUrlOf`).
 */
export function cdpPath(pathname: string, authorization: string | null = null): { token: string; rest: string } | null {
	const m = /^\/browser-cdp\/([A-Za-z0-9_-]{16,})(\/.*)?$/.exec(pathname);
	if (m) return { token: m[1], rest: m[2] ?? "" };
	if (!/^\/json(\/[a-z]*)?$/.test(pathname) || !authorization) return null;
	const basic = /^Basic\s+([A-Za-z0-9+/]+=*)$/i.exec(authorization.trim());
	const user = basic ? Buffer.from(basic[1], "base64").toString("utf8").split(":")[0] : "";
	return /^[A-Za-z0-9_-]{16,}$/.test(user) ? { token: user, rest: pathname } : null;
}

/** The endpoint omp is given for a token, on the server's loopback `origin` (`http://127.0.0.1:<port>`). */
export function cdpUrlOf(origin: string, token: string): string {
	return origin.replace("://", `://${token}@`);
}

export interface BrowserService {
	installer: BrowserInstaller;
	registry: PageRegistry;
	host: EngineHost;
	proxy: CdpProxy;
	screen: ScreenHub;
}

export class LazyBrowser {
	#loading: Promise<BrowserService> | null = null;
	#service: BrowserService | null = null;
	/** CEF: the app's connection on `/browser-engine` (the engine is started on it), null while it is not connected. */
	#link: CefLink | null = null;
	#auto: BrowserAutoUpdater | null = null;

	constructor(private readonly opts: LazyBrowserOptions) {}

	/**
	 * Automatic updates of Chrome for Testing (`autoupdate.ts`), the first look a minute from now. `wanted` says whether the
	 * person wants them now (Settings › Browser: the switch on, and the browser not turned off). Nothing of the browser is
	 * loaded for a look while nothing is installed. None with CEF: the Mac app ships it, and it updates with the app.
	 */
	startAutoUpdate(wanted: () => boolean): void {
		if (engineHere() === "cef") return;
		this.#auto ??= new BrowserAutoUpdater({
			wanted,
			installer: async () => {
				if (!existsSync(join(this.opts.dataDir, "browser", "current.json"))) return null;
				const { installer } = await this.service();
				return installer.state(false).installed ? installer : null;
			},
			use: () => this.use(),
			log: (line) => console.warn(line),
		});
		this.#auto.start();
	}

	/** The automatic update's switch, or the browser, was turned on or off: it looks again soon. */
	autoUpdateChanged(): void {
		this.#auto?.wake();
	}

	/** What uses the browser now: the engine, the conversations' connections and the Browser tabs that show a page. */
	private use(): BrowserUse {
		const service = this.#service;
		if (!service) return { engine: false, connections: 0, watchers: 0, lastUse: 0 };
		return {
			engine: service.host.active,
			connections: service.proxy.open,
			watchers: service.screen.watching,
			lastUse: Math.max(service.proxy.lastUse, service.screen.lastUse),
		};
	}

	/**
	 * The app connected on `/browser-engine` (CEF): the engine is on this connection from now on; one before it ends, and the
	 * engine on that one with it.
	 */
	attachApp(socket: AppSocket): CefLink {
		this.#link?.end("The app connected again");
		// The app's CEF said hello: the conversations' endpoints are named again, and the Browser tabs told it could not be
		// used watch again.
		const link = new CefLink(socket, () => {
			this.opts.engineLinked();
			this.#service?.screen.engineBack();
		});
		this.#link = link;
		return link;
	}

	/** The app's connection closed. */
	detachApp(link: CefLink, why: string): void {
		link.end(why);
		if (this.#link === link) this.#link = null;
	}

	/** The installer when the service was made; null while nobody asked. */
	get loaded(): BrowserInstaller | null {
		return this.#service?.installer ?? null;
	}

	service(): Promise<BrowserService> {
		this.#loading ??= Promise.all([
			import("./install.ts"),
			import("./registry.ts"),
			import("./engine.ts"),
			import("./proxy.ts"),
			import("./cft.ts"),
			import("./screen.ts"),
		]).then(
			([{ BrowserInstaller }, { PageRegistry }, { EngineHost }, { CdpProxy }, { startCft }, { ScreenHub }]) => {
				const root = join(this.opts.dataDir, "browser");
				const engine = engineHere();
				const registry = new PageRegistry(join(root, "owners.json"));
				let installer: BrowserInstaller | null = null;
				const start = async (): Promise<EngineStart> => {
					if (engine === "cef") {
						const link = this.#link;
						if (!link?.ready) throw new Error("the app's browser is not connected");
						// The app keeps its pages while the server restarts: they are met again, not closed (`fresh: false`).
						return { transport: startCefEngine(link), generation: link.run, fresh: false };
					}
					const executable = installer?.executable();
					if (!executable) throw new Error("it is not installed (Settings › Browser)");
					const transport = await startCft({
						executable,
						profileDir: installer?.profileDir() ?? join(root, "cft-profile"),
					});
					// Its pages are tabs of one headless window, and Chrome tells nobody of their titles (engine.ts `cft`).
					return { transport, generation: randomUUID(), fresh: true, cft: true };
				};
				const host = new EngineHost(registry, start);
				// Whether CfT ran before Clear or an update stopped it: it runs again for the conversations that used it.
				let wasRunning = false;
				installer = new BrowserInstaller({
					root,
					engine,
					hooks: {
						stopEngine: async (why) => {
							wasRunning = host.running !== null;
							await host.stop(why);
						},
						startEngine: async () => {
							if (!wasRunning) return;
							await host.ready().catch(() => {});
							this.#service?.screen.engineBack();
						},
						requestAppRestart: () => this.opts.requestAppRestart(),
					},
				});
				const inst = installer;
				inst.onChange(() => this.opts.changed(inst));
				const service = {
					installer: inst,
					registry,
					host,
					proxy: new CdpProxy(host, registry),
					screen: new ScreenHub(host, registry),
				};
				this.#service = service;
				return service;
			},
			(e: unknown) => {
				this.#loading = null;
				throw e;
			},
		);
		return this.#loading;
	}

	/** `/api/browser` and `/api/browser/*`. */
	async handle(req: Request, url: URL, who: { remote: RemoteIdentity | null; local: boolean }): Promise<Response> {
		const [{ handleBrowserRoute }, { installer }] = await Promise.all([import("./install.ts"), this.service()]);
		return handleBrowserRoute(req, url, installer, who);
	}

	/** The conversation a token is of; null for no conversation's. */
	async ownerOf(token: string): Promise<string | null> {
		return (await this.service()).registry.ownerOf(token);
	}

	/** `/browser-cdp/<token>/json/…` of `owner`; `base` is the endpoint's WebSocket address. */
	async http(owner: string, rest: string, base: string): Promise<Response> {
		return (await this.service()).proxy.http(owner, rest, base);
	}

	/** A conversation's CDP WebSocket opened (the service exists: its token was looked up). */
	connect(owner: string, socket: ProxySocket, target: string | null): ProxyConnection | null {
		return this.#service?.proxy.connect(owner, socket, target) ?? null;
	}

	/** A Browser tab's socket (`/ws/browser`): made with the service, which the tab's first message needs anyway. */
	async screen(socket: ScreenSocket): Promise<ScreenClient> {
		return (await this.service()).screen.connect(socket);
	}

	/**
	 * The conversation's CDP endpoint on `origin` (`browser.cdpUrl` of its omp), or null while the browser cannot be used:
	 * CfT is not installed, or the app's CEF is not connected (it failed to load, or has not said hello yet). Its omp then
	 * uses its own hidden Chromium.
	 */
	async cdpUrlFor(owner: string, origin: string): Promise<string | null> {
		const { installer, registry } = await this.service();
		const usable = installer.engine === "cef" ? this.#link?.ready === true : installer.executable() !== null;
		return usable ? cdpUrlOf(origin, registry.tokenFor(owner)) : null;
	}

	/** The conversation in `from` moved to `to` (omp's `/move`): its pages and endpoint are the new file's. */
	async moved(from: string, to: string): Promise<void> {
		(await this.known())?.registry.rekey(from, to);
	}

	/**
	 * The conversation was deleted (`forget`: its endpoint goes too) or archived (its omp may still run, and keeps its
	 * endpoint): its pages are closed.
	 */
	async closeOwner(owner: string, forget: boolean): Promise<void> {
		await (await this.known())?.registry.closeOwner(owner, forget);
	}

	/**
	 * The person turned the browser off (`PREF.browser`): every page closes and the engine stops (CfT ends; the app's CEF stays
	 * loaded, with no page, until the app quits). Nothing of it is loaded for this when it never ran.
	 */
	async turnOff(): Promise<void> {
		const service = this.#service;
		if (!service) return;
		await service.registry.closeAll();
		await service.host.stop("The browser was turned off");
	}

	/** The service, when there is anything of the browser to change: it ran here or before (its owners file is there). */
	private async known(): Promise<BrowserService | null> {
		if (this.#service) return this.#service;
		if (!existsSync(join(this.opts.dataDir, "browser", "owners.json"))) return null;
		return this.service();
	}

	/** The server is stopping: the engine it started ends with it, and no look comes any more. */
	async stop(): Promise<void> {
		this.#auto?.stop();
		await this.#service?.host.stop("The server stopped");
	}
}
