import { flushDrafts } from "./drafts.ts";

/** A tab left open across an upgrade asks for page chunks the new build no longer has. */

/** The wording of a failed lazy import: Chrome, Firefox and Safari differ, and Vite words a failed CSS preload itself. */
const CHUNK_ERROR =
	/dynamically imported module|importing a module script failed|unable to preload|loading (?:css )?chunk \S+ failed|ChunkLoadError/i;

export function isChunkLoadError(err: unknown): boolean {
	const text = err instanceof Error ? `${err.name}: ${err.message}` : String(err ?? "");
	return CHUNK_ERROR.test(text);
}

const STORAGE_KEY = "ompw.chunkReloadAt";

/** A reload this recent that did not fix the failure means the chunk is really gone: stop reloading. */
export const RELOAD_WINDOW_MS = 30_000;

interface ReloadDeps {
	storage?: Pick<Storage, "getItem" | "setItem">;
	now?: number;
	reload?: () => void;
	/** Writes out what the page keeps in memory and would lose: the unsent drafts. */
	flush?: () => void;
}

/**
 * Reload to fetch the new build, unless that was already tried moments ago: a chunk that is still
 * missing after a reload would loop forever, so the error screen takes over then. Returns whether it reloaded.
 */
export function reloadOnce({
	storage = sessionStorage,
	now = Date.now(),
	reload = () => location.reload(),
	flush = flushDrafts,
}: ReloadDeps = {}): boolean {
	try {
		const last = storage.getItem(STORAGE_KEY);
		if (last !== null && now - Number(last) < RELOAD_WINDOW_MS) return false;
		storage.setItem(STORAGE_KEY, String(now));
	} catch {
		// Storage is blocked: without a record of the attempt the guard cannot hold, so don't risk a loop.
		return false;
	}
	flush();
	reload();
	return true;
}

/** How many fetches nobody has asked for yet (see `quietly`) are on their way. */
let quiet = 0;

/**
 * Follow a fetch that nobody asked for yet: a chunk fetched ahead of the click that needs it. While it is on its
 * way, its failure is not a reason to reload the tab (see `reloadOnPreloadError`): whoever asks for the chunk gets
 * the failure, and with it the boundary that says so.
 */
export function quietly(fetch: Promise<unknown>): void {
	quiet++;
	const done = () => void quiet--;
	fetch.then(done, done);
}

/** Vite's report of a chunk that did not load: fetch the new build, unless the chunk was only a head start. */
export function reloadOnPreloadError(deps?: ReloadDeps): void {
	if (quiet === 0) reloadOnce(deps);
}
