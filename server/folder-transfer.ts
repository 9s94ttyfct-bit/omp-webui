import { join } from "node:path";
import type { OpenHooks } from "./folder.ts";
import { editFile } from "./folder-write.ts";
import { type ArchiveDeps, planArchive, sendArchive, TicketStore } from "./transfer-archive.ts";
import {
	DEFAULT_LIMITS,
	failure,
	Gate,
	type Limits,
	POLICY_CODES,
	record,
	type Trace,
	type TransferContext,
	type TransferEnv,
	TransferError,
} from "./transfer-core.ts";
import { download } from "./transfer-download.ts";
import { TransferLog } from "./transfer-log.ts";
import { type UploadDeps, Uploads } from "./transfer-upload.ts";

/**
 * The file transfer of `/api/folder/*` (#614): `download`, `archive` and `upload`, and the save into a file that the Files tab's
 * editor makes (`POST /api/folder/file`, `folder-write.ts`, logged with the transfers). Loaded by the first request for one
 * (`folder-lazy.ts`): a server nobody moves a file on holds none of it. One `TransferService` per server holds what is
 * going on (uploads that are not finished, tickets for ZIPs, how many answers are being sent) and writes the log
 * (`<data dir>/transfers.jsonl`, see `transfer-log.ts`).
 *
 * The rules of each route are in its module (`transfer-download.ts`, `transfer-archive.ts`, `transfer-upload.ts`); what all of them
 * share, and the failure each answers with, is in `transfer-core.ts`. Every route is for any page that holds the token (and, for a
 * page that came through the tunnel, passed Access): the request is checked by `main.ts` before it gets here, and what *this
 * computer* lets such a page do (`TransferEnv.setting`) is asked here, route by route.
 */

export interface TransferOptions {
	/** Where the log is (`<data dir>/transfers.jsonl`). */
	logFile: string;
	/** Other limits (tests use small ones). */
	limits?: Partial<Limits>;
	now?: () => number;
	statfs?: UploadDeps["statfs"];
	hooks?: OpenHooks;
	beforePublish?: UploadDeps["beforePublish"];
}

/** How often uploads that were given up are looked for, and tickets that ran out are not looked for at all (they are pruned as they are used). */
const SWEEP_MS = 60_000;

export class TransferService {
	readonly log: TransferLog;
	readonly limits: Limits;
	readonly uploads: Uploads;
	readonly tickets: TicketStore;
	readonly #downloads: Gate;
	readonly #archives: Gate;
	readonly #plans: Gate;
	readonly #now: () => number;
	readonly #hooks: OpenHooks | undefined;
	readonly #beforePublish: TransferOptions["beforePublish"];
	readonly #timer: ReturnType<typeof setInterval>;

	constructor(opts: TransferOptions) {
		this.limits = { ...DEFAULT_LIMITS, ...opts.limits };
		this.#now = opts.now ?? Date.now;
		this.#hooks = opts.hooks;
		this.#beforePublish = opts.beforePublish;
		this.log = new TransferLog(opts.logFile);
		this.#downloads = new Gate(2, 4);
		this.#archives = new Gate(1, 2);
		this.#plans = new Gate(2, 4);
		this.tickets = new TicketStore(this.#now);
		this.uploads = new Uploads({
			log: this.log,
			gate: new Gate(4, 8),
			limits: this.limits,
			now: this.#now,
			statfs: opts.statfs,
			beforePublish: opts.beforePublish,
		});
		this.#timer = setInterval(() => void this.uploads.expire(), SWEEP_MS);
		this.#timer.unref();
	}

	/** The server is going away: what was staged is removed. */
	async close(): Promise<void> {
		clearInterval(this.#timer);
		await this.uploads.close();
	}

	/** The route `route` (what follows `/api/folder/`), or null when it is none of the transfer's. */
	static owns(route: string): boolean {
		return (
			route === "download" ||
			route === "archive" ||
			route.startsWith("archive/") ||
			route === "upload" ||
			route.startsWith("upload/")
		);
	}

	async handle(req: Request, url: URL, ctx: TransferContext, env: TransferEnv): Promise<Response> {
		const route = url.pathname.slice("/api/folder/".length);
		const head = req.method === "HEAD";
		const trace: Trace = {
			kind: route.startsWith("upload")
				? "upload"
				: route.startsWith("archive")
					? "zip"
					: route === "file"
						? "edit"
						: "download",
			root: "",
			path: "",
			started: this.#now(),
		};
		try {
			return await this.#route(route, req, url, ctx, env, trace);
		} catch (e) {
			if (e instanceof TransferError) {
				// What the person's rule said no to is written down (a page that tried is worth knowing of); a mistake of a request is not.
				if (POLICY_CODES.includes(e.code) && !(head && e.code === "off"))
					record(this.log, env, trace, `refused:${e.code}`);
				return failure(e, head);
			}
			if (typeof (e as NodeJS.ErrnoException).code === "string") {
				// What the system said is for the log: its message names a path.
				console.error("omp-webui: file transfer failed:", e);
				return failure(new TransferError("The file could not be read or written", 500, "write"), head);
			}
			throw e;
		}
	}

	async #route(
		route: string,
		req: Request,
		url: URL,
		ctx: TransferContext,
		env: TransferEnv,
		trace: Trace,
	): Promise<Response> {
		const method = req.method;
		const only = (...allowed: string[]) => {
			if (!allowed.includes(method))
				throw new TransferError(
					`${allowed.join(" or ")} required`,
					405,
					"badRequest",
					{},
					{ allow: allowed.join(", ") },
				);
		};
		if (route === "download") {
			only("GET", "HEAD");
			return download(req, url, ctx, env, trace, {
				log: this.log,
				gate: this.#downloads,
				limits: this.limits,
				now: this.#now,
				hooks: this.#hooks,
			});
		}
		const archive: ArchiveDeps = {
			tickets: this.tickets,
			plans: this.#plans,
			gate: this.#archives,
			limits: this.limits,
			now: this.#now,
			hooks: this.#hooks,
			ended: (t, e, status, files, bytes) => record(this.log, e, t, status, { files, size: bytes }),
		};
		if (route === "archive") {
			only("POST");
			return planArchive(req, ctx, env, trace, archive);
		}
		if (route.startsWith("archive/")) {
			only("GET");
			return sendArchive(route, env, trace, archive);
		}
		if (route === "upload") {
			only("POST");
			return this.uploads.upload(req, url, ctx, env, trace);
		}
		if (route === "upload/state") {
			only("GET");
			return this.uploads.state(url, env);
		}
		if (route === "upload/cancel") {
			only("POST");
			return this.uploads.cancel(req, env);
		}
		if (route === "file") {
			only("POST");
			return editFile(req, ctx, env, trace, { log: this.log, hooks: this.#hooks, beforePublish: this.#beforePublish });
		}
		throw new TransferError("Not found", 404, "notFound");
	}
}

/** The place of the log under a data folder. */
export const transferLogFile = (dataDir: string): string => join(dataDir, "transfers.jsonl");
