import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { showLang, t } from "../../web/src/i18n/index.ts";
import { statusItems } from "../../web/src/lib/status-line.ts";
import { fmtCountdown, resetTime, usageLimitLabel } from "../../web/src/lib/usage-limit.ts";
import { initialLive, type LiveState, type RpcState } from "../../web/src/store/live.ts";

/** The usage-limit stage and fast mode of the status line, worded as omp's own status line words them. */

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const soon = Math.floor(NOW / 1000) + 3 * 3600;
const farAway = Math.floor(NOW / 1000) + 3 * 24 * 3600;
const clock = (sec: number) =>
	new Date(sec * 1000).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

test("low priority names when it ends and how much of the allowance is left", () => {
	expect(usageLimitLabel({ stage: "low_priority", resetsAtSec: soon, allowanceLeftPercent: 62 }, t, NOW)).toBe(
		`low priority until ${clock(soon)} · 62% left`,
	);
	expect(usageLimitLabel({ stage: "low_priority", resetsAtSec: soon }, t, NOW)).toBe(
		`low priority until ${clock(soon)}`,
	);
	// 0% left is still a figure.
	expect(usageLimitLabel({ stage: "low_priority", resetsAtSec: soon, allowanceLeftPercent: 0 }, t, NOW)).toContain(
		"0% left",
	);
});

test("wrap-up says the limit is reached, and when it resets or that extra usage follows", () => {
	expect(usageLimitLabel({ stage: "wrap_up", resetsAtSec: soon }, t, NOW)).toBe(
		`limit reached · wrapping up · resets ${clock(soon)}`,
	);
	expect(usageLimitLabel({ stage: "wrap_up" }, t, NOW)).toBe("limit reached · wrapping up");
	expect(usageLimitLabel({ stage: "wrap_up", resetsAtSec: soon, extraUsage: true }, t, NOW)).toBe(
		"limit reached · wrap-up, then extra usage",
	);
});

test("a stage omp has not documented, or a reset time it did not give, never reads Invalid Date", () => {
	expect(usageLimitLabel({ stage: "mystery", resetsAtSec: soon }, t, NOW)).toBeNull();
	expect(usageLimitLabel({ stage: "low_priority" }, t, NOW)).toBe("low priority");
	for (const stage of ["low_priority", "wrap_up"]) {
		expect(usageLimitLabel({ stage }, t, NOW)).not.toContain("Invalid");
	}
});

test("a reset more than 20 hours away is named by its weekday too", () => {
	const near = resetTime(soon, NOW);
	const far = resetTime(farAway, NOW);
	expect(near).toBe(clock(soon));
	expect(far).not.toBe(clock(farAway));
	expect(far).toContain(new Date(farAway * 1000).toLocaleString(undefined, { weekday: "short" }));
});

const live = (state: Partial<RpcState>): LiveState => ({
	...initialLive({
		liveId: "L",
		pid: 1,
		cwd: "/",
		sessionFile: null,
		sessionId: null,
		args: [],
		startedAt: 0,
		streaming: false,
		exited: false,
		subscribers: 1,
		pausedAt: null,
		mode: "full",
	}),
	state: {
		isStreaming: false,
		isCompacting: false,
		steeringMode: "all",
		followUpMode: "all",
		interruptMode: "immediate",
		messageCount: 0,
		queuedMessageCount: 0,
		...state,
	},
});

test("the status items carry the usage limit and whether fast mode is in effect, not merely selected", () => {
	const limit = { stage: "low_priority", resetsAtSec: soon, allowanceLeftPercent: 62 };
	expect(statusItems(live({ usageLimit: limit, fastModeActive: true }), 0, null, 0)).toMatchObject({
		usageLimit: limit,
		fast: true,
	});
	// Selected but fallen back to normal: the provider refused the fast tier.
	expect(statusItems(live({ fastModeEnabled: true, fastModeActive: false }), 0, null, 0)).toMatchObject({
		fast: false,
		usageLimit: undefined,
	});
	expect(statusItems(undefined, 0, null, 0).fast).toBe(false);
});

test("a countdown to a reset rounds up, so it never reads zero before the time is up", () => {
	expect(fmtCountdown(0)).toBe("0s");
	expect(fmtCountdown(-5000)).toBe("0s");
	expect(fmtCountdown(1)).toBe("1s");
	expect(fmtCountdown(59_000)).toBe("59s");
	expect(fmtCountdown(59_001)).toBe("1m 00s");
	expect(fmtCountdown(5 * 60_000 + 5000)).toBe("5m 05s");
	expect(fmtCountdown(3_599_000)).toBe("59m 59s");
	// Past an hour the seconds go unsaid and the minutes round up in their place.
	expect(fmtCountdown(3_600_000)).toBe("1h 0m");
	expect(fmtCountdown(3_600_001)).toBe("1h 1m");
	expect(fmtCountdown(72 * 60_000)).toBe("1h 12m");
	expect(fmtCountdown(2 * 3_600_000 + 4 * 60_000 + 58_000)).toBe("2h 5m");
	expect(fmtCountdown(24 * 3_600_000 - 1)).toBe("1d 0h");
	expect(fmtCountdown(3 * 86_400_000)).toBe("3d 0h");
	expect(fmtCountdown(2 * 86_400_000 + 3 * 3_600_000 + 1)).toBe("2d 4h");
});

describe("a countdown in Chinese", () => {
	beforeAll(() => showLang("zh-CN"));
	afterAll(() => showLang("en"));

	test("uses Chinese units with no spaces", () => {
		expect(fmtCountdown(0)).toBe("0秒");
		expect(fmtCountdown(45_000)).toBe("45秒");
		expect(fmtCountdown(59_000)).toBe("59秒");
		expect(fmtCountdown(59_999)).toBe("1分00秒");
		expect(fmtCountdown(60_000)).toBe("1分00秒");
		expect(fmtCountdown(12 * 60_000 + 5000)).toBe("12分05秒");
		expect(fmtCountdown(3_599_000)).toBe("59分59秒");
		expect(fmtCountdown(3_599_999)).toBe("1小时0分");
		expect(fmtCountdown(3_600_000)).toBe("1小时0分");
		expect(fmtCountdown(72 * 60_000)).toBe("1小时12分");
		expect(fmtCountdown(23 * 3_600_000 + 59 * 60_000)).toBe("23小时59分");
		expect(fmtCountdown(86_400_000)).toBe("1天0小时");
		expect(fmtCountdown(3 * 86_400_000)).toBe("3天0小时");
		expect(fmtCountdown(2 * 86_400_000 + 3 * 3_600_000 + 1)).toBe("2天4小时");
	});
});
