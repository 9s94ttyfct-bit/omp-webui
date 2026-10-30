import type { LiveInfo } from "@shared/protocol.ts";
import type { LiveCacheWarming, LiveQuotaHold } from "@shared/quota-floor.ts";
import { ownSession, sessionRow, startLive } from "../support/live.ts";
import { type SocketTap, tapSocket } from "../support/socket-tap.ts";
import { expect, type Page, test } from "./fixtures.ts";

/**
 * The quota floor (#652), from the page's side: the Settings card that sets a provider's floor, and what a conversation
 * says while it is held (`LiveInfo.quotaHold`) with its "Continue anyway". No model is called and no quota is spent: the
 * usage figures are stubbed, and the hold is pushed to the page as the `live` frame the server would send (the server's own
 * decisions, when a hold begins and ends, are the server's tests').
 *
 * The floors are the server's (`quota-floor.json` of this worker's data folder), so every test takes the one it set away.
 */

const PROVIDER = "quotaspec";
const WRITE = { "x-omp-webui": "1" };

const NOW = () => Date.now();

/** `omp usage` for the provider: one account, one 5-hour window with `fraction` left. */
const reportOf = (fraction: number) => [
	{
		provider: PROVIDER,
		limits: [
			{
				id: `${PROVIDER}:5h`,
				label: "Claude 5 Hour",
				window: { resetsAt: NOW() + 2 * 3_600_000 },
				amount: { remainingFraction: fraction, unit: "percent" },
				status: "ok",
			},
		],
	},
];

const stubUsage = (page: Page, fraction = 0.37) =>
	page.route(/\/api\/usage\?/, (route) => route.fulfill({ json: reportOf(fraction) }));

const floorsOf = async (page: Page): Promise<Record<string, number>> => {
	const settings: { floors: Record<string, number> } = await (await page.request.get("/api/quota-floor")).json();
	return settings.floors;
};

const clearFloor = (page: Page) =>
	page.request.post("/api/quota-floor", { data: { provider: PROVIDER, floor: null }, headers: WRITE });

test.afterEach(async ({ page }) => {
	await clearFloor(page);
});

const row = (page: Page) => page.locator(`[data-testid="quota-floor-row"][data-provider="${PROVIDER}"]`);

test("a floor is set for a provider, kept across a reload, and taken away with Off", async ({ page }) => {
	await stubUsage(page);
	await page.goto("/#/settings/models");
	const card = page.getByTestId("quota-floor-settings");
	await expect(card).toBeVisible();
	await expect(row(page)).toBeVisible();
	// The provider, its share left now (the window omp names), and no floor: off by default.
	await expect(row(page).getByTestId("quota-floor-provider")).toHaveText(PROVIDER);
	await expect(row(page).getByTestId("quota-floor-left")).toHaveText("37% left · Claude 5 Hour");
	await expect(row(page).getByTestId("quota-floor-state")).toHaveText("No floor");
	await expect(row(page).getByTestId("quota-floor-save")).toBeDisabled();
	await expect(row(page).getByTestId("quota-floor-off")).toBeDisabled();
	expect((await floorsOf(page))[PROVIDER]).toBeUndefined();

	await row(page).getByTestId("quota-floor-input").fill("25");
	await row(page).getByTestId("quota-floor-save").click();
	await expect(row(page).getByTestId("quota-floor-state")).toHaveText("Holds at 25% left");
	await expect(row(page)).toHaveAttribute("data-floor", "25");
	expect((await floorsOf(page))[PROVIDER]).toBe(25);

	// It is the server's, not the page's: a reload finds it.
	await page.reload();
	await expect(row(page).getByTestId("quota-floor-input")).toHaveValue("25");
	await expect(row(page).getByTestId("quota-floor-state")).toHaveText("Holds at 25% left");

	await row(page).getByTestId("quota-floor-off").click();
	await expect(row(page).getByTestId("quota-floor-state")).toHaveText("No floor");
	await expect(row(page).getByTestId("quota-floor-input")).toHaveValue("");
	await expect(row(page).getByTestId("quota-floor-off")).toBeDisabled();
	expect((await floorsOf(page))[PROVIDER]).toBeUndefined();
});

