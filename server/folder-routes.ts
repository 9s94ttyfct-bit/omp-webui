import { type FSWatcher, statSync, watch } from "node:fs";
import type { FileDiff, FolderChanges } from "../shared/changes.ts";
import { FOLDER_LIMITS } from "../shared/folder.ts";
import { changesAnswer, diffAnswer } from "./changes-routes.ts";
import {
	FolderError,
	findFiles,
	listFolder,
	openFolderDir,
	openFolderFile,
	type PackageProbe,
	type Runner,
	readFolderDocument,
	readFolderFile,
	readFolderImage,
	resolveInside,
	rootOf,
} from "./folder.ts";
import { mayEdit } from "./folder-write.ts";
import type { GitMarks } from "./git-marks.ts";
import type { TransferEnv } from "./transfer-core.ts";

/**
 * `/api/folder/*`: the Files tab's reads of the folder a conversation works in, and the actions that hand a file or a
 * folder to macOS. The folder is never named by the page: it names the conversation (`live` and/or `file`) and the
 * server looks its folder up, so that no page can have another folder listed or read. Everything is relative to that
 * folder (see `resolveInside` for what is refused). The one write here is the save into a file the page's editor makes
 * (`POST file`, answered by the file transfer: `folder-write.ts`); the actions that hand a file or a folder to macOS are
 * for the page on this computer alone.
 */

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const fail = (error: string, status: number) => json({ error }, status);

export interface FolderContext {
	/** The folder the conversation the request names works in; null when it names none the server knows. */
	cwdOf(live: string | null, file: string | null): Promise<string | null>;
	/** The marks of the working tree of the folder (null: not in a repository, or not looked at). */
	marks(cwd: string, fresh: boolean): Promise<GitMarks | null>;
	/** How the folder differs from its repository's last commit (see `GitProbe.changes`); `fresh` looks again instead of using what was read a moment ago. */
	changes(cwd: string, fresh: boolean): Promise<FolderChanges>;
	/** The text change of one file of that list (see `GitProbe.diff`); null: not looked at, not a change, or git did not answer. */
	diff(cwd: string, path: string): Promise<FileDiff | null>;
	/**
	 * The request is from a page on this computer (see `isThisComputer` in `this-computer.ts`): the one that may open a file here, ask for what
	 * is hidden by default, and read what looks like a secret. Any other page is `guarded`.
	 */
	local: boolean;
	/** Opens or reveals the file (tests replace the system's `open`). */
	runner?: Runner;
	platform?: string;
	/** Whether macOS takes a folder for a package (tests replace LaunchServices' answer, which only a Mac gives). */
	isPackage?: PackageProbe;
	/**
	 * The file transfer (`download`, `archive`, `upload`: see `folder-transfer.ts`), answered for this request. Absent: there is
	 * none (a server that does not give one answers 404). The code is loaded by the first request for one, not before.
	 */
	transfer?: (req: Request, url: URL) => Promise<Response>;
	/**
	 * What this computer lets this request do with files (see `TransferEnv`), looked at when it is asked. The answer to a read of
	 * a text file says whether the file is `editable` for this page and this place by it; absent: no file is offered for
	 * editing (the save would still ask the transfer, which has it).
	 */
	env?: () => TransferEnv;
}

/** What a request names: the conversation, and a path in its folder. */
function ask(url: URL) {
	const q = url.searchParams;
	return { live: q.get("live"), file: q.get("file"), path: q.get("path") ?? "", all: q.get("all") === "1" };
}

