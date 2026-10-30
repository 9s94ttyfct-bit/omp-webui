/**
 * Guided goal: instead of typing an objective, the user lets omp interview them. The conversation gets
 * one host tool, `propose_goal`; the model asks its questions in the chat (the `ask` tool for choices,
 * plain text for open ones) and ends the interview by calling it. The web UI shows the proposal as a
 * confirm card; only the user's confirmation creates the goal (omp's `goal` RPC), so a model can never
 * start goal mode by itself. The tool is registered when the interview starts and removed when it ends. It lives in
 * one omp process, so the server remembers which conversations are interviewing (server/omp/interviews.ts) and gives
 * the tool back when one is resumed in a new process (reaped as idle, closed for the terminal, a restarted server).
 */

/** The host tool the interview ends with. */
export const PROPOSE_GOAL_TOOL = "propose_goal";

/** What omp's `set_host_tools` takes (rpc.md, "set_host_tools payload"). */
export interface HostToolDefinition {
	name: string;
	label: string;
	description: string;
	parameters: Record<string, unknown>;
	loadMode?: "essential" | "discoverable";
}

/** What the model proposes; the user may edit all of it before confirming. */
export interface GoalProposal {
	objective: string;
	criteria: string[];
	/** Tokens omp may spend on the goal; absent for no limit. */
	tokenBudget?: number;
}

/** Smallest budget the model is told to propose; a trivial goal turn alone costs several thousand tokens. */
const MIN_TOKEN_BUDGET = 10_000;

/**
 * The tool's definition. `essential` puts it in the model's tool list from the next turn on: a host tool
 * defaults to `discoverable`, which the model would have to search for first.
 */
export function proposeGoalTool(): HostToolDefinition {
	return {
		name: PROPOSE_GOAL_TOOL,
		label: "Propose goal",
		loadMode: "essential",
		description:
			"Ends the guided goal interview. Shows the user a proposed goal to confirm, edit or reject, and returns their decision. " +
			"Call it once, only after the user has answered enough of your questions; do not call it before asking anything. " +
			"It does not start any work: if the user confirms, goal mode starts and the result says so.",
		parameters: {
			type: "object",
			properties: {
				objective: {
					type: "string",
					description:
						"One or two sentences: the outcome to reach, specific enough that someone else could tell whether it was reached.",
				},
				acceptance_criteria: {
					type: "array",
					minItems: 1,
					maxItems: 8,
					items: { type: "string" },
					description:
						"Concrete conditions that must hold when the goal is done. Each says how it is checked (a command that passes, a file that exists, behavior that can be observed).",
				},
				token_budget: {
					type: "integer",
					minimum: MIN_TOKEN_BUDGET,
					description:
						"Total tokens omp may spend on the goal, input and output together. Roughly 150000 for a small change, 500000 for a feature, 1500000 for a large piece of work. Omit for no limit.",
				},
			},
			required: ["objective", "acceptance_criteria"],
			additionalProperties: false,
		},
	};
}

/** The proposal a `propose_goal` call carries, or null when it has no usable objective. Tolerates what a model may send. */
export function readProposal(args: unknown): GoalProposal | null {
	if (!args || typeof args !== "object") return null;
	const a = args as Record<string, unknown>;
	const objective = typeof a.objective === "string" ? a.objective.trim() : "";
	if (!objective) return null;
	const criteria = (Array.isArray(a.acceptance_criteria) ? a.acceptance_criteria : [])
		.map((c) => (typeof c === "string" ? c.trim() : ""))
		.filter(Boolean);
	const budget =
		typeof a.token_budget === "number" && Number.isFinite(a.token_budget) ? Math.floor(a.token_budget) : Number.NaN;
	return { objective, criteria, ...(budget >= 1 ? { tokenBudget: budget } : {}) };
}

/** The single string omp's `goal` create takes: the objective, then its acceptance criteria as a list. */
export function goalObjective(p: Pick<GoalProposal, "objective" | "criteria">): string {
	const criteria = p.criteria.map((c) => c.trim()).filter(Boolean);
	if (!criteria.length) return p.objective.trim();
	return `${p.objective.trim()}\n\nAcceptance criteria:\n${criteria.map((c) => `- ${c}`).join("\n")}`;
}

/** The language names the web UI puts in the interview prompt (`interviewPrompt`'s `language`), by interface language. */
export const INTERVIEW_LANGUAGES = { en: "English", "zh-CN": "Simplified Chinese" } as const;

