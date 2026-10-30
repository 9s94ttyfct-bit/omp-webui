import {
	CASES_MAX,
	DEFAULT_POLICY_VERSION,
	type GuardRules,
	isDefaultPolicy,
	isThreshold,
	normalizePolicy,
	POLICY_MAX,
	parseRules,
	parseThresholds,
	parseUserCase,
	policyProblem,
	SETTABLE_KINDS,
	settableTo,
	type Threshold,
	type Thresholds,
	type UserCase,
} from "./guard-policy.ts";
import { RISK_KINDS, type RiskKind } from "./risk-confirm.ts";

/**
 * "Guard dangerous commands" (Settings › Safety): what the setting is, what the server tells the gate inside omp, and
 * what the gate writes down about each decision. One module with no imports but a type, because the gate runs inside
 * omp's own process, copied next to `shared/remote-risk.ts` (see `server/omp/gate/install.ts`); the server and the page
 * read the same file.
 *
 * What it is: every conversation's omp, the main agent's and each subagent's, is started with the gate (`#608`). With
 * the guard on, a call the classifier (`shared/remote-risk.ts`) calls risky is not run until it is approved: by an
 * independent reviewer model, or by the person (`ask`). Not a sandbox: a best effort that reads the command or the paths a
 * call carries.
 */

/** `off`: the gate does not look at calls (as before). `reviewer`: a reviewer model approves or refuses. `ask`: the person does. */
export const GUARD_MODES = ["off", "reviewer", "ask"] as const;
export type GuardMode = (typeof GUARD_MODES)[number];

export function isGuardMode(value: unknown): value is GuardMode {
	return typeof value === "string" && (GUARD_MODES as readonly string[]).includes(value);
}

/** The settings, as the person chose them (kept in the app's data folder, `guard.json`). */
export interface GuardConfig {
	mode: GuardMode;
	/**
	 * The reviewer model: blank lets the guard choose (a model of another family than the agent's, see
	 * `server/omp/gate/review.ts`). Otherwise a model selector, `provider/id`; several separated by commas are a chain,
	 * the first reviews and the rest are tried, in order, when it cannot be reached.
	 */
	reviewer: string;
	/**
	 * When no reviewer can be reached: ask the person about the main agent's call, if a page is open on the conversation
	 * (a subagent has nobody to ask). Off: the call is refused as "reviewer unavailable".
	 */
	askWhenUnavailable: boolean;
	/**
	 * When the reviewer denies a call: ask the person about the main agent's call, with the reviewer's reason, if a page is
	 * open on the conversation (a subagent has nobody to ask). Their Allow runs it. Off: the reviewer's denial is final.
	 */
	askWhenDenied: boolean;
}

/** A fresh install guards: the reviewer decides, and the person is asked when no reviewer can be reached or one denies. */
export const DEFAULT_GUARD_CONFIG: GuardConfig = {
	mode: "reviewer",
	reviewer: "",
	askWhenUnavailable: true,
	askWhenDenied: true,
};

/** The longest `reviewer` setting, in characters. */
export const REVIEWER_MAX = 512;

/** A change the settings refuse. */
export class GuardConfigError extends Error {}

/** Why `value` cannot be the reviewer setting (null: it can). Blank is fine: the guard chooses. */
export function reviewerProblem(value: string): "tooLong" | "invalid" | null {
	if (value.length > REVIEWER_MAX) return "tooLong";
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) return "invalid";
	}
	return null;
}

/** The selectors of the reviewer setting, in the order they are tried. */
export function reviewerSelectors(reviewer: string): string[] {
	return reviewer
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s !== "");
}

const record = (v: unknown): Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * The settings a file says. A guard that is on unless it clearly says otherwise: a field that is missing, of another
 * type or not one of the modes is the default, so a damaged file never turns the guard off.
 */
export function parseGuardConfig(raw: unknown): GuardConfig {
	const r = record(raw);
	const reviewer = typeof r.reviewer === "string" ? r.reviewer.trim() : "";
	return {
		mode: isGuardMode(r.mode) ? r.mode : DEFAULT_GUARD_CONFIG.mode,
		reviewer: reviewerProblem(reviewer) === null ? reviewer : "",
		askWhenUnavailable: r.askWhenUnavailable === false ? false : DEFAULT_GUARD_CONFIG.askWhenUnavailable,
		askWhenDenied: r.askWhenDenied === false ? false : DEFAULT_GUARD_CONFIG.askWhenDenied,
	};
}

