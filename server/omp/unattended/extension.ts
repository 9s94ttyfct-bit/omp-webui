import { closeSync, mkdirSync, openSync, readSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Unattended mode (#646), an omp extension: the web UI starts every conversation's omp with it, and it does something
 * only while the person has the mode on for that conversation. omp calls its `before_agent_start` handler before it builds
 * the system prompt of a turn; for the **main agent** the handler appends the standing instruction ("the person is away:
 * do not ask, go on with what needs no decision, file what does") and makes the tool `file_question` available; for
 * anything else (a subagent, a title's request) it does nothing at all.
 *
 * It is copied into the app's data folder (`install.ts`), because omp reads an extension from a file; it runs in omp's own
 * process and imports nothing of the app, so what it shares with the server (the names below, the length limit, the
 * tool's result) is written out here and exported for the server to use (the server's tests hold the two to the same
 * values). It is the model guidance's sibling (`server/omp/guidance/extension.ts`) and works the same way:
 *
 * - The instruction is the file named in `OMPW_UNATTENDED_FILE`, which the server sets for the process. The server writes it
 *   beside the conversation's settings overlay while the mode is on, and takes it away when it is off: the handler reads it
 *   at each turn, so a switch reaches the next turn without a restart. A file that is gone or unreadable means off (a
 *   conversation never fails for this). At most `UNATTENDED_READ_MAX` characters are read.
 * - The tool is registered when omp starts but kept out of the model's tool list (`defaultInactive`); the handler adds it
 *   to the active tools while the file is there and takes it out when it is not, so a conversation that is not unattended
 *   offers the model nothing new, and the tool's text never costs those conversations a token.
 * - `file_question` returns at once. It files nothing itself: the server watches the conversation's event stream and files
 *   the call's arguments (`server/live.ts`), so there is no credential in the process, and nothing here can reach the
 *   server's data.
 * - The note `<file>.loaded` says the extension is in: omp carries on without an extension it could not load, so the
 *   server does not take a command line that names it for one that runs it.
 */

/** The environment variable that names the conversation's instruction file (`server/omp/unattended/session.ts`). */
export const UNATTENDED_FILE_ENV = "OMPW_UNATTENDED_FILE";

/** What follows the instruction file's name in the note the extension leaves when it has started in the process. */
export const UNATTENDED_LOADED_SUFFIX = ".loaded";

/**
 * The most characters of the file one turn takes: `INSTRUCTION_MAX` of `shared/unattended.ts`, the two newlines after it
 * and `WAITING_MAX`, the questions that still wait (#694).
 */
export const UNATTENDED_READ_MAX = 8_002;

/** The tool the agent files a question with: `UNATTENDED_TOOL` of `shared/unattended.ts`. */
export const FILE_QUESTION_TOOL = "file_question";

/** What the tool returns: `TOOL_RECORDED_RESULT` of `shared/unattended.ts`. */
export const FILE_QUESTION_RESULT =
	'Recorded for the person, who is away. Continue with what does not need the answer. The answer will arrive later as a message that begins "Answer to your question".';

/** The heading the block is put under when the person's text carries none. */
const HEADING = "## Unattended mode";

/** What omp passes a `before_agent_start` handler, as far as this reads it. */
interface BeforeAgentStart {
	systemPrompt?: unknown;
}

/** The session of the agent whose turn it is: `main`, or `sub` for a task subagent (and an advisor). */
interface Context {
	agent?: { kind?: string };
}

/** What this uses of omp's extension API. */
interface Pi {
	on(event: "before_agent_start", handler: (event: BeforeAgentStart, ctx: Context) => unknown): void;
	registerTool(tool: Record<string, unknown>): void;
	getActiveTools(): string[] | Promise<string[]>;
	setActiveTools(names: string[]): void | Promise<void>;
}

/** The tool's arguments, as the model sees them (the server holds what it files to its own limits). */
const PARAMETERS = {
	type: "object",
	properties: {
		title: { type: "string", description: "The question, in one short line." },
		context: {
			type: "string",
			description:
				"What the person needs to know to answer: what you found, why it matters, what depends on it. They read this later, away from the conversation.",
		},
		options: {
			type: "array",
			description: "The answers you can see, if there are choices. Leave out for an open question.",
			items: {
				type: "object",
				properties: {
					label: { type: "string", description: "The choice, short." },
					description: { type: "string", description: "What choosing it means." },
				},
				required: ["label"],
				additionalProperties: false,
			},
		},
		recommended: { type: "integer", minimum: 0, description: "The index in options of the one you would pick." },
		meanwhile: {
			type: "string",
			description: "What you did, or are going on to do, while this waits.",
		},
	},
	required: ["title", "context"],
	additionalProperties: false,
};

/**
 * The start of `file`, at most `UNATTENDED_READ_MAX` characters: only as many bytes are read as that can take (UTF-8 is at
 * most four bytes a character), so that a file the model made huge costs a turn nothing.
 */
function readCapped(file: string): string {
	const fd = openSync(file, "r");
	try {
		const buffer = Buffer.alloc(UNATTENDED_READ_MAX * 4);
		let filled = 0;
		while (filled < buffer.length) {
			const n = readSync(fd, buffer, filled, buffer.length - filled, null);
			if (n === 0) break;
			filled += n;
		}
		return buffer.toString("utf8", 0, filled).slice(0, UNATTENDED_READ_MAX);
	} finally {
		closeSync(fd);
	}
}

export default function unattended(pi: Pi): void {
	const file = process.env[UNATTENDED_FILE_ENV];
	pi.registerTool({
		name: FILE_QUESTION_TOOL,
		label: "File question",
		description:
			"Files one question for the person, who is away, and returns at once without waiting. Use it for anything that needs their decision; then go on with the work that does not depend on the answer. The answer comes later as a message.",
		parameters: PARAMETERS,
		// Out of the model's tool list until the handler below puts it in: a conversation that is not unattended offers nothing new.
		defaultInactive: true,
		loadMode: "essential",
		// Filing a note for the person changes nothing in the workspace: a permission mode never stops the agent to ask about it.
		approval: "read",
		async execute() {
			return { content: [{ type: "text", text: FILE_QUESTION_RESULT }], details: {} };
		},
	});
	/** Put the tool in the active tools while the mode is on, and out of them when it is off (only when that is a change). */
	const syncTool = async (on: boolean): Promise<void> => {
		const active = await pi.getActiveTools();
		const has = active.includes(FILE_QUESTION_TOOL);
		if (on && !has) await pi.setActiveTools([...active, FILE_QUESTION_TOOL]);
		else if (!on && has) await pi.setActiveTools(active.filter((n) => n !== FILE_QUESTION_TOOL));
	};
	pi.on("before_agent_start", async (event, ctx) => {
		// A subagent has its own prompt (and omp offers it no extension tools): the instruction is about how the main agent
		// reaches the person. A title's request has no agent (`ctx.agent` absent) and is left alone too.
		if (ctx?.agent?.kind !== "main") return undefined;
		let text = "";
		if (file) {
			try {
				text = readCapped(file);
			} catch {
				// No file: the mode is off for this conversation.
			}
		}
		const instruction = text.replace(/^\s+|\s+$/g, "");
		try {
			await syncTool(instruction !== "");
		} catch {
			// The tool stays as it was: the instruction still reaches the model, and the server files its `ask` dialogs itself.
		}
		if (!instruction) return undefined;
		const blocks = Array.isArray(event?.systemPrompt)
			? event.systemPrompt.filter((b): b is string => typeof b === "string")
			: [];
		// The text carries its own heading only when the person wrote one: what omp's own prompt looks like is not this
		// extension's to decide.
		const block = instruction.startsWith("#") ? instruction : `${HEADING}\n${instruction}`;
		return { systemPrompt: [...blocks, block] };
	});
	// Said last, once the handler is in: the server calls the mode live on the strength of this note, and not of the command line.
	if (!file) return;
	try {
		mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
		writeFileSync(`${file}${UNATTENDED_LOADED_SUFFIX}`, String(process.pid), { mode: 0o600 });
	} catch {
		// No note: the page says the instruction is not carried, which is the safe thing to say.
	}
}
