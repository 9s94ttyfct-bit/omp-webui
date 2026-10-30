import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { isProtectedPath } from "../shared/remote-risk.ts";
import {
	ERROR_HEADER,
	type FileTransfer,
	TRANSFER_LIMITS,
	type TransferCode,
	type TransferFailure,
	type TransferKind,
} from "../shared/transfer.ts";
import { FolderError, inside, isSecretLooking, partsOf, type Resolved, resolveFor, rootOf } from "./folder.ts";
import type { TransferLog } from "./transfer-log.ts";

/**
 * What the file transfer of `/api/folder/*` (download, ZIP, upload: `folder-transfer.ts`) shares: the failure every route
 * answers with, the settings of the request that decides what it may do, the folder of a conversation as the transfer sees it,
 * and the few rules that every route asks of a path (a secret, a place nothing is carried out of or into unasked).
 */

/** A failure that is answered as `{ error, code, ... }` with `status`, and in the `ERROR_HEADER` header too. */
export class TransferError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly code: TransferCode,
		readonly extra: Record<string, unknown> = {},
		readonly headers: Record<string, string> = {},
	) {
		super(message);
	}
}

/** What the request is, as `main.ts` knows it: who asked, from where, and what this computer allows that page. */
export interface TransferEnv {
	/** What this page may do with files: `full` for a page on this computer, the person's setting for any other. */
	setting: FileTransfer;
	/** The page is on this computer (see `isThisComputer`). */
	local: boolean;
	/** Who asked, for the log and for what belongs to one asker: the Access email, `local`, or `net:<address>`. */
	who: string;
	/** When the Access session of a remote page ends (ms since the epoch): a transfer does not outlive it. */
	validUntil?: number;
	/** Every folder an omp-webui keeps its own data in: nothing is written into one. */
	dataDirs: readonly string[];
	/** The places nothing is changed or carried out of unasked besides the built-in ones (the data folders, omp's agent folder). */
	protect: readonly string[];
	/** The home folder of the person the server runs as. */
	home: string;
}

/** What the transfer asks of the server about a conversation. */
export interface TransferContext {
	/** The folder the conversation the request names works in; null when it names none the server knows. */
	cwdOf(live: string | null, file: string | null): Promise<string | null>;
}

/** The limits in force: `TRANSFER_LIMITS`, and the few more the server alone knows (tests use small ones). */
export interface Limits extends Record<keyof typeof TRANSFER_LIMITS, number> {
	/** How long a body may take to send its next piece before the upload is given up, in ms. */
	stallMs: number;
	/** Free disk space an upload leaves: the larger of `reserveBytes` and `reservePercent` of the disk. */
	reserveBytes: number;
	reservePercent: number;
	/** Bytes of uploads that are begun and not finished, across the server. */
	inFlightBytes: number;
	/** Entries (files and folders) a ZIP's walk looks at before it gives up. */
	archiveWalk: number;
	/** The most pieces of one chunk size a response of the transfer reads at once. */
	chunkBytes: number;
}

const GiB = 1024 * 1024 * 1024;

export const DEFAULT_LIMITS: Limits = {
	...TRANSFER_LIMITS,
	stallMs: 30_000,
	reserveBytes: GiB,
	reservePercent: 5,
	inFlightBytes: 4 * GiB,
	archiveWalk: 200_000,
	chunkBytes: 512 * 1024,
};

/** The codes that are the person's rule saying no (not a mistake of the request): refusals the log keeps. */
export const POLICY_CODES: readonly TransferCode[] = [
	"off",
	"uploadOff",
	"outside",
	"secret",
	"hidden",
	"protected",
	"homeFolder",
	"ownData",
	"refused",
];

/** The answer to a failed request: the body is JSON, and the code is in a header too (a `HEAD` answer has no body). */
export function failure(e: TransferError, head = false): Response {
	const body: TransferFailure & Record<string, unknown> = { error: e.message, code: e.code, ...e.extra };
	const headers: Record<string, string> = {
		"content-type": "application/json",
		"cache-control": "no-store",
		[ERROR_HEADER]: e.code,
		...e.headers,
	};
	return new Response(head ? null : JSON.stringify(body), { status: e.status, headers });
}

export const json = (data: unknown, status = 200, headers: Record<string, string> = {}): Response =>
	new Response(JSON.stringify(data), {
		status,
		headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
	});

/** What the folder code said, as the code the page words. */
export function fromFolder(e: FolderError): TransferError {
	switch (e.status) {
		case 400:
			return new TransferError(e.message, 400, "badRequest");
		case 404:
			return new TransferError(e.message, 404, "notFound");
		case 415:
			return new TransferError(e.message, 415, "notFile");
		case 403:
			if (/secret/i.test(e.message)) return new TransferError(e.message, 403, "secret");
			if (/hidden/i.test(e.message)) return new TransferError(e.message, 403, "hidden");
			if (/permission/i.test(e.message)) return new TransferError(e.message, 403, "refused");
			return new TransferError(e.message, 403, "outside");
		default:
			return new TransferError(e.message, 500, "write");
	}
}

/** Run `job`, a read of the folder code: its refusals are `TransferError`s. */
export async function viaFolder<T>(job: () => Promise<T>): Promise<T> {
	try {
		return await job();
	} catch (e) {
		if (e instanceof FolderError) throw fromFolder(e);
		throw e;
	}
}

