import { isRecord } from "./guards.ts";
import { cleanText, oneLine } from "./unattended.ts";

/**
 * `restart_session`: the main agent ends its own omp process, and the same conversation goes on in a fresh one, without the
 * person. It is for a process that is wedged in a way the agent can see but not undo from inside it — `bash` calls that
 * hang while other tools still answer, background jobs that became runaway threads of omp's own process.
 *
 * How it works (`server/omp/restart/`):
 *
 * - The conversation's omp is started with a small extension of the server's own (`server/omp/restart/extension.ts`), which
 *   registers the tool for the main agent only. The call returns at once and tells the agent to end its turn: the server
 *   sees the call in the event stream and writes a request record (`RestartRequest`) to its data folder.
 * - When the main agent's turn ends (not when the conversation is idle: a background job keeps it busy forever, and that is
 *   what the restart ends), or two minutes after the call, by aborting the turn, the server checks that nothing is cut off
 *   that the person would miss (a question waiting for them, a pause, running subagents unless `force`), ends omp and
 *   everything it started, resumes the same session file in a new process, and sends `continue_with` to it as a message
 *   carrying the request's id. A refusal is told to the agent the same way.
 * - The person can do the same from the conversation (This session › Force restart): the turn is aborted and the process
 *   restarted on the same path, with no message unless the agent had asked for one.
 */

/** The tool's name. */
export const RESTART_TOOL = "restart_session";

/** What the server keeps of a call's arguments (a model's text is not trusted to be short). */
export const RESTART_LIMITS = {
	reason: 200,
	continueWith: 4_000,
} as const;

/** How many restarts the agent may ask for, per conversation, in `RESTART_WINDOW_MS`. */
export const RESTART_MAX = 3;
export const RESTART_WINDOW_MS = 60 * 60_000;

/** How long the turn that asked for a restart has to end by itself before it is aborted. */
export const RESTART_TURN_END_MS = 2 * 60_000;

/** Who asked for a restart. */
export type RestartBy = "agent" | "user";

/** Why a restart the agent asked for was not made. */
export type RestartRefusal =
	/** A dialog waits for the person (a question, an approval): ending the process would take it away from them. */
	| "asking"
	/** The person paused the conversation. */
	| "paused"
	/** Subagents run, and the call did not say `force`. */
	| "subagents"
	/** omp did not say whether subagents run, and the call did not say `force`. */
	| "subagentsUnknown"
	/** `RESTART_MAX` restarts in the last `RESTART_WINDOW_MS` already. */
	| "rateLimit"
	/** The conversation has no session file to resume. */
	| "noSession";

export const RESTART_REFUSALS: readonly RestartRefusal[] = [
	"asking",
	"paused",
	"subagents",
	"subagentsUnknown",
	"rateLimit",
	"noSession",
];

/** What a refusal says to the agent: the cause, and what to do instead. */
const REFUSAL_TEXT: Record<RestartRefusal, { cause: string; instead: string }> = {
	asking: {
		cause: "a question or approval is waiting for the person",
		instead: "Wait for their answer, then call restart_session again if the process is still wedged.",
	},
	paused: {
		cause: "the person paused the conversation",
		instead: "Carry on in this process; call restart_session again if it is still wedged.",
	},
	subagents: {
		cause: "subagents are still running",
		instead: "Wait for them, or call restart_session again with force: true to end them with the process.",
	},
	subagentsUnknown: {
		cause: "omp did not say whether subagents are running",
		instead: "Call restart_session again with force: true if ending any running subagents is acceptable.",
	},
	rateLimit: {
		cause: `this conversation was restarted ${RESTART_MAX} times in the last hour already`,
		instead: "Carry on in this process, or tell the person what is wrong.",
	},
	noSession: {
		cause: "the conversation has no saved session to resume",
		instead: "Carry on in this process.",
	},
};

/** The cause of a refusal, as the agent reads it. */
export const refusalCause = (why: RestartRefusal): string => REFUSAL_TEXT[why].cause;

/** The tool's arguments as the server keeps them, or null when they lack what the tool requires. */
export interface RestartArgs {
	reason: string;
	continueWith: string;
	force: boolean;
}

