import { isRecord } from "./guards.ts";

/**
 * Unattended mode (#646): the person turns it on for a conversation and goes away. The agent does what needs no decision,
 * and what needs one reaches the person as a **question** in a list (the sidebar's Questions) instead of blocking the turn.
 *
 * How it reaches omp (the same mechanism as the model guidance, #641 — `server/omp/guidance/`):
 *
 * - The conversation's omp is started with a small extension of the server's own (`server/omp/unattended/extension.ts`).
 *   While the mode is on, its `before_agent_start` handler appends the standing instruction (this file's
 *   `DEFAULT_INSTRUCTION`, or the person's edit of it) to the **main agent's** system prompt, and makes the tool
 *   `file_question` available to it. The instruction is a file beside the conversation's settings overlay, read at every
 *   turn: turning the mode on or off reaches the next turn without a restart, and the prompt is rebuilt from omp's own
 *   blocks each time, so compaction and resuming cannot drop it.
 * - `file_question` returns at once. The server sees the call in the conversation's event stream and files the question.
 * - omp's own `ask` dialog (what the model uses when it wants a choice) is answered by the server with `ASK_RECORDED_REPLY`
 *   and filed the same way, so that it never blocks. Only `ask`: omp's approvals of tools, and what the guard asks
 *   ("Guard dangerous commands"), are the person's consent and are never answered for them.
 * - The person answers from the Questions list; the answer goes to the conversation as an ordinary message (queued while
 *   it works, waking it when it is idle or closed).
 */

/** What follows the settings overlay's file name in the file that holds the instruction (`server/omp/unattended/session.ts`). */
export const UNATTENDED_SUFFIX = ".unattended.md";

/** The tool the agent files a question with. */
export const UNATTENDED_TOOL = "file_question";

/** The most characters of the instruction one turn takes (the system prompt is paid for on every turn). */
export const INSTRUCTION_MAX = 4_000;

/** The limits a question is held to, as the server files it (a model's text is not trusted to be short). */
export const QUESTION_LIMITS = {
	title: 200,
	context: 3_000,
	meanwhile: 1_500,
	options: 10,
	label: 200,
	description: 400,
	answer: 6_000,
	/** What the server keeps in all, settled ones included: the oldest settled go first, then the oldest open. */
	kept: 200,
	/** The most a conversation may have open: a runaway agent cannot fill the list with its own. */
	openPerConversation: 60,
} as const;

/** What an `ask` dialog is answered with while unattended: what the model reads as the person's answer. */
export const ASK_RECORDED_REPLY =
	'Recorded for the person, who is away. Continue with what does not need the answer. The answer will arrive later as a message that begins "Answer to your question".';

/** What `file_question` returns to the model. */
export const TOOL_RECORDED_RESULT =
	'Recorded for the person, who is away. Continue with what does not need the answer. The answer will arrive later as a message that begins "Answer to your question".';

/** The standing instruction the person starts with, and what Restore default puts back. */
export const DEFAULT_INSTRUCTION = [
	"## Unattended mode",
	"The person is away and will not answer you now. Do not ask them anything directly and do not wait for an answer.",
	`- Go on with everything that does not need a decision from the person.`,
	`- When something does need one (a choice between approaches, a missing detail, a permission you are unsure of, anything risky or hard to undo), do not guess at a point that matters and do not stop. Call \`${UNATTENDED_TOOL}\` once for it: a short title, the context the person needs to answer it, the options you see (mark the one you would pick), and what you are doing in the meantime. It returns at once.`,
	"- Then continue with the parts of the work that do not depend on the answer. When nothing is left that does not, say what is waiting in a final message and stop.",
	`- Do not use the \`ask\` tool: while the person is away it is only recorded, and you get no answer. Use \`${UNATTENDED_TOOL}\` instead.`,
	'- The answer arrives later as a message that begins "Answer to your question". Act on it when it comes.',
].join("\n");

/** One option of a question. */
export interface QuestionOption {
	label: string;
	description?: string;
}

