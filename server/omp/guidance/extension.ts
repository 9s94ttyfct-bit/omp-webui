import { closeSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Guidance, an omp extension: the web UI starts a conversation's omp with it, and omp calls its `before_agent_start`
 * handler before it builds the system prompt of a turn. The guidance is the conversation's standing work rules (#641:
 * first about handing work to subagents and their models; now any rule the person wants the conversation to keep). The
 * handler appends it to the main agent's prompt, says in the conversation when it changed, and does nothing at all for
 * anything else.
 *
 * It is copied into the app's data folder (`install.ts`), because omp reads an extension from a file; it runs in omp's
 * own process and imports nothing of the app, so what it shares with the server (the names below, the length limit) is
 * written out here and exported for the server to use (the server's tests hold the two to the same values).
 *
 * Why an extension and not a flag (measured against omp 18.12.6, `tests/contract/model-guidance.test.ts`):
 * `--append-system-prompt` reaches the system prompt, but omp takes one value — a second flag replaces the first, and an
 * explicit one suppresses a discovered `APPEND_SYSTEM.md`, which is the person's own file. The web UI passes the person's
 * own `--append-system-prompt` from New chat's Options, so it cannot take the flag for itself.
 *
 * What it does with the prompt: it appends one block after the blocks omp built. It never replaces them, so everything
 * omp puts in the prompt (its instructions, the workstation, the context files, the append text, an interview's
 * prelude) stays exactly as it was, and a turn whose prompt omp rebuilds after a compaction gets the guidance again.
 *
 * Where the text is: the file named in `OMPW_GUIDANCE_FILE`, which the server sets for the process. The server writes it
 * beside the conversation's settings overlay, and rewrites it when the guidance changes: the handler reads it at each
 * turn, so a change reaches the next turn without a restart, and a conversation whose guidance was cleared carries none
 * from the next turn on. A file that is gone or unreadable adds nothing (a conversation never fails for its guidance).
 * The handler takes at most `GUIDANCE_READ_MAX` characters of it: the server holds the text to that length when it writes
 * the file, and a file that grew since (the model has tools) must not put more into every turn's prompt.
 *
 * Why it says it outranks things, and why a change is said in the conversation (measured with a real model, 8 replies a
 * case, design `docs/superpowers/specs/2026-11-01-guidance-change-note-design.md`): omp's recalled memories reach the
 * model as a message in the conversation at each turn, the same standing as what the person typed, and a guidance that
 * changed only in the system prompt lost to the older rule in the conversation (a rule the person typed: 2 of 8 replies
 * followed the new guidance; a memory: 0 of 8). With the note below, 8 of 8 did. An old memory against a guidance that
 * never changed lost 2 of 8 without the priority sentence, and none with it.
 *
 * What the conversation was given is read from its own session, the branch's own entries (`getBranch`), so a resumed
 * conversation, a new process and a switch to another branch all compare with what that branch was given. The record is
 * the note itself once omp delivered it (a `custom_message`, `GUIDANCE_NOTE_TYPE`, `details: { text }`, which the page draws
 * as "Guidance changed"), and, for a branch with no turn yet, a custom entry (`GUIDANCE_NOTE_TYPE`, `{ text }`; entries are
 * not sent to the model) written with the first turn, which needs no note: the system prompt carries the guidance. Nothing
 * is written on the strength of a note omp may still drop — omp runs this hook again when the base prompt changed meanwhile,
 * and drops the prompt and its messages when the turn is aborted or the session switched after it — so such a turn leaves
 * no record, and the next one tells the model again. The note's words are neutral, so a conversation from before this,
 * which has no record, is told once and truthfully what its standing instructions are.
 *
 * What it says of itself: once the handler is in, it leaves a note (`<file>.loaded`), as the gate does (`<overlay>.risk.loaded`).
 * omp carries on without an extension it could not load, so the server does not take a command line that names this
 * extension for one that runs it: the page says a change is live only once the note is there.
 */

/** The environment variable that names the conversation's guidance file (`server/omp/guidance/session.ts`). */
export const GUIDANCE_FILE_ENV = "OMPW_GUIDANCE_FILE";

/** What follows the guidance file's name in the note the extension leaves when it has started in the process. */
export const GUIDANCE_LOADED_SUFFIX = ".loaded";

/** The most characters of the file one turn takes: `GUIDANCE_MAX` of `shared/model-guidance.ts`. */
export const GUIDANCE_READ_MAX = 4_000;

/** The custom type of the entry that records what a conversation was given, and of the note that says it changed. */
export const GUIDANCE_NOTE_TYPE = "ompw-guidance";

/** The heading of the block in the system prompt. */
export const GUIDANCE_HEADING = "# Standing instructions for this conversation";

/** What the block says of itself, under the heading. */
const PRIORITY =
	"These are the person's current standing instructions for this whole conversation. They replace any earlier instruction in this conversation, any recalled memory and any earlier habit of this conversation that disagrees with them.";

/** The note a conversation gets when its guidance changed (`text`), or was turned off (empty). */
function noteFor(text: string): string {
	return text
		? `The standing instructions of this conversation are now:\n\n${text}\n\nThey replace any earlier instruction in this conversation, and any recalled memory, that disagrees with them.`
		: "The standing instructions of this conversation were removed. Rules that were given only as standing instructions no longer apply.";
}

/** What omp passes a `before_agent_start` handler, as far as this reads it. */
interface BeforeAgentStart {
	/** The blocks of the system prompt omp built for this turn, in order. */
	systemPrompt?: unknown;
}

/** The session of the agent whose turn it is: `main`, or `sub` for a task subagent (and an advisor). */
interface Context {
	agent?: { kind?: string };
	sessionManager?: {
		getBranch?(): unknown[];
		appendCustomEntry?(customType: string, data: unknown): unknown;
	};
}

/** One entry of the session's branch, as far as this reads it. */
interface Entry {
	type?: string;
	customType?: string;
	data?: { text?: unknown };
	details?: { text?: unknown };
	message?: { role?: string };
}

/**
 * What the branch was last given (empty: nothing, or the guidance was turned off): its latest note or record. And whether
 * it has a message of the person's (a turn before this one). Neither can be read: as if nothing was given, in a branch
 * with no turns.
 */
function branchState(ctx: Context): { given: string; hadTurns: boolean } {
	let entries: Entry[] = [];
	try {
		entries = (ctx.sessionManager?.getBranch?.() ?? []) as Entry[];
	} catch {}
	let given = "";
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e?.customType !== GUIDANCE_NOTE_TYPE || (e.type !== "custom" && e.type !== "custom_message")) continue;
		const text = e.type === "custom" ? e.data?.text : e.details?.text;
		given = typeof text === "string" ? text : "";
		break;
	}
	return { given, hadTurns: entries.some((e) => e?.type === "message" && e.message?.role === "user") };
}

