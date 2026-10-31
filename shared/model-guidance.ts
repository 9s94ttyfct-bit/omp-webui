/**
 * Model guidance: what the person tells the main agent about handing work to subagents and choosing their models —
 * "at most 1 Sonnet subagent at a time, at most 3 DeepSeek subagents", "simple tasks to DeepSeek, complex ones to
 * Sonnet" (#641). It is standing instructions for one conversation, not a message in it.
 *
 * How it reaches omp (measured against the installed omp 18.12.6, `tests/contract/model-guidance.test.ts`): the
 * conversation's omp is started with a small extension (`server/omp/guidance/extension.ts`) that appends the text to the
 * main agent's system prompt in its `before_agent_start` handler. The alternatives were tried and rejected:
 *
 * - `--append-system-prompt` reaches the system prompt, but omp takes one value: a second flag replaces the first, and
 *   an explicit one suppresses a discovered `APPEND_SYSTEM.md` (the person's own file, silently). The web UI already
 *   passes the person's `--append-system-prompt` from New chat's Options, so it cannot take it.
 * - A first user message would be visible in the transcript, and would be compacted away as the conversation grows.
 * - `AGENTS.md` (or `contextFiles.extra`) is read from the folder, so it would be visible to every conversation there,
 *   would follow the folder rather than the conversation, and would be inherited by subagents.
 * - omp's `--config` overlay cannot hold prompt text: it carries settings, and no setting is an append.
 *
 * The extension appends to the main agent's prompt only: a task subagent's `before_agent_start` (`ctx.agent.kind` is
 * `sub`) is left as it is, and so is a title's request (it offers no tools and is not the agent's prompt). The text is in
 * a file of the conversation's own, beside its settings overlay, read at each turn: a change reaches the next turn
 * without a restart, and the prompt is rebuilt from omp's own blocks every time, so compaction and resuming cannot drop
 * it.
 */

/** The most guidance text one conversation may carry (a few paragraphs; the system prompt is paid for on every turn). */
export const GUIDANCE_MAX = 4_000;
/** The most characters a template's name may hold. */
export const GUIDANCE_NAME_MAX = 60;
/** The most templates kept. */
export const GUIDANCE_TEMPLATES_MAX = 50;
/** The most characters a template's id may hold (what a conversation names the template it picked by is bounded the same). */
export const GUIDANCE_ID_MAX = 80;

/**
 * The file the app writes beside a conversation's settings overlay and the extension reads at each turn: its name, so
 * that both sides agree on it (`server/omp/guidance/`).
 */
export const GUIDANCE_SUFFIX = ".guidance.md";

/** A saved guidance template: a name the person picks it by, and the text it stands for. */
export interface GuidanceTemplate {
	/** Stable across renames (the template a conversation was started with is kept by it). */
	id: string;
	name: string;
	text: string;
	/** One of the templates the app ships, so that Restore defaults can put it back as it was. */
	builtin?: true;
}

/** What a page is told of the templates, and what the store holds. */
export interface GuidanceTemplates {
	templates: GuidanceTemplate[];
	/** Counts the changes (a page that changed one tells the others, which re-read). */
	rev: number;
}

/** Why a template cannot be saved. */
export type GuidanceProblem =
	| "nameEmpty"
	| "nameTooLong"
	| "nameRepeated"
	| "textEmpty"
	| "textTooLong"
	| "tooMany"
	/** An update of a template that is not there any more (deleted meanwhile): saving it would add it again (#715). */
	| "gone"
	| "unknown";