/** A change a page asks for: the fields it names, each checked. Throws `GuardConfigError` for one that is not acceptable. */
export function parseGuardPatch(patch: unknown): Partial<GuardConfig> {
	if (typeof patch !== "object" || patch === null || Array.isArray(patch))
		throw new GuardConfigError("The change must be an object");
	const p = patch as Record<string, unknown>;
	const out: Partial<GuardConfig> = {};
	for (const key of Object.keys(p)) {
		if (key !== "mode" && key !== "reviewer" && key !== "askWhenUnavailable" && key !== "askWhenDenied")
			throw new GuardConfigError(`Unknown setting: ${key}`);
	}
	if ("mode" in p) {
		if (!isGuardMode(p.mode)) throw new GuardConfigError("mode must be off, reviewer or ask");
		out.mode = p.mode;
	}
	if ("reviewer" in p) {
		if (typeof p.reviewer !== "string") throw new GuardConfigError("reviewer must be text");
		const reviewer = p.reviewer.trim();
		const problem = reviewerProblem(reviewer);
		if (problem === "tooLong") throw new GuardConfigError(`reviewer is longer than ${REVIEWER_MAX} characters`);
		if (problem === "invalid") throw new GuardConfigError("reviewer has a character that cannot be in a model name");
		out.reviewer = reviewer;
	}
	if ("askWhenUnavailable" in p) {
		if (typeof p.askWhenUnavailable !== "boolean")
			throw new GuardConfigError("askWhenUnavailable must be true or false");
		out.askWhenUnavailable = p.askWhenUnavailable;
	}
	if ("askWhenDenied" in p) {
		if (typeof p.askWhenDenied !== "boolean") throw new GuardConfigError("askWhenDenied must be true or false");
		out.askWhenDenied = p.askWhenDenied;
	}
	return out;
}

/**
 * A change a page asks for to what the person tuned (`GuardRules`): the part it names is replaced, the rest stays. `policy`
 * `null` is the default template again, a category set to `null` is Ask again, and `cases` is the whole list.
 */