test("a floor that is not a whole number from 1 to 99 is refused with a message, and nothing is saved", async ({
	page,
}) => {
	await stubUsage(page);
	await page.goto("/#/settings/models");
	const input = row(page).getByTestId("quota-floor-input");
	for (const bad of ["150", "0", "5.5", "abc", "-3"]) {
		await input.fill(bad);
		await input.press("Enter");
		await expect(row(page).getByTestId("quota-floor-error"), `refusal of ${bad}`).toHaveText(
			"Enter a whole number from 1 to 99.",
		);
		expect((await floorsOf(page))[PROVIDER], `nothing saved for ${bad}`).toBeUndefined();
	}
	// Typing again clears the message; a good value is saved with Enter alone.
	await input.fill("40");
	await expect(row(page).getByTestId("quota-floor-error")).toHaveCount(0);
	await input.press("Enter");
	await expect(row(page).getByTestId("quota-floor-state")).toHaveText("Holds at 40% left");
	expect((await floorsOf(page))[PROVIDER]).toBe(40);
});

test("the server refuses a floor outside 1 to 99 with 422 and keeps the one it has", async ({ page }) => {
	await page.request.post("/api/quota-floor", { data: { provider: PROVIDER, floor: 30 }, headers: WRITE });
	for (const floor of [0, 100, 150, 5.5, "20"]) {
		const res = await page.request.post("/api/quota-floor", { data: { provider: PROVIDER, floor }, headers: WRITE });
		expect(res.status(), `floor ${JSON.stringify(floor)}`).toBe(422);
		const body: { error?: unknown } = await res.json();
		expect(typeof body.error).toBe("string");
	}
	expect((await floorsOf(page))[PROVIDER]).toBe(30);
});

test("a provider that has a floor is listed when omp reports no usage for it, and its floor can be taken away", async ({
	page,
}) => {
	await page.request.post("/api/quota-floor", { data: { provider: PROVIDER, floor: 15 }, headers: WRITE });
	// Nothing reports a quota now (the provider was signed out, say).
	await page.route(/\/api\/usage\?/, (route) => route.fulfill({ json: [] }));
	await page.goto("/#/settings/models");
	await expect(row(page)).toBeVisible();
	await expect(row(page).getByTestId("quota-floor-left")).toHaveText("no usage figure");
	await expect(row(page).getByTestId("quota-floor-state")).toHaveText("Holds at 15% left");
	await row(page).getByTestId("quota-floor-off").click();
	// No usage figure and no floor: nothing is left to list for the provider.
	await expect(row(page)).toHaveCount(0);
	expect((await floorsOf(page))[PROVIDER]).toBeUndefined();
});

test("the card says in a line what it does, and 'How it works' holds the rest", async ({ page }) => {
	await stubUsage(page);
	await page.goto("/#/settings/models");
	const details = page.getByTestId("quota-floor-details");
	await expect(page.getByTestId("quota-floor-settings")).toContainText("Off for every provider until you set a floor");
	await expect(details).toBeHidden();
	await page.getByTestId("quota-floor-how").getByText("How it works").click();
	await expect(details).toBeVisible();
	for (const said of [
		"the request in flight finishes",
		"held, not frozen",
		"Continue anyway",
		"Subagents that are already running finish their assignment",
		"first request of a new prompt",
		"$0.05",
		"90% of the cache's lifetime",
		"an hour after the request that made the entry",
		"--trusted-extension",
	])
		await expect(details).toContainText(said);
});

test("Settings finds the card by its name and the words people use for it, and opens it", async ({ page }) => {
	await stubUsage(page);
	await page.goto("/#/settings/models");
	await expect(page.getByTestId("quota-floor-settings")).toBeVisible();
	const field = page.getByTestId("settings-search-input");
	await field.fill("quota floor");
	await expect(page.getByTestId("settings-search-result").first()).toContainText("Hold when this much or less is left");
	await field.press("Enter");
	await expect(page.locator('[data-marked="true"]')).toHaveCount(1);
	await expect(page.getByTestId("quota-floor-settings")).toBeVisible();
});