/** How a question reached the list: the agent filed it (`tool`), or omp's own `ask` dialog was recorded (`ask`). */
export type QuestionSource = "tool" | "ask";

export type QuestionState = "open" | "answered" | "dismissed";

/** One question for the person. */
export interface Question {
	id: string;
	/** The conversation it was filed from: its session file ("" when omp had not named one yet; such a question cannot be answered). */
	session: string;
	/** The conversation's folder, for the list to say where it is. */
	cwd?: string;
	/** The conversation's title when the question was filed (the page prefers the title the conversation has now). */
	title: string;
	source: QuestionSource;
	/** The question itself, one line. */
	question: string;
	/** What the person needs to know to answer it. */
	context: string;
	options: QuestionOption[];
	/** The option the agent would pick (an index into `options`). */
	recommended?: number;
	/** `ask` dialogs only: more than one option may be chosen. */
	multi?: boolean;
	/** What the agent did, or went on doing, while the question waits. */
	meanwhile?: string;
	askedAt: number;
	state: QuestionState;
	settledAt?: number;
	/** What the person answered: the options they chose and what they wrote. */
	answer?: { options: string[]; text: string };
	/** What filed it: the tool call's id or the dialog's, so that the same call is never filed twice. */
	call?: string;
}

/** What the pages are told on every change: only counts, so that the list is fetched when it is opened. */
export interface QuestionCounts {
	/** Counts the changes. */
	rev: number;
	open: number;
	/** Open questions by conversation (session file), for the conversation's own badge. */
	byConversation: Record<string, number>;
}

/** Why a question could not be kept: the conversation has `openPerConversation` open already, it had no text, or the list could not be written. */
export const QUESTION_DROP_WHYS = ["full", "empty", "unwritable"] as const;
export type QuestionDropWhy = (typeof QUESTION_DROP_WHYS)[number];

/**
 * A question the server could not keep (#650): what the conversation is told of it at once (a `question_dropped` frame), and
 * what the Questions list says of it for as long as the server lives. Kept in memory, never in the questions file.
 */
export interface QuestionDrop {
	/** Counts the server's drops from 1: a page shows the ones after the last it read. */
	seq: number;
	/** The conversation that filed it (its session file), which the list groups by. */
	session: string;
	why: QuestionDropWhy;
	/** The question as it was filed, "" when it had no text. */
	question: string;
	at: number;
}

/** One drop, as a page is told it in the conversation's own state (`LiveInfo.questionDropped`): no session, no seq. */
export interface QuestionDropNote {
	why: QuestionDropWhy;
	/** The question as it was filed, "" when it had no text. */
	question: string;
	/** The server's clock when it was dropped. */
	at: number;
}

/** The list a page reads when it opens the Questions page. */
export interface QuestionList extends QuestionCounts {
	questions: Question[];
	/** The questions that could not be kept since this server started, newest last (see `QuestionDrop`). */
	dropped: QuestionDrop[];
}

/** What a page is told of one conversation's unattended mode (`LiveInfo.unattended`; absent: off). */
export interface LiveUnattended {
	/**
	 * Whether the instruction and the question tool reach this process: true while it runs with the extension. A process
	 * that runs without it (`skipped`) still has its `ask` dialogs filed: that is the server's.
	 */
	live: boolean;
	/** Why the process does not carry the instruction, when it cannot (absent: it does). */
	skipped?: "trustedExtension" | "inherited" | "unavailable";
}

/** What the instruction is now (`GET /api/unattended`). */
export interface UnattendedSettings {
	instruction: string;
	/** The text that ships, for Restore default. */
	shipped: string;
	/** Whether `instruction` is the person's own (not the shipped text). */
	custom: boolean;
}

/** Why the instruction is refused. */
export type InstructionProblem = "empty" | "tooLong";

export const instructionProblemText = (p: InstructionProblem): string =>
	p === "empty" ? "The instruction needs some text" : `The instruction is at most ${INSTRUCTION_MAX} characters`;

/** `text` with blank lines at either end gone, the rest as written. */
export const instructionText = (text: string): string => text.replace(/^\s+|\s+$/g, "");

