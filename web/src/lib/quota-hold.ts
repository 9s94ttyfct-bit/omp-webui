import type { LiveCacheWarming, LiveQuotaHold, QuotaHoldReason, QuotaHoldState } from "@shared/quota-floor.ts";
import type { MessageKey, Vars } from "../i18n/index.ts";
import "../i18n/later.ts";
import { fmtCost } from "./format.ts";

/**
 * What the line a held conversation shows says (#652), chosen from what the server tells (`LiveInfo.quotaHold`): each is a
 * string of the app (`key`) with what fills it (`vars`), so that the choice is a plain function and the words are the
 * translation's. Nothing here is drawn: `components/QuotaHoldNote.tsx` does that, in a chunk of its own.
 */
export interface Say {
	key: MessageKey;
	vars?: Vars;
}

/** The states the page draws; one a newer server adds is not guessed at (the line is left out). */
export const HOLD_TITLE: Record<QuotaHoldState, MessageKey> = {
	armed: "chat.quotaHoldTitleArmed",
	held: "chat.quotaHoldTitleHeld",
	overridden: "chat.quotaHoldTitleOverridden",
	unavailable: "chat.quotaHoldTitleUnavailable",
};

export const isHoldState = (s: unknown): s is QuotaHoldState => typeof s === "string" && Object.hasOwn(HOLD_TITLE, s);

/** Whole percent of a window that is left, from the share the server sends (0–1). */
export const percentLeft = (remaining: number): number =>
	Number.isFinite(remaining) ? Math.min(100, Math.max(0, Math.round(remaining * 100))) : 0;

/** Why the floor holds this conversation: the provider's share left against the person's floor, with the window when omp names it. */
export function holdWhy(hold: LiveQuotaHold): Say {
	const vars = { provider: hold.provider, pct: percentLeft(hold.remaining), floor: hold.floor };
	return hold.window
		? { key: "chat.quotaHoldWhy", vars: { ...vars, window: hold.window } }
		: { key: "chat.quotaHoldWhyNoWindow", vars };
}

/** What the state means for the conversation, in a sentence under the title (the unavailable one says why, see `unavailableWhy`). */
export function holdDetail(hold: LiveQuotaHold): Say | null {
	switch (hold.state) {
		case "armed":
			return { key: "chat.quotaHoldArmedDetail" };
		case "held":
			return { key: "chat.quotaHoldHeldDetail" };
		case "overridden":
			return { key: "chat.quotaHoldOverriddenDetail", vars: { provider: hold.provider } };
		case "unavailable":
			return unavailableWhy(hold.reason);
	}
}

const UNAVAILABLE: Record<QuotaHoldReason, MessageKey> = {
	trustedExtension: "chat.quotaHoldUnavailableTrusted",
	notLoaded: "chat.quotaHoldUnavailableNotLoaded",
};

/** Why a conversation cannot be held; a reason a newer server adds is the plain "cannot be held". */
export function unavailableWhy(reason: QuotaHoldReason | undefined): Say {
	return {
		key:
			reason !== undefined && Object.hasOwn(UNAVAILABLE, reason)
				? UNAVAILABLE[reason]
				: "chat.quotaHoldUnavailableOther",
	};
}

/**
 * When the conversation goes on: after the window's reset at `time` (with the time left, when there is some), the reset
 * being past, or the reset not being known. `now` and `left` are in the caller's hands because the line counts down.
 */
export function resumeSay(
	hold: LiveQuotaHold,
	clock: { now: number; time: (epochMs: number) => string; left: (ms: number) => string },
): Say {
	if (typeof hold.resetsAt !== "number" || !Number.isFinite(hold.resetsAt)) {
		return { key: "chat.quotaHoldResumesUnknown", vars: { provider: hold.provider } };
	}
	const left = hold.resetsAt - clock.now;
	if (left <= 0) return { key: "chat.quotaHoldResumesDue" };
	const time = clock.time(hold.resetsAt);
	return { key: "chat.quotaHoldResumesIn", vars: { time, left: clock.left(left) } };
}

const LAPSE: Record<NonNullable<LiveCacheWarming["why"]>, MessageKey> = {
	cost: "chat.quotaHoldLapseCost",
	limit: "chat.quotaHoldLapseLimit",
	reset: "chat.quotaHoldLapseReset",
	small: "chat.quotaHoldLapseSmall",
	omp: "chat.quotaHoldLapseOmp",
};

const isMoney = (n: number | undefined): n is number => typeof n === "number" && Number.isFinite(n);

/**
 * What happens to the prompt cache while the conversation waits: kept warm (with what that costs against rebuilding it),
 * let go (and why), outliving the wait, off for the conversation, or not decided yet. A figure the server leaves out is a
 * sentence without it, not a made-up one; a state a newer server adds reads as "not decided yet".
 */
export function warmingSay(w: LiveCacheWarming): Say {
	switch (w.state) {
		case "on": {
			if (!isMoney(w.warmCost) || !isMoney(w.rebuildCost)) return { key: "chat.quotaHoldWarmOn" };
			const n = typeof w.pings === "number" && Number.isFinite(w.pings) ? Math.max(0, Math.round(w.pings)) : null;
			if (n === null) return { key: "chat.quotaHoldWarmOn" };
			return {
				key: n === 1 ? "chat.quotaHoldWarmOnOne" : "chat.quotaHoldWarmOnMany",
				vars: { n, warm: fmtCost(w.warmCost), rebuild: fmtCost(w.rebuildCost) },
			};
		}
		case "lapse": {
			if (w.why === "cost") {
				return isMoney(w.warmCost) && isMoney(w.rebuildCost)
					? { key: LAPSE.cost, vars: { warm: fmtCost(w.warmCost), rebuild: fmtCost(w.rebuildCost) } }
					: { key: "chat.quotaHoldLapseCostBare" };
			}
			return { key: w.why !== undefined && Object.hasOwn(LAPSE, w.why) ? LAPSE[w.why] : "chat.quotaHoldLapse" };
		}
		case "none":
			return { key: "chat.quotaHoldWarmNone" };
		case "off":
			return { key: "chat.quotaHoldWarmOff" };
		default:
			return { key: "chat.quotaHoldWarmUnknown" };
	}
}

/** What omp's refreshes of the cache have come to since the hold began; nothing while there have been none. */
export function refreshedSay(w: LiveCacheWarming): Say | null {
	const n = w.refreshes;
	if (typeof n !== "number" || !Number.isFinite(n) || n < 1) return null;
	const spent = fmtCost(isMoney(w.spent) ? w.spent : 0);
	return n === 1
		? { key: "chat.quotaHoldRefreshedOne", vars: { spent } }
		: { key: "chat.quotaHoldRefreshedMany", vars: { n: Math.round(n), spent } };
}
