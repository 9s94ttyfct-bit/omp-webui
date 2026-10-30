import type {
	GuardConfig,
	GuardLogPage,
	GuardLogQuery,
	GuardOverridePatch,
	LiveGuard,
	RulesPatch,
} from "@shared/guard.ts";
import type { BenchInfo, BenchPreview, BenchRun } from "@shared/guard-bench.ts";
import type { GuardDefaults, GuardRules, Threshold } from "@shared/guard-policy.ts";
import type { RiskKind } from "@shared/risk-confirm.ts";
import { useApp } from "../store/app.ts";
import { onGuardMessage, useGuard } from "../store/guard.ts";

/** `/api/guard*`: the settings, what the person tuned, the log of the decisions and the benchmark. Every route answers 403 to a page that came through the tunnel. */

async function request<T>(path: string, init?: RequestInit): Promise<T> {
	const res = await fetch(path, init);
	const body = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(typeof body.error === "string" ? body.error : res.statusText);
	return body as T;
}

/** The settings as the server keeps them now, which every page of this computer shows (as it does when told by the socket). */
function kept({ config }: { config: GuardConfig }): GuardConfig {
	onGuardMessage({ t: "guard_config", config });
	return config;
}

/** What the person tuned, as the server keeps it now, and the shipped defaults it is measured against. */
export interface GuardRulesAnswer {
	rules: GuardRules;
	defaults: GuardDefaults;
}

function keptRules(answer: GuardRulesAnswer): GuardRulesAnswer {
	useGuard.setState({ rules: answer.rules });
	return answer;
}

const WRITE_HEADERS = { "content-type": "application/json", "x-omp-webui": "1" };

/** The query string of a log request: only what is set. */
function logQuery(q: GuardLogQuery): string {
	const params = new URLSearchParams({ limit: String(q.limit) });
	if (q.before) params.set("before", q.before);
	if (q.outcome) params.set("outcome", q.outcome);
	if (q.by) params.set("by", q.by);
	if (q.text?.trim()) params.set("q", q.text.trim());
	if (q.conversation) params.set("conversation", q.conversation);
	return params.toString();
}

export const guardApi = {
	config: () => request<{ config: GuardConfig }>("/api/guard").then(kept),
	/** Change some of the settings: the server answers with all of them, as it keeps them now. */
	change: (patch: Partial<GuardConfig>) =>
		request<{ config: GuardConfig }>("/api/guard", {
			method: "POST",
			headers: WRITE_HEADERS,
			body: JSON.stringify(patch),
		}).then(kept),
	/** What the person tuned (the reviewer's rules, a threshold per category, their benchmark cases) and the shipped defaults. */
	rules: () => request<GuardRulesAnswer>("/api/guard/rules").then(keptRules),
	/** Change some of what the person tuned: the server answers with all of it, as it keeps it now. */
	changeRules: (patch: RulesPatch) =>
		request<GuardRulesAnswer>("/api/guard/rules", {
			method: "POST",
			headers: WRITE_HEADERS,
			body: JSON.stringify(patch),
		}).then(keptRules),
	/**
	 * Change what one conversation chose of the guard over these settings: a field named is set, one set to `null` follows
	 * the settings again, and `null` for all of them leaves it with nothing of its own. The server answers with what the
	 * conversation is under now, which its page shows at once (the `live` frame that says the same follows).
	 */
	conversation: (liveId: string, guard: GuardOverridePatch | null) =>
		request<{ guard: LiveGuard | undefined }>("/api/guard/live", {
			method: "POST",
			headers: WRITE_HEADERS,
			body: JSON.stringify({ liveId, guard }),
		}).then(({ guard: now }) => {
			useApp.setState((s) => {
				const live = s.lives[liveId];
				if (!live || !now) return s;
				return { lives: { ...s.lives, [liveId]: { ...live, info: { ...live.info, guard: now } } } };
			});
			return now;
		}),
	/** A page of the decisions that match, newest first. */
	log: (query: GuardLogQuery) => request<GuardLogPage>(`/api/guard/log?${logQuery(query)}`),
	/** What the benchmark offers, and the run so far. */
	bench: () => request<BenchInfo>("/api/guard/bench"),
	/** Begin a run by the settings as they are now; `reviewer`: put the reviewer model to work (it costs tokens). */
	startBench: (reviewer: boolean) =>
		request<{ run: BenchRun }>("/api/guard/bench", {
			method: "POST",
			headers: WRITE_HEADERS,
			body: JSON.stringify({ reviewer }),
		}),
	cancelBench: () =>
		request<{ cancelled: boolean }>("/api/guard/bench/cancel", { method: "POST", headers: WRITE_HEADERS }),
	/** How many shipped harmful cases would run unasked now, and with these thresholds (the classifier alone; nothing is run). */
	preview: (thresholds: Partial<Record<RiskKind, Threshold | null>>) =>
		request<{ preview: BenchPreview }>("/api/guard/bench/preview", {
			method: "POST",
			headers: WRITE_HEADERS,
			body: JSON.stringify({ thresholds }),
		}).then((r) => r.preview),
};
