import { join } from "node:path";
import type { EngineKind } from "../../shared/browser.ts";
import type { RemoteIdentity } from "../remote-auth.ts";
import type { BrowserInstaller } from "./install.ts";

/**
 * The built-in browser, made on first use: nothing of it is loaded while no page asks for it (`GET /api/browser`, the
 * Browser tab, Settings › Browser).
 *
 * The engine is CEF when the Mac app started this server (it sets `OMP_WEBUI_BROWSER_ENGINE=cef`), else Chrome for
 * Testing. The variable is one of the `OMP_WEBUI_*` the server keeps from omp's environment.
 */

export interface LazyBrowserOptions {
	dataDir: string;
	/** The state changed: tell every page (each with its own `canManage`). */
	changed(inst: BrowserInstaller): void;
	/** CEF: the app is to restart (shell events' `browserRestart`). */
	requestAppRestart(): void;
}

export function engineHere(env: Record<string, string | undefined> = process.env): EngineKind {
	return env.OMP_WEBUI_BROWSER_ENGINE === "cef" ? "cef" : "cft";
}

export class LazyBrowser {
	#loading: Promise<BrowserInstaller> | null = null;
	#installer: BrowserInstaller | null = null;

	constructor(private readonly opts: LazyBrowserOptions) {}

	/** The installer when it was made; null while nobody asked. */
	get loaded(): BrowserInstaller | null {
		return this.#installer;
	}

	installer(): Promise<BrowserInstaller> {
		this.#loading ??= import("./install.ts").then(
			({ BrowserInstaller }) => {
				const inst = new BrowserInstaller({
					root: join(this.opts.dataDir, "browser"),
					engine: engineHere(),
					hooks: { requestAppRestart: () => this.opts.requestAppRestart() },
				});
				inst.onChange(() => this.opts.changed(inst));
				this.#installer = inst;
				return inst;
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
		const [{ handleBrowserRoute }, inst] = await Promise.all([import("./install.ts"), this.installer()]);
		return handleBrowserRoute(req, url, inst, who);
	}
}