const NO_IDEA = "Help me define a goal. I do not have a precise idea yet, so start by asking what I want to achieve.";
const IDEA_PREFIX = "Help me define a goal. My rough idea: ";
const SETUP_LINE = "Guided goal setup: interview me first, then propose the goal for me to confirm.";
/** Where the instructions begin: after the idea and a blank line. */
const INSTRUCTIONS_START = `\n\n${SETUP_LINE}\n`;
const LANGUAGE_LINE = "- Use the language I write in; before I have written anything, use ";

/**
 * The message that starts the interview. It is an ordinary user message, so the transcript shows exactly what
 * the web UI asked of omp. `rough` is what the user already knows they want, if anything; `language` is the one
 * to use until the user has written something in another. `parseInterviewPrompt` reads it back.
 */
export function interviewPrompt(rough: string, language: string): string {
	const idea = rough.trim();
	return [
		idea ? `${IDEA_PREFIX}${idea}` : NO_IDEA,
		"",
		SETUP_LINE,
		"- Ask one focused question at a time and wait for my answer before the next one.",
		"- When my answer is a choice between options, use the `ask` tool and mark the option you recommend. Ask open questions as plain text.",
		"- Find out what you can from the project yourself (read files, search) instead of asking me.",
		"- Cover what done looks like and how it is verified, the scope, what must not change, and how much effort it deserves.",
		"- Stop at six questions or fewer, as soon as you could write an objective someone else could verify.",
		`- Finish by calling \`${PROPOSE_GOAL_TOOL}\` once, with the objective, the acceptance criteria and a token budget. I will confirm, change or reject it there. Do not start the work and do not create the goal any other way.`,
		`${LANGUAGE_LINE}${language}.`,
	].join("\n");
}

/** What `interviewPrompt` was made from. */
export interface InterviewRequest {
	/** What the user had already said they want; empty when they had no idea yet. */
	rough: string;
	/** The language the interview was asked to start in (one of `INTERVIEW_LANGUAGES`). */
	language: string;
}

/**
 * The request behind a user message, or null for any message that is not the interview prompt. The transcript only
 * has the message, so this is how the chat shows it as what it is (a compact chip, not the instructions) and how
 * the conversation is named.
 */
export function parseInterviewPrompt(text: string): InterviewRequest | null {
	// The idea may span lines and say anything; the instructions after it are ours, so the last start is the real one.
	const at = text.lastIndexOf(INSTRUCTIONS_START);
	if (at < 0) return null;
	const head = text.slice(0, at);
	const rough = head === NO_IDEA ? "" : head.startsWith(IDEA_PREFIX) ? head.slice(IDEA_PREFIX.length) : null;
	if (rough === null) return null;
	const language = text
		.slice(at)
		.split("\n")
		.findLast((l) => l.startsWith(LANGUAGE_LINE));
	return language ? { rough, language: language.slice(LANGUAGE_LINE.length).replace(/\.$/, "") } : null;
}

/** What a guided goal setup is called, in the language the interview was started in (the server has no interface language). */
export function interviewLabel(language: string): string {
	return language === INTERVIEW_LANGUAGES["zh-CN"] ? "引导式目标设定" : "Guided goal setup";
}

/** What the model is told, as the tool result, once the user has decided. */
export const PROPOSAL_RESULTS = {
	confirmed: (objective: string) =>
		`The user confirmed the goal. Goal mode is now active with this objective:\n${objective}\nBegin working on it now.`,
	cancelled:
		"The user cancelled goal setup. No goal was created. Acknowledge in one short sentence and do nothing else.",
	revise: (feedback: string) =>
		`The user did not accept this proposal and wants changes:\n${feedback}\nAsk a follow-up question if you need one, then call ${PROPOSE_GOAL_TOOL} again with the revised proposal.`,
	/** The user set a goal by hand while this proposal was open, so it is neither confirmed nor cancelled. */
	replaced: (objective: string) =>
		`The user set a goal directly instead of answering this proposal. Goal mode is now active with this objective:\n${objective}\nThe guided setup is over: do not propose another goal. Begin working on it now.`,
} as const;

/** A `host_tool_result` body as the browser sends it (`ui_response`): text for the model, and whether it is an error. */
export function hostResult(text: string, isError = false) {
	return { result: { content: [{ type: "text" as const, text }] }, ...(isError ? { isError: true } : {}) };
}