test("the card is in the interface's language: 简体中文", async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("ompw.lang", "zh-CN"));
	await stubUsage(page);
	await page.goto("/#/settings/models");
	await expect(page.getByTestId("quota-floor-settings")).toContainText("额度下限");
	await expect(row(page).getByTestId("quota-floor-left")).toHaveText("剩余 37% · Claude 5 Hour");
	await expect(row(page).getByTestId("quota-floor-state")).toHaveText("未设下限");
	await row(page).getByTestId("quota-floor-input").fill("200");
	await row(page).getByTestId("quota-floor-input").press("Enter");
	await expect(row(page).getByTestId("quota-floor-error")).toHaveText("请输入 1 到 99 之间的整数。");
	await row(page).getByTestId("quota-floor-input").fill("30");
	await row(page).getByTestId("quota-floor-save").click();
	await expect(row(page).getByTestId("quota-floor-state")).toHaveText("剩余 30% 时暂缓");
});

// ------------------------------------------------------------------------------------- what a held conversation says

const FROM = NOW();

const warming = (w: Partial<LiveCacheWarming> = {}): LiveCacheWarming => ({ state: "unknown", ...w });

/** What the server sends for a conversation at the floor: `LiveInfo.quotaHold`. */
const hold = (extra: Partial<LiveQuotaHold> = {}): LiveQuotaHold => ({
	state: "held",
	provider: "anthropic",
	floor: 10,
	remaining: 0.042,
	window: "5 hour",
	resetsAt: NOW() + 2 * 3_600_000,
	since: FROM,
	warming: warming(),
	...extra,
});

async function chat(page: Page, title: string, n: number) {
	ownSession(n, title);
	await page.addInitScript(() => localStorage.setItem("ompw.autoTitle", "off"));
	const tap = await tapSocket(page);
	await page.goto("/");
	const liveId = await startLive(page, tap, title, `quota-${n}`);
	return { tap, liveId };
}

/** The server's own info for `liveId`, as every page is told it. */
async function infoOf(page: Page, liveId: string): Promise<LiveInfo> {
	const lives = (await (await page.request.get("/api/lives")).json()) as LiveInfo[];
	const found = lives.find((l) => l.liveId === liveId);
	if (!found) throw new Error(`the server does not list ${liveId}`);
	// The conversation held for real, if the server decided so: the spec says what it means to show.
	const { quotaHold: _server, ...rest } = found;
	return rest;
}

/** What the server sends when a process's info changes, with the hold on it (or without: the hold is over). */
async function say(
	page: Page,
	tap: SocketTap,
	liveId: string,
	quotaHold: LiveQuotaHold | null,
	extra: Partial<LiveInfo> = {},
) {
	tap.push({ t: "live", info: { ...(await infoOf(page, liveId)), ...extra, ...(quotaHold ? { quotaHold } : {}) } });
}

const note = (page: Page) => page.getByTestId("quota-hold-note");