export interface RulesPatch {
	policy?: { text: string; basedOn?: number } | null;
	thresholds?: Partial<Record<RiskKind, Threshold | null>>;
	cases?: UserCase[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A change to the rules, each part checked. Throws `GuardConfigError` for one that is not acceptable. */
export function parseRulesPatch(patch: unknown): RulesPatch {
	if (!isObject(patch)) throw new GuardConfigError("The change must be an object");
	for (const key of Object.keys(patch)) {
		if (key !== "policy" && key !== "thresholds" && key !== "cases")
			throw new GuardConfigError(`Unknown setting: ${key}`);
	}
	const out: RulesPatch = {};
	if ("policy" in patch) {
		const p = patch.policy;
		if (p === null) out.policy = null;
		else {
			if (!isObject(p) || typeof p.text !== "string") throw new GuardConfigError("policy must be {text} or null");
			const problem = policyProblem(p.text);
			if (problem === "empty") throw new GuardConfigError("The rules cannot be empty: restore the default instead");
			if (problem === "tooLong") throw new GuardConfigError(`The rules are longer than ${POLICY_MAX} characters`);
			if (problem === "invalid") throw new GuardConfigError("The rules have a character that cannot be in text");
			const based = p.basedOn;
			if (
				based !== undefined &&
				!(typeof based === "number" && Number.isInteger(based) && based >= 0 && based <= DEFAULT_POLICY_VERSION)
			)
				throw new GuardConfigError("basedOn must be a version of the default rules");
			out.policy = { text: p.text, ...(based !== undefined ? { basedOn: based } : {}) };
		}
	}
	if ("thresholds" in patch) {
		const t = patch.thresholds;
		if (!isObject(t)) throw new GuardConfigError("thresholds must be an object");
		const set: Partial<Record<RiskKind, Threshold | null>> = {};
		for (const [kind, value] of Object.entries(t)) {
			if (!(RISK_KINDS as readonly string[]).includes(kind)) throw new GuardConfigError(`Unknown category: ${kind}`);
			if (!(SETTABLE_KINDS as readonly string[]).includes(kind))
				throw new GuardConfigError(`${kind} is not looked at by the guard: there is nothing to set`);
			if (value !== null && !isThreshold(value))
				throw new GuardConfigError(`${kind} must be allow, ask, block or null`);
			if (value !== null && !settableTo(kind as RiskKind, value))
				throw new GuardConfigError(`${kind} cannot be set to ${value}: the guard always looks at these`);
			set[kind as RiskKind] = value;
		}
		out.thresholds = set;
	}
	if ("cases" in patch) {
		const list = patch.cases;
		if (!Array.isArray(list)) throw new GuardConfigError("cases must be a list");
		if (list.length > CASES_MAX) throw new GuardConfigError(`At most ${CASES_MAX} cases of your own`);
		const seen = new Set<string>();
		const cases: UserCase[] = [];
		for (const [i, item] of list.entries()) {
			const c = parseUserCase(item);
			if (!c) throw new GuardConfigError(`Case ${i + 1} is not valid: it needs a command and harmful or harmless`);
			if (seen.has(c.id)) throw new GuardConfigError(`Case ${i + 1} repeats the id ${c.id}`);
			seen.add(c.id);
			cases.push(c);
		}
		out.cases = cases;
	}
	return out;
}

/** `current` with `patch` on it, cleaned the way a file's rules are read: a part at its default is not kept. */
export function applyRulesPatch(current: GuardRules, patch: RulesPatch): GuardRules {
	const next: Record<string, unknown> = { ...current };
	if (patch.policy === null) delete next.policy;
	else if (patch.policy) {
		const text = normalizePolicy(patch.policy.text);
		if (isDefaultPolicy(text)) delete next.policy;
		else
			next.policy = {
				text,
				basedOn: patch.policy.basedOn ?? current.policy?.basedOn ?? DEFAULT_POLICY_VERSION,
			};
	}
	if (patch.thresholds) {
		const merged: Record<string, unknown> = { ...current.thresholds };
		for (const [kind, value] of Object.entries(patch.thresholds)) {
			if (value === null) delete merged[kind];
			else merged[kind] = value;
		}
		next.thresholds = merged;
	}
	if (patch.cases) next.cases = patch.cases;
	return parseRules(next);
}

/**
 * What one conversation says of the guard over the global settings: only the fields it chose. A field it did not choose
 * follows the global setting, also when that changes; none at all (`null`) is a conversation that follows it entirely, which
 * every new conversation does unless the person picks otherwise. It is kept with the conversation, whatever becomes of its
 * process (`server/omp/approval.ts`, and the record of a paused one, `server/omp/parked.ts`).
 */
export interface GuardOverride {
	mode?: GuardMode;
	reviewer?: string;
	askWhenUnavailable?: boolean;
	askWhenDenied?: boolean;
}

const OVERRIDE_KEYS = ["mode", "reviewer", "askWhenUnavailable", "askWhenDenied"] as const;

/**
 * The override a stored value says, or null for none. Anything damaged (not an object, a field of another type or one that
 * is not a mode, a field that is not one of these) is none, not the part that could be read: the conversation then follows
 * the global setting, which a damaged record can never turn off.
 */
export function parseGuardOverride(raw: unknown): GuardOverride | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	const out: GuardOverride = {};
	for (const key of Object.keys(r)) {
		const value = r[key];
		if (key === "mode" && isGuardMode(value)) out.mode = value;
		else if (key === "reviewer" && typeof value === "string" && reviewerProblem(value.trim()) === null)
			out.reviewer = value.trim();
		else if ((key === "askWhenUnavailable" || key === "askWhenDenied") && typeof value === "boolean") out[key] = value;
		else return null;
	}
	return Object.keys(out).length > 0 ? out : null;
}

/** A change a page asks for to a conversation's override: a field it names is set, and `null` is "follow the global setting". */
export type GuardOverridePatch = { [K in keyof GuardOverride]?: GuardOverride[K] | null };

/** The change `patch` asks for, each field checked as the global settings' are. Throws `GuardConfigError` for one that is not acceptable. */
export function parseGuardOverridePatch(patch: unknown): GuardOverridePatch {
	if (typeof patch !== "object" || patch === null || Array.isArray(patch))
		throw new GuardConfigError("The change must be an object");
	const follow: string[] = [];
	const set: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(patch)) {
		if (value === null && (OVERRIDE_KEYS as readonly string[]).includes(key)) follow.push(key);
		else set[key] = value;
	}
	return { ...parseGuardPatch(set), ...Object.fromEntries(follow.map((key) => [key, null])) };
}

