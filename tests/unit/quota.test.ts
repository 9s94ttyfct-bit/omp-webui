import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { SessionEntry, UsageLimit, UsageReport } from "../../shared/protocol.ts";
import { exhaustion, isExhausted, remainingFraction } from "../../shared/quota.ts";
import { accountQuotas, bestAccount, providersUsed, quotaLevel, ringShare } from "../../web/src/lib/quota.ts";

const limit = (id: string, amount: UsageLimit["amount"], status = "ok"): UsageLimit => ({
	id,
	label: id,
	amount,
	status,
});

test("remaining share comes from omp's fraction, else remaining/limit, else 1 - used", () => {
	expect(remainingFraction(limit("a", { remainingFraction: 0.3 }))).toBe(0.3);
	expect(remainingFraction(limit("b", { remaining: 25, limit: 100 }))).toBe(0.25);
	expect(remainingFraction(limit("c", { usedFraction: 0.9 }))).toBeCloseTo(0.1);
	expect(remainingFraction(limit("d", { used: 3 }))).toBeNull();
	expect(remainingFraction(limit("e", { remainingFraction: 1.4 }))).toBe(1);
});

const account = (email: string | undefined, limits: UsageLimit[], provider = "anthropic"): UsageReport => ({
	provider,
	limits,
	...(email ? { metadata: { email } } : {}),
});
const pct = (id: string, remainingFraction: number, status?: string) => limit(id, { remainingFraction }, status);

const two: UsageReport[] = [
	account("a@x.org", [pct("5h", 0.03), pct("7d", 0.4)]),
	account("b@x.org", [pct("5h", 0.92), pct("7d", 0.6)]),
];

test("the best account is the one whose tightest window has the most left", () => {
	const best = bestAccount(two, "anthropic");
	expect(best?.name).toBe("b@x.org");
	expect(best?.tightest.limit.id).toBe("7d");
	expect(best?.tightest.fraction).toBe(0.6);
	expect(best?.tightest.level).toBe("ok");
});

test("accounts come best first, ties keep the listed order, each with its own tightest window", () => {
	const list = accountQuotas(two, "anthropic");
	expect(list.map((a) => a.name)).toEqual(["b@x.org", "a@x.org"]);
	expect(list[1]?.tightest.limit.id).toBe("5h");
	expect(list[1]?.windows.map((w) => w.limit.id)).toEqual(["5h", "7d"]);

	const tie = [account("first@x.org", [pct("5h", 0.5)]), account("second@x.org", [pct("5h", 0.5)])];
	expect(accountQuotas(tie, "anthropic").map((a) => a.name)).toEqual(["first@x.org", "second@x.org"]);
});

test("a single account without an email is unnamed", () => {
	const list = accountQuotas([account(undefined, [pct("5h", 0.6), pct("7d", 0.2)])], "anthropic");
	expect(list).toHaveLength(1);
	expect(list[0]?.name).toBeNull();
	expect(list[0]?.tightest.limit.id).toBe("7d");
	expect(list[0]?.tightest.level).toBe("low");
});

test("accounts without a usable window are ignored, and so are windows without a share", () => {
	const reports = [
		account("empty@x.org", []),
		account("blind@x.org", [limit("5h", { used: 3 })]),
		account("ok@x.org", [limit("5h", { used: 3 }), pct("7d", 0.7)]),
	];
	const list = accountQuotas(reports, "anthropic");
	expect(list.map((a) => a.name)).toEqual(["ok@x.org"]);
	expect(list[0]?.windows.map((w) => w.limit.id)).toEqual(["7d"]);
	expect(bestAccount([account("empty@x.org", [])], "anthropic")).toBeNull();
});

test("an exhausted window makes the account's level critical whatever its share", () => {
	const best = bestAccount([account(undefined, [pct("5h", 0.5, "exhausted")])], "anthropic");
	expect(best?.tightest.level).toBe("critical");
});