test("each state of a hold has its own line, with its title and what it means", async ({ page }) => {
	const { tap, liveId } = await chat(page, "Quota hold states", 0xf1);
	await expect(note(page)).toHaveCount(0);

	await say(page, tap, liveId, hold({ state: "armed" }));
	await expect(note(page)).toHaveAttribute("data-state", "armed");
	await expect(page.getByTestId("quota-hold-title")).toHaveText("Quota floor reached: the next step will wait");
	await expect(page.getByTestId("quota-hold-why")).toHaveText(
		"anthropic has 4% of its 5 hour window left, at or below your floor of 10%",
	);
	await expect(page.getByTestId("quota-hold-detail")).toContainText("The request in flight finishes first");
	await expect(page.getByTestId("quota-hold-continue")).toHaveText("Continue anyway");

	await say(page, tap, liveId, hold({ state: "held" }));
	await expect(note(page)).toHaveAttribute("data-state", "held");
	await expect(page.getByTestId("quota-hold-title")).toHaveText("Waiting for the quota to reset");
	await expect(page.getByTestId("quota-hold-detail")).toHaveText(
		"omp is waiting before its next step. It is not frozen.",
	);
	await expect(page.getByTestId("quota-hold-continue")).toBeVisible();
	await expect(page.getByTestId("quota-hold-again")).toHaveCount(0);

	await say(page, tap, liveId, hold({ state: "overridden" }));
	await expect(note(page)).toHaveAttribute("data-state", "overridden");
	await expect(page.getByTestId("quota-hold-title")).toHaveText("Continuing past the quota floor");
	await expect(page.getByTestId("quota-hold-detail")).toContainText(
		"The floor is ignored until anthropic is above it again",
	);
	await expect(page.getByTestId("quota-hold-again")).toHaveText("Hold again");
	await expect(page.getByTestId("quota-hold-continue")).toHaveCount(0);
	// Nothing is awaited and no cache is spent on once the person chose to go on.
	await expect(page.getByTestId("quota-hold-resumes")).toHaveCount(0);
	await expect(page.getByTestId("quota-hold-cache")).toHaveCount(0);

	await say(page, tap, liveId, hold({ state: "unavailable", reason: "trustedExtension" }));
	await expect(note(page)).toHaveAttribute("data-state", "unavailable");
	await expect(page.getByTestId("quota-hold-title")).toHaveText(
		"Quota floor reached, but this conversation cannot be held",
	);
	await expect(page.getByTestId("quota-hold-detail")).toContainText("--trusted-extension");
	await expect(page.getByTestId("quota-hold-continue")).toHaveCount(0);
	await expect(page.getByTestId("quota-hold-again")).toHaveCount(0);

	await say(page, tap, liveId, hold({ state: "unavailable", reason: "notLoaded" }));
	await expect(page.getByTestId("quota-hold-detail")).toContainText("did not start in this conversation's omp");

	// The server takes the hold away (the window reset, or the turn ended): the line goes, and there is one line, not two.
	await expect(note(page)).toHaveCount(1);
	await say(page, tap, liveId, null);
	await expect(note(page)).toHaveCount(0);
});

test("it says when the conversation goes on: the reset time and what is left, a reset that has passed, or none known", async ({
	page,
}) => {
	const { tap, liveId } = await chat(page, "Quota hold resumes", 0xf2);
	await say(page, tap, liveId, hold({ resetsAt: NOW() + 2 * 3_600_000 }));
	const resumes = page.getByTestId("quota-hold-resumes");
	// "02:14 PM" in the page's own locale, with what is left of it (the countdown rounds up).
	await expect(resumes).toHaveText(/^Resumes after the reset at \d{1,2}:\d{2}(?:\s?[AP]M)?, in (?:2h 0m|1h 59m)$/);

	await say(page, tap, liveId, hold({ resetsAt: NOW() - 60_000 }));
	await expect(resumes).toHaveText("The reset time has passed: checking the quota, then it resumes by itself.");

	await say(page, tap, liveId, hold({ resetsAt: undefined }));
	await expect(resumes).toHaveText("The reset time is unknown. It resumes once anthropic is above your floor again.");
});