/** Read a JSON body of a POST; anything else is an empty one. */
async function bodyOf(req: Request): Promise<Record<string, unknown>> {
	const body: unknown = await req.json().catch(() => null);
	return typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

/** `Cache-Control` of the answers that carry a picture's or a document's bytes: the browser keeps them for a minute at most, and `v` (the file's change time) busts it. */
const IMAGE_CACHE = "private, max-age=60";
/** The routes of the file transfer (`download`, `archive`, `archive/<ticket>`, `upload`, `upload/state`, `upload/cancel`). */
const TRANSFER_ROUTE = /^(?:download|archive|upload)(?:\/|$)/;

export async function handleFolder(req: Request, url: URL, ctx: FolderContext): Promise<Response> {
	const route = url.pathname.slice("/api/folder/".length);
	const q = url.searchParams;
	// A save into a file is the one write on a route that is also a read (`file`): the transfer answers it.
	if (TRANSFER_ROUTE.test(route) || (route === "file" && req.method === "POST"))
		return ctx.transfer ? ctx.transfer(req, url) : fail("Not found", 404);
	try {
		if (route === "open") {
			if (req.method !== "POST") return fail("POST required", 405);
			// The one request that acts on this computer beyond reading: a page that came in through the tunnel (or by a
			// network address) never asks it, whatever it carries.
			if (!ctx.local) return fail("Opening files is only for the page on this computer", 403);
			const body = await bodyOf(req);
			const live = typeof body.live === "string" ? body.live : null;
			const file = typeof body.file === "string" ? body.file : null;
			const cwd = await ctx.cwdOf(live, file);
			if (!cwd) return fail("Unknown conversation", 404);
			const root = await rootOf(cwd);
			// `dir`: open the folder itself in Finder (the conversation's own when `path` is empty); otherwise one file.
			if (body.dir === true) await openFolderDir(root, body.path, ctx.platform, ctx.runner, {}, ctx.isPackage);
			else await openFolderFile(root, body.path, body.reveal === true, ctx.platform, ctx.runner);
			return json({ ok: true });
		}
		// A look at git that skips what is kept (`fresh`) starts work of its own: it is a POST, as it is for `/api/git`.
		const fresh = q.get("fresh") === "1";
		if (req.method !== (fresh ? "POST" : "GET")) return fail(fresh ? "POST required" : "GET required", 405);
		const { live, file, path, all } = ask(url);
		const cwd = await ctx.cwdOf(live, file);
		if (!cwd) return fail("Unknown conversation", 404);
		const root = await rootOf(cwd);
		// A page that is not this computer's is shown no more than the conversation shows it (see `ListOptions.guarded`).
		const guarded = !ctx.local;
		switch (route) {
			case "list": {
				const marks = await ctx.marks(root, q.get("fresh") === "1");
				const listing = await listFolder(root, path, { all, marks, guarded });
				// Whether this page may ask for the folder to be opened in Finder (as `FolderFile.local` says of a file).
				return json(
					ctx.local && (ctx.platform ?? process.platform) === "darwin" ? { ...listing, local: true } : listing,
				);
			}
			case "find": {
				const marks = await ctx.marks(root, fresh);
				return json(await findFiles(root, q.get("q") ?? "", { all, marks, fresh, guarded }));
			}
			case "changes":
				return json(await changesAnswer(ctx, root, fresh, guarded));
			case "diff":
				return json(await diffAnswer(ctx, root, path, guarded));
			case "file": {
				const read = await readFolderFile(root, path, ctx.local && (ctx.platform ?? process.platform) === "darwin", {
					guarded,
				});
				// What the text allows is `readFolderFile`'s to say; whether this page and this place allow a write is the transfer's.
				if (read.kind === "text" && read.editable && !(ctx.env && (await mayEdit(root, path, ctx.env()))))
					return json({ ...read, editable: false });
				return json(read);
			}
			case "raw": {
				const { bytes, mime } = await readFolderImage(root, path, { guarded });
				return new Response(bytes, {
					headers: {
						"content-type": mime,
						// The bytes are an image and nothing else, whatever the file says it is.
						"x-content-type-options": "nosniff",
						"cache-control": IMAGE_CACHE,
					},
				});
			}
			case "doc": {
				const { bytes } = await readFolderDocument(root, path, { guarded });
				return new Response(bytes, {
					headers: {
						// Opaque bytes for the page to read with `fetch`: whatever the file says it is, a browser that is sent here
						// by an address saves it and does not open it as a document (a PDF can carry scripts of its own).
						"content-type": "application/octet-stream",
						"content-disposition": "attachment",
						"x-content-type-options": "nosniff",
						"cache-control": IMAGE_CACHE,
					},
				});
			}
		}
		return fail("Not found", 404);
	} catch (e) {
		if (e instanceof FolderError) return fail(e.message, e.status);
		throw e;
	}
}

/** How long a burst of changes is waited out before the page is told. */
const DEBOUNCE_MS = 250;
/** … and the longest a page waits for a change, in a burst that does not end. */
const MAX_WAIT_MS = 1000;
/**
 * How long after a folder is watched it is looked at once more. The system starts a watch on another thread (FSEvents on
 * macOS, for Bun and Node alike), so a change made in the first moments after `watch` returns can be lost for good, more
 * often the busier the machine is (measured: a file written straight after `watch` was never told of about 1 time in 20
 * at load 60+). The page reads the folder around the same time, so a change in that gap would stay out of the Files tab
 * until something else refreshed it.
 */
const CATCH_UP_MS = 500;

/** When the folder last had an entry made or removed (what a watch that began late would not tell of); null: unreadable. */
function stamp(dir: string): number | null {
	try {
		return statSync(dir).mtimeMs;
	} catch {
		return null;
	}
}

interface Watch {
	root: string;
	watchers: Map<string, FSWatcher>;
	notify: (root: string) => void;
	timer: ReturnType<typeof setTimeout> | undefined;
	since: number;
	/** The looks at folders just watched that have not happened yet. */
	catchUps: Set<ReturnType<typeof setTimeout>>;
}

/**
 * What a page is watching: the folders it has expanded in the Files tab (never more than `FOLDER_LIMITS.watchedDirs`),
 * and nothing at all once it says so or its socket ends. A change in one of them (a file made, changed or removed)
 * tells the page once the burst is over; the page asks for what it shows again.
 *
 * The page's messages are handled at once, not one after the other, and a `set` looks up the conversation's folder and
 * each path before it watches anything. So each `set` is numbered, and only the newest of an owner goes on to watch (an
 * older one that is still looking things up gives way); `drop` (the socket ended, the tab closed) ends every one of them
 * that has not watched yet, and an owner that is gone (`alive`) is never given a watch.
 */
export class FolderWatches {
	readonly #owners = new Map<object, Watch>();
	/** The newest `set` of each owner; gone when the owner was dropped. */
	readonly #newest = new WeakMap<object, number>();
	#calls = 0;

	/**
	 * The folders `dirs` (relative to the folder of the conversation `cwdOf` finds) are the owner's watch from now on; none:
	 * it watches nothing. Resolves once the watch is made, or given up for a newer one, or for an owner that is gone.
	 */
	async set(
		owner: object,
		cwdOf: () => Promise<string | null>,
		dirs: unknown,
		notify: (root: string) => void,
		alive: () => boolean = () => true,
	): Promise<void> {
		if (!Array.isArray(dirs) || dirs.length === 0) return this.drop(owner);
		const call = ++this.#calls;
		this.#newest.set(owner, call);
		const current = () => this.#newest.get(owner) === call && alive();
		const cwd = await cwdOf().catch(() => null);
		if (!current()) return;
		let root: string | null = null;
		try {
			root = cwd === null ? null : await rootOf(cwd);
		} catch {
			// no folder to watch
		}
		if (!current()) return;
		if (root === null) return this.#release(owner);
		const wanted = new Map<string, string>();
		for (const rel of dirs.slice(0, FOLDER_LIMITS.watchedDirs)) {
			try {
				const dir = await resolveInside(root, rel);
				wanted.set(dir.rel, dir.abs);
			} catch {
				// a folder that is gone, or that is not the folder's own, is not watched
			}
		}
		if (!current()) return;
		// Nothing is waited for from here on: the watch is made as a whole, for the newest ask.
		let mine = this.#owners.get(owner);
		if (mine && mine.root !== root) {
			this.#release(owner);
			mine = undefined;
		}
		mine ??= { root, watchers: new Map(), notify, timer: undefined, since: 0, catchUps: new Set() };
		mine.notify = notify;
		this.#owners.set(owner, mine);
		for (const [rel, watcher] of mine.watchers) {
			if (wanted.has(rel)) continue;
			watcher.close();
			mine.watchers.delete(rel);
		}
		for (const [rel, abs] of wanted) {
			if (mine.watchers.has(rel)) continue;
			try {
				const before = stamp(abs);
				let heard = false;
				// Not persistent: a watch must not keep the server alive. `recursive` is not asked for: only what is expanded.
				const watcher = watch(abs, { persistent: false }, () => {
					heard = true;
					this.#changed(mine);
				});
				// A folder that was removed, or a system that has no more watches to give: the page is told and asks again.
				watcher.on("error", () => {
					watcher.close();
					mine.watchers.delete(rel);
					this.#changed(mine);
				});
				mine.watchers.set(rel, watcher);
				// A watch that was not heard from yet may have begun after a change was made: look once more.
				const look = setTimeout(() => {
					mine.catchUps.delete(look);
					if (!heard && mine.watchers.get(rel) === watcher && stamp(abs) !== before) this.#changed(mine);
				}, CATCH_UP_MS);
				look.unref();
				mine.catchUps.add(look);
			} catch {
				// unreadable, or no watch to be had: the page refreshes when a turn ends
			}
		}
	}

	#changed(mine: Watch): void {
		const now = Date.now();
		if (mine.timer === undefined) mine.since = now;
		clearTimeout(mine.timer);
		const wait = Math.max(0, Math.min(DEBOUNCE_MS, mine.since + MAX_WAIT_MS - now));
		mine.timer = setTimeout(() => {
			mine.timer = undefined;
			mine.notify(mine.root);
		}, wait);
	}

	/** The owner watches nothing from now on, and no `set` of it that is still looking things up will watch anything. */
	drop(owner: object): void {
		this.#newest.delete(owner);
		this.#release(owner);
	}

	#release(owner: object): void {
		const mine = this.#owners.get(owner);
		if (!mine) return;
		this.#owners.delete(owner);
		clearTimeout(mine.timer);
		for (const look of mine.catchUps) clearTimeout(look);
		mine.catchUps.clear();
		for (const watcher of mine.watchers.values()) watcher.close();
		mine.watchers.clear();
	}

	/** Folders watched across owners (for tests). */
	get size(): number {
		let n = 0;
		for (const mine of this.#owners.values()) n += mine.watchers.size;
		return n;
	}
}