test("providers are not mixed", () => {
	const reports = [...two, account("o@x.org", [pct("5h", 0.01)], "openai-codex")];
	expect(accountQuotas(reports, "anthropic")).toHaveLength(2);
	expect(bestAccount(reports, "openai-codex")?.tightest.fraction).toBe(0.01);
	expect(bestAccount(reports, "google")).toBeNull();
});

const assistant = (provider: string | undefined): SessionEntry =>
	({ type: "message", id: "x", message: { role: "assistant", provider, content: [] } }) as unknown as SessionEntry;
const user: SessionEntry = {
	type: "message",
	id: "u",
	message: { role: "user", content: "hi" },
} as unknown as SessionEntry;
const switched = (model: unknown): SessionEntry =>
	({ type: "model_change", id: "m", parentId: null, timestamp: "", model }) as SessionEntry;

test("a conversation's providers are every one it replied with or switched to, the most recent first", () => {
	expect(providersUsed([user, assistant("openai"), user, assistant("anthropic"), user])).toEqual([
		"anthropic",
		"openai",
	]);
	expect(providersUsed([assistant("openai"), assistant(undefined)])).toEqual(["openai"]);
	expect(providersUsed([user])).toEqual([]);
	expect(providersUsed([])).toEqual([]);
});

test("a model change names a provider too, even before the new model has answered", () => {
	const path = [assistant("anthropic"), user, switched("openai-codex/gpt-5.2:high")];
	expect(providersUsed(path)).toEqual(["openai-codex", "anthropic"]);
	// A bare model id, or something that is not a model reference, names no provider.
	expect(providersUsed([switched("gpt-5.2"), switched(undefined), switched("/x")])).toEqual([]);
});

test("the running process's provider leads, and none is listed twice", () => {
	const path = [assistant("openai"), assistant("anthropic"), switched("openai/gpt-5.2")];
	expect(providersUsed(path, "anthropic")).toEqual(["anthropic", "openai"]);
	expect(providersUsed([], "google")).toEqual(["google"]);
	expect(providersUsed(path, null)).toEqual(["openai", "anthropic"]);
});

test("the guard's reviewer and the subagents spend quota too: their providers are listed after the conversation's own (#688)", () => {
	const reviewed = {
		type: "model_usage",
		id: "r",
		purpose: "guard",
		provider: "openai-codex",
		model: "gpt",
	} as unknown as SessionEntry;
	expect(providersUsed([assistant("anthropic"), reviewed], "anthropic")).toEqual(["anthropic", "openai-codex"]);
	// From the subagents' and advisors' own transcripts: last, and none twice.
	expect(providersUsed([assistant("anthropic")], "anthropic", false, [], ["google", "anthropic"])).toEqual([
		"anthropic",
		"google",
	]);
	// A process on a local server spends none of them.
	expect(providersUsed([reviewed], "omlx", true, [], ["google"])).toEqual(["omlx"]);
});

const exhausted = (id: string, resetsAt?: number) => ({
	...pct(id, 0, "exhausted"),
	...(resetsAt === undefined ? {} : { window: { resetsAt } }),
});

test("a provider is used up when every account is, and recovers when its soonest account does", () => {
	expect(exhaustion([account("a@x.org", [exhausted("5h", 5000)])], "anthropic")).toEqual({ resetsAt: 5000 });
	const two = [account("a@x.org", [exhausted("5h", 9000)]), account("b@x.org", [exhausted("5h", 4000)])];
	expect(exhaustion(two, "anthropic")).toEqual({ resetsAt: 4000 });
	// One account with capacity left: not used up.
	expect(exhaustion([...two, account("c@x.org", [pct("5h", 0.4)])], "anthropic")).toBeNull();
});

test("an account recovers only when its last used-up window does", () => {
	const weekly = account("a@x.org", [exhausted("5h", 3000), exhausted("7d", 90_000), pct("opus", 0.5)]);
	expect(exhaustion([weekly], "anthropic")).toEqual({ resetsAt: 90_000 });
});

test("used up with no reset time to give: exhausted, resetting at an unknown time", () => {
	expect(exhaustion([account(undefined, [exhausted("5h")])], "anthropic")).toEqual({ resetsAt: null });
	// One account that cannot say does not hide the other's reset.
	const mixed = [account("a@x.org", [exhausted("5h")]), account("b@x.org", [exhausted("5h", 7000)])];
	expect(exhaustion(mixed, "anthropic")).toEqual({ resetsAt: 7000 });
});