/** `current` with `patch` on it: a field set to `null` follows the global setting again. Null: nothing is left of it. */
export function applyGuardOverridePatch(
	current: GuardOverride | null,
	patch: GuardOverridePatch,
): GuardOverride | null {
	const next: Record<string, unknown> = { ...current };
	for (const key of OVERRIDE_KEYS) {
		if (!(key in patch)) continue;
		const value = patch[key];
		if (value === null || value === undefined) delete next[key];
		else next[key] = value;
	}
	return Object.keys(next).length > 0 ? (next as GuardOverride) : null;
}

/** The change that leaves a conversation with nothing of its own: every field follows the global settings. */
export const FOLLOW_GLOBAL_GUARD: GuardOverridePatch = {
	mode: null,
	reviewer: null,
	askWhenUnavailable: null,
	askWhenDenied: null,
};

/**
 * What a conversation's guard is, as every page is told it (`LiveInfo.guard`): `config` is what the guard does for it now,
 * the global settings with the conversation's own fields over them, and `own` the fields it chose itself (absent: it
 * follows the global setting entirely). A field of `config` that is not in `own` is the global setting's. `damaged`: what
 * was kept of its choices could not be read, so `config` is at least as strict as the default (see `resolveGuard`).
 */
export interface LiveGuard {
	config: GuardConfig;
	own?: GuardOverride;
	damaged?: true;
}

/** What was kept of a conversation's choices: none, choices, or a record that could not be read. */
export interface KeptGuard {
	own: GuardOverride | null;
	damaged: boolean;
}
export const NO_GUARD: KeptGuard = { own: null, damaged: false };
export const DAMAGED_GUARD: KeptGuard = { own: null, damaged: true };

/**
 * A record as it was kept: nothing (absent, or no field at all) is none; choices that can be read are those; anything else
 * (not an object, a field of another type or no mode, a field that is none of these) is damage, not the part that could be read.
 */
export function readKeptGuard(raw: unknown): KeptGuard {
	if (raw === undefined) return NO_GUARD;
	const own = parseGuardOverride(raw);
	if (own) return { own, damaged: false };
	if (typeof raw === "object" && raw !== null && !Array.isArray(raw) && Object.keys(raw).length === 0) return NO_GUARD;
	return DAMAGED_GUARD;
}

/** How a kept record is written: damage as the word `"damaged"` (which reads back as damage), none as nothing. */
export const keptJson = (kept: KeptGuard): GuardOverride | "damaged" | undefined =>
	kept.damaged ? "damaged" : (kept.own ?? undefined);

/** `off` < `reviewer` < `ask`. */
const MODE_RANK: Record<GuardMode, number> = { off: 0, reviewer: 1, ask: 2 };
export const stricterMode = (a: GuardMode, b: GuardMode): GuardMode => (MODE_RANK[a] >= MODE_RANK[b] ? a : b);

/** How strict a kept record is: Off is less than following the settings, which is less than damage (read as the default at least), which is less than Ask me. */
const keptRank = (k: KeptGuard): number =>
	k.damaged ? 2 : k.own?.mode === undefined ? 1 : k.own.mode === "off" ? 0 : k.own.mode === "reviewer" ? 2 : 3;

/**
 * The stricter of two records of one conversation (a paused one's, and the store's); at a tie the one that asks when no
 * reviewer can be reached, then the one whose reviewer's denial is final (it does not ask the person to overrule it).
 */
export function stricterKept(a: KeptGuard, b: KeptGuard): KeptGuard {
	const ra = keptRank(a);
	const rb = keptRank(b);
	if (ra !== rb) return ra > rb ? a : b;
	const asks = (k: KeptGuard) => (k.damaged || k.own?.askWhenUnavailable !== false ? 1 : 0);
	if (asks(a) !== asks(b)) return asks(b) > asks(a) ? b : a;
	return b.own?.askWhenDenied === false && a.own?.askWhenDenied !== false ? b : a;
}

/** The kept record of a paused conversation's file (`ParkedRecord.guard`, `guardDamaged`). */
export const recordKept = (r: { guard?: GuardOverride; guardDamaged?: boolean } | undefined): KeptGuard =>
	r?.guard ? { own: r.guard, damaged: false } : r?.guardDamaged ? DAMAGED_GUARD : NO_GUARD;

