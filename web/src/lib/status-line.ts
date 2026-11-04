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

/**
 * What the status line gives way with when its one row has too little room for all of it, the first first (see
 * `useFitSteps`). Its lowest items go first: the folder is shortened and then left to the header, which names it in
 * full then; the working time, the goal's budget and the cost go to the header's menu (the cost is the header's own
 * chip, which says it with its subagents' share); then the branch's name is shortened, and then only its icon (its name
 * in its title). Last the model's name ends in an ellipsis. The context, the agents running, the usage limit and the
 * pull request stay on the line.
 */
export const STATUS_STEPS = [
	"cwd-short",
	"cwd",
	"time",
	"goal",
	"cost",
	"branch-short",
	"branch-icon",
	"model-short",
] as const;
export type StatusStep = (typeof STATUS_STEPS)[number];
/** What the line can put elsewhere (the folder in the header, the rest in its menu). */
export type StatusFold = "cwd" | "time" | "goal" | "cost";

/** The items the line has: a step for an item it does not have would change nothing, and is not one of its steps. */
export interface StatusHas {
	cwd: boolean;
	time: boolean;
	goal: boolean;
	cost: boolean;
	branch: boolean;
	model: boolean;
}

const STATUS_STEP_ITEM: Record<StatusStep, keyof StatusHas> = {
	"cwd-short": "cwd",
	cwd: "cwd",
	time: "time",
	goal: "goal",
	cost: "cost",
	"branch-short": "branch",
	"branch-icon": "branch",
	"model-short": "model",
};

/** The line's steps for the items it has, in their order. */
export function statusSteps(has: StatusHas): StatusStep[] {
	return STATUS_STEPS.filter((step) => has[STATUS_STEP_ITEM[step]]);
}

/** What the first `taken` of `steps` have put off the line, in the order they went. */
export function statusFolds(steps: readonly StatusStep[], taken: number): StatusFold[] {
	return steps
		.slice(0, taken)
		.filter((step): step is StatusFold => step === "cwd" || step === "time" || step === "goal" || step === "cost");
}

/**
 * What the chat's header gives way with when the room beside its title is short, the first first (see `useFitSteps`):
 * Rename, Export, the Loaded list, the cost and Goal go to its menu, then This session (its gear is in the menu then,
 * and the guard's switch moves beside the menu), and last the quota is written shorter: the conversation's own
 * provider's without its meter, the providers' names left out, and then each one's figure alone. The title keeps its
 * room until nothing else can give way; the side panel's button, the guard's switch and the quota always stay.
 */
export const HEADER_STEPS = [
	"rename",
	"export",
	"loaded",
	"cost",
	"goal",
	"session",
	"quota-short",
	"quota-terse",
] as const;
export type HeaderStep = (typeof HEADER_STEPS)[number];

/** The header's steps for what it has: Rename and Export need a saved file, This session omp or a file to start it from. */
export function headerSteps(has: {
	rename: boolean;
	export: boolean;
	session: boolean;
	/** The quota has a long form: its own provider's meter, or the names of more than one provider. */
	quotaShort: boolean;
	/** More than one provider's quota, which each say their figure alone in the tersest form. */
	quotaTerse: boolean;
}): HeaderStep[] {
	return HEADER_STEPS.filter((step) => {
		if (step === "rename" || step === "export" || step === "session") return has[step];
		if (step === "quota-short") return has.quotaShort;
		if (step === "quota-terse") return has.quotaTerse;
		return true;
	});
}