/** A page may download when this computer lets it (a page on this computer always may). */
export function requireDownload(env: TransferEnv): void {
	if (!env.local && env.setting === "off")
		throw new TransferError("Sending files is switched off on this computer", 403, "off");
}

/** A page may upload when this computer lets it (a page on this computer always may). */
export function requireUpload(env: TransferEnv): void {
	if (env.local || env.setting === "full") return;
	throw new TransferError(
		env.setting === "off"
			? "Receiving files is switched off on this computer"
			: "Receiving files is not allowed on this computer",
		403,
		env.setting === "off" ? "off" : "uploadOff",
	);
}

/** The real folder of the conversation the request names: 404 when it names none, or its folder is gone. */
export async function conversationRoot(
	ctx: TransferContext,
	live: string | null,
	file: string | null,
): Promise<string> {
	const cwd = await ctx.cwdOf(live, file);
	if (!cwd) throw new TransferError("Unknown conversation", 404, "notFound");
	return viaFolder(() => rootOf(cwd));
}

const homes = new Map<string, string>();

/** The real path of the home folder (a home named through a link is compared as what it is). */
export function realHome(home: string): string {
	let real = homes.get(home);
	if (real === undefined) {
		try {
			real = realpathSync(home);
		} catch {
			real = home;
		}
		homes.set(home, real);
	}
	return real;
}

/** Whether the conversation's folder is the home folder or holds it: a page there is shown what the Files tab shows, and no more. */
export const holdsHome = (root: string, env: TransferEnv): boolean => inside(root, realHome(env.home));

/** Where CI runs what it finds on a push: the Files tab lists it, a page never writes below it (an upload, nor a save). */
export function startsPrograms(parts: readonly string[]): boolean {
	const [first, second] = parts.map((p) => p.toLowerCase());
	return first === ".github" && (second === "workflows" || second === "actions");
}

/** Whether `abs` (a real path) is a place nothing is carried out of or into unasked. */
export const isProtected = (abs: string, env: TransferEnv): boolean =>
	isProtectedPath(abs, { home: realHome(env.home), protect: env.protect });

/**
 * What a page that is not this computer's may read by its path: what the Files tab shows it, with one difference, the person's
 * decision (#614): dependency and build folders and dotfiles are for download (`dist/`, `node_modules`, `.github`), except in
 * a conversation whose folder is the home folder, where the Files tab's own rule holds as it is. What looks like a secret
 * (by its name, whatever a link calls it) and what is in a protected place is refused to such a page whatever its name.
 * A page on this computer is shown what the Files tab shows it.
 */
export async function resolveDownload(root: string, rel: unknown, env: TransferEnv, home: boolean): Promise<Resolved> {
	const file = await viaFolder(() => resolveFor(root, rel, !env.local && home));
	if (env.local) return file;
	if (isSecretLooking(relative(root, file.abs)) || isSecretLooking(viaFolderSync(() => partsOf(rel)).join("/")))
		throw new TransferError(
			"This looks like a secret: it is not sent to a page that is not on this computer",
			403,
			"secret",
		);
	if (isProtected(file.abs, env))
		throw new TransferError("This is a place nothing is carried out of unasked", 403, "protected");
	return file;
}

function viaFolderSync<T>(job: () => T): T {
	try {
		return job();
	} catch (e) {
		if (e instanceof FolderError) throw fromFolder(e);
		throw e;
	}
}

/** The etag of a file: its size, change time and inode (a different file, or the same one changed, is another etag). */
export const etagOf = (st: { size: number | bigint; mtimeMs: number | bigint; ino: number | bigint }): string =>
	`${st.size}-${Math.floor(Number(st.mtimeMs))}-${st.ino}`;

/**
 * A count of what is going on, by who asked and in all: a transfer that would pass either limit is turned away (429) until
 * another ends. `take` answers the way to give the place back (once), or null when there is none.
 */
export class Gate {
	#total = 0;
	readonly #by = new Map<string, number>();

	constructor(
		readonly perWho: number,
		readonly total: number,
	) {}

	take(who: string): (() => void) | null {
		const mine = this.#by.get(who) ?? 0;
		if (mine >= this.perWho || this.#total >= this.total) return null;
		this.#by.set(who, mine + 1);
		this.#total++;
		let given = false;
		return () => {
			if (given) return;
			given = true;
			this.#total--;
			const left = (this.#by.get(who) ?? 1) - 1;
			if (left <= 0) this.#by.delete(who);
			else this.#by.set(who, left);
		};
	}
}

/** The answer when a gate is full. */
export const busy = (): TransferError =>
	new TransferError("Too many transfers at once: try again in a moment", 429, "busy", {}, { "retry-after": "2" });

/** What the log is told of one request: set as it goes along, written when the transfer ends or is refused. */
export interface Trace {
	kind: TransferKind;
	/** The conversation's folder (its real path), once known. */
	root: string;
	/** The file or folder asked for, relative to it. */
	path: string;
	started: number;
}

/** One line of the log for `trace`. */
export function record(
	log: TransferLog,
	env: TransferEnv,
	trace: Trace,
	status: string,
	more: { size?: number; files?: number; sha256?: string } = {},
): void {
	log.append({
		t: new Date().toISOString(),
		kind: trace.kind,
		who: env.who,
		root: trace.root,
		path: trace.path,
		...more,
		status,
		ms: Date.now() - trace.started,
	});
}
