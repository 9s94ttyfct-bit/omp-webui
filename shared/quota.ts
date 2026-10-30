import type { UsageLimit, UsageReport } from "./protocol.ts";

/**
 * What `omp usage --json` says about a provider, read the same way by the page (the quota pills) and the server (when
 * a conversation waits out a usage limit): the share of a window left, whether it is used up, and when a provider's
 * usage frees up again.
 */

/**
 * How often a conversation that is working looks at its provider's quota: a turn spends quota the whole time it runs,
 * and the figures a page shows are otherwise minutes out of date (#458).
 */
export const QUOTA_REFRESH_MS = 30_000;

/**
 * How often the quota is looked at while nothing runs: a conversation nobody works in spends no quota, and every look
 * starts a process that asks the provider.
 */
export const QUOTA_IDLE_REFRESH_MS = 120_000;

/**
 * How long the server keeps a provider's figures before it asks `omp usage` again. It is shorter than
 * {@link QUOTA_REFRESH_MS}, so a look that is this old is answered from the cache and the page's figures are never
 * older than one interval: one `omp usage` per provider per interval, however many conversations and tabs ask.
 */
export const QUOTA_TTL_MS = 25_000;

/** Share of a usage window still available (0–1), or null when omp gives no basis for it. */
export function remainingFraction(l: UsageLimit): number | null {
	const a = l.amount;
	if (typeof a.remainingFraction === "number") return clamp(a.remainingFraction);
	if (typeof a.remaining === "number" && typeof a.limit === "number" && a.limit > 0)
		return clamp(a.remaining / a.limit);
	if (typeof a.usedFraction === "number") return clamp(1 - a.usedFraction);
	return null;
}

const clamp = (n: number) => Math.min(1, Math.max(0, n));

/** A window status that says nothing is left (`exhausted`, and the other wordings providers use for it). */
export const exhaustedStatus = (status: string | undefined): boolean =>
	status !== undefined && /exhaust|exceed|blocked|limit/i.test(status);

/**
 * Whether omp reports the window as used up: its status says so, or a known amount has nothing left.
 *
 * Exception: omp marks a spent window `warning`, not `exhausted`, when it still serves requests (OpenAI credits fund the
 * overage of a spent plan window, `buildUsageStatus` in omp's `usage/openai-codex.ts`): that explicit verdict beats the share.
 */
export function isExhausted(l: UsageLimit): boolean {
	if (exhaustedStatus(l.status)) return true;
	return l.status !== "warning" && remainingFraction(l) === 0;
}

/** Case, dashes and dots do not tell models apart: `claude-sonnet-5-5` and `Claude Sonnet 5.5` are the same name. */
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** A window omp scopes to some models: it names a tier or a model and is not the account's umbrella (`shared`). */
const isModelScoped = (l: UsageLimit): boolean => {
	const s = l.scope;
	return s !== undefined && s.shared !== true && Boolean(s.tier || s.modelId);
};

/** Whether a model-scoped window is spent by `model` (a bare model id): its tier is in the id (`opus` in `claude-opus-5`) or its model is the one. */
function spentBy(l: UsageLimit, model: string): boolean {
	const key = squash(model);
	if (!key) return false;
	const tier = squash(l.scope?.tier ?? "");
	if (tier && key.includes(tier)) return true;
	const id = squash(l.scope?.modelId ?? "");
	return id !== "" && (key.includes(id) || id.includes(key));
}

/**
 * The windows a request to `model` (a bare model id, as `get_state` reports it) draws on, as omp gates it: the shared
 * windows, the ones without a scope, and the model-scoped ones that are the model's own. An Opus-only weekly cap
 * does not stop a Sonnet request. Without a model only the shared and unscoped ones remain.
 *
 * Only where the account has a shared window to scope against: omp scopes per provider, and some name a plan
 * (`tier: "individual"`) rather than a model family, which must not make every window of theirs vanish.
 */
export function limitsFor(limits: UsageLimit[], model?: string | null): UsageLimit[] {
	if (!limits.some((l) => l.scope?.shared === true)) return limits;
	return limits.filter((l) => !isModelScoped(l) || (model ? spentBy(l, model) : false));
}

/** A provider whose every account is used up: `resetsAt` (epoch ms) is when the first of them frees up, null when omp does not say. */
export interface Exhaustion {
	resetsAt: number | null;
}

/**
 * Whether `provider` is used up for `model`, and until when. An account recovers when the last of its used-up windows
 * the model draws on ({@link limitsFor}) resets, and the provider when its first account does. Not used up as long as
 * one account has capacity; accounts that report no windows say nothing and are ignored, so a provider without usage
 * data is never "used up".
 */
export function exhaustion(reports: UsageReport[], provider: string, model?: string | null): Exhaustion | null {
	const accounts = reports.filter((r) => r.provider === provider && r.limits.length > 0);
	if (accounts.length === 0) return null;
	let soonest: number | null = null;
	for (const account of accounts) {
		const used = limitsFor(account.limits, model).filter(isExhausted);
		if (used.length === 0) return null;
		let recovers: number | null = 0;
		for (const w of used) {
			const at = w.window?.resetsAt;
			if (typeof at !== "number") {
				recovers = null;
				break;
			}
			recovers = Math.max(recovers, at);
		}
		if (recovers !== null && (soonest === null || recovers < soonest)) soonest = recovers;
	}
	return { resetsAt: soonest };
}