/** `text` cut to `max` UTF-16 units without leaving half of a surrogate pair at the end. */
export function clip(text: string, max: number): string {
	if (text.length <= max) return text;
	let end = max;
	const last = text.charCodeAt(end - 1);
	if (last >= 0xd800 && last <= 0xdbff) end--;
	return text.slice(0, end);
}

/** A control character other than a line break or a tab, which a model may put in a text and a page must not show. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: that is what it removes
const CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

/** `value` as text of at most `max` characters with no control characters, trimmed; "" for anything that is not text. */
export function cleanText(value: unknown, max: number): string {
	if (typeof value !== "string") return "";
	return clip(value.replace(CONTROLS, "").replace(/\r\n?/g, "\n").trim(), max);
}

/**
 * `text` on one line: each line break (and the space around it) is one space. U+0085, U+2028 and U+2029 count as breaks
 * too, since a model reads them as such.
 */
export const oneLine = (text: string): string => text.replace(/\s*[\n\r\u0085\u2028\u2029]\s*/g, " ");

/** The options a model sent, as `QuestionOption`s: the ones with a label, at most `QUESTION_LIMITS.options`, no label twice. */
export function cleanOptions(value: unknown): QuestionOption[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	const out: QuestionOption[] = [];
	for (const raw of value) {
		const item = typeof raw === "string" ? { label: raw } : raw;
		if (!isRecord(item)) continue;
		const { label, description } = item;
		const l = oneLine(cleanText(label, QUESTION_LIMITS.label));
		if (!l || seen.has(l)) continue;
		seen.add(l);
		const d = cleanText(description, QUESTION_LIMITS.description);
		out.push(d ? { label: l, description: d } : { label: l });
		if (out.length >= QUESTION_LIMITS.options) break;
	}
	return out;
}

/** What a question needs of its filer, as the server files it: nothing here is the model's own length or shape. */
export interface QuestionDraft {
	question: string;
	context: string;
	options: QuestionOption[];
	recommended?: number;
	multi?: boolean;
	meanwhile?: string;
}

/** The draft `file_question`'s arguments make, or null when there is no question in them. */
export function draftOfToolArgs(args: unknown): QuestionDraft | null {
	if (!isRecord(args)) return null;
	const a = args;
	const question = oneLine(cleanText(a.title ?? a.question, QUESTION_LIMITS.title));
	if (!question) return null;
	const options = cleanOptions(a.options);
	// The agent's words, on one line: the answer message they go back in is the person's (role user), and a line break of the
	// agent's would let it write a line of that message's own, such as a "Chosen:" the person never chose (#750).
	const meanwhile = oneLine(cleanText(a.meanwhile, QUESTION_LIMITS.meanwhile));
	const rec = a.recommended;
	return {
		question,
		context: cleanText(a.context, QUESTION_LIMITS.context),
		options,
		...(typeof rec === "number" && Number.isInteger(rec) && rec >= 0 && rec < options.length
			? { recommended: rec }
			: {}),
		...(meanwhile ? { meanwhile } : {}),
	};
}

/** The drafts an omp `ask` dialog's questions make (one per question of the call). */
export function draftsOfAsk(questions: unknown): QuestionDraft[] {
	if (!Array.isArray(questions)) return [];
	const out: QuestionDraft[] = [];
	for (const raw of questions) {
		if (!isRecord(raw)) continue;
		const q = raw;
		const question = oneLine(cleanText(q.question, QUESTION_LIMITS.title));
		if (!question) continue;
		const options = cleanOptions(q.options);
		const rec = q.recommended;
		out.push({
			question,
			context: cleanText(q.header, QUESTION_LIMITS.context),
			options,
			...(typeof rec === "number" && Number.isInteger(rec) && rec >= 0 && rec < options.length
				? { recommended: rec }
				: {}),
			...(q.multi === true ? { multi: true } : {}),
		});
	}
	return out;
}