test("a window that omp reports as used up by its status or by its share counts, others do not", () => {
	expect(isExhausted(limit("a", { remaining: 0, limit: 100 }))).toBe(true);
	expect(isExhausted(limit("b", { remainingFraction: 0.4 }, "exhausted"))).toBe(true);
	expect(isExhausted(limit("c", { remainingFraction: 0.01 }))).toBe(false);
	expect(isExhausted(limit("d", { used: 3 }))).toBe(false);
});

test("without usage data a provider is never used up", () => {
	expect(exhaustion([], "anthropic")).toBeNull();
	expect(exhaustion([account("a@x.org", [])], "anthropic")).toBeNull();
	expect(exhaustion([account("a@x.org", [exhausted("5h", 5000)], "openai")], "anthropic")).toBeNull();
});

test("levels: critical under 10% or when omp says the window is exhausted", () => {
	expect(quotaLevel(0.5)).toBe("ok");
	expect(quotaLevel(0.24)).toBe("low");
	expect(quotaLevel(0.05)).toBe("critical");
	expect(quotaLevel(0.8, "exhausted")).toBe("critical");
});

test("offline, only the running process's provider is listed: the history's cloud providers are not spent", () => {
	const path = [assistant("anthropic"), assistant("openai-codex"), switched("openai/gpt-5.2")];
	expect(providersUsed(path, "omlx", true)).toEqual(["omlx"]);
	expect(providersUsed(path, null, true)).toEqual([]);
	expect(providersUsed(path, undefined, true)).toEqual([]);
	// Online the history counts as before.
	expect(providersUsed(path, "omlx")).toEqual(["omlx", "openai", "openai-codex", "anthropic"]);
});

// ---------------------------------------------------------------- windows scoped to models (omp's `UsageScope`)

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const sharedWindow = (id: string, resetsAt: number, fraction = 0): UsageLimit => ({
	...pct(id, fraction, fraction === 0 ? "exhausted" : "ok"),
	window: { resetsAt },
	scope: { shared: true },
});
/** omp's Anthropic rows: `tier` is the model family (`opus`, `sonnet`, `fable`, …) and the row is not `shared`. */
const tierWindow = (tier: string, resetsAt: number, fraction = 0): UsageLimit => ({
	...pct(`7d:${tier}`, fraction, fraction === 0 ? "exhausted" : "ok"),
	window: { resetsAt },
	scope: { tier },
});
const SONNET = "claude-sonnet-5-5";
const OPUS = "claude-opus-5-1";

test("a used-up tier window of another model does not stretch the wait: shared 5h +1h, Opus weekly +4d, Sonnet turn", () => {
	const reports = [account("a@x.org", [sharedWindow("5h", HOUR), tierWindow("opus", 4 * DAY)])];
	expect(exhaustion(reports, "anthropic", SONNET)).toEqual({ resetsAt: HOUR });
	// The Opus turn waits for both.
	expect(exhaustion(reports, "anthropic", OPUS)).toEqual({ resetsAt: 4 * DAY });
	// Without a model only the shared windows count, as in omp.
	expect(exhaustion(reports, "anthropic")).toEqual({ resetsAt: HOUR });
});

test("an Opus-only window that is used up is not 'used up' for a Sonnet model, and is for an Opus model", () => {
	const reports = [account("a@x.org", [sharedWindow("5h", HOUR, 0.6), tierWindow("opus", 4 * DAY)])];
	expect(exhaustion(reports, "anthropic", SONNET)).toBeNull();
	expect(exhaustion(reports, "anthropic", OPUS)).toEqual({ resetsAt: 4 * DAY });
	// The pill's figure follows: the tightest window is the shared one for Sonnet, the empty Opus one for Opus.
	expect(bestAccount(reports, "anthropic", SONNET)?.tightest.limit.id).toBe("5h");
	expect(bestAccount(reports, "anthropic", SONNET)?.tightest.level).toBe("ok");
	expect(bestAccount(reports, "anthropic", OPUS)?.tightest.limit.id).toBe("7d:opus");
	expect(bestAccount(reports, "anthropic", OPUS)?.tightest.level).toBe("critical");
	// Every window is still listed for the popover.
	expect(bestAccount(reports, "anthropic", SONNET)?.windows.map((w) => w.limit.id)).toEqual(["5h", "7d:opus"]);
});

