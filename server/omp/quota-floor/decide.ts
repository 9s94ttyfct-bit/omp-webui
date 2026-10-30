import type { UsageReport } from "../../../shared/protocol.ts";
import {
	isExhausted,
	limitsFor,
	QUOTA_IDLE_REFRESH_MS,
	QUOTA_REFRESH_MS,
	remainingFraction,
} from "../../../shared/quota.ts";

/**
 * The decisions of the quota floor (#652), pure: what a provider's usage reports say against the floor, and what a
 * conversation's hold does with it. Nothing here reads a clock, a file or a process; `service.ts` supplies them.
 */

/**
 * A hold whose window should have reset this long ago, and whose quota cannot be read, is let go: the floor cannot be
 * checked any more, and the window the hold waited for is over. The one thing worse than a hold that ends too early is one
 * that never ends.
 */
export const STALE_AFTER_RESET_MS = 15 * 60_000;

/** A provider's reports against its floor, for one model. */
export interface FloorReading {
	provider: string;
	/** The floor: percent of a window that is left. */
	floor: number;
	/** The share left, 0–1: the account with the most left, in its window that is nearest to being used up. */
	remaining: number;
	/** Every account is at or below the floor in a window the model draws on. */
	low: boolean;
	/** When the provider frees up: the first account to recover does so when the last of its windows at the floor resets. Null when omp does not say. */
	resetsAt: number | null;
	/** omp's label of the window that decides when that is. */
	window: string | null;
}

const labelOf = (l: UsageReport["limits"][number]): string | null => l.window?.label || l.label || null;

/**
 * `provider`'s usage against `floor` (percent left) for the windows a request to `model` draws on (`limitsFor`, as the
 * quota pill and omp gate them). The provider is at its floor only when every account is: omp moves on to another account
 * when one is used up, and so does the work. An account is at the floor when any window of it is. An account that reports
 * no usable window says nothing of how much it has left, and is not taken for one that is low. Null when the provider has
 * no reports with windows at all.
 */
export function readFloor(
	reports: UsageReport[],
	provider: string,
	model: string | null,
	floor: number,
): FloorReading | null {
	const accounts = reports.filter((r) => r.provider === provider && r.limits.length > 0);
	if (accounts.length === 0) return null;
	const line = floor / 100 + 1e-9;
	let low = true;
	let best = 0;
	/** For each account at the floor: when it recovers, and the label of the window that decides it. */
	const recoveries: { at: number | null; window: string | null }[] = [];
	for (const account of accounts) {
		const windows = limitsFor(account.limits, model).flatMap((limit) => {
			const share = remainingFraction(limit) ?? (isExhausted(limit) ? 0 : null);
			return share === null ? [] : [{ limit, share }];
		});
		if (windows.length === 0) {
			low = false;
			continue;
		}
		best = Math.max(best, Math.min(...windows.map((w) => w.share)));
		const atFloor = windows.filter((w) => w.share <= line || isExhausted(w.limit));
		if (atFloor.length === 0) {
			low = false;
			continue;
		}
		// The account recovers when the last of its windows at the floor resets; one that does not say when leaves it unknown.
		const unknown = atFloor.find((w) => typeof w.limit.window?.resetsAt !== "number");
		if (unknown) {
			recoveries.push({ at: null, window: labelOf(unknown.limit) });
			continue;
		}
		const last = atFloor.reduce((a, b) => ((b.limit.window?.resetsAt ?? 0) >= (a.limit.window?.resetsAt ?? 0) ? b : a));
		recoveries.push({ at: last.limit.window?.resetsAt ?? null, window: labelOf(last.limit) });
	}
	// The provider recovers when its first account does: the soonest reset that is known.
	const known = recoveries.filter((r) => r.at !== null);
	const first =
		known.length > 0 ? known.reduce((a, b) => ((b.at as number) < (a.at as number) ? b : a)) : recoveries[0];
	return {
		provider,
		floor,
		remaining: best,
		low,
		resetsAt: low ? (first?.at ?? null) : null,
		window: low ? (first?.window ?? null) : null,
	};
}

/** A conversation's hold: the floor was reached, and has not been left since. */
export interface QuotaHold {
	provider: string;
	floor: number;
	remaining: number;
	window: string | null;
	resetsAt: number | null;
	/** When the floor was reached (the server's clock). */
	since: number;
}

/** How the quota is looked at: the intervals, and the grace after a reset. A test supplies shorter ones (`OMP_WEBUI_QUOTA_*`). */
export interface QuotaTimings {
	/** After a window's reset the quota is looked at again once this has passed: the reset is the provider's clock, and it is not exact. */
	graceMs: number;
	/** How often a conversation that works on a provider with a floor looks (it spends quota); also how often a held one looks again once its reset has passed. */
	workingLookMs: number;
	/** How often a held conversation looks before its reset: it spends nothing, so the look is rare. */
	heldLookMs: number;
}

export const DEFAULT_TIMINGS: QuotaTimings = {
	graceMs: 60_000,
	workingLookMs: QUOTA_REFRESH_MS,
	heldLookMs: QUOTA_IDLE_REFRESH_MS,
};

/** The time the quota is looked at again after the reset, and the extension's own time to let the conversation go; null while there is no reset time. */
export function resumeAtOf(hold: Pick<QuotaHold, "resetsAt">, timings: QuotaTimings): number | null {
	return hold.resetsAt === null ? null : hold.resetsAt + timings.graceMs;
}

/**
 * What a look at the quota does to a conversation's hold. A look that says the floor is reached begins one (or updates it:
 * the figures and the reset time move); one that says it is not ends it. A look that could not be made changes nothing,
 * except that a hold whose window reset long ago and cannot be checked ends (`STALE_AFTER_RESET_MS`).
 */
export function nextHold(prev: QuotaHold | null, reading: FloorReading | null, now: number): QuotaHold | null {
	if (reading === null) {
		if (prev && prev.resetsAt !== null && now >= prev.resetsAt + STALE_AFTER_RESET_MS) return null;
		return prev;
	}
	if (!reading.low) return null;
	return {
		provider: reading.provider,
		floor: reading.floor,
		remaining: reading.remaining,
		window: reading.window,
		resetsAt: reading.resetsAt,
		since: prev ? prev.since : now,
	};
}

/**
 * How long until the quota is next looked at, or null when it is not looked at: a conversation that is not working and is
 * not held spends nothing and nothing is waiting for it. One that works spends quota and is looked at every
 * `workingLookMs`. One that is held spends none, so it is looked at slowly (`heldLookMs`) and, above all, once when its window
 * resets (`resumeAt`), which is what ends the hold; if the provider still says it is low then (its figures lag), it is looked
 * at again at the working interval, not the slow one.
 */
export function nextLookMs(opts: {
	working: boolean;
	held: boolean;
	resumeAt: number | null;
	now: number;
	last: number;
	timings: QuotaTimings;
}): number | null {
	if (!opts.working && !opts.held) return null;
	const { timings } = opts;
	const past = opts.resumeAt !== null && opts.now >= opts.resumeAt;
	const every = opts.held && !past ? timings.heldLookMs : timings.workingLookMs;
	let due = opts.last + every;
	// The reset is looked at when it comes, once: not before it.
	if (opts.held && opts.resumeAt !== null && opts.last < opts.resumeAt) due = Math.min(due, opts.resumeAt);
	return Math.max(0, due - opts.now);
}