/** The answer an `ask` dialog gets while unattended: the fixed reply to every question of the call. */
export function recordedAskAnswers(
	questions: unknown,
): { id: string; selectedOptions: string[]; customInput: string }[] {
	if (!Array.isArray(questions)) return [];
	const out: { id: string; selectedOptions: string[]; customInput: string }[] = [];
	for (const raw of questions) {
		const id = isRecord(raw) ? raw.id : undefined;
		if (typeof id === "string") out.push({ id, selectedOptions: [], customInput: ASK_RECORDED_REPLY });
	}
	return out;
}

/** What the person chose and wrote, as a page sends it. */
export interface AnswerInput {
	options: string[];
	text: string;
}

/**
 * The answer a page sent, held to what a question can carry: the options must be ones the question offers (`ask` dialogs'
 * multi-choice aside, one), and the text is cut. Null when there is no answer at all (nothing chosen, nothing written).
 */
export function cleanAnswer(question: Pick<Question, "options" | "multi">, input: unknown): AnswerInput | null {
	if (!isRecord(input)) return null;
	const { options, text } = input;
	const offered = new Set(question.options.map((o) => o.label));
	const chosen: string[] = [];
	if (Array.isArray(options))
		for (const o of options) if (typeof o === "string" && offered.has(o) && !chosen.includes(o)) chosen.push(o);
	const picked = question.multi ? chosen : chosen.slice(0, 1);
	const written = cleanText(text, QUESTION_LIMITS.answer);
	if (!picked.length && !written) return null;
	return { options: picked, text: written };
}

/**
 * The message that carries the person's answer to the conversation: an ordinary message, in the words the instruction
 * names. It stands on its own (#694): the question may have been filed long before, and a compaction may have taken the
 * call out of what the agent holds; it says when it was filed and what the agent said it would do meanwhile, so an answer
 * that comes after the agent went its own way is not read as if nothing had happened since.
 */
export function answerMessage(
	question: Pick<Question, "question" | "askedAt" | "meanwhile">,
	answer: AnswerInput,
): string {
	const lines = [`Answer to your question "${oneLine(question.question)}":`];
	if (answer.options.length) lines.push(`Chosen: ${answer.options.map(oneLine).join("; ")}`);
	if (answer.text) lines.push(answer.options.length ? `Note: ${answer.text}` : answer.text);
	const filed = `You filed it at ${new Date(question.askedAt).toISOString()}`;
	// A question filed before its words were kept on one line is held to that here too (#750).
	const meanwhile = question.meanwhile ? oneLine(question.meanwhile) : "";
	lines.push(
		meanwhile
			? `(${filed}; meanwhile you said you would: ${meanwhile}. If you have gone another way since, square it with this answer.)`
			: `(${filed}. If you have gone another way since, square it with this answer.)`,
	);
	return lines.join("\n");
}

/** The most characters the list of waiting questions takes in the instruction file, under the instruction (`INSTRUCTION_MAX`). */
export const WAITING_MAX = 4_000;

/**
 * What the agent of an unattended conversation is told, under its instruction, of the questions it filed that still wait
 * (#694): a compaction may take the calls out of what it holds, and it must not file one again or decide it as if it were
 * answered. `waiting` newest first; what does not fit in `WAITING_MAX` is counted, not listed. Empty when none waits.
 */
export function waitingQuestionsBlock(
	waiting: readonly Pick<Question, "question" | "askedAt" | "meanwhile">[],
): string {
	if (!waiting.length) return "";
	const lines = [
		"Questions you filed that still wait for the person (do not file them again; the answers come as messages):",
	];
	let size = (lines[0] as string).length;
	for (let i = 0; i < waiting.length; i++) {
		const q = waiting[i] as (typeof waiting)[number];
		const meanwhile = q.meanwhile ? `; meanwhile: ${q.meanwhile}` : "";
		const line = `- "${q.question}" (filed ${new Date(q.askedAt).toISOString()})${meanwhile}`;
		// Room is kept for the line that says how many more there are.
		if (size + line.length + 1 > WAITING_MAX - 40) {
			lines.push(`- and ${waiting.length - i} older`);
			break;
		}
		lines.push(line);
		size += line.length + 1;
	}
	return lines.join("\n");
}
