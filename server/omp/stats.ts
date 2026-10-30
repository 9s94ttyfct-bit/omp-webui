import { readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { run } from "./run.ts";

/**
 * `omp stats --json` (the dashboard's numbers), kept for 30 s. omp reads its whole statistics database for it, which takes
 * a few seconds and more on a large one: a request that comes while a run is under way shares it, and a run that does not
 * end within `STATS_MS` is killed. Otherwise one omp that hangs would start another with every request, for as long as the
 * server runs (#319).
 *
 * Most of that time is omp bringing its database up to date with the transcripts written since it last looked ("Syncing
 * session files…": 12 s for 760 transcripts here), before it reads a figure (#690). So the last answer is also kept on
 * disk (`keepStatsIn`), and `keptStats` answers with it at once, from memory or from that file, while a run brings it up to
 * date: the page shows those figures and then the new ones.
 */

const TTL_MS = 30_000;
const STATS_MS = 60_000;
let cache: { at: number; body: string } | null = null;
let inflight: Promise<string> | null = null;
let keptFile: string | null = null;

/** Where the last answer is kept across restarts (the server's own data folder). */
export function keepStatsIn(file: string): void {
	keptFile = file;
}

async function collect(bin: string, timeoutMs: number): Promise<string> {
	const ran = await run([bin, "stats", "--json"], { timeoutMs });
	if (ran.code !== 0) throw new Error(`omp stats exited ${ran.code}: ${ran.stderr}`);
	cache = { at: Date.now(), body: ran.stdout };
	if (keptFile) {
		// Written whole and then renamed: a server killed meanwhile leaves the last copy, never half of one.
		const part = `${keptFile}.part`;
		try {
			writeFileSync(part, ran.stdout, { mode: 0o600 });
			renameSync(part, keptFile);
		} catch {
			// Not kept this time: the next answer is.
		}
	}
	return ran.stdout;
}

/** The answer of `omp stats --json`; `force` skips the kept one. */
export function ompStats(bin: string, force: boolean, timeoutMs = STATS_MS): Promise<string> {
	if (!force && cache && Date.now() - cache.at < TTL_MS) return Promise.resolve(cache.body);
	inflight ??= collect(bin, timeoutMs).finally(() => {
		inflight = null;
	});
	return inflight;
}

/** An answer kept from before, and when it was had; `refreshing` while a run brings it up to date. */
export interface KeptStats {
	body: string;
	at: number;
	refreshing: boolean;
}

/** The last answer from the disk, when there is one and it is whole JSON. */
function fromDisk(): { at: number; body: string } | null {
	if (!keptFile) return null;
	try {
		const body = readFileSync(keptFile, "utf8");
		JSON.parse(body);
		return { at: statSync(keptFile).mtimeMs, body };
	} catch {
		return null;
	}
}

/**
 * An answer for a page now: the one of a moment ago as it is; an older one (kept in memory or on disk) with a run started
 * to bring it up to date, which `ompStats(bin, false)` then waits for. Null when there is none: the caller waits for a run.
 */
export function keptStats(bin: string, timeoutMs = STATS_MS): KeptStats | null {
	if (cache && Date.now() - cache.at < TTL_MS) return { ...cache, refreshing: false };
	const kept = cache ?? fromDisk();
	if (!kept) return null;
	// A run that fails leaves the kept figures; the page's wait for it says so.
	ompStats(bin, false, timeoutMs).catch(() => {});
	return { ...kept, refreshing: true };
}

/** What a test starts from. */
export function forgetStats(): void {
	cache = null;
	inflight = null;
	keptFile = null;
}