/**
 * What of a conversation's own choices (`mine`, damage included) goes along to another conversation that chose nothing, when
 * the move is not proven to be the same conversation moved on: only a field whose value is stricter than what that
 * conversation gets by following the settings (`resolveGuard(global, null)`), so that an Off never reaches it, a conversation
 * under Ask me does not drop to Reviewer model because the one it left chose that, and what is no stricter than the settings
 * is left following them. The reviewer is no matter of strictness and stays behind. Never damage: that is the file's.
 */
export function strictOnly(global: GuardConfig, mine: KeptGuard): KeptGuard {
	const mineNow = resolveGuard(global, mine.own, mine.damaged).config;
	const following = resolveGuard(global, null).config;
	const own: GuardOverride = {};
	if (MODE_RANK[mineNow.mode] > MODE_RANK[following.mode]) own.mode = mineNow.mode;
	// Asking the person when no reviewer can be reached is what is stricter here, as at adoption (`stricterKept`).
	if (mineNow.askWhenUnavailable && !following.askWhenUnavailable) own.askWhenUnavailable = true;
	// A reviewer's denial that is final is stricter than one the person is asked to overrule.
	if (!mineNow.askWhenDenied && following.askWhenDenied) own.askWhenDenied = false;
	return Object.keys(own).length > 0 ? { own, damaged: false } : NO_GUARD;
}

/**
 * The settings a conversation is under: `global` with the fields of `own` over them. A conversation whose kept record is
 * `damaged` is under the stricter of the global settings and the default (the reviewer decides, the person is asked when
 * none can be reached): damage can never make it Off. Whether a denial is put to the person is the global setting's: the
 * default (it is) is never stricter than it.
 */
export function resolveGuard(global: GuardConfig, own: GuardOverride | null | undefined, damaged = false): LiveGuard {
	const config: GuardConfig = { ...global };
	if (damaged) {
		config.mode = stricterMode(config.mode, DEFAULT_GUARD_CONFIG.mode);
		config.askWhenUnavailable = config.askWhenUnavailable || DEFAULT_GUARD_CONFIG.askWhenUnavailable;
	}
	const chosen: GuardOverride = {};
	for (const key of OVERRIDE_KEYS) {
		const value = own?.[key];
		if (value === undefined) continue;
		(config as unknown as Record<string, unknown>)[key] = value;
		(chosen as Record<string, unknown>)[key] = value;
	}
	return {
		config,
		...(Object.keys(chosen).length > 0 ? { own: chosen } : {}),
		...(damaged ? { damaged: true as const } : {}),
	};
}

/** What the server tells a process's gate about the guard, in its state file (`<overlay>.risk`, see `shared/risk-confirm.ts`). */
export interface GuardWord {
	mode: GuardMode;
	/** The reviewer setting's selectors (blank: the gate chooses). */
	reviewers: string[];
	askWhenUnavailable: boolean;
	/**
	 * When the reviewer denies a call, the person may overrule it (only where `page` says somebody will see the question).
	 * False while the conversation is unattended, whatever the setting: its turn never waits for the person (#752).
	 */
	askWhenDenied: boolean;
	/**
	 * Somebody is there who will see a question to the person: a page is open on this conversation, or the macOS app is
	 * running in the background and will tell them (it reads `/api/shell/events`, and Settings has notifications on).
	 * Neither: no question is asked, a call no reviewer could be reached for is refused, and a reviewer's denial is final.
	 */
	page: boolean;
	/** The file the gate appends its decisions to, one JSON line each (`GuardDecision`). */
	log: string;
	/** The app's own files and folders (its data, the process's settings overlay): a call that names one is refused, whoever would approve it. */
	own: string[];
	/** What each category of risky call is set to; absent where all are Ask (`shared/guard-policy.ts`). */
	thresholds?: Thresholds;
	/** The reviewer's rules as the person wrote them; absent where it follows the default template. */
	policy?: string;
}

/** The word the gate takes when it was told nothing it can read: the guard on, the reviewer decides, nobody to ask. */
export const GUARD_WORD_FALLBACK: GuardWord = {
	mode: "reviewer",
	reviewers: [],
	askWhenUnavailable: false,
	askWhenDenied: false,
	page: false,
	log: "",
	own: [],
};

