import { goalHeld, type HeldStatus } from "@shared/goal.ts";
import type { LiveState, RpcState } from "../store/live.ts";
import type { TurnClock } from "../store/turn-clock.ts";
import { modelLabel, type StartConfig, selectedThinking } from "./models.ts";

/** What the chat's status line says about the live process, as the TUI's bottom line does. */
export interface StatusItems {
	/** How long the agent has worked in this conversation. */
	activeMs: number;
	/** `thinking` is what it is set to (`auto` stays `auto`); `resolved` the level omp resolved `auto` to, once it says. */
	model?: { name: string; thinking?: string; resolved?: string };
	context?: NonNullable<RpcState["contextUsage"]>;
	/** Fast mode is on and in effect (`fastModeActive`, not merely selected). */
	fast: boolean;
	/** The account is past its usage limit; absent while it is not. */
	usageLimit?: NonNullable<RpcState["usageLimit"]>;
	/** A goal omp still holds (active, paused or out of budget), with the tokens it has used of its budget. */
	goal?: { objective: string; used: number; budget?: number; status: HeldStatus };
}

/**
 * The status line's figures. `savedMs` is how long the conversation's saved entries say the agent has worked
 * (`activeMs(entries)`, which costs a pass over them: keep it until they change). `clock` is the page's own clock of
 * the turn in flight (see store/turn-clock.ts), which a turn that is not running leaves out of it. Without that clock
 * (the page opened mid-turn) a running turn counts up to its last saved entry: the saved timestamps are the machine
 * omp runs on's, and this browser's clock may not agree with it. `savedThinking` is the level the conversation's
 * journal leaves, which says `auto` for a resumed conversation omp does not announce it for; `config` the one the process
 * started with.
 */
export function statusItems(
	live: LiveState | undefined,
	savedMs: number,
	clock: TurnClock | null,
	now: number,
	savedThinking?: string,
	config?: StartConfig | null,
): StatusItems {
	const model = live?.state?.model;
	const { selected: thinking, resolved } = selectedThinking(live, savedThinking, config);
	const goal = live?.goal;
	return {
		activeMs: live?.streaming && clock ? clock.activeBefore + Math.max(0, now - clock.startedAt) : savedMs,
		model: model && {
			name: modelLabel(model),
			thinking: thinking && thinking !== "off" ? thinking : undefined,
			resolved,
		},
		context: live?.state?.contextUsage,
		fast: live?.state?.fastModeActive === true,
		usageLimit: live?.state?.usageLimit,
		goal:
			goal && goalHeld(goal)
				? {
						objective: goal.objective,
						used: goal.tokensUsed ?? 0,
						budget: goal.tokenBudget || undefined,
						status: goal.status,
					}
				: undefined,
	};
}