test("a window without a scope is shared, and so is one with an empty scope, even next to scoped ones", () => {
	const reports = [
		account("a@x.org", [
			sharedWindow("5h", 1000),
			exhausted("daily", 2000),
			{ ...exhausted("7d", 9000), scope: {} },
			tierWindow("opus", 99_000),
		]),
	];
	expect(exhaustion(reports, "anthropic", SONNET)).toEqual({ resetsAt: 9000 });
});

test("a window scoped to one model counts for that model only; names are compared without case, dashes or dots", () => {
	const pro: UsageLimit = { ...exhausted("pro", 7000), scope: { modelId: "gemini-2.5-pro" } };
	const reports = [account("a@x.org", [sharedWindow("daily", 3000, 0.5), pro], "google-gemini-cli")];
	expect(exhaustion(reports, "google-gemini-cli", "gemini-2.5-pro")).toEqual({ resetsAt: 7000 });
	expect(exhaustion(reports, "google-gemini-cli", "Gemini 2.5 Pro")).toEqual({ resetsAt: 7000 });
	expect(exhaustion(reports, "google-gemini-cli", "gemini-2.5-flash")).toBeNull();
});

test("an account whose windows have no shared one is not scoped: plan-named tiers must not hide its windows", () => {
	const copilot: UsageLimit = { ...exhausted("premium", 5000), scope: { tier: "individual" } };
	expect(exhaustion([account("a@x.org", [copilot], "github-copilot")], "github-copilot", "gpt-5.2")).toEqual({
		resetsAt: 5000,
	});
});

test("scoping is per account: another account with capacity for the model still keeps the provider usable", () => {
	const reports = [
		account("a@x.org", [sharedWindow("5h", HOUR, 0.5), tierWindow("opus", 4 * DAY)]),
		account("b@x.org", [sharedWindow("5h", 2 * HOUR), tierWindow("sonnet", 3 * DAY)]),
	];
	// a's Sonnet is fine, so the provider is not used up for Sonnet; for Opus a is held back by its weekly cap, b by its 5h.
	expect(exhaustion(reports, "anthropic", SONNET)).toBeNull();
	expect(exhaustion(reports, "anthropic", OPUS)).toEqual({ resetsAt: 2 * HOUR });
});

// ---------------------------------------------------------------- OpenAI: the pill follows the 5-hour window

const FIVE_HOURS = 5 * HOUR;
const WEEK = 7 * DAY;
/** omp's OpenAI rows (`openai-codex:primary` / `:secondary`): the window's id and duration say which one it is. */
const codexWindow = (
	key: "primary" | "secondary",
	durationMs: number,
	fraction: number,
	resetsAt: number,
	status = fraction === 0 ? "exhausted" : "ok",
): UsageLimit => ({
	id: `openai-codex:${key}`,
	label: durationMs >= DAY ? `${durationMs / DAY} days` : `${durationMs / HOUR} hours`,
	scope: { shared: true },
	window: { id: durationMs >= DAY ? `${durationMs / DAY}d` : `${durationMs / HOUR}h`, durationMs, resetsAt },
	amount: { remainingFraction: fraction, unit: "percent" },
	status,
});
const fiveHourWindow = (fraction: number, resetsAt = 2 * HOUR) =>
	codexWindow("primary", FIVE_HOURS, fraction, resetsAt);
const weeklyWindow = (fraction: number, resetsAt = 3 * DAY) => codexWindow("secondary", WEEK, fraction, resetsAt);
const codex = (limits: UsageLimit[], email = "o@x.org") => account(email, limits, "openai-codex");

