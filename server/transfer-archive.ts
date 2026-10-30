import { randomBytes } from "node:crypto";
import type { Dirent } from "node:fs";
import { lstat, readdir, realpath, stat } from "node:fs/promises";
import { basename, join, relative, sep } from "node:path";
import { isRecord } from "../shared/guards.ts";
import type { ArchivePlan, ArchiveSkipped } from "../shared/transfer.ts";
import { hiddenByDefault } from "./files.ts";
import {
	FolderError,
	holdsPrivateKey,
	inside,
	isSecretLooking,
	type OpenHooks,
	openRegular,
	resolveInside,
	throughHidden,
} from "./folder.ts";
import { type ZipSink, ZipWriter } from "./migrate/zip.ts";
import {
	busy,
	conversationRoot,
	type Gate,
	holdsHome,
	isProtected,
	type Limits,
	requireDownload,
	resolveDownload,
	type Trace,
	type TransferContext,
	type TransferEnv,
	TransferError,
} from "./transfer-core.ts";
import { attachmentHeaders } from "./transfer-download.ts";

/**
 * A folder of the conversation as a ZIP, in two steps. `POST /api/folder/archive` walks the folder and answers what the ZIP
 * will hold (files, bytes, and what is left out and why: `ArchivePlan`), with a ticket; `GET /api/folder/archive/<ticket>`
 * streams it, once. A walk is a plan and not a licence: each file is resolved and opened again at its turn, by the rules of
 * the plan (a link put in the way since is refused, a file that is gone is skipped, one that cannot be read through is an
 * abort of the whole answer, never a ZIP that says it is whole and is not).
 *
 * What is left out always: what looks like a secret (by name, or a private key in its text) and what is in a protected place,
 * links to folders, links that lead out of the folder, sockets and pipes, and names a ZIP cannot hold. What is left out unless
 * the page asks for it (and the conversation's folder is not the home folder): dotfiles and dependency and build folders
 * *below* the folder asked for (the folder itself may be `dist` or `node_modules`).
 */

/** A file of the plan. */
interface PlanEntry {
	/** Relative to the folder the ZIP is of, written with `/`. */
	rel: string;
	size: number;
}

/** What a ticket stands for: the walk, and whom and what it is bound to. */
interface Ticket {
	id: string;
	who: string;
	root: string;
	/** The folder, as a real path and relative to the conversation's folder (empty for that folder itself). */
	folderAbs: string;
	folderRel: string;
	/** The name of the folder in the ZIP (every entry is `<top>/<rel>`). */
	top: string;
	name: string;
	hidden: boolean;
	home: boolean;
	entries: PlanEntry[];
	files: number;
	bytes: number;
	expires: number;
}

/** The tickets there are: 128 random bits each, good for one answer, for the one who asked, until they expire. */
export class TicketStore {
	readonly #tickets = new Map<string, Ticket>();

	constructor(
		private readonly now: () => number,
		private readonly perWho = 8,
		private readonly total = 64,
	) {}

	#prune(): void {
		const now = this.now();
		for (const [id, t] of this.#tickets) if (t.expires <= now) this.#tickets.delete(id);
	}

