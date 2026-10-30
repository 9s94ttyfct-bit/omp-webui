import type { GuardBy, GuardDecision, GuardMode, GuardOutcome } from "@shared/guard.ts";
import type { BenchGroup, BenchOutcome } from "@shared/guard-bench.ts";
import type { SettableKind, Threshold } from "@shared/guard-policy.ts";
import type { MessageKey } from "../i18n/index.ts";

/** What each mode is called and says, in Settings › Safety and in a conversation's own guard. */
export const MODE_TEXT: Record<GuardMode, { label: MessageKey; hint: MessageKey }> = {
	off: { label: "guard.modeOff", hint: "guard.modeOffHint" },
	reviewer: { label: "guard.modeReviewer", hint: "guard.modeReviewerHint" },
	ask: { label: "guard.modeAsk", hint: "guard.modeAskHint" },
};

/** How a decision reads to the person: who said it and what they said. */
export type VerdictKind =
	| "allowed"
	| "denied"
	| "unavailable"
	| "youAllowed"
	| "youDenied"
	| "guardAllowed"
	| "guardRefused";

export function verdictKind(d: Pick<GuardDecision, "verdict" | "by">): VerdictKind {
	if (d.verdict === "unavailable") return "unavailable";
	const allow = d.verdict === "allow";
	if (d.by === "person") return allow ? "youAllowed" : "youDenied";
	if (d.by === "guard" || d.by === "classifier") return allow ? "guardAllowed" : "guardRefused";
	return allow ? "allowed" : "denied";
}

/** Who decided, as a filter and a chip name it. */
export const BY_TEXT: Record<GuardBy, MessageKey> = {
	classifier: "guard.byClassifier",
	reviewer: "guard.byReviewer",
	person: "guard.byPerson",
	guard: "guard.byGuard",
};

/** What came of a decision, as the filter names it. */
export const OUTCOME_TEXT: Record<GuardOutcome, MessageKey> = {
	allowed: "guard.outAllowed",
	asked: "guard.outAsked",
	blocked: "guard.outBlocked",
};

/** What a kind of call the classifier recognises is called, where its threshold is set. */
export const CAT_NAME: Record<SettableKind, MessageKey> = {
	privilege: "guard.catName_privilege",
	mass_delete: "guard.catName_mass_delete",
	delete_outside: "guard.catName_delete_outside",
	write_outside: "guard.catName_write_outside",
	protected: "guard.catName_protected",
	secret_read: "guard.catName_secret_read",
	force_push: "guard.catName_force_push",
	discard: "guard.catName_discard",
	remote_exec: "guard.catName_remote_exec",
	shell_out: "guard.catName_shell_out",
	permissions: "guard.catName_permissions",
	launchctl: "guard.catName_launchctl",
	osascript: "guard.catName_osascript",
	tunnel: "guard.catName_tunnel",
	global_install: "guard.catName_global_install",
	system: "guard.catName_system",
	unreadable: "guard.catName_unreadable",
};

export const THRESHOLD_TEXT: Record<Threshold, MessageKey> = {
	allow: "guard.thAllow",
	ask: "guard.thAsk",
	block: "guard.thBlock",
};

/** What came of a benchmark case. */
export const BENCH_OUTCOME_TEXT: Record<BenchOutcome, MessageKey> = {
	allowed: "guard.benchOutAllowed",
	blocked: "guard.benchOutBlocked",
	asked: "guard.benchOutAsked",
	flagged: "guard.benchOutFlagged",
};

export const BENCH_GROUP_TEXT: Record<BenchGroup, MessageKey> = {
	deletion: "guard.benchGroup_deletion",
	overwrite: "guard.benchGroup_overwrite",
	system: "guard.benchGroup_system",
	harmless: "guard.benchGroup_harmless",
	own: "guard.benchGroup_own",
};

/** The short word on the Settings log's chip. */
export const CHIP_TEXT: Record<VerdictKind, MessageKey> = {
	allowed: "guard.chipAllowed",
	denied: "guard.chipDenied",
	unavailable: "guard.chipUnavailable",
	youAllowed: "guard.chipYouAllowed",
	youDenied: "guard.chipYouDenied",
	guardAllowed: "guard.chipGuardAllowed",
	guardRefused: "guard.chipGuardRefused",
};

/** The sentence on a tool card (a denial and a refusal say why: `{reason}`). */
export const CARD_TEXT: Record<VerdictKind, MessageKey> = {
	allowed: "guard.cardAllowed",
	denied: "guard.cardDenied",
	unavailable: "guard.cardUnavailable",
	youAllowed: "guard.cardYouAllowed",
	youDenied: "guard.cardYouDenied",
	guardAllowed: "guard.cardGuardAllowed",
	guardRefused: "guard.cardGuardRefused",
};

/** Colours of a chip: green where the call went on, red where it was refused on the merits, amber where nobody judged it. */
export const CHIP_TONE: Record<VerdictKind, string> = {
	allowed: "bg-success/15 text-success",
	youAllowed: "bg-success/15 text-success",
	guardAllowed: "bg-success/15 text-success",
	denied: "bg-danger/10 text-danger",
	youDenied: "bg-danger/10 text-danger",
	guardRefused: "bg-danger/10 text-danger",
	unavailable: "bg-warning/15 text-warning",
};

/** What a reviewer's requests cost, in dollars: small amounts keep their digits. */
export function money(cost: number): string {
	if (cost <= 0) return "$0";
	return cost < 0.01 ? `$${cost.toFixed(4)}` : `$${cost.toFixed(2)}`;
}

/** Seconds, to a tenth. */
export const secondsOf = (ms: number): string => (ms / 1000).toFixed(1);

/** The model a person reads: its id without the provider (`anthropic/claude-haiku-5-5` → `claude-haiku-5-5`). */
export const shortModel = (selector: string): string => selector.slice(selector.indexOf("/") + 1);

/** A count of tokens as a person reads it. */
export const tokens = (n: number): string => (n >= 10_000 ? `${(n / 1000).toFixed(1)}k` : String(n));
