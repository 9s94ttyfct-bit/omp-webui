import type { GuardConfig, GuardDecision } from "@shared/guard.ts";
import type { GuardRules } from "@shared/guard-policy.ts";
import type { ServerMessage } from "@shared/protocol.ts";
import { create } from "zustand";

/**
 * What the page knows of "Guard dangerous commands" (Settings › Safety): the verdict on each call it has heard of, the
 * settings as the server last said them, and where no reviewer could be reached. This lookup is all of it that is in the
 * first chunk; everything that draws a verdict, the settings or the notice is a lazy chunk (see `lib/guard-decisions.ts`
 * for what asks the server).
 */
interface GuardState {
	/** The verdict on a call, by the tool call's id. */
	byCall: Record<string, GuardDecision>;
	/** The settings as the server last told this page (null until it has: the Settings card asks for them itself). */
	config: GuardConfig | null;
	/** What the person tuned (the reviewer's rules, the threshold of each category, their cases), as the server last told this page; null until it has. */
	rules: GuardRules | null;
	/**
	 * The latest decision that said no reviewer could be reached, by the conversation it was made in (`conversationOf` its
	 * file), until the next decision in that conversation (whatever it says), the mode changes or it is dismissed.
	 */
	unavailable: Record<string, GuardDecision>;
	/** The decision that arrived last: the Settings log follows it, one set at a time, so that none is missed. */
	last: GuardDecision | null;
}

export const useGuard = create<GuardState>(() => ({
	byCall: {},
	config: null,
	rules: null,
	unavailable: {},
	last: null,
}));

/**
 * The conversation a session file belongs to: its own file, or, for a subagent's (`<conversation file minus .jsonl>/<Name>.jsonl`),
 * the conversation's. "" when omp did not say, which no conversation is.
 */
export function conversationOf(file: string): string {
	const named = /^(.*?\/\d{4}-\d\d-\d\dT[^/_]+Z_[^/]+?)(?:\.jsonl)?(?:\/|$)/.exec(file);
	return named ? named[1] : file.replace(/\.jsonl$/, "");
}

/** Fold a `guard_decision` or `guard_config` message into the store (the settings card hands its own answers in the same way). */
export function onGuardMessage(msg: Extract<ServerMessage, { t: "guard_decision" | "guard_config" }>): void {
	if (msg.t === "guard_config") {
		// A change of the mode takes the notices away: by the mode the page held before, or, when it held none, by the mode each
		// notice's decision was made under.
		useGuard.setState((s) => ({
			config: msg.config,
			...(msg.rules ? { rules: msg.rules } : {}),
			unavailable: s.config
				? s.config.mode !== msg.config.mode
					? {}
					: s.unavailable
				: Object.fromEntries(Object.entries(s.unavailable).filter(([, d]) => d.mode === msg.config.mode)),
		}));
		return;
	}
	const d = msg.decision;
	useGuard.setState((s) => {
		// The next decision in the conversation ends the notice about it; one that says "unavailable" again starts it anew.
		const home = conversationOf(d.file);
		const { [home]: _gone, ...others } = s.unavailable;
		return {
			byCall: d.toolCallId ? { ...s.byCall, [d.toolCallId]: d } : s.byCall,
			unavailable: d.verdict === "unavailable" ? { ...others, [home]: d } : others,
			last: d,
		};
	});
}
