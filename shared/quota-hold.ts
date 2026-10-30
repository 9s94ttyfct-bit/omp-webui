import type { CacheWarming, CacheWarmingWhy } from "./quota-floor.ts";

/**
 * What the server and omp's extension (`server/omp/quota-floor/extension.ts`) share of a quota hold (#652): the one small
 * file they talk through, the words of what the extension tells back, and the cost check that decides whether the prompt
 * cache is kept warm while a conversation is held.
 *
 * It imports types only: the extension runs in omp's own process, and its copy of this file is written beside it
 * (`server/omp/quota-floor/install.ts`). The server's tests hold the extension to the names and numbers here.
 */

/** The environment variable that names the conversation's hold file (it sits beside the process's settings overlay). */
export const QUOTA_FILE_ENV = "OMPW_QUOTA_FILE";

/** What follows the settings overlay's name in the hold file's name. */
export const QUOTA_SUFFIX = ".quota";

/** What follows the hold file's name in the note the extension leaves when it has started in the process. */
export const QUOTA_LOADED_SUFFIX = ".loaded";

/**
 * The title of the dialog the extension waits in while a conversation is held, and its one option. omp stops its own clock
 * on a tool call's handler while a dialog is open (`tool_call` handlers have a timeout, `extensionHandlers.toolCallTimeoutMs`,
 * that dialogs pause), which is what lets the handler wait for hours. The server consumes the dialog: a page is never shown it
 * and never answers it. Nothing else may use the title.
 */
export const QUOTA_DIALOG_TITLE = "omp-webui quota floor";
export const QUOTA_DIALOG_CONTINUE = "Continue";

/** The key of the status the extension tells the server its cache warming decisions with (`ctx.ui.setStatus`); the server consumes it too. */
export const QUOTA_STATUS_KEY = "omp-webui-quota-floor";

/** How often the extension reads the hold file while it waits: how long a release (or a stop) takes to reach a held handler at most. */
export const QUOTA_POLL_MS = 1_000;

/**
 * How long past the time the server meant to look again (`resumeAt`) the extension waits before it lets the conversation go
 * by itself. A server that is gone cannot look, and the window it was waiting for has reset by then: the one end of a hold
 * the extension decides alone. A hold with no reset time has none: nothing is spent while a conversation is held, and one
 * that is let go with nobody there would spend on, past the floor.
 */
export const QUOTA_SELF_RELEASE_MS = 5 * 60_000;

/** The hold, as the server writes it for the extension. A file that is absent, unreadable or says anything else is no hold. */
export interface QuotaHoldFile {
	v: 1;
	hold: true;
	provider: string;
	/** When the window frees up (epoch ms); null when omp does not say. */
	resetsAt: number | null;
	/** When the server looks at the quota again after the reset; null while there is no reset time. */
	resumeAt: number | null;
	/** The extension lets the conversation go at this time if it has heard nothing; null: never. */
	expiresAt: number | null;
	/** When the floor was reached. */
	since: number;
}

/** What the server decides of the hold: the file without its constant fields. */
export type HoldFields = Omit<QuotaHoldFile, "v" | "hold">;

const finiteOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A plain object (the extension imports types only, so it has no `isRecord` of the app's to use). */
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function holdFileText(hold: HoldFields): string {
	const file: QuotaHoldFile = { v: 1, hold: true, ...hold };
	return `${JSON.stringify(file)}\n`;
}

export function parseHoldFile(text: string): QuotaHoldFile | null {
	let v: unknown;
	try {
		v = JSON.parse(text);
	} catch {
		return null;
	}
	if (!isObject(v)) return null;
	const since = finiteOrNull(v.since);
	if (v.v !== 1 || v.hold !== true || typeof v.provider !== "string" || since === null) return null;
	return {
		v: 1,
		hold: true,
		provider: v.provider,
		resetsAt: finiteOrNull(v.resetsAt),
		resumeAt: finiteOrNull(v.resumeAt),
		expiresAt: finiteOrNull(v.expiresAt),
		since,
	};
}

/** What the extension tells of the prompt cache: its last decision. */
export interface WarmVerdict {
	v: 1;
	/** When it decided (epoch ms). */
	at: number;
	state: Extract<CacheWarming, "on" | "lapse" | "none">;
	why?: CacheWarmingWhy;
	pings?: number;
	/** Dollars: all the refreshes until the reset. */
	warmCost?: number;
	/** Dollars: what rebuilding the cache once costs over reading it. */
	rebuildCost?: number;
}

export function warmVerdictText(verdict: Omit<WarmVerdict, "v">): string {
	const body: WarmVerdict = { v: 1, ...verdict };
	return JSON.stringify(body);
}

const WHYS: readonly CacheWarmingWhy[] = ["cost", "limit", "reset", "small", "omp"];

/** The verdict an already parsed value says, or null: what is kept in a record and what the extension tells are read the same way. */
export function warmVerdictOf(v: unknown): WarmVerdict | null {
	if (!isObject(v)) return null;
	const at = finiteOrNull(v.at);
	if (v.v !== 1 || at === null) return null;
	if (v.state !== "on" && v.state !== "lapse" && v.state !== "none") return null;
	const why = WHYS.find((w) => w === v.why);
	const pings = finiteOrNull(v.pings);
	const warmCost = finiteOrNull(v.warmCost);
	const rebuildCost = finiteOrNull(v.rebuildCost);
	return {
		v: 1,
		at,
		state: v.state,
		...(why ? { why } : {}),
		...(pings !== null ? { pings } : {}),
		...(warmCost !== null ? { warmCost } : {}),
		...(rebuildCost !== null ? { rebuildCost } : {}),
	};
}

/** The verdict the extension's status says (`warmVerdictText`), or null for any other text. */
export function parseWarmVerdict(text: string | undefined): WarmVerdict | null {
	if (text === undefined) return null;
	try {
		return warmVerdictOf(JSON.parse(text));
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------------- the cost check

/**
 * The cost check of the prompt cache while a conversation is held (#652).
 *
 * omp keeps a prompt cache entry alive by re-sending the last request with a one-token reply shortly before the entry
 * expires (`providers.cacheWarming`: a *refresh*), and asks the extensions before each refresh whether to go on
 * (`cache_warming_decision`). While the quota is at its floor the conversation waits for the window's reset, which can be
 * hours; the cache is worth keeping only while keeping it until then costs less than rebuilding it once after it. With `n`
 * the refreshes still to make until the reset (this one included):
 *
 *     keep it warm  ⇔  missCost − n × warmCost  ≥  WARM_SAVINGS_MIN
 *
 * where `warmCost` is what one refresh costs (the cached prompt read, plus one output token) and `missCost` what the first
 * request after the reset costs more when the entry is gone (the prompt written to the cache, over the prompt read from it);
 * both are omp's own figures for the conversation's model and prompt, handed to the decision. `WARM_SAVINGS_MIN` is omp's
 * own threshold (`$0.05`), so that a saving of a few cents is not chased with a ping every few minutes for hours.
 *
 * `n` follows from the interval between two refreshes, which the decision measures (it is the time since the entry was last
 * touched), and the reset time: `n = ⌈(resumeAt − now) / interval⌉`. Three things end it before the cost does, and the cache
 * is let go (`lapse`): the reset time is not known; omp's own limit on refreshing (below) is reached before the reset; the
 * cache has no price difference to save. And one makes it pointless: the entry lasts until the reset (`none`).
 *
 * The limits are omp's, as of omp 18.12 (`session/cache-warmer.ts`) and are not the extension's to change: a refresh comes at
 * 90 % of the entry's lifetime (ten seconds before its end at the latest); omp stops refreshing one hour after the request
 * that made the entry while the agent is working (a hold is in the middle of a turn: the agent is working), and half an hour
 * after it while it is idle. A refresh that the limit would stop before the reset keeps nothing warm, so it is not made.
 */
export const WARM_SAVINGS_MIN = 0.05;

/** omp's refresh comes at this share of the entry's lifetime, or `WARM_MARGIN_MS` before it ends, whichever is earlier. */
export const WARM_FRACTION = 0.9;
export const WARM_MARGIN_MS = 10_000;

/** How long after the request that made the entry omp goes on refreshing it: while the agent works, and while it is idle. */
export const WARM_CAP_STREAMING_MS = 60 * 60_000;
export const WARM_CAP_IDLE_MS = 30 * 60_000;

/** The lifetime an interval between two refreshes belongs to: the inverse of omp's `getCacheWarmingDelayMs`. */
export function ttlFromDelayMs(delayMs: number): number {
	// The delay is 90 % of the lifetime from 100 s up, and the lifetime less ten seconds below it.
	return delayMs >= WARM_FRACTION * 100_000 ? delayMs / WARM_FRACTION : delayMs + WARM_MARGIN_MS;
}

export interface WarmingInput {
	/** The refresh omp is deciding is due now (epoch ms). */
	now: number;
	/** When the hold ends: the window's reset and the grace after it. Null when the reset is not known. */
	resumeAt: number | null;
	/** When the request that made the cache entry began: omp's limit on refreshing counts from it. */
	startedAt: number;
	/** How long it has been since the entry was last touched: the interval between two refreshes. */
	delayMs: number;
	/** The agent is working (a hold in the middle of a turn), not idle: which of omp's limits applies. */
	streaming: boolean;
	/** Dollars: one refresh. */
	warmCost: number;
	/** Dollars: the first request after the reset, over what it costs when the entry is still there. */
	missCost: number;
}

export interface WarmingPlan {
	state: Extract<CacheWarming, "on" | "lapse" | "none">;
	why?: CacheWarmingWhy;
	/** The refreshes still to make until the reset, this one included; 0 when the entry lasts that long. */
	pings: number;
	/** Dollars: `pings` refreshes. */
	warmCost: number;
	/** Dollars: rebuilding the entry once. */
	rebuildCost: number;
}

/** Whether keeping the cache warm until the reset is worth it, by the check above. Pure: it reads nothing and decides only. */
export function warmingPlan(i: WarmingInput): WarmingPlan {
	const rebuildCost = Math.max(0, i.missCost);
	const lapse = (why: CacheWarmingWhy, pings = 0): WarmingPlan => ({
		state: "lapse",
		why,
		pings,
		warmCost: pings * i.warmCost,
		rebuildCost,
	});
	if (i.resumeAt === null) return lapse("reset");
	if (!(i.delayMs > 0)) return lapse("limit");
	// The entry was last touched `delayMs` ago and lives its lifetime from then: it outlives the hold, and nothing is spent.
	if (i.resumeAt <= i.now - i.delayMs + ttlFromDelayMs(i.delayMs))
		return { state: "none", pings: 0, warmCost: 0, rebuildCost };
	const pings = Math.max(1, Math.ceil((i.resumeAt - i.now) / i.delayMs));
	const cap = i.startedAt + (i.streaming ? WARM_CAP_STREAMING_MS : WARM_CAP_IDLE_MS);
	// omp stops refreshing at its limit: refreshes that cannot reach the reset keep nothing warm.
	if (i.now + (pings - 1) * i.delayMs > cap) return lapse("limit", pings);
	// A rebuild that costs no more than a read is nothing to save (a provider without cache prices).
	if (!(i.missCost > 0) || !(i.warmCost >= 0)) return lapse("small", pings);
	const spent = pings * i.warmCost;
	if (i.missCost - spent < WARM_SAVINGS_MIN) return lapse("cost", pings);
	return { state: "on", pings, warmCost: spent, rebuildCost };
}
