import {
	type ArchivePlan,
	type ArchiveRequest,
	CSRF_HEADER,
	ERROR_HEADER,
	type ExistsFailure,
	type TransferCode,
	type TransferFailure,
	type UploadProgress,
	type UploadSaved,
} from "@shared/transfer.ts";
import type { FolderScope } from "./folder-api.ts";
import {
	backoffMs,
	baseName,
	type Conflict,
	conflictPlan,
	isRetryable,
	MAX_TRIES,
	nextPiece,
	type Resend,
	type Resolution,
	retryAfterMs,
} from "./transfer-plan.ts";

/**
 * The page's side of moving files between the computer the server runs on and a page that is not on it (#614, step two;
 * the routes are in `shared/transfer.ts`): checking and starting a download, planning a folder's ZIP, and uploading files
 * in pieces that are sent again when they fail. No React and no strings: the words for a failure are
 * `lib/transfer-words.ts`'s, and what is drawn is `components/files/TransferPanel.tsx`'s. This module is loaded only when
 * transfers are used (it is no part of the first page load).
 */

/** Every code of the contract: a code the server sends that is not here is shown with the server's own sentence. */
const KNOWN: Record<TransferCode, true> = {
	off: true,
	uploadOff: true,
	outside: true,
	secret: true,
	hidden: true,
	protected: true,
	homeFolder: true,
	ownData: true,
	refused: true,
	badName: true,
	badRequest: true,
	notFound: true,
	gone: true,
	notFile: true,
	notFolder: true,
	exists: true,
	offset: true,
	changed: true,
	conflict: true,
	notText: true,
	tooLarge: true,
	tooMany: true,
	busy: true,
	diskFull: true,
	stalled: true,
	write: true,
};

const isCode = (value: unknown): value is TransferCode => typeof value === "string" && Object.hasOwn(KNOWN, value);

/** What the server added to a failure besides its code. */
export interface FailureExtra {
	limit?: number;
	/** 409 `conflict`: what the file on disk is now (a save made from it overwrites). */
	etag?: string;
	existing?: ExistsFailure["existing"];
	suggestion?: string;
	received?: number;
	counted?: { files: number; bytes: number };
	/** How long `Retry-After` asked to wait. */
	retryAfterMs?: number;
}

/** A refused or failed transfer: the server's code (`failed` when it gave none we know, or no answer came), its sentence, and the HTTP status (0: no answer). */
export class TransferError extends Error {
	readonly limit?: number;
	readonly etag?: string;
	readonly existing?: ExistsFailure["existing"];
	readonly suggestion?: string;
	readonly received?: number;
	readonly counted?: { files: number; bytes: number };
	readonly retryAfterMs?: number;
	constructor(
		message: string,
		readonly code: TransferCode | "failed",
		readonly status: number,
		extra: FailureExtra = {},
	) {
		super(message);
		this.limit = extra.limit;
		this.etag = extra.etag;
		this.existing = extra.existing;
		this.suggestion = extra.suggestion;
		this.received = extra.received;
		this.counted = extra.counted;
		this.retryAfterMs = extra.retryAfterMs;
	}
}

/** An answer, as much of it as the page looks at. */
export interface Reply {
	status: number;
	text: string;
	/** The `ERROR_HEADER` of the answer (a `HEAD` has no body to carry the code). */
	code: string | null;
	retryAfterMs: number;
}

export const abortError = (): DOMException => new DOMException("Cancelled", "AbortError");

export const isAbort = (e: unknown): boolean => e instanceof DOMException && e.name === "AbortError";