export function restartArgsOf(value: unknown): RestartArgs | null {
	if (!isRecord(value)) return null;
	const reason = oneLine(cleanText(value.reason, RESTART_LIMITS.reason));
	const continueWith = cleanText(value.continue_with, RESTART_LIMITS.continueWith);
	if (!reason || !continueWith) return null;
	return { reason, continueWith, force: value.force === true };
}

/** The start of every message the server sends to the conversation about a restart: what makes it findable in the session file. */
const MARK = "omp-webui";

/** A request's id: what its messages carry, and what the server looks for in the session file before it sends one. */
export const RESTART_ID = /^r-[0-9a-f]{16}$/;

/** The words of the first line of a restart's message, after its mark. */
const RESTARTED_BY_AGENT = "Restarted by the agent: ";
const REFUSED = "Restart refused: ";

/**
 * The message the new process is sent: the agent's own `continue_with`, under a first line that names the request (the
 * page draws it as a divider, and the server finds it in the session file) and a paragraph that says what happened and that
 * the words are the agent's, not the person's.
 */
export function restartMessage(id: string, reason: string, continueWith: string): string {
	return [
		`[${MARK} restart ${id}] ${RESTARTED_BY_AGENT}${oneLine(reason)}`,
		"This conversation's omp process was ended and started again because you called restart_session. Everything the old process had started has ended (background bash and eval jobs, dev servers, MCP servers, eval state); the history, the todos and the goal are kept. This message was written by omp-webui from your own restart request: it is not from the person.",
		"What you asked to do next (continue_with):",
		continueWith,
	].join("\n");
}

/** The message that tells the agent its restart was not made, and why. */
export function refusalMessage(id: string, why: RestartRefusal, reason: string): string {
	const { cause, instead } = REFUSAL_TEXT[why];
	return [
		`[${MARK} restart-refused ${id} ${why}] ${REFUSED}${cause}`,
		`Your restart_session call (reason: ${oneLine(reason)}) was not carried out because ${cause}. Nothing was ended. ${instead} This message was written by omp-webui: it is not from the person.`,
	].join("\n");
}

/** A restart's message, as the page reads it back out of the transcript. */
export type RestartMessage =
	| { kind: "restarted"; id: string; reason: string; continueWith: string }
	| { kind: "refused"; id: string; why: RestartRefusal };

const FIRST_LINE = /^\[omp-webui (restart|restart-refused) (r-[0-9a-f]{16})(?: ([A-Za-z]+))?\] ([^\n]*)/;

/** What a user message of the server's about a restart says, or null for any other message. */
export function parseRestartMessage(text: string): RestartMessage | null {
	const m = FIRST_LINE.exec(text);
	if (!m) return null;
	const [, kind, id, why, rest] = m as unknown as [string, string, string, string | undefined, string];
	if (kind === "restart") {
		if (!rest.startsWith(RESTARTED_BY_AGENT)) return null;
		const marker = "\nWhat you asked to do next (continue_with):\n";
		const at = text.indexOf(marker);
		return {
			kind: "restarted",
			id,
			reason: rest.slice(RESTARTED_BY_AGENT.length),
			continueWith: at >= 0 ? text.slice(at + marker.length) : "",
		};
	}
	const refusal = RESTART_REFUSALS.find((r) => r === why);
	return refusal ? { kind: "refused", id, why: refusal } : null;
}

/** What a conversation's process tells every page of a restart (`LiveInfo`). */
export interface RestartPendingNote {
	/** The agent's reason. */
	reason: string;
	/** When it asked (server clock). */
	at: number;
}

/** A restart was refused while the conversation was paused: the agent is told when it runs again. */
export interface RestartRefusedNote {
	why: RestartRefusal;
	reason: string;
	at: number;
}

/** This process took over from one the person force-restarted (`by: "user"`), until its first turn begins. */
export interface RestartedNote {
	by: RestartBy;
	at: number;
}

/** A restart could not be made: the old process did not end, or the conversation could not be started again. */
export interface RestartFailedNote {
	message: string;
	at: number;
}