/**
 * The start of `file`, at most `GUIDANCE_READ_MAX` characters: only as many bytes are read as that can take (UTF-8 is at
 * most four bytes a character), so that a file the model made huge costs a turn nothing.
 */
function readCapped(file: string): string {
	const fd = openSync(file, "r");
	try {
		const buffer = Buffer.alloc(GUIDANCE_READ_MAX * 4);
		let filled = 0;
		while (filled < buffer.length) {
			const n = readSync(fd, buffer, filled, buffer.length - filled, null);
			if (n === 0) break;
			filled += n;
		}
		return buffer.toString("utf8", 0, filled).slice(0, GUIDANCE_READ_MAX);
	} finally {
		closeSync(fd);
	}
}

export default function modelGuidance(pi: {
	on(event: "before_agent_start", handler: (event: BeforeAgentStart, ctx: Context) => unknown): void;
}): void {
	const file = process.env[GUIDANCE_FILE_ENV];
	pi.on("before_agent_start", async (event, ctx) => {
		// A subagent's prompt is its own: the guidance is about how the main agent hands work out, and must not read as an
		// instruction to the subagent about itself. A title's request has no agent (`ctx.agent` absent) and is left alone too.
		if (ctx?.agent?.kind !== "main") return undefined;
		if (!file) return undefined;
		let text = "";
		try {
			text = readCapped(file).replace(/^\s+|\s+$/g, "");
		} catch {
			// No file: the conversation has no guidance (or its overlay is gone, and omp is ending anyway).
		}
		const result: { systemPrompt?: string[]; message?: unknown } = {};
		if (text) {
			const blocks = Array.isArray(event?.systemPrompt)
				? event.systemPrompt.filter((b): b is string => typeof b === "string")
				: [];
			result.systemPrompt = [...blocks, `${GUIDANCE_HEADING}\n${PRIORITY}\n\n${text}`];
		}
		const { given, hadTurns } = branchState(ctx);
		if (text !== given) {
			if (hadTurns)
				result.message = { customType: GUIDANCE_NOTE_TYPE, display: true, details: { text }, content: noteFor(text) };
			else
				try {
					ctx.sessionManager?.appendCustomEntry?.(GUIDANCE_NOTE_TYPE, { text });
				} catch {
					// Not recorded: the next turn has a turn before it, and says it in a note, which is the safe side.
				}
		}
		return result.systemPrompt || result.message ? result : undefined;
	});
	// Said last, once the handler is in: the server calls the guidance live on the strength of this note, and not of the command line.
	if (!file) return;
	try {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		writeFileSync(`${file}${GUIDANCE_LOADED_SUFFIX}`, String(process.pid), { mode: 0o600 });
	} catch {
		// No note: the page says the guidance is not carried live, which is the safe thing to say.
	}
}
