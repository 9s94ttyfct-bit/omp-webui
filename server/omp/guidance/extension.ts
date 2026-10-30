import { closeSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Model guidance, an omp extension: the web UI starts a conversation's omp with it when the person gave that conversation
 * guidance on how to use models for subagents (#641), and omp calls its `before_agent_start` handler before it builds the
 * system prompt of a turn. The handler appends the conversation's guidance text to the main agent's prompt, and does
 * nothing at all for anything else.
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

/** The heading the block is put under; the text itself follows it. */
const HEADING = "## Model guidance";

/** What omp passes a `before_agent_start` handler, as far as this reads it. */
interface BeforeAgentStart {
	/** The blocks of the system prompt omp built for this turn, in order. */
	systemPrompt?: unknown;
}

/** The session of the agent whose turn it is: `main`, or `sub` for a task subagent (and an advisor). */
interface Context {
	agent?: { kind?: string };
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
		let text: string;
		try {
			text = readCapped(file);
		} catch {
			// No file: the conversation has no guidance (or its overlay is gone, and omp is ending anyway).
			return undefined;
		}
		const guidance = text.replace(/^\s+|\s+$/g, "");
		if (!guidance) return undefined;
		const blocks = Array.isArray(event?.systemPrompt)
			? event.systemPrompt.filter((b): b is string => typeof b === "string")
			: [];
		// The text carries its own heading only when the person wrote one: what omp's own prompt looks like is not this
		// extension's to decide, and a template that starts with "## Model guidance" does not get a second heading.
		const block = guidance.startsWith("#") ? guidance : `${HEADING}\n${guidance}`;
		return { systemPrompt: [...blocks, block] };
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