/** The shipped templates: what the person starts with, and what Restore defaults puts back. */
export const BUILTIN_GUIDANCE: readonly GuidanceTemplate[] = [
	{
		id: "builtin-one-of-each",
		name: "One of each kind at a time",
		builtin: true,
		text: [
			"## Model guidance",
			"For subagents, respect these limits at all times, counting the ones already running:",
			"- At most 1 Sonnet subagent at a time.",
			"- At most 3 DeepSeek subagents at a time.",
			"- Any other model: at most 2 subagents at a time.",
			"Do not start a subagent that would break a limit. Either wait for one of that model to finish, or do the work yourself, and say which you did.",
		].join("\n"),
	},
	{
		id: "builtin-simple-complex",
		name: "Simple to DeepSeek, complex to Sonnet",
		builtin: true,
		text: [
			"## Model guidance",
			"Choose a subagent's model by how hard its work is, and say which you chose and why:",
			"- Simple, mechanical work — searching for where something is, listing files, mechanical renames, reading and summarising, checking a build or a test command — goes to a DeepSeek subagent.",
			"- Work that needs judgement — design, tricky debugging, reading unfamiliar code, reviewing a change — goes to a Sonnet subagent.",
			"When you are unsure, start with a DeepSeek subagent for the reading and searching, and do the thinking yourself or in one Sonnet subagent afterwards.",
		].join("\n"),
	},
];

/** A fresh id for a template the person makes. */
export function newGuidanceId(seed = Math.random()): string {
	return `t${Date.now().toString(36)}${Math.trunc(seed * 1e6).toString(36)}`;
}

/** `text` as it is put in the prompt: blank lines at either end gone, the rest as written. */
export const guidanceText = (text: string): string => text.replace(/^\s+|\s+$/g, "");

/** How long a template's summary line is at most, in characters (a list row, one line). */
export const GUIDANCE_SUMMARY_MAX = 110;

/**
 * One line that says what a template is about, for a list: its first line of text, without the marks of a Markdown list item
 * or quote, cut at `max` characters with an ellipsis. A heading is a title, not what it says (the shipped ones all start with
 * `## Model guidance`): it is the line only when there is nothing else. The full text is the template's own.
 */
export function guidanceSummary(text: string, max = GUIDANCE_SUMMARY_MAX): string {
	let heading = "";
	for (const raw of text.split("\n")) {
		const titled = /^\s*#{1,6}\s+/.test(raw);
		const line = raw.replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s*)*/, "").trim();
		if (!line) continue;
		if (titled) {
			heading ||= line;
			continue;
		}
		return cut(line, max);
	}
	return cut(heading, max);
}

const cut = (line: string, max: number): string => (line.length > max ? `${line.slice(0, max - 1).trimEnd()}…` : line);

/** Why `text` cannot be a conversation's guidance (null: it can, or it is empty and means none). */
export function guidanceProblem(text: string): "tooLong" | null {
	return guidanceText(text).length > GUIDANCE_MAX ? "tooLong" : null;
}

/** Why a template's name is refused (a subset of `GuidanceProblem`). */
export type GuidanceNameProblem = "nameEmpty" | "nameTooLong" | "nameRepeated";

/**
 * Why `name` cannot be the name of the template `id` (null: it can): empty once trimmed, longer than `GUIDANCE_NAME_MAX`, or
 * the trimmed name of another template of `templates` (the person picks a template by its name). The store refuses the same
 * (`server/omp/guidance/store.ts`); the Guidance tab's *Create new template* and rename say it before asking.
 */
export function guidanceNameProblem(
	name: string,
	templates: readonly Pick<GuidanceTemplate, "id" | "name">[],
	id?: string,
): GuidanceNameProblem | null {
	const trimmed = name.trim();
	if (!trimmed) return "nameEmpty";
	if (trimmed.length > GUIDANCE_NAME_MAX) return "nameTooLong";
	if (templates.some((t) => t.id !== id && t.name.trim() === trimmed)) return "nameRepeated";
	return null;
}

/** Whether `id` names a template of `templates`. */
export const hasTemplate = (templates: readonly GuidanceTemplate[], id: string): boolean =>
	templates.some((t) => t.id === id);

/**
 * The text a conversation carries: the template `id` names, as it stands now (editing a template reaches the
 * conversations that use it at their next turn: `LivePool.followGuidanceTemplates`), else the text the conversation was
 * given directly. Empty: none.
 */
