import type { FolderContext, FolderWatches, handleFolder } from "./folder-routes.ts";
import type { TransferOptions, TransferService } from "./folder-transfer.ts";
import type { TransferContext, TransferEnv } from "./transfer-core.ts";

/**
 * The Files tab's server side (`folder-routes.ts`, `folder.ts`), loaded when a page first uses it.
 *
 * Reading the folder a conversation works in, finding its files and watching what a page has expanded is code a server
 * that nobody opens a Files tab on never runs, and it should not be held in memory for (#585). The routes and the watches
 * are loaded together by the first request or watch that names a folder, and not at all by anything else: a server that
 * has not seen one holds none of them.
 *
 * What is asked of every request, whether it comes from this computer (`isThisComputer`), is not here: it is in
 * `this-computer.ts`, which is small and loaded at start.
 */
interface Loaded {
	handleFolder: typeof handleFolder;
	watches: FolderWatches;
}

export class LazyFolder {
	#loading: Promise<Loaded> | null = null;
	#watches: FolderWatches | null = null;
	#transfers: Promise<TransferService> | null = null;

	/** `options` are what the file transfer needs of the server (where its log is); read when the first transfer is asked for. */
	constructor(private readonly options?: () => TransferOptions) {}
	/** The code is loaded once, by whichever use comes first; one that failed to load is tried again by the next. */
	#load(): Promise<Loaded> {
		this.#loading ??= import("./folder-routes.ts").then(
			(routes) => {
				this.#watches = new routes.FolderWatches();
				return { handleFolder: routes.handleFolder, watches: this.#watches };
			},
			(error: unknown) => {
				this.#loading = null;
				throw error;
			},
		);
		return this.#loading;
	}

	/** `/api/folder/*`. */
	async handle(req: Request, url: URL, ctx: FolderContext): Promise<Response> {
		return (await this.#load()).handleFolder(req, url, ctx);
	}
	/**
	 * A request for the file transfer (`download`, `archive`, `upload`), answered by the one service of this server, which is
	 * loaded by the first of them. Nothing of it is in memory before.
	 */
	async transfer(req: Request, url: URL, ctx: TransferContext, env: TransferEnv): Promise<Response> {
		if (!this.options) return new Response("Not found", { status: 404 });
		const options = this.options;
		this.#transfers ??= import("./folder-transfer.ts").then(
			(m) => new m.TransferService(options()),
			(error: unknown) => {
				this.#transfers = null;
				throw error;
			},
		);
		return (await this.#transfers).handle(req, url, ctx, env);
	}

	/** The server is going away: uploads that were not finished are removed (nothing was loaded: nothing to remove). */
	async close(): Promise<void> {
		if (this.#transfers) await (await this.#transfers).close().catch(() => {});
	}

	/**
	 * What `FolderWatches.set` does. A set that names no folder and comes before anything was loaded has nothing to
	 * release (nothing was ever watched) and loads nothing; once a load has begun every set goes through it, in the order
	 * they came, so that the newest still wins.
	 */
	async watch(...args: Parameters<FolderWatches["set"]>): Promise<void> {
		const dirs = args[2];
		if (this.#loading === null && (!Array.isArray(dirs) || dirs.length === 0)) return;
		return (await this.#load()).watches.set(...args);
	}

	/**
	 * The owner (a page's socket) watches nothing from now on. Nothing loaded: nothing was watched. A `watch` still waiting
	 * for the code is given up by its `alive` check, which is false for a socket that ended.
	 */
	drop(owner: object): void {
		this.#watches?.drop(owner);
	}
}