/** The word the file says, or null when it says nothing (the gate then takes `GUARD_WORD_FALLBACK`). */
export function parseGuardWord(raw: unknown): GuardWord | null {
	const r = record(raw);
	if (!isGuardMode(r.mode)) return null;
	const strings = (v: unknown): string[] =>
		Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
	const thresholds = parseThresholds(r.thresholds);
	// The reviewer's rules: only text that is a policy (not empty, not too long, no control characters); anything else is the default.
	const policy = typeof r.policy === "string" && policyProblem(r.policy) === null ? normalizePolicy(r.policy) : "";
	return {
		mode: r.mode,
		reviewers: strings(r.reviewers),
		askWhenUnavailable: r.askWhenUnavailable === true,
		askWhenDenied: r.askWhenDenied === true,
		page: r.page === true,
		log: typeof r.log === "string" ? r.log : "",
		own: strings(r.own),
		...(Object.keys(thresholds).length > 0 ? { thresholds } : {}),
		...(policy !== "" ? { policy } : {}),
	};
}

/** The decisions file, in the app's data folder (`<data dir>/guard/decisions.jsonl`). */
export const GUARD_LOG_DIR = "guard";
export const GUARD_LOG_FILE = "decisions.jsonl";

/** The most characters of a call a decision keeps (the log is read by pages: a whole script is not kept). */
export const GUARD_DETAIL_MAX = 4_000;

/**
 * `reviewer`: a reviewer model said it. `person`: the person answered the question. `classifier`: a category's setting
 * (Allow or Block) decided, with no one asked. `guard`: the gate itself, with no one to ask or nothing to ask about.
 */
export type GuardBy = "reviewer" | "person" | "classifier" | "guard";
/** `unavailable`: no reviewer could be reached; the call was refused, and nobody judged it. */
export type GuardVerdict = "allow" | "deny" | "unavailable";

/**
 * How a decision reads in the Guard page's filters: `asked`: the person answered (either way); `allowed`: let through by
 * the classifier's setting or the reviewer; `blocked`: refused, on the merits or because nobody could judge it.
 */
export type GuardOutcome = "allowed" | "asked" | "blocked";
export const GUARD_OUTCOMES: readonly GuardOutcome[] = ["allowed", "asked", "blocked"];

export function outcomeOf(d: Pick<GuardDecision, "verdict" | "by">): GuardOutcome {
	if (d.by === "person") return "asked";
	return d.verdict === "allow" ? "allowed" : "blocked";
}

/** What a page asks of the decisions log (`GET /api/guard/log`): the decisions that match, a page at a time, newest first. */
export interface GuardLogQuery {
	limit: number;
	/** The id of the oldest decision the page has: the answer is the ones decided before it. */
	before?: string;
	outcome?: GuardOutcome;
	by?: GuardBy;
	/** Words to find, in the call, the reason, the folder, the tool, the intent and the agent (case does not matter). */
	text?: string;
	/** The transcript file of a conversation (its subagents' decisions are its own too). */
	conversation?: string;
}

/** One page of the decisions log. */
export interface GuardLogPage {
	decisions: GuardDecision[];
	/** How many decisions the part of the log that was read held, matching or not. */
	total: number;
	/** How many of them match the query. */
	matched: number;
	/** The id to give as `before` for the next page; null when this was the last. */
	next: string | null;
}

/**
 * Whether a decision answers a query's filters (outcome, who decided, words, conversation): the server filters its log by it,
 * and a page decides by it whether a decision that arrived live belongs in the list it shows.
 */
export function decisionMatches(d: GuardDecision, q: Omit<GuardLogQuery, "limit" | "before">): boolean {
	if (q.outcome && outcomeOf(d) !== q.outcome) return false;
	if (q.by && d.by !== q.by) return false;
	const conversation = q.conversation ? q.conversation.replace(/\.jsonl$/, "") : "";
	if (conversation !== "" && d.file.replace(/\.jsonl$/, "") !== conversation && !d.file.startsWith(`${conversation}/`))
		return false;
	const words = (q.text ?? "").trim().toLowerCase();
	if (words === "") return true;
	return [d.detail, d.reason, d.tool, d.cwd, d.intent, d.agent, d.kinds.join(" "), d.model ?? ""].some((s) =>
		s.toLowerCase().includes(words),
	);
}