test("OpenAI: the pill shows the 5-hour window while the weekly one is lower but not used up", () => {
	const best = bestAccount([codex([fiveHourWindow(0.8), weeklyWindow(0.05)])], "openai-codex");
	expect(best?.headline.limit.window?.durationMs).toBe(FIVE_HOURS);
	expect(best?.headline.fraction).toBe(0.8);
	expect(best?.headline.level).toBe("ok");
	// The tightest window is still the weekly one: it is what the popover's warning colours follow.
	expect(best?.tightest.limit.id).toBe("openai-codex:secondary");
});

test("OpenAI: the 5-hour window is found by its duration, not by its place in the list or its key", () => {
	const reversed = bestAccount([codex([weeklyWindow(0.05), fiveHourWindow(0.8)])], "openai-codex");
	expect(reversed?.headline.fraction).toBe(0.8);
	// A plan whose first window is the weekly one: nothing is five hours long, so it stays the tightest.
	const weeklyOnly = bestAccount([codex([codexWindow("primary", WEEK, 0.3, 3 * DAY)])], "openai-codex");
	expect(weeklyOnly?.headline.fraction).toBe(0.3);
	// A window that omp gave no duration (a fallback "Primary window") is not taken for the 5-hour one.
	const unknown: UsageLimit = { ...fiveHourWindow(0.9), window: { id: "primary", resetsAt: HOUR } };
	expect(bestAccount([codex([unknown, weeklyWindow(0.2)])], "openai-codex")?.headline.fraction).toBe(0.2);
});

test("OpenAI: once the weekly window is used up the pill shows it, whatever the 5-hour one has left", () => {
	const list = accountQuotas([codex([fiveHourWindow(0.8), weeklyWindow(0)])], "openai-codex");
	expect(list[0]?.headline.limit.id).toBe("openai-codex:secondary");
	expect(list[0]?.headline.level).toBe("critical");
	// A weekly window omp flags as exhausted counts too, even with a share that rounds above zero.
	const flagged = codex([fiveHourWindow(0.8), codexWindow("secondary", WEEK, 0.004, 3 * DAY, "exhausted")]);
	expect(accountQuotas([flagged], "openai-codex")[0]?.headline.limit.id).toBe("openai-codex:secondary");
	// And the provider is used up until that reset, which is the countdown the pill shows.
	expect(exhaustion([codex([fiveHourWindow(0.8), weeklyWindow(0, 3 * DAY)])], "openai-codex")).toEqual({
		resetsAt: 3 * DAY,
	});
});

test("OpenAI: a used-up 5-hour window shows itself while the weekly one has capacity", () => {
	const best = bestAccount([codex([fiveHourWindow(0), weeklyWindow(0.6)])], "openai-codex");
	expect(best?.headline.fraction).toBe(0);
	expect(best?.headline.limit.window?.durationMs).toBe(FIVE_HOURS);
});

test("OpenAI: both windows stay listed for the popover, and accounts rank by what their pill shows", () => {
	const list = accountQuotas(
		[
			codex([fiveHourWindow(0.8), weeklyWindow(0.05)], "a@x.org"),
			codex([fiveHourWindow(0.3), weeklyWindow(0.9)], "b@x.org"),
			codex([fiveHourWindow(0.95), weeklyWindow(0)], "c@x.org"),
		],
		"openai-codex",
	);
	expect(list.map((a) => a.name)).toEqual(["a@x.org", "b@x.org", "c@x.org"]);
	expect(list[0]?.windows.map((w) => w.limit.id)).toEqual(["openai-codex:primary", "openai-codex:secondary"]);
	expect(list[2]?.windows).toHaveLength(2);
});