export function guidanceTextOf(
	templates: readonly GuidanceTemplate[],
	guidance: { template?: string | null; text?: string | null } | null | undefined,
): string {
	if (!guidance) return "";
	if (guidance.template) {
		const found = templates.find((t) => t.id === guidance.template);
		if (found) return guidanceText(found.text);
	}
	return guidance ? guidanceText(guidance.text ?? "") : "";
}

/** What a conversation was given: the template it picked (kept even while the template is renamed), or the text. */
export interface SessionGuidance {
	template?: string;
	text?: string;
}

/** Why `problem` is refused, as a page reads it. */
export function guidanceProblemText(problem: GuidanceProblem): string {
	switch (problem) {
		case "nameEmpty":
			return "The template needs a name";
		case "nameTooLong":
			return `A name is at most ${GUIDANCE_NAME_MAX} characters`;
		case "nameRepeated":
			return "There is already a template with that name";
		case "textEmpty":
			return "The template needs some text";
		case "textTooLong":
			return `The text is at most ${GUIDANCE_MAX} characters`;
		case "tooMany":
			return `Keep at most ${GUIDANCE_TEMPLATES_MAX} templates`;
		case "gone":
			return "That template does not exist any more";
		case "unknown":
			return "Not a guidance template";
	}
}

/**
 * What a page sent as `guidance` (a request body, or the `guidance` of a new conversation), read: the template's id, the
 * text, or both; null for none. Throws on anything that is not one of those: a page that sends something else has a bug,
 * and taking it as "none" would silently drop what the person chose.
 */
export function parseSessionGuidance(value: unknown): SessionGuidance | null {
	if (value === null || value === undefined) return null;
	if (typeof value !== "object" || Array.isArray(value)) throw new Error("Not a model guidance choice");
	const { template, text } = value as Record<string, unknown>;
	if (template !== undefined && template !== null && typeof template !== "string")
		throw new Error("Not a model guidance choice");
	if (text !== undefined && text !== null && typeof text !== "string") throw new Error("Not a model guidance choice");
	if (typeof template === "string" && template.length > GUIDANCE_ID_MAX) throw new Error("Not a model guidance choice");
	const picked: SessionGuidance = {};
	if (typeof template === "string" && template) picked.template = template;
	if (typeof text === "string" && guidanceText(text)) picked.text = text;
	if (!picked.template && !picked.text) return null;
	const problem = picked.text ? guidanceProblem(picked.text) : null;
	if (problem === "tooLong") throw new Error(guidanceProblemText("textTooLong"));
	return picked;
}

/**
 * Why a running conversation cannot carry guidance, when it cannot: `trustedExtension` when the person started it with
 * their own `--trusted-extension` (omp refuses `--extension` with it: the process runs without any server extension and
 * says nothing of the guidance), `inherited` when this server took the process over from one that did not start it with
 * the extension (a paused conversation of an older version: it gets it when it is opened again), `unavailable` when the
 * extension's files could not be written.
 */
export type GuidanceSkip = "trustedExtension" | "inherited" | "unavailable";

/** What a page is told of a conversation's guidance (`LiveInfo.guidance`). */
export interface LiveGuidance {
	/** The template it was started with, while that template still exists; null for text typed by hand. */
	template: string | null;
	/** The template's name, for the page (a template renamed since shows its new name). */
	templateName: string | null;
	/** The text the conversation carries now. */
	text: string;
	/**
	 * Whether a change reaches this process without a restart: true while it runs with the extension (which reads the file
	 * at each turn). A conversation whose omp runs without it says why (`skipped`), and its guidance is read-only: it
	 * carries what it was opened with, and the next opening carries the change.
	 */
	live: boolean;
	/** Why the process does not carry guidance, when it cannot (absent: it does, or it was given none). */
	skipped?: GuidanceSkip;
}