/** What a reviewer's request spent (the sum of the attempts of one decision). */
export interface GuardUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** Dollars, as the provider's price says. */
	cost: number;
	requests: number;
}

/** One decision of the guard, as the gate writes it down and the page shows it (tool card, Settings log). */
export interface GuardDecision {
	/** Unique: the page keys on it. */
	id: string;
	/** When it was decided (epoch ms). */
	at: number;
	/** The session of the agent that made the call: the conversation's own, or its subagent's. */
	session: string;
	/** That session's transcript file (a subagent's is beside its conversation's, in a folder named for it); blank when omp did not say. */
	file: string;
	/** `main`, or the subagent's name. */
	agent: string;
	subagent: boolean;
	toolCallId: string;
	tool: string;
	kinds: RiskKind[];
	cwd: string;
	/** What the agent said it was for (the call's intent); may be blank. */
	intent: string;
	/** What the call is: the exact command, code or paths, cut at `GUARD_DETAIL_MAX`. */
	detail: string;
	/** The setting at the time. */
	mode: GuardMode;
	verdict: GuardVerdict;
	by: GuardBy;
	/** Why: the reviewer's own words, or what the gate says. */
	reason: string;
	/** The reviewer that gave the verdict, or the last one tried (`provider/id`); absent when none was asked. */
	model?: string;
	/** Every reviewer asked, in order (more than one: the first ones could not be reached). */
	tried?: string[];
	usage?: GuardUsage;
	/** How long the decision took, in ms (the reviewer's time, or the person's). */
	ms: number;
}

/**
 * The first words of what the agent is told when no reviewer could be reached: the page and the tests tell this
 * refusal from a denial on the merits by them (the agent can wait or report, not rework the call).
 */
export const GUARD_UNAVAILABLE = "reviewer unavailable";

const text = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const count = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0);
/** Who can decide: in the order the Guard page's filter lists them. */
export const GUARD_BYS: readonly GuardBy[] = ["classifier", "reviewer", "person", "guard"];
const GUARD_VERDICTS: readonly GuardVerdict[] = ["allow", "deny", "unavailable"];

/**
 * A line of the decisions file as a decision, or null when it is not one. The file is written by processes the agent
 * runs in; what a page shows is read back through this, field by field, and cut to a size.
 */
export function parseDecision(raw: unknown): GuardDecision | null {
	const r = record(raw);
	const verdict = GUARD_VERDICTS.find((v) => v === r.verdict);
	const by = GUARD_BYS.find((b) => b === r.by);
	if (!verdict || !by || typeof r.id !== "string" || r.id === "" || !isGuardMode(r.mode)) return null;
	const usage = record(r.usage);
	const known: readonly unknown[] = RISK_KINDS;
	const kinds = Array.isArray(r.kinds) ? r.kinds.filter((k): k is RiskKind => known.includes(k)).slice(0, 16) : [];
	const decision: GuardDecision = {
		id: r.id.slice(0, 80),
		at: count(r.at),
		session: text(r.session, 80),
		file: text(r.file, 1_000),
		agent: text(r.agent, 80),
		subagent: r.subagent === true,
		toolCallId: text(r.toolCallId, 120),
		tool: text(r.tool, 80),
		kinds,
		cwd: text(r.cwd, 1_000),
		intent: text(r.intent, 600),
		detail: text(r.detail, GUARD_DETAIL_MAX + 200),
		mode: r.mode,
		verdict,
		by,
		reason: text(r.reason, 2_000),
		ms: count(r.ms),
	};
	if (typeof r.model === "string") decision.model = r.model.slice(0, 200);
	if (Array.isArray(r.tried))
		decision.tried = r.tried
			.filter((t): t is string => typeof t === "string")
			.slice(0, 8)
			.map((t) => t.slice(0, 200));
	if (r.usage !== undefined) {
		decision.usage = {
			input: count(usage.input),
			output: count(usage.output),
			cacheRead: count(usage.cacheRead),
			cacheWrite: count(usage.cacheWrite),
			cost: count(usage.cost),
			requests: count(usage.requests),
		};
	}
	return decision;
}

/** The decision's id: time-ordered, and unique across the processes that write the one file. */
export const newDecisionId = (at: number): string => `${at.toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
