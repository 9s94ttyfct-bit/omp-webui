import type { SessionEntry, UsageLimit, UsageReport } from "@shared/protocol.ts";
import { exhaustedStatus, isExhausted, limitsFor, remainingFraction } from "@shared/quota.ts";
import { Fold } from "./lineage.ts";
import { messageOf } from "./messages.ts";

export type QuotaLevel = "ok" | "low" | "critical";

export function quotaLevel(fraction: number, status?: string): QuotaLevel {
	if (exhaustedStatus(status)) return "critical";
	if (fraction < 0.1) return "critical";
	if (fraction < 0.25) return "low";
	return "ok";
}

/** The share of a quota ring that is filled, in whole percent (0-100): the figure the pill says, drawn as an arc. */
export function ringShare(fraction: number): number {
	return Number.isFinite(fraction) ? Math.min(100, Math.max(0, Math.round(fraction * 100))) : 0;
}

export interface WindowQuota {
	limit: UsageLimit;
	fraction: number;
	level: QuotaLevel;
}

/** One account of a provider: `omp usage` returns one report per account. */
export interface AccountQuota {
	/** The account's email, when omp reports one. */
	name: string | null;
	/** Every window with a known share. */
	windows: WindowQuota[];
	/** The window with the least left among those the model draws on: what limits this account's next request. */
	tightest: WindowQuota;
	/**
	 * The window the pill shows for this account: the {@link tightest} one, except for OpenAI, whose pill follows the
	 * 5-hour window (the weekly one only once it is used up and really blocks requests).
	 */
	headline: WindowQuota;
}

/** omp's id for the ChatGPT-subscription provider, the one `omp usage` reports 5-hour and weekly windows for. */
const OPENAI = "openai-codex";
const HOUR_MS = 3_600_000;
/** Durations are compared to the minute, as omp does for the same windows. */
const DURATION_SLACK_MS = 60_000;
const hasDuration = (w: WindowQuota, ms: number): boolean => {
	const d = w.limit.window?.durationMs;
	return typeof d === "number" && Math.abs(d - ms) <= DURATION_SLACK_MS;
};

/**
 * The window an OpenAI account's pill shows, or null when it has no 5-hour window (then the tightest one is shown).
 * omp ids OpenAI's windows by position (`openai-codex:primary` is not always the 5-hour one: some plans have only a
 * weekly window), so a window is the 5-hour one by its duration. Of the windows the model draws on, a Spark model
 * spends the Spark meter's, any other model the chat meter's (the ones without a tier). The weekly window takes the
 * pill's place when it is used up: then the 5-hour share says nothing about whether a request goes through.
 */
function openaiHeadline(windows: WindowQuota[], own: Set<UsageLimit>, model?: string | null): WindowQuota | null {
	const drawn = windows.filter((w) => own.has(w.limit));
	const key = (model ?? "").toLowerCase();
	const tiered = drawn.filter((w) => w.limit.scope?.tier && key.includes(w.limit.scope.tier.toLowerCase()));
	const meter = tiered.length > 0 ? tiered : drawn.filter((w) => !w.limit.scope?.tier);
	const fiveHour = meter.find((w) => hasDuration(w, 5 * HOUR_MS));
	if (!fiveHour) return null;
	const weekly = meter.find((w) => hasDuration(w, 7 * 24 * HOUR_MS));
	return weekly && isExhausted(weekly.limit) ? weekly : fiveHour;
}

/**
 * A provider's accounts that have usable data, the one whose pill figure has the most capacity left first (ties: listed order).
 * `model` (a bare model id): a window scoped to other models, like an Opus-only weekly cap while a Sonnet model
 * works, is listed but is never an account's tightest.
 */
export function accountQuotas(reports: UsageReport[], provider: string, model?: string | null): AccountQuota[] {
	const out: AccountQuota[] = [];
	for (const r of reports) {
		if (r.provider !== provider) continue;
		const own = new Set(limitsFor(r.limits, model));
		const windows: WindowQuota[] = [];
		for (const limit of r.limits) {
			const fraction = remainingFraction(limit);
			if (fraction !== null) windows.push({ limit, fraction, level: quotaLevel(fraction, limit.status) });
		}
		const tightest = windows.reduce<WindowQuota | null>(
			(a, w) => (own.has(w.limit) && (!a || w.fraction < a.fraction) ? w : a),
			null,
		);
		if (!tightest) continue;
		const headline = (provider === OPENAI ? openaiHeadline(windows, own, model) : null) ?? tightest;
		out.push({ name: r.metadata?.email || null, windows, tightest, headline });
	}
	return out.sort((a, b) => b.headline.fraction - a.headline.fraction);
}

export function bestAccount(reports: UsageReport[], provider: string, model?: string | null): AccountQuota | null {
	return accountQuotas(reports, provider, model)[0] ?? null;
}

/** The provider of a model reference (`anthropic/claude-haiku-5-5:low`), or undefined for a bare model id. */
function providerOfModel(model: unknown): string | undefined {
	if (typeof model !== "string") return undefined;
	const slash = model.indexOf("/");
	return slash > 0 ? model.slice(0, slash) : undefined;
}

/**
 * Every provider a conversation has talked to or switched to, from its transcript: the provider of each assistant
 * message, of each model change and of each request omp made on the side (`model_usage`: the guard's reviewer, a judge),
 * the most recently used first. The running process's own provider (`current`) comes before them, since it is what the
 * next request spends. Whose quota a saved conversation would spend, and not only the last one's: a conversation that
 * mixes providers draws on each (#688).
 *
 * `local`: the process runs on a local server's models and spends nothing of the cloud providers its history may name, so
 * only its own provider is listed (none while it has not said which).
 *
 * A page that holds only the end of a long conversation passes the providers the rest of it used (`older`, oldest first,
 * as the session list names the models): they come after every provider the entries name. `others`: the providers its
 * subagents and advisors spent, from their own transcripts; they come last.
 */
export function providersUsed(
	entries: SessionEntry[],
	current?: string | null,
	local = false,
	older: readonly string[] = [],
	others: readonly string[] = [],
): string[] {
	if (local) return current ? [current] : [];
	const seen = new Set<string>();
	if (current) seen.add(current);
	// Most recently used first: the map holds each provider at the place of its last use, oldest first.
	for (const provider of [...recent.run(entries)].reverse()) seen.add(provider);
	for (const provider of [...older].reverse()) seen.add(provider);
	for (const provider of others) seen.add(provider);
	return [...seen];
}

const recent = new Fold<SessionEntry, Set<string>>(
	() => new Set(),
	(used, entries, from) => {
		for (let i = from; i < entries.length; i++) {
			const e = entries[i] as SessionEntry;
			const provider =
				e.type === "model_change"
					? providerOfModel(e.model)
					: e.type === "model_usage"
						? typeof e.provider === "string" && e.provider
							? e.provider
							: undefined
						: messageOf(e)?.provider;
			if (!provider) continue;
			used.delete(provider);
			used.add(provider);
		}
		return used;
	},
	true,
);