test("OpenAI: a model-specific meter (Spark) neither makes the pill nor takes the chat window's place", () => {
	const spark = (key: "primary" | "secondary", duration: number, fraction: number): UsageLimit => ({
		...codexWindow(key, duration, fraction, HOUR),
		id: `openai-codex:spark:${key}`,
		label: `${duration >= DAY ? "7 days" : "5 hours"} (Spark)`,
		scope: { shared: true, tier: "spark", modelId: "GPT-5.3-Codex-Spark" },
	});
	const limits = [
		fiveHourWindow(0.7),
		weeklyWindow(0.4),
		spark("primary", FIVE_HOURS, 0.1),
		spark("secondary", WEEK, 0.2),
	];
	expect(bestAccount([codex(limits)], "openai-codex", "gpt-5.2")?.headline.fraction).toBe(0.7);
	// A Spark model spends the Spark meter's own 5-hour window.
	expect(bestAccount([codex(limits)], "openai-codex", "gpt-5.3-codex-spark")?.headline.fraction).toBe(0.1);
	expect(bestAccount([codex(limits)], "openai-codex")?.windows).toHaveLength(4);
});

test("other providers keep showing their tightest window, even with a 5-hour one and a used-up weekly one", () => {
	const timed = (id: string, duration: number, fraction: number): UsageLimit => ({
		...pct(id, fraction),
		window: { durationMs: duration },
	});
	const limits = [timed("5h", FIVE_HOURS, 0.8), timed("7d", WEEK, 0.05)];
	const best = bestAccount([account("a@x.org", limits)], "anthropic");
	expect(best?.headline.limit.id).toBe("7d");
	expect(best?.headline).toBe(best?.tightest);
	const gone = bestAccount([account("a@x.org", [timed("5h", FIVE_HOURS, 0.8), timed("7d", WEEK, 0)])], "anthropic");
	expect(gone?.headline.limit.id).toBe("7d");
	const other = bestAccount([account("a@x.org", limits, "google-gemini-cli")], "google-gemini-cli");
	expect(other?.headline.limit.id).toBe("7d");
});

// ---------------------------------------------------------------- credits fund the overage of a spent OpenAI window (#335)

const creditOverage: UsageReport[] = JSON.parse(
	readFileSync(join(import.meta.dir, "../fixtures/openai-credit-overage-usage.json"), "utf8"),
);

test("OpenAI on credits: windows omp marks 'warning' at 0% left are not used up, so no 'used up' pill and no countdown (#335)", () => {
	expect(creditOverage[0]?.limits.map((l) => isExhausted(l))).toEqual([false, false]);
	expect(exhaustion(creditOverage, "openai-codex")).toBeNull();
	const best = bestAccount(creditOverage, "openai-codex");
	expect(best?.headline.limit.window?.durationMs).toBe(FIVE_HOURS);
	expect(best?.headline.fraction).toBe(0);
	expect(best?.windows).toHaveLength(2);
});

test("a spent window omp does not call 'warning' is still used up, and a 'warning' with a share is not", () => {
	expect(isExhausted(pct("5h", 0))).toBe(true);
	expect(isExhausted(pct("5h", 0, "ok"))).toBe(true);
	expect(isExhausted(pct("5h", 0, "exhausted"))).toBe(true);
	expect(isExhausted(pct("5h", 0.05, "warning"))).toBe(false);
	// Without credits omp says `exhausted` at 100%: the same window is used up.
	const blocked = [
		{ ...creditOverage[0], limits: creditOverage[0]?.limits.map((l) => ({ ...l, status: "exhausted" })) },
	];
	expect(exhaustion(blocked as UsageReport[], "openai-codex")).toEqual({ resetsAt: 1792007200000 + 252_000_000 });
});

test("the quota ring fills as many percent as the pill says, and is clamped to the circle", () => {
	expect(ringShare(0)).toBe(0);
	expect(ringShare(0.53)).toBe(53);
	expect(ringShare(0.005)).toBe(1);
	expect(ringShare(0.994)).toBe(99);
	expect(ringShare(1)).toBe(100);
	expect(ringShare(1.4)).toBe(100);
	expect(ringShare(-0.2)).toBe(0);
	expect(ringShare(Number.NaN)).toBe(0);
	// The share and the tone come from the same window: a share just under a threshold is the next level.
	expect(quotaLevel(0.25)).toBe("ok");
	expect(quotaLevel(0.24)).toBe("low");
	expect(quotaLevel(0.1)).toBe("low");
	expect(quotaLevel(0.09)).toBe("critical");
});