	/** Whether `who` may have one more ticket: `busy` when they or the server have as many as there may be. */
	room(who: string): void {
		this.#prune();
		let mine = 0;
		for (const other of this.#tickets.values()) if (other.who === who) mine++;
		if (mine >= this.perWho || this.#tickets.size >= this.total) throw busy();
	}

	add(t: Ticket): void {
		this.room(t.who);
		this.#tickets.set(t.id, t);
	}

	/** The ticket, taken out: the one it was made for gets it once; anybody else, or a second time, gets none. */
	take(id: string, who: string): Ticket | null {
		this.#prune();
		const t = this.#tickets.get(id);
		if (!t || t.who !== who) return null;
		this.#tickets.delete(id);
		return t;
	}

	get size(): number {
		this.#prune();
		return this.#tickets.size;
	}
}

export interface ArchiveDeps {
	tickets: TicketStore;
	/** Holds a place for each walk that makes a plan (a walk looks at up to `archiveWalk` entries). */
	plans: Gate;
	gate: Gate;
	limits: Limits;
	now: () => number;
	hooks?: OpenHooks;
	/** Called when an answer ends (the log writes its line). */
	ended: (trace: Trace, env: TransferEnv, status: string, files: number, bytes: number) => void;
}

/** Characters a ZIP entry does not carry: control and invisible ones, direction overrides, and the backslash. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is looked for.
const NOT_IN_ENTRY = /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\\]/;

/** Whether `name` (written with `/`) can be an entry of the ZIP: what the writer takes, and no name that shows other than it is. */
export function zipNameOk(name: string): boolean {
	if (name === "" || name.startsWith("/") || name.endsWith("/") || NOT_IN_ENTRY.test(name)) return false;
	const raw = Buffer.from(name, "utf8");
	return raw.toString("utf8") === name && raw.length <= 0xffff && !name.split("/").includes("..");
}

/** Extensions of what is compressed already: stored as it is, not deflated again. */
const STORED = new Set(
	"zip gz tgz bz2 xz zst 7z rar jar jpg jpeg png gif webp avif heic mp3 mp4 m4a m4v mov mkv webm aac ogg flac woff2 pdf".split(
		" ",
	),
);
const storedName = (name: string): boolean => STORED.has(name.slice(name.lastIndexOf(".") + 1).toLowerCase());

/** The part of a link's target below `folderAbs` (the folder the ZIP is of), or below `root` when it is outside it, is hidden by default. */
function hiddenBelow(root: string, folderAbs: string, real: string): boolean {
	const from = inside(folderAbs, real) ? folderAbs : root;
	return throughHidden(from, relative(from, real).split(sep).filter(Boolean), false);
}

const slashed = (path: string): string => (sep === "/" ? path : path.split(sep).join("/"));

/** What the walk of a folder found. */
interface Walked {
	entries: PlanEntry[];
	skipped: ArchiveSkipped;
	files: number;
	bytes: number;
}

async function walk(
	t: Pick<Ticket, "root" | "folderAbs" | "hidden">,
	env: TransferEnv,
	limits: Limits,
): Promise<Walked> {
	const skipped: ArchiveSkipped = { secret: 0, links: 0, special: 0, name: 0, hidden: 0 };
	const entries: PlanEntry[] = [];
	let files = 0;
	let bytes = 0;
	let examined = 0;
	const over = (code: "tooLarge" | "tooMany", limit: number) =>
		new TransferError(
			code === "tooMany" ? "That folder holds too many files for a ZIP" : "That folder is too large for a ZIP",
			413,
			code,
			{ counted: { files, bytes }, limit },
		);
	const stack: { abs: string; rel: string }[] = [{ abs: t.folderAbs, rel: "" }];
	for (let at = stack.pop(); at !== undefined; at = stack.pop()) {
		let listed: Dirent[];
		try {
			listed = await readdir(at.abs, { withFileTypes: true });
		} catch {
			skipped.special++;
			continue;
		}
		listed.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
		for (const d of listed) {
			if (++examined > limits.archiveWalk) throw over("tooMany", limits.archiveWalk);
			const rel = at.rel ? `${at.rel}/${d.name}` : d.name;
			const abs = join(at.abs, d.name);
			if (!zipNameOk(rel)) {
				skipped.name++;
				continue;
			}
			if (isSecretLooking(slashed(relative(t.root, abs))) || isProtected(abs, env)) {
				skipped.secret++;
				continue;
			}
			const link = d.isSymbolicLink();
			let isDir = d.isDirectory();
			let isFile = d.isFile();
			if (!t.hidden && hiddenByDefault(d.name, isDir, abs)) {
				skipped.hidden++;
				continue;
			}
			let source = abs;
			if (link) {
				// A link to a file inside the folder is followed (as the Files tab does); to a folder, or out of it, never.
				const real = await realpath(abs).catch(() => null);
				const info = real === null ? null : await stat(real).catch(() => null);
				if (real === null || info === null || !inside(t.root, real) || info.isDirectory()) {
					skipped.links++;
					continue;
				}
				if (!info.isFile()) {
					skipped.special++;
					continue;
				}
				if (isSecretLooking(slashed(relative(t.root, real))) || isProtected(real, env)) {
					skipped.secret++;
					continue;
				}
				if (!t.hidden && hiddenBelow(t.root, t.folderAbs, real)) {
					skipped.hidden++;
					continue;
				}
				isDir = false;
				isFile = true;
				source = real;
			}
			if (isDir) {
				stack.push({ abs, rel });
			} else if (isFile) {
				const info = await lstat(source).catch(() => null);
				if (info === null) continue;
				entries.push({ rel, size: info.size });
				files++;
				bytes += info.size;
				if (files > limits.archiveFiles) throw over("tooMany", limits.archiveFiles);
				if (bytes > limits.archiveBytes) throw over("tooLarge", limits.archiveBytes);
			} else {
				skipped.special++;
			}
		}
	}
	return { entries, skipped, files, bytes };
}

/** A name for the ZIP from the name of the folder. */
function zipNamed(folderAbs: string, root: string): { top: string; name: string } {
	const raw = basename(folderAbs) || basename(root);
	const top = raw.replace(NOT_IN_ENTRY, "_").replace(/\//g, "_").trim() || "folder";
	return { top, name: `${top}.zip` };
}

/** The body of `POST /api/folder/archive`, read as what it asks. */
async function asked(
	req: Request,
): Promise<{ live: string | null; file: string | null; path: string; hidden: boolean }> {
	const body: unknown = await req.json().catch(() => null);
	if (!isRecord(body) || typeof body.path !== "string")
		throw new TransferError("Name the folder: { path }", 400, "badRequest");
	return {
		live: typeof body.live === "string" ? body.live : null,
		file: typeof body.file === "string" ? body.file : null,
		path: body.path,
		hidden: body.hidden === true,
	};
}

/** `POST /api/folder/archive`: what the ZIP of a folder would hold, and the ticket to ask for it with. */
export async function planArchive(
	req: Request,
	ctx: TransferContext,
	env: TransferEnv,
	trace: Trace,
	deps: ArchiveDeps,
): Promise<Response> {
	requireDownload(env);
	const body = await asked(req);
	const root = await conversationRoot(ctx, body.live, body.file);
	trace.root = root;
	trace.path = body.path.slice(0, 4096);
	const home = holdsHome(root, env);
	const folder = await resolveDownload(root, body.path, env, home);
	const info = await stat(folder.abs).catch(() => null);
	if (info === null) throw new TransferError("Not found", 404, "notFound");
	if (!info.isDirectory()) throw new TransferError("That is a file, not a folder", 400, "notFolder");
	const hiddenAllowed = !home;
	const hidden = body.hidden && hiddenAllowed;
	const t: Ticket = {
		id: randomBytes(16).toString("hex"),
		who: env.who,
		root,
		folderAbs: folder.abs,
		folderRel: folder.rel,
		...zipNamed(folder.abs, root),
		hidden,
		home,
		entries: [],
		files: 0,
		bytes: 0,
		expires: deps.now() + deps.limits.ticketMs,
	};
	// Room for the ticket is asked before the walk, not after it, and a walk holds a place for as long as it goes on.
	deps.tickets.room(env.who);
	const release = deps.plans.take(env.who);
	if (!release) throw busy();
	let found: Walked;
	try {
		found = await walk(t, env, deps.limits);
	} finally {
		release();
	}
	t.entries = found.entries;
	t.files = found.files;
	t.bytes = found.bytes;
	deps.tickets.add(t);
	const plan: ArchivePlan = {
		ticket: t.id,
		url: `/api/folder/archive/${t.id}`,
		name: t.name,
		files: found.files,
		bytes: found.bytes,
		skipped: found.skipped,
		expires: t.expires,
		hiddenAllowed,
		hidden,
	};
	return new Response(JSON.stringify(plan), {
		headers: { "content-type": "application/json", "cache-control": "no-store" },
	});
}

/** The file of `e` as the ZIP will carry it, opened again by the rules of the plan; null when it is not there any more or cannot be read. */
async function reopen(t: Ticket, e: PlanEntry, env: TransferEnv, hooks?: OpenHooks) {
	const below = t.folderRel ? `${t.folderRel}/${e.rel}` : e.rel;
	try {
		const real = (await resolveInside(t.root, below)).abs;
		if (isSecretLooking(slashed(relative(t.root, real))) || isProtected(real, env))
			throw new TransferError("This looks like a secret", 403, "secret");
		if (!t.hidden && hiddenBelow(t.root, t.folderAbs, real)) throw new TransferError("This is hidden", 403, "hidden");
		return await openRegular(real, hooks);
	} catch (err) {
		if (err instanceof FolderError && (err.status === 404 || err.message === "No permission")) return null;
		if (err instanceof FolderError) throw new TransferError(err.message, 403, "outside");
		throw err;
	}
}

/** What a file that is read whole is, at most. */
const WHOLE_BYTES = 1024 * 1024;

/** The ZIP of the ticket, as a stream: made as the client takes it, ended at `validUntil`, and aborted (never ended well) when something goes wrong. */
function archiveStream(
	t: Ticket,
	env: TransferEnv,
	trace: Trace,
	deps: ArchiveDeps,
	release: () => void,
): ReadableStream<Uint8Array> {
	let controller!: ReadableStreamDefaultController<Uint8Array>;
	let cancelled = false;
	let expired = false;
	let wake: (() => void) | null = null;
	const abort = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const stop = () => {
		abort.abort();
		wake?.();
	};
	const drained = async (): Promise<void> => {
		while (!cancelled && !expired && (controller.desiredSize ?? 1) <= 0) {
			const { promise, resolve } = Promise.withResolvers<void>();
			wake = resolve;
			await promise;
		}
	};
	// The ZIP is written to a sink that hands what it is given to the stream, and waits for the client to take it. Bytes that
	// were sent cannot be taken back: an entry that fails half way ends the answer (`truncate` refuses), it is not skipped.
	const sink: ZipSink = {
		async write(buf, offset, length) {
			if (cancelled || expired) throw new Error("The download was stopped");
			controller.enqueue(Buffer.from(buf.subarray(offset, offset + length)));
			await drained();
			return { bytesWritten: length };
		},
		async truncate() {
			throw new Error("A ZIP that is being sent cannot take back what it has sent");
		},
		async sync() {},
		async close() {},
	};
	let files = 0;
	let bytes = 0;
	const produce = async () => {
		const writer = ZipWriter.createOn(sink, "");
		try {
			for (const e of t.entries) {
				if (cancelled) break;
				if (expired) throw new Error("The Access session ended");
				const opened = await reopen(t, e, env, deps.hooks);
				if (opened === null) continue;
				const { handle } = opened;
				try {
					const info = await handle.stat();
					const name = `${t.top}/${e.rel}`;
					const options = {
						compress: !storedName(e.rel),
						level: 1,
						mtimeMs: info.mtimeMs,
						mode: info.mode & 0o777,
						signal: abort.signal,
					};
					if (info.size <= WHOLE_BYTES) {
						const whole = Buffer.alloc(info.size);
						const { bytesRead } = await handle.read(whole, 0, info.size, 0);
						const body = whole.subarray(0, bytesRead);
						// A key is a key whatever the file is called: a ZIP carries none.
						if (holdsPrivateKey(body.toString("utf8"))) continue;
						await writer.add(name, body, options);
						bytes += body.length;
					} else {
						const chunk = deps.limits.chunkBytes;
						const limit = deps.limits.archiveBytes - bytes;
						async function* chunks(): AsyncGenerator<Uint8Array> {
							let position = 0;
							for (;;) {
								const buffer = Buffer.allocUnsafe(chunk);
								const { bytesRead } = await handle.read(buffer, 0, chunk, position);
								if (bytesRead === 0) return;
								position += bytesRead;
								if (position > limit) throw new Error("The folder grew past what a ZIP may hold");
								yield bytesRead === chunk ? buffer : buffer.subarray(0, bytesRead);
							}
						}
						const written = await writer.add(name, chunks(), options);
						bytes += written.size;
					}
					files++;
				} finally {
					await handle.close().catch(() => {});
				}
			}
			if (cancelled) return end("aborted");
			await writer.finish();
			// The end is written down before the client is told of it: a client that has the last byte has the log line too.
			end("ok");
			controller.close();
		} catch (e) {
			if (!cancelled) {
				try {
					controller.error(e);
				} catch {
					// the stream is over already
				}
			}
			end(cancelled ? "aborted" : expired ? "expired" : "failed");
		}
	};
	let over = false;
	const end = (status: string) => {
		if (over) return;
		over = true;
		clearTimeout(timer);
		release();
		deps.ended(trace, env, status, files, bytes);
	};
	return new ReadableStream<Uint8Array>(
		{
			start(c) {
				controller = c;
				if (env.validUntil !== undefined) {
					timer = setTimeout(
						() => {
							expired = true;
							stop();
							try {
								controller.error(new Error("The Access session ended"));
							} catch {
								// over already
							}
						},
						Math.max(0, env.validUntil - deps.now()),
					);
					timer.unref();
				}
				void produce();
			},
			pull() {
				wake?.();
				wake = null;
			},
			cancel() {
				cancelled = true;
				stop();
			},
		},
		new CountQueuingStrategy({ highWaterMark: 4 }),
	);
}

/** `GET /api/folder/archive/<ticket>`: the ZIP the ticket stands for, once. */
export async function sendArchive(route: string, env: TransferEnv, trace: Trace, deps: ArchiveDeps): Promise<Response> {
	requireDownload(env);
	const id = route.slice("archive/".length);
	const t = /^[0-9a-f]{32}$/.test(id) ? deps.tickets.take(id, env.who) : null;
	if (!t) throw new TransferError("That ZIP is not there any more: ask for it again", 404, "gone");
	trace.root = t.root;
	trace.path = t.folderRel;
	const release = deps.gate.take(env.who);
	if (!release) {
		// Too many answers at once is not the ticket's fault: it is given back.
		deps.tickets.add(t);
		throw busy();
	}
	return new Response(archiveStream(t, env, trace, deps, release), {
		headers: { ...attachmentHeaders(t.name), "content-type": "application/zip" },
	});
}
