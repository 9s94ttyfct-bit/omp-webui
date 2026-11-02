import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { EngineKind } from "../../shared/browser.ts";
import type { RemoteIdentity } from "../remote-auth.ts";
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
}

export function engineHere(env: Record<string, string | undefined> = process.env): EngineKind {
	return env.OMP_WEBUI_BROWSER_ENGINE === "cef" ? "cef" : "cft";
}

/** A conversation's endpoint path: `/browser-cdp/<token><rest>`. */
export function cdpPath(pathname: string): { token: string; rest: string } | null {
	const m = /^\/browser-cdp\/([A-Za-z0-9_-]{16,})(\/.*)?$/.exec(pathname);
	return m ? { token: m[1], rest: m[2] ?? "" } : null;
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

	constructor(private readonly opts: LazyBrowserOptions) {}

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
					if (engine === "cef") throw new Error("the app's browser is not connected");
					const executable = installer?.executable();
					if (!executable) throw new Error("it is not installed (Settings › Browser)");
					const transport = await startCft({
						executable,
						profileDir: installer?.profileDir() ?? join(root, "cft-profile"),
					});
					return { transport, generation: randomUUID(), fresh: true };
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
							if (wasRunning) await host.ready().catch(() => {});
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

	/** The server is stopping: the engine it started ends with it. */
	async stop(): Promise<void> {
		await this.#service?.host.stop("The server stopped");
	}
}