test("it says what happens to the prompt cache, and what the refreshes have cost so far", async ({ page }) => {
	const { tap, liveId } = await chat(page, "Quota hold cache", 0xf3);
	const cache = page.getByTestId("quota-hold-cache");
	const cases: [Partial<LiveCacheWarming>, string][] = [
		[
			{ state: "on", pings: 6, warmCost: 0.0312, rebuildCost: 0.46 },
			"Keeping the prompt cache warm: 6 refreshes until the reset, about $0.03, less than the $0.46 to rebuild it",
		],
		[
			{ state: "lapse", why: "cost", pings: 40, warmCost: 2.4, rebuildCost: 0.35 },
			"Letting the prompt cache lapse: keeping it warm until the reset would cost about $2.40, more than the $0.35 to rebuild it",
		],
		[{ state: "lapse", why: "limit" }, "Letting the prompt cache lapse: omp stops refreshing before the reset"],
		[{ state: "lapse", why: "reset" }, "Letting the prompt cache lapse: the reset time is unknown"],
		[
			{ state: "lapse", why: "small" },
			"Letting the prompt cache lapse: it is too small for refreshing to save anything",
		],
		[{ state: "lapse", why: "omp" }, "Letting the prompt cache lapse: omp stopped refreshing it"],
		[{ state: "none" }, "The prompt cache outlives the hold: nothing is spent"],
		[{ state: "off" }, "Cache warming is off for this conversation"],
		[{ state: "unknown" }, "omp decides about the prompt cache at its next refresh"],
	];
	for (const [w, text] of cases) {
		await say(page, tap, liveId, hold({ warming: warming(w) }));
		await expect(cache, JSON.stringify(w)).toHaveText(text);
		await expect(cache).toHaveAttribute("data-warming", w.state ?? "");
		await expect(cache).toHaveAttribute("data-why", w.why ?? "");
	}
	// Refreshes omp has made since the hold began, and what they cost.
	await expect(page.getByTestId("quota-hold-refreshed")).toHaveCount(0);
	await say(
		page,
		tap,
		liveId,
		hold({
			warming: warming({ state: "on", pings: 3, warmCost: 0.02, rebuildCost: 0.3, refreshes: 4, spent: 0.0271 }),
		}),
	);
	await expect(page.getByTestId("quota-hold-refreshed")).toHaveText("Refreshed 4 times so far, spending $0.03");
	await say(
		page,
		tap,
		liveId,
		hold({ warming: warming({ state: "on", pings: 1, warmCost: 0.02, rebuildCost: 0.3, refreshes: 1, spent: 0.01 }) }),
	);
	await expect(cache).toHaveText(
		"Keeping the prompt cache warm: 1 refresh until the reset, about $0.02, less than the $0.30 to rebuild it",
	);
	await expect(page.getByTestId("quota-hold-refreshed")).toHaveText("Refreshed once so far, spending $0.01");
});

test("Continue anyway and Hold again each send quota_override for this conversation, and the answer is shown", async ({
	page,
}) => {
	const { tap, liveId } = await chat(page, "Quota hold override", 0xf4);
	// What the server answers a `quota_override` with: the conversation's info as it is now. The spec says what that is.
	let answer: LiveQuotaHold | null = null;
	tap.rewrite((msg, request) => {
		if (msg.t !== "reply" || request?.t !== "quota_override" || typeof msg.data !== "object" || msg.data === null)
			return msg;
		const { quotaHold: _held, ...info } = msg.data as LiveInfo;
		return { ...msg, data: { ...info, ...(answer ? { quotaHold: answer } : {}) } };
	});
	await say(page, tap, liveId, hold({ state: "held" }));
	await expect(page.getByTestId("quota-hold-continue")).toBeVisible();
	expect(tap.sent.filter((m) => m.t === "quota_override")).toEqual([]);

	answer = hold({ state: "overridden" });
	await page.getByTestId("quota-hold-continue").click();
	await expect.poll(() => tap.sent.filter((m) => m.t === "quota_override").length).toBe(1);
	const first = tap.sent.findLast((m) => m.t === "quota_override");
	expect(first).toMatchObject({ t: "quota_override", liveId, on: true });
	// The reply is the process's info as it is now: the line shows it without waiting for the `live` frame.
	await expect(note(page)).toHaveAttribute("data-state", "overridden");
	await expect(page.getByTestId("quota-hold-again")).toBeVisible();

	answer = hold({ state: "held" });
	await page.getByTestId("quota-hold-again").click();
	await expect.poll(() => tap.sent.filter((m) => m.t === "quota_override").length).toBe(2);
	expect(tap.sent.findLast((m) => m.t === "quota_override")).toMatchObject({ t: "quota_override", liveId, on: false });
	await expect(note(page)).toHaveAttribute("data-state", "held");
});

