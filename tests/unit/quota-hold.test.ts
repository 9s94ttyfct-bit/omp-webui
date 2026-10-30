import { expect, test } from "bun:test";
import type { LiveInfo } from "../../shared/protocol.ts";
import type { LiveCacheWarming, LiveQuotaHold } from "../../shared/quota-floor.ts";
import { t } from "../../web/src/i18n/index.ts";
import "../../web/src/i18n/later.ts";
import {
	HOLD_TITLE,
	holdDetail,
	holdWhy,
	isHoldState,
	percentLeft,
	refreshedSay,
	resumeSay,
	type Say,
	unavailableWhy,
	warmingSay,
} from "../../web/src/lib/quota-hold.ts";
import { withInfo } from "../../web/src/store/live.ts";

/**
 * The line a conversation held at its provider's quota floor shows (#652): the words are chosen from what the server tells
 * (`LiveInfo.quotaHold`) by plain functions, so each state and each way of the prompt cache is checked here, in the app's
 * own English. The line itself (`components/QuotaHoldNote.tsx`) is `tests/e2e/quota-floor.spec.ts`'s.
 */

const said = (s: Say): string => t(s.key, s.vars);

const info = (extra: Partial<LiveInfo> = {}): LiveInfo => ({
	liveId: "L1",
	pid: 1,
	cwd: "/",
	sessionFile: "/sessions/a.jsonl",
	sessionId: "s",
	args: [],
	startedAt: 0,
	streaming: false,
	exited: false,
	subscribers: 1,
	pausedAt: null,
	mode: "full",
	...extra,
});

const warming = (w: Partial<LiveCacheWarming> = {}): LiveCacheWarming => ({ state: "unknown", ...w });

const hold = (extra: Partial<LiveQuotaHold> = {}): LiveQuotaHold => ({
	state: "held",
	provider: "anthropic",
	floor: 10,
	remaining: 0.042,
	window: "5 hour",
	resetsAt: 1_700_000_000_000 + 2 * 3_600_000,
	since: 1_700_000_000_000,
	warming: warming(),
	...extra,
});

test("the info the server sends carries the hold, and one without it clears it", () => {
	const live = { info: info(), resumedAt: 0 } as Parameters<typeof withInfo>[0];
	const held = withInfo(live, info({ quotaHold: hold() }));
	expect(held.info.quotaHold?.state).toBe("held");
	expect(withInfo(held, info()).info.quotaHold).toBeUndefined();
});

test("each state has its own title, and a state the page does not know is not drawn", () => {
	expect(said({ key: HOLD_TITLE.armed })).toBe("Quota floor reached: the next step will wait");
	expect(said({ key: HOLD_TITLE.held })).toBe("Waiting for the quota to reset");
	expect(said({ key: HOLD_TITLE.overridden })).toBe("Continuing past the quota floor");
	expect(said({ key: HOLD_TITLE.unavailable })).toBe("Quota floor reached, but this conversation cannot be held");
	expect(isHoldState("held")).toBe(true);
	expect(isHoldState("paused")).toBe(false);
	expect(isHoldState(undefined)).toBe(false);
});

test("why it is held: the share left against the floor, in whole percent, with the window when omp names it", () => {
	expect(said(holdWhy(hold()))).toBe("anthropic has 4% of its 5 hour window left, at or below your floor of 10%");
	expect(said(holdWhy(hold({ window: undefined })))).toBe(
		"anthropic has 4% of its quota left, at or below your floor of 10%",
	);
	expect(percentLeft(0.1)).toBe(10);
	expect(percentLeft(-1)).toBe(0);
	expect(percentLeft(7)).toBe(100);
	expect(percentLeft(Number.NaN)).toBe(0);
});

test("what each state means, and why one that cannot be held cannot", () => {
	expect(said(holdDetail(hold({ state: "armed" })) as Say)).toContain("The request in flight finishes first");
	expect(said(holdDetail(hold({ state: "held" })) as Say)).toBe(
		"omp is waiting before its next step. It is not frozen.",
	);
	expect(said(holdDetail(hold({ state: "overridden" })) as Say)).toBe(
		"You chose to continue. The floor is ignored until anthropic is above it again.",
	);
	expect(said(unavailableWhy("trustedExtension"))).toContain("--trusted-extension");
	expect(said(unavailableWhy("notLoaded"))).toContain("did not start");
	// A reason a newer server adds, or none: the plain sentence.
	expect(said(unavailableWhy(undefined))).toBe("This conversation cannot be held. It keeps working past the floor.");
	expect(said(unavailableWhy("somethingNew" as "notLoaded"))).toContain("cannot be held");
	expect(said(holdDetail(hold({ state: "unavailable", reason: "notLoaded" })) as Say)).toContain("did not start");
});