function parseJson(text: string): Record<string, unknown> | null {
	try {
		const value: unknown = JSON.parse(text);
		return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

const isExisting = (v: unknown): v is ExistsFailure["existing"] => {
	const o = v as Record<string, unknown> | null;
	return (
		typeof o === "object" &&
		o !== null &&
		typeof o.size === "number" &&
		typeof o.modified === "number" &&
		typeof o.etag === "string" &&
		typeof o.replaceable === "boolean"
	);
};

/** What an answer that is not a success says, read as a failure: its code and sentence, and what else it carries. */
export function failureOf(reply: Reply): TransferError {
	const body = parseJson(reply.text) as Partial<TransferFailure & ExistsFailure & { etag: string }> & {
		received?: unknown;
		counted?: unknown;
	};
	const raw = body?.code ?? reply.code ?? undefined;
	const code = isCode(raw) ? raw : "failed";
	const sentence =
		typeof body?.error === "string" && body.error
			? body.error
			: reply.status
				? `HTTP ${reply.status}`
				: "The connection failed";
	const counted = body?.counted as { files?: unknown; bytes?: unknown } | undefined;
	return new TransferError(sentence, code, reply.status, {
		limit: typeof body?.limit === "number" ? body.limit : undefined,
		etag: typeof body?.etag === "string" ? body.etag : undefined,
		existing: isExisting(body?.existing) ? body.existing : undefined,
		suggestion: typeof body?.suggestion === "string" ? body.suggestion : undefined,
		received: typeof body?.received === "number" ? body.received : undefined,
		counted:
			typeof counted?.files === "number" && typeof counted.bytes === "number"
				? { files: counted.files, bytes: counted.bytes }
				: undefined,
		retryAfterMs: reply.retryAfterMs,
	});
}

const enc = encodeURIComponent;

function scopeParts(scope: FolderScope): string[] {
	const parts: string[] = [];
	if (scope.live) parts.push(`live=${enc(scope.live)}`);
	if (scope.file) parts.push(`file=${enc(scope.file)}`);
	return parts;
}

/** Where a file's bytes are (`path` is relative to the conversation's folder). */
export function downloadUrl(scope: FolderScope, path: string): string {
	return `/api/folder/download?${[...scopeParts(scope), `path=${enc(path)}`].join("&")}`;
}

/** What goes in the address of one piece of an upload. */
export interface PieceParams {
	/** The folder it goes to, relative to the conversation's folder ("" is that folder itself). */
	dir: string;
	name: string;
	/** The whole file's size, whichever piece this is. */
	size: number;
	id?: string;
	offset?: number;
	exists?: "keep";
	replace?: string;
}

export function uploadUrl(scope: FolderScope, p: PieceParams): string {
	const parts = [...scopeParts(scope), `dir=${enc(p.dir)}`, `name=${enc(p.name)}`, `size=${p.size}`];
	if (p.id !== undefined) parts.push(`id=${enc(p.id)}`, `offset=${p.offset ?? 0}`);
	if (p.exists) parts.push("exists=keep");
	if (p.replace !== undefined) parts.push(`replace=${enc(p.replace)}`);
	return `/api/folder/upload?${parts.join("&")}`;
}

export const stateUrl = (id: string): string => `/api/folder/upload/state?id=${enc(id)}`;

/** Read an answer: its status, text and the headers the page looks at. */
async function replyOf(res: Response): Promise<Reply> {
	return {
		status: res.status,
		text: await res.text().catch(() => ""),
		code: res.headers.get(ERROR_HEADER),
		retryAfterMs: retryAfterMs(res.headers.get("retry-after")),
	};
}

const networkFailure = (): TransferError => new TransferError("The connection failed", "failed", 0);

/**
 * Ask whether a file can be downloaded before it is: a download is started as a link the browser follows, and the page
 * cannot see how that ended (a refusal would be a page of JSON where the file should be). The refusal's code is in the
 * answer's `ERROR_HEADER`, a `HEAD` having no body. Throws a `TransferError` when it is refused.
 */
export async function statDownload(scope: FolderScope, path: string, signal?: AbortSignal): Promise<void> {
	let res: Response;
	try {
		// The server asks the header of everything that is not a GET (a HEAD included).
		res = await fetch(downloadUrl(scope, path), { method: "HEAD", headers: { [CSRF_HEADER]: "1" }, signal });
	} catch (e) {
		if (isAbort(e)) throw e;
		throw networkFailure();
	}
	if (!res.ok) throw failureOf({ status: res.status, text: "", code: res.headers.get(ERROR_HEADER), retryAfterMs: 0 });
}

/**
 * Hand an address to the browser to save: a link with `download`, clicked. The macOS app's window turns this into its
 * own save panel (a `fetch` and a `Blob` would hold the whole file in memory and give it no panel at all).
 */
export function startSave(url: string, name: string): void {
	const link = document.createElement("a");
	link.href = url;
	link.download = name;
	link.rel = "noopener";
	link.style.display = "none";
	document.body.append(link);
	link.click();
	link.remove();
}

/** Download one file: check that it may be, then start it. */
export async function downloadFile(scope: FolderScope, path: string): Promise<void> {
	await statDownload(scope, path);
	startSave(downloadUrl(scope, path), baseName(path));
}

/**
 * What a folder's ZIP will hold, and the ticket to ask for it with. `hidden` asks for what is hidden by default too (the
 * answer says whether it was given: `ArchivePlan.hidden`). Throws a `TransferError`: `tooLarge` or `tooMany` carry what was
 * counted, `notFolder` says the path is a file.
 */
export async function planArchive(
	scope: FolderScope,
	path: string,
	hidden: boolean,
	signal?: AbortSignal,
): Promise<ArchivePlan> {
	const body: ArchiveRequest = {
		...(scope.live ? { live: scope.live } : {}),
		...(scope.file ? { file: scope.file } : {}),
		path,
		...(hidden ? { hidden: true } : {}),
	};
	let res: Response;
	try {
		res = await fetch("/api/folder/archive", {
			method: "POST",
			headers: { "content-type": "application/json", [CSRF_HEADER]: "1" },
			body: JSON.stringify(body),
			signal,
		});
	} catch (e) {
		if (isAbort(e)) throw e;
		throw networkFailure();
	}
	const reply = await replyOf(res);
	if (!res.ok) throw failureOf(reply);
	const plan = parseJson(reply.text) as unknown as ArchivePlan | null;
	if (!plan || typeof plan.url !== "string" || typeof plan.name !== "string") throw failureOf({ ...reply, status: 0 });
	return plan;
}

/** How the pieces of an upload reach the server: the page's own is `browserTransport`; a test brings one of its own. */
export interface Transport {
	piece(
		scope: FolderScope,
		params: PieceParams,
		body: Blob,
		signal: AbortSignal,
		onBytes: (sent: number) => void,
	): Promise<Reply>;
	state(id: string, signal: AbortSignal): Promise<Reply>;
	cancel(id: string): Promise<void>;
}

/** One piece, as an `XMLHttpRequest` (`fetch` reports no progress of what it sends). A failure to connect is an answer of status 0. */
function sendPiece(
	scope: FolderScope,
	params: PieceParams,
	body: Blob,
	signal: AbortSignal,
	onBytes: (sent: number) => void,
): Promise<Reply> {
	const { promise, resolve, reject } = Promise.withResolvers<Reply>();
	if (signal.aborted) {
		reject(abortError());
		return promise;
	}
	const request = new XMLHttpRequest();
	const stop = () => request.abort();
	const finish = () => signal.removeEventListener("abort", stop);
	request.open("POST", uploadUrl(scope, params));
	request.setRequestHeader(CSRF_HEADER, "1");
	request.setRequestHeader("content-type", "application/octet-stream");
	request.upload.onprogress = (e) => onBytes(e.loaded);
	request.onload = () => {
		finish();
		resolve({
			status: request.status,
			text: request.responseText,
			code: request.getResponseHeader(ERROR_HEADER),
			retryAfterMs: retryAfterMs(request.getResponseHeader("retry-after")),
		});
	};
	request.onerror = () => {
		finish();
		resolve({ status: 0, text: "", code: null, retryAfterMs: 0 });
	};
	request.onabort = () => {
		finish();
		reject(abortError());
	};
	signal.addEventListener("abort", stop, { once: true });
	request.send(body);
	return promise;
}

export const browserTransport: Transport = {
	piece: sendPiece,
	async state(id, signal) {
		try {
			return await replyOf(await fetch(stateUrl(id), { signal }));
		} catch (e) {
			if (isAbort(e)) throw e;
			return { status: 0, text: "", code: null, retryAfterMs: 0 };
		}
	},
	async cancel(id) {
		await fetch("/api/folder/upload/cancel", {
			method: "POST",
			headers: { "content-type": "application/json", [CSRF_HEADER]: "1" },
			body: JSON.stringify({ id }),
		}).catch(() => {});
	},
};

/** Wait `ms`, or until `signal` stops it (which throws). */
export function waitFor(ms: number, signal: AbortSignal): Promise<void> {
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	if (signal.aborted) {
		reject(abortError());
		return promise;
	}
	const timer = setTimeout(() => {
		signal.removeEventListener("abort", stopped);
		resolve();
	}, ms);
	const stopped = () => {
		clearTimeout(timer);
		reject(abortError());
	};
	signal.addEventListener("abort", stopped, { once: true });
	return promise;
}

/** A file to send: what the page holds of it, and where it goes. */
export interface UploadItem {
	file: Blob;
	/** The folder it goes to, relative to the conversation's folder. */
	dir: string;
	name: string;
	size: number;
}

export interface UploadOptions {
	signal: AbortSignal;
	/** Bytes of the file sent so far (not counting what the server could still lose). */
	onProgress?: (sent: number) => void;
	/** Save under a free name when one by this name is there. */
	exists?: "keep";
	/** Replace the file there, if it is still the one with this etag. */
	replace?: string;
	sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

const isSaved = (v: Record<string, unknown> | null): v is Record<string, unknown> & UploadSaved =>
	v !== null && v.done === true && typeof v.path === "string" && typeof v.name === "string";

const isProgress = (v: Record<string, unknown> | null): v is Record<string, unknown> & UploadProgress =>
	v !== null && typeof v.id === "string" && typeof v.received === "number";

/**
 * Upload one file: a file of at most one piece is one request; a bigger one is sent a piece at a time, the first answered
 * with where the upload is (202) and the last with where the file is (200). A piece that fails (no answer, 408, 429, 5xx) is
 * sent again after asking where the upload stands, five tries in all; an upload the server lost (`gone`) begins again from
 * the start, once. `signal` stops it, and the server is told to throw away what arrived. Resolves to where it was saved;
 * throws `TransferError` (`exists` carries what is there) or an `AbortError`.
 */
export async function uploadOne(
	scope: FolderScope,
	item: UploadItem,
	options: UploadOptions,
	transport: Transport = browserTransport,
): Promise<UploadSaved> {
	const { signal } = options;
	const sleep = options.sleep ?? waitFor;
	let id: string | undefined;
	let received = 0;
	let restarted = false;
	let failures = 0;
	const settle = (e: unknown): never => {
		if (isAbort(e) && id !== undefined) void transport.cancel(id);
		throw e;
	};
	for (;;) {
		if (signal.aborted) return settle(abortError());
		const { offset, end } = nextPiece(received, item.size);
		const params: PieceParams = {
			dir: item.dir,
			name: item.name,
			size: item.size,
			...(id === undefined ? {} : { id, offset }),
			...(options.exists ? { exists: options.exists } : {}),
			...(options.replace === undefined ? {} : { replace: options.replace }),
		};
		let reply: Reply;
		try {
			reply = await transport.piece(scope, params, item.file.slice(offset, end), signal, (n) =>
				options.onProgress?.(Math.min(item.size, offset + n)),
			);
		} catch (e) {
			return settle(e);
		}
		const body = parseJson(reply.text);
		if (reply.status === 200 && isSaved(body)) {
			options.onProgress?.(item.size);
			return body;
		}
		if (reply.status === 202 && isProgress(body)) {
			id = body.id;
			received = body.received;
			failures = 0;
			options.onProgress?.(Math.min(item.size, received));
			continue;
		}
		const failure = failureOf(reply);
		if (failure.code === "gone" && id !== undefined) {
			if (restarted) throw failure;
			restarted = true;
			id = undefined;
			received = 0;
			failures = 0;
			options.onProgress?.(0);
			continue;
		}
		if (failure.code === "offset" && id !== undefined && failure.received !== undefined) {
			// The server holds more or less than the page thought: go on from where it says.
			if (++failures >= MAX_TRIES) throw failure;
			received = Math.min(item.size, failure.received);
			continue;
		}
		if (!isRetryable(reply.status) || ++failures >= MAX_TRIES) throw failure;
		try {
			await sleep(backoffMs(failures, failure.retryAfterMs), signal);
		} catch (e) {
			return settle(e);
		}
		if (id === undefined) continue;
		// Where does the upload stand now? A piece that was lost may have arrived.
		let state: Reply;
		try {
			state = await transport.state(id, signal);
		} catch (e) {
			return settle(e);
		}
		const progress = state.status === 200 ? parseJson(state.text) : null;
		if (isProgress(progress)) {
			received = Math.min(item.size, progress.received);
			continue;
		}
		const lost = failureOf(state);
		if (lost.code === "gone") {
			if (restarted) throw lost;
			restarted = true;
			id = undefined;
			received = 0;
			failures = 0;
			options.onProgress?.(0);
		}
		// Any other answer: the same piece is sent again from where the page thought it was.
	}
}

/** How a row of an upload stands. `held`: a file by that name is there, and nothing was written; it waits for the batch to be done. */
export type RowState = "waiting" | "sending" | "held" | "done" | "failed" | "skipped" | "cancelled";

export interface RowError {
	code: TransferCode | "failed";
	message: string;
	status: number;
	limit?: number;
}

/** One file of an upload, as the list shows it. */
export interface UploadRow extends UploadItem {
	key: number;
	state: RowState;
	sent: number;
	saved?: UploadSaved;
	error?: RowError;
	conflict?: Conflict["failure"];
}

export interface BatchItem {
	file: Blob;
	dir: string;
	name: string;
	size: number;
}

const errorOf = (e: TransferError): RowError => ({
	code: e.code,
	message: e.message,
	status: e.status,
	...(e.limit === undefined ? {} : { limit: e.limit }),
});

/** How often the list is told of progress (every other change is told at once). */
const PROGRESS_MS = 120;

export interface BatchOptions {
	transport?: Transport;
	/** How many files are sent at a time. */
	concurrency?: number;
	sleep?: UploadOptions["sleep"];
}

/**
 * The files of an upload, sent three at a time. A file whose name is taken is `held` until the others are done, and the
 * person answers once for all of them (`resolve`): both are kept, they are replaced, or they are left out. More files can
 * be added while it runs. Rows are the batch's own; `onChange` gets a copy of them as they change.
 */
export class UploadBatch {
	readonly rows: UploadRow[] = [];
	/** Set when the batch was stopped by a refusal that holds for all of it (the setting changed meanwhile). */
	halted: RowError | null = null;
	private readonly controllers = new Map<number, AbortController>();
	private readonly modes = new Map<number, Resend>();
	private readonly queue: UploadRow[] = [];
	private readonly waiters: (() => void)[] = [];
	private readonly transport: Transport;
	private readonly concurrency: number;
	private readonly sleep: UploadOptions["sleep"];
	private active = 0;
	private stopped = false;
	private nextKey = 0;
	private timer: ReturnType<typeof setTimeout> | undefined;
	private last = 0;

	constructor(
		readonly scope: FolderScope,
		private readonly onChange: (rows: UploadRow[]) => void,
		options: BatchOptions = {},
	) {
		this.transport = options.transport ?? browserTransport;
		this.concurrency = options.concurrency ?? 3;
		this.sleep = options.sleep;
	}

	snapshot(): UploadRow[] {
		return this.rows.map((row) => ({ ...row }));
	}

	private notify(now: boolean): void {
		const at = Date.now();
		if (!now && at - this.last < PROGRESS_MS) {
			this.timer ??= setTimeout(() => {
				this.timer = undefined;
				this.notify(true);
			}, PROGRESS_MS);
			return;
		}
		clearTimeout(this.timer);
		this.timer = undefined;
		this.last = at;
		this.onChange(this.snapshot());
	}

	/** Whether any file is being sent or waits for its turn. */
	get busy(): boolean {
		return this.active > 0 || this.queue.length > 0;
	}

	/** Send these files too. Resolves when everything of the batch is settled (sent, failed, held, left out or cancelled). */
	add(items: readonly BatchItem[]): Promise<void> {
		if (!this.busy) {
			this.stopped = false;
			this.halted = null;
		}
		const rows = items.map((item): UploadRow => ({ ...item, key: this.nextKey++, state: "waiting", sent: 0 }));
		this.rows.push(...rows);
		this.queue.push(...rows);
		this.notify(true);
		this.pump();
		return this.idle();
	}

	/** The files held back by one that is there already. */
	held(): Conflict[] {
		return this.rows.flatMap((r) => (r.state === "held" && r.conflict ? [{ key: r.key, failure: r.conflict }] : []));
	}

	/** Do what the person chose with the held files, and send those that are to be sent. */
	resolve(choice: Resolution): Promise<void> {
		if (!this.busy) this.stopped = false;
		const plan = conflictPlan(this.held(), choice);
		const row = (key: number) => this.rows.find((r) => r.key === key);
		for (const key of plan.skipped) {
			const r = row(key);
			if (r) r.state = "skipped";
		}
		for (const key of plan.refused) {
			const r = row(key);
			if (!r) continue;
			r.state = "failed";
			r.error = { code: "exists", message: "A file by that name is there, and it cannot be replaced", status: 409 };
		}
		for (const m of plan.resend) {
			const r = row(m.key);
			if (!r) continue;
			r.state = "waiting";
			r.sent = 0;
			r.conflict = undefined;
			this.modes.set(m.key, m);
			this.queue.push(r);
		}
		this.notify(true);
		this.pump();
		return this.idle();
	}

	/** Stop one file (by its key), or all of them. What had arrived is thrown away by the server. */
	cancel(key?: number): void {
		if (key === undefined) {
			this.stopped = true;
			for (const r of this.rows) if (r.state === "waiting" || r.state === "held") r.state = "cancelled";
			for (const c of this.controllers.values()) c.abort();
			this.notify(true);
			this.pump();
			return;
		}
		const r = this.rows.find((x) => x.key === key);
		if (!r) return;
		if (r.state === "waiting" || r.state === "held") {
			r.state = "cancelled";
			this.notify(true);
		} else this.controllers.get(key)?.abort();
	}

	private idle(): Promise<void> {
		if (!this.busy) return Promise.resolve();
		const { promise, resolve } = Promise.withResolvers<void>();
		this.waiters.push(resolve);
		return promise;
	}

	/** Start files until as many are being sent as there may be; and tell those who wait when nothing is left to do. */
	private pump(): void {
		while (!this.stopped && this.active < this.concurrency) {
			const row = this.queue.shift();
			if (!row) break;
			// One that was cancelled while it waited is no work.
			if (row.state !== "waiting") continue;
			this.active++;
			void this.one(row).finally(() => {
				this.active--;
				this.pump();
			});
		}
		if (this.stopped) {
			for (const row of this.queue.splice(0)) if (row.state === "waiting") row.state = "cancelled";
			this.notify(true);
		}
		if (!this.busy) for (const wake of this.waiters.splice(0)) wake();
	}

	private async one(row: UploadRow): Promise<void> {
		const mode = this.modes.get(row.key);
		this.modes.delete(row.key);
		const control = new AbortController();
		this.controllers.set(row.key, control);
		row.state = "sending";
		row.sent = 0;
		this.notify(true);
		try {
			row.saved = await uploadOne(
				this.scope,
				row,
				{
					signal: control.signal,
					onProgress: (sent) => {
						row.sent = sent;
						this.notify(false);
					},
					...(mode && "exists" in mode ? { exists: mode.exists } : {}),
					...(mode && "replace" in mode ? { replace: mode.replace } : {}),
					sleep: this.sleep,
				},
				this.transport,
			);
			row.state = "done";
			row.sent = row.size;
		} catch (e) {
			if (isAbort(e)) row.state = "cancelled";
			else if (e instanceof TransferError) {
				if (e.code === "exists" && e.existing && !mode) {
					row.state = "held";
					row.conflict = { suggestion: e.suggestion ?? "", existing: e.existing };
				} else if (e.code === "changed" && mode && "replace" in mode) {
					row.state = "skipped";
					row.error = errorOf(e);
				} else {
					row.state = "failed";
					row.error = errorOf(e);
				}
				// The setting was turned down since the page was told: nothing else of this batch is sent.
				if (e.code === "off" || e.code === "uploadOff") {
					this.halted = errorOf(e);
					this.stopped = true;
					for (const c of this.controllers.values()) c.abort();
				}
			} else {
				row.state = "failed";
				row.error = { code: "failed", message: e instanceof Error ? e.message : String(e), status: 0 };
			}
		} finally {
			this.controllers.delete(row.key);
			this.notify(true);
		}
	}
}
