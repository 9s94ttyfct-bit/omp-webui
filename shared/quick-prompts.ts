/**
 * Quick prompts (#659): messages the person sends often, one click from the message box. Kept with the person's
 * preferences (`PREF.quickPrompts`, synced like the others). Each says how it is sent while the agent works: `steer`
 * reaches the agent now, `followUp` waits for the turn to end. When the agent is idle either is an ordinary message.
 *
 * A prompt may also stop the session after the turn it starts (`stopAfter`): when that turn ends the server ends the
 * conversation's omp process (`Live.softStop`); the conversation is kept and the next message starts it again. The
 * built-in *Soft stop* (#658) is such a prompt: it asks the agent to save its progress in a handoff and stop.
 */

export type QuickPromptMode = "steer" | "followUp";

export interface QuickPrompt {
	/** Stable across edits; `soft-stop` for the built-in one. */
	id: string;
	name: string;
	text: string;
	mode: QuickPromptMode;
	/** End the conversation's omp process when the turn this prompt starts (or reaches) ends. */
	stopAfter: boolean;
}

export const SOFT_STOP_ID = "soft-stop";

/** The most prompts kept, and the longest name and text. All of them together must also fit `MAX_PREF_LENGTH` (16 KiB). */
export const QUICK_PROMPTS_MAX = 20;
export const QUICK_PROMPT_NAME_MAX = 60;
export const QUICK_PROMPT_TEXT_MAX = 2000;

/**
 * What *Soft stop* tells the agent. English whatever the interface language: it is an instruction to the model, like the
 * other instructions the app sends.
 */
export const SOFT_STOP_TEXT = [
	"Soft stop: wrap up now without losing any work.",
	"1. Stop starting new work. Finish or safely pause the step in progress; do not leave files half-edited. Stop any background jobs or subagents you started, or note them.",
	"2. Then write a handoff as your final message, complete enough that you (or another agent) can resume from it alone:",
	"   - Goal and current status;",
	"   - What is done (with files changed, and commits made if any);",
	"   - What is in progress, exactly where it stopped;",
	"   - Uncommitted changes and anything temporary left behind;",
	"   - Next steps, in order, with the commands to run;",
	"   - Open questions and decisions waiting for me.",
	"3. Do not write the handoff to a file unless I asked you to; put it in the message. End your turn after it. The session will be stopped, and I will continue it later.",
].join("\n");

/**
 * The built-in prompts. Their text is English whatever the interface language (an instruction to the model); their names
 * are shown in the page's language while the person keeps them (`promptName`). A built-in added in an update reaches a
 * list the person already saved once (`parseQuickPrompts`, `PREF.quickPromptsSeen`); one they removed stays removed.
 */
export const DEFAULT_QUICK_PROMPTS: readonly QuickPrompt[] = [
	{ id: SOFT_STOP_ID, name: "Soft stop", text: SOFT_STOP_TEXT, mode: "steer", stopAfter: true },
	{
		id: "review-changes",
		name: "Review my changes",
		text: "Review the uncommitted changes in this project (git diff, and new files) as a careful reviewer: look for bugs, edge cases, security problems, missing tests and anything that breaks existing behaviour. Report what you find, most serious first, with file and line; do not change any file.",
		mode: "followUp",
		stopAfter: false,
	},
	{
		id: "write-tests",
		name: "Write tests for this",
		text: "Write tests for what was just changed, following the project's existing test conventions. Each test must fail if the behaviour it covers broke: no tests of wiring or wording. Run them and the tests around them, fix what fails, and tell me what each new test protects.",
		mode: "followUp",
		stopAfter: false,
	},
	{
		id: "summarize",
		name: "Summarize & next steps",
		text: "Summarize where we are: the goal, what is done (files changed, commits), what is in progress, open questions and decisions waiting for me, and the next steps in order with the commands to run. Keep it short; do not start new work.",
		mode: "followUp",
		stopAfter: false,
	},
	{
		id: "commit-work",
		name: "Commit the work",
		text: "Commit the work: look at the diff, run the project's checks (type check, lint, the relevant tests) and fix what fails, then commit with a clear message that says what changed and why. Split unrelated changes into separate commits. Do not push.",
		mode: "followUp",
		stopAfter: false,
	},
	{
		id: "simplify",
		name: "Simplify what you wrote",
		text: "Simplify the code you wrote in this conversation without changing what it does: remove what is not needed, merge duplicates, prefer the project's existing helpers and the plainer construct. Run the tests afterwards and tell me what you changed.",
		mode: "followUp",
		stopAfter: false,
	},
];