test("when it goes on: the reset time with what is left, the reset being past, or not known", () => {
	const clock = (now: number) => ({
		now,
		time: (ms: number) => `T${ms - 1_700_000_000_000}`,
		left: (ms: number) => `${ms / 60_000}m`,
	});
	const h = hold({ resetsAt: 1_700_000_000_000 + 90 * 60_000 });
	expect(said(resumeSay(h, clock(1_700_000_000_000)))).toBe("Resumes after the reset at T5400000, in 90m");
	// The reset time has passed: it resumes by itself once the quota is looked at again.
	expect(said(resumeSay(h, clock(1_700_000_000_000 + 91 * 60_000)))).toContain("The reset time has passed");
	expect(said(resumeSay(hold({ resetsAt: undefined }), clock(0)))).toBe(
		"The reset time is unknown. It resumes once anthropic is above your floor again.",
	);
});

test("what happens to the prompt cache, one sentence for each way it can go", () => {
	expect(said(warmingSay(warming({ state: "on", pings: 4, warmCost: 0.0123, rebuildCost: 0.31 })))).toBe(
		"Keeping the prompt cache warm: 4 refreshes until the reset, about $0.01, less than the $0.31 to rebuild it",
	);
	expect(said(warmingSay(warming({ state: "on", pings: 1, warmCost: 0.5, rebuildCost: 2 })))).toBe(
		"Keeping the prompt cache warm: 1 refresh until the reset, about $0.50, less than the $2.00 to rebuild it",
	);
	// Without the figures it is said without them: nothing is made up.
	expect(said(warmingSay(warming({ state: "on" })))).toBe(
		"Keeping the prompt cache warm until the reset, which costs less than rebuilding it",
	);
	expect(said(warmingSay(warming({ state: "lapse", why: "cost", warmCost: 3.5, rebuildCost: 0.4 })))).toBe(
		"Letting the prompt cache lapse: keeping it warm until the reset would cost about $3.50, more than the $0.40 to rebuild it",
	);
	expect(said(warmingSay(warming({ state: "lapse", why: "cost" })))).toBe(
		"Letting the prompt cache lapse: keeping it warm until the reset would cost more than rebuilding it",
	);
	expect(said(warmingSay(warming({ state: "lapse", why: "limit" })))).toBe(
		"Letting the prompt cache lapse: omp stops refreshing before the reset",
	);
	expect(said(warmingSay(warming({ state: "lapse", why: "reset" })))).toBe(
		"Letting the prompt cache lapse: the reset time is unknown",
	);
	expect(said(warmingSay(warming({ state: "lapse", why: "small" })))).toBe(
		"Letting the prompt cache lapse: it is too small for refreshing to save anything",
	);
	expect(said(warmingSay(warming({ state: "lapse", why: "omp" })))).toBe(
		"Letting the prompt cache lapse: omp stopped refreshing it",
	);
	expect(said(warmingSay(warming({ state: "lapse" })))).toBe("Letting the prompt cache lapse");
	expect(said(warmingSay(warming({ state: "none" })))).toBe("The prompt cache outlives the hold: nothing is spent");
	expect(said(warmingSay(warming({ state: "off" })))).toBe("Cache warming is off for this conversation");
	expect(said(warmingSay(warming({ state: "unknown" })))).toBe(
		"omp decides about the prompt cache at its next refresh",
	);
	// A state a newer server adds is "not decided yet", not a blank.
	expect(said(warmingSay(warming({ state: "later" as "unknown" })))).toBe(
		"omp decides about the prompt cache at its next refresh",
	);
});

test("the refreshes made so far, once there are some", () => {
	expect(refreshedSay(warming())).toBeNull();
	expect(refreshedSay(warming({ refreshes: 0, spent: 0 }))).toBeNull();
	expect(said(refreshedSay(warming({ refreshes: 1, spent: 0.002 })) as Say)).toBe(
		"Refreshed once so far, spending $0.0020",
	);
	expect(said(refreshedSay(warming({ refreshes: 5, spent: 0.25 })) as Say)).toBe(
		"Refreshed 5 times so far, spending $0.25",
	);
	// The count without the money: nothing is spent that the server did not say.
	expect(said(refreshedSay(warming({ refreshes: 2 })) as Say)).toBe("Refreshed 2 times so far, spending $0");
});