test("a refused change is said in a toast and leaves the line as it was", async ({ page }) => {
	const { tap, liveId } = await chat(page, "Quota hold refused", 0xf5);
	tap.rewrite((msg, request) =>
		msg.t === "reply" && request?.t === "quota_override"
			? { t: "reply", req: msg.req, ok: false, error: "Live session not found" }
			: msg,
	);
	await say(page, tap, liveId, hold({ state: "held" }));
	await page.getByTestId("quota-hold-continue").click();
	await expect(page.getByText("Could not change the quota hold: Live session not found")).toBeVisible();
	await expect(note(page)).toHaveAttribute("data-state", "held");
	await expect(page.getByTestId("quota-hold-continue")).toBeEnabled();
});

test("the line is in the interface's language: 简体中文", async ({ page }) => {
	await page.addInitScript(() => localStorage.setItem("ompw.lang", "zh-CN"));
	const { tap, liveId } = await chat(page, "额度暂缓测试", 0xf6);
	await say(
		page,
		tap,
		liveId,
		hold({ warming: warming({ state: "lapse", why: "cost", warmCost: 2.4, rebuildCost: 0.35 }) }),
	);
	await expect(page.getByTestId("quota-hold-title")).toHaveText("正在等待额度重置");
	await expect(page.getByTestId("quota-hold-why")).toHaveText(
		"anthropic 的 5 hour 窗口只剩 4%，已达到或低于你设的下限 10%",
	);
	await expect(page.getByTestId("quota-hold-cache")).toHaveText(
		"让提示缓存失效：保持预热到重置约需 $2.40，高于重建缓存的 $0.35",
	);
	await expect(page.getByTestId("quota-hold-continue")).toHaveText("仍然继续");
});

// ------------------------------------------------------------------------------------- the marks of a held conversation

test("the sidebar marks a conversation that is held, and a pause or a question for the person comes first", async ({
	page,
}) => {
	const title = "Quota hold sidebar";
	const { tap, liveId } = await chat(page, title, 0xf7);
	const held = sessionRow(page, title).getByRole("img", { name: "Waiting for the quota to reset" });
	await expect(held).toHaveCount(0);

	await say(page, tap, liveId, hold({ state: "held" }));
	await expect(held).toHaveCount(1);
	// Armed is not held yet: the request in flight is still working.
	await say(page, tap, liveId, hold({ state: "armed" }));
	await expect(held).toHaveCount(0);
	await say(page, tap, liveId, hold({ state: "overridden" }));
	await expect(held).toHaveCount(0);

	await say(page, tap, liveId, hold({ state: "held" }));
	await expect(held).toHaveCount(1);
	// A pause is the stronger word: the process is frozen, not waiting on its own.
	await say(page, tap, liveId, hold({ state: "held" }), { pausedAt: NOW() });
	await expect(held).toHaveCount(0);
	await expect(sessionRow(page, title).getByRole("img", { name: "Paused" })).toHaveCount(1);

	await say(page, tap, liveId, hold({ state: "held" }), { pausedAt: null });
	await expect(held).toHaveCount(1);
	await say(page, tap, liveId, null);
	await expect(held).toHaveCount(0);
});

test("Settings' running sessions say that a held conversation waits for the quota", async ({ page }) => {
	const title = "Quota hold running";
	const { tap, liveId } = await chat(page, title, 0xf8);
	await say(page, tap, liveId, hold({ state: "held" }));
	await expect(note(page)).toBeVisible();
	await page.evaluate(() => {
		location.hash = "#/settings/app";
	});
	const running = page.getByTestId("running-session").filter({ hasText: title });
	await expect(running).toBeVisible();
	// The Settings page lists the processes the server reports; what the server says of the hold is said again here.
	await say(page, tap, liveId, hold({ state: "held" }));
	await expect(running.getByTestId("running-status")).toHaveText("waiting for the quota to reset");
	await say(page, tap, liveId, null);
	await expect(running.getByTestId("running-status")).not.toHaveText("waiting for the quota to reset");
});