/** The ids of the built-in prompts. */
export const BUILT_IN_IDS: readonly string[] = DEFAULT_QUICK_PROMPTS.map((p) => p.id);

/**
 * The built-ins a saved list was made with, from `PREF.quickPromptsSeen` (a JSON list of ids). A list saved before that
 * preference existed knew Soft stop only.
 */
export function parseSeen(value: string | null): string[] {
	if (value === null) return [SOFT_STOP_ID];
	try {
		const raw: unknown = JSON.parse(value);
		return Array.isArray(raw) ? raw.filter((id): id is string => typeof id === "string") : [SOFT_STOP_ID];
	} catch {
		return [SOFT_STOP_ID];
	}
}

const isMode = (v: unknown): v is QuickPromptMode => v === "steer" || v === "followUp";

/** One stored prompt, or null for anything the page does not write. */
function promptOf(raw: unknown): QuickPrompt | null {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
	const { id, name, text, mode, stopAfter } = raw as Record<string, unknown>;
	if (typeof id !== "string" || !id || id.length > 64) return null;
	if (typeof name !== "string" || !name.trim() || name.length > QUICK_PROMPT_NAME_MAX) return null;
	if (typeof text !== "string" || !text.trim() || text.length > QUICK_PROMPT_TEXT_MAX) return null;
	if (!isMode(mode)) return null;
	return { id, name, text, mode, stopAfter: stopAfter === true };
}

/**
 * The prompts a stored value says, in order; the defaults when nothing is stored (null) or the value is not a list. A
 * prompt that is not valid, or repeats an id, is left out; the list is cut at `QUICK_PROMPTS_MAX`. A built-in the saved
 * list was not made with (`seen`, see `parseSeen`) is added at its end, room allowing: a built-in the person removed is
 * among those seen, and stays removed.
 */
export function parseQuickPrompts(value: string | null, seen: string | null = null): QuickPrompt[] {
	if (value === null) return DEFAULT_QUICK_PROMPTS.map((p) => ({ ...p }));
	let raw: unknown;
	try {
		raw = JSON.parse(value);
	} catch {
		return DEFAULT_QUICK_PROMPTS.map((p) => ({ ...p }));
	}
	if (!Array.isArray(raw)) return DEFAULT_QUICK_PROMPTS.map((p) => ({ ...p }));
	const ids = new Set<string>();
	const out: QuickPrompt[] = [];
	for (const item of raw) {
		const p = promptOf(item);
		if (!p || ids.has(p.id)) continue;
		ids.add(p.id);
		out.push(p);
		if (out.length >= QUICK_PROMPTS_MAX) break;
	}
	const known = new Set(parseSeen(seen));
	for (const d of DEFAULT_QUICK_PROMPTS) {
		if (out.length >= QUICK_PROMPTS_MAX) break;
		if (!known.has(d.id) && !ids.has(d.id)) out.push({ ...d });
	}
	return out;
}

/** The list *Restore the defaults* makes of `list`: the built-ins as shipped, then the person's own prompts. */
export function restoredQuickPrompts(list: readonly QuickPrompt[]): QuickPrompt[] {
	const own = list.filter((p) => !BUILT_IN_IDS.includes(p.id));
	return [...DEFAULT_QUICK_PROMPTS.map((p) => ({ ...p })), ...own.map((p) => ({ ...p }))].slice(0, QUICK_PROMPTS_MAX);
}

/** The value kept for a list: null (nothing kept) when it is the defaults as shipped. */
export function serializeQuickPrompts(list: readonly QuickPrompt[]): string | null {
	const same =
		list.length === DEFAULT_QUICK_PROMPTS.length &&
		list.every((p, i) => JSON.stringify(p) === JSON.stringify(DEFAULT_QUICK_PROMPTS[i]));
	return same ? null : JSON.stringify(list.slice(0, QUICK_PROMPTS_MAX));
}
