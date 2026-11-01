import { readFileSync } from "node:fs";

/**
 * `restart_session`, an omp extension: the web UI starts every conversation's omp with it, and it gives the **main agent**
 * a tool to end its own omp process and go on with the same conversation in a fresh one (`shared/restart.ts`).
 *
 * It is copied into the app's data folder (`install.ts`), because omp reads an extension from a file; it runs in omp's own
 * process and imports nothing of the app, so what it shares with the server (the names below, the tool's result) is written
 * out here and exported for the server to use (the server's tests hold the two to the same values). It is the unattended
 * mode's sibling (`server/omp/unattended/extension.ts`) and works the same way:
 *
 * - The tool is registered when omp starts but kept out of the model's tool list (`defaultInactive`); a `before_agent_start`
 *   handler adds it to the active tools for the main agent's turns. A subagent's turn, and a title's request, change
 *   nothing, and a call that says it comes from another agent than the main one is refused.
 * - The call returns at once and does nothing itself: the server watches the conversation's event stream and acts on a call
 *   that ended without an error (`server/omp/restart/coordinator.ts`). Nothing here can reach the server or its data, and
 *   there is no credential in the process.
 * - The only thing it reads is the file named in `OMPW_RESTART_FILE`, which the server writes for the process: until when
 *   the conversation may not ask for another restart (`{ "blockedUntil": <ms> }`). A call before then is the tool's error,
 *   so that a looping agent learns of the limit from the call itself. A file that is missing or unreadable means no limit
 *   (the server holds the limit again when it sees the call).
 */

/** The environment variable that names the file the server writes the conversation's limit to. */
export const RESTART_FILE_ENV = "OMPW_RESTART_FILE";

/** The tool's name: `RESTART_TOOL` of `shared/restart.ts`. */
export const RESTART_SESSION_TOOL = "restart_session";

/** What the tool returns when the restart is asked for. */
export const RESTART_ACCEPTED_RESULT =
	"Restart requested. End your turn now: reply with one short line and call no more tools. The process is ended when this turn ends (or after two minutes, by aborting the turn), and the conversation goes on in a fresh process, where your continue_with arrives as a message. If the restart is refused instead, a message says why.";

/** The tool's description, as the model reads it. */
export const RESTART_DESCRIPTION =
	"End your own omp process and continue this same conversation in a fresh one, without the person. Only for a process that is wedged in a way you cannot undo from inside it: bash calls that hang while other tools still work, background jobs that run away. Everything the process started ends with it: background bash and eval jobs, dev servers, MCP servers, eval state. The history, the todos and the goal are kept. The call returns at once; then end your turn immediately (one short line, no more tool calls). The restart happens when your turn ends. Refused while a question or approval waits for the person, while the conversation is paused, and while subagents run unless force is true. At most 3 restarts per conversation per hour.";

/** What omp passes the handlers and a tool's `execute`, as far as this reads it: whose turn it is. */
interface Context {
	agent?: { kind?: string };
}

/** What this uses of omp's extension API. */
interface Pi {
	on(event: "before_agent_start", handler: (event: unknown, ctx: Context) => unknown): void;
	registerTool(tool: Record<string, unknown>): void;
	getActiveTools(): string[] | Promise<string[]>;
	setActiveTools(names: string[]): void | Promise<void>;
}

const PARAMETERS = {
	type: "object",
	properties: {
		reason: {
			type: "string",
			description: "Why the process must be restarted, in one short line. The person sees it in the conversation.",
		},
		continue_with: {
			type: "string",
			description:
				"What to do once the conversation runs in the new process; it arrives there as a message. Write it so that doing it twice is harmless (it can arrive again after a crash): e.g. 'check whether the build in dist/ finished, then continue with the release notes' rather than 'start the build'.",
		},
		force: {
			type: "boolean",
			description:
				"End running subagents too (they end with the process). Without it the restart is refused while subagents run.",
		},
	},
	required: ["reason", "continue_with"],
	additionalProperties: false,
};

/** Until when the server says the conversation may not ask for another restart, or null for no limit. */
function blockedUntil(file: string | undefined): number | null {
	if (!file) return null;
	try {
		const value = JSON.parse(readFileSync(file, "utf8")) as { blockedUntil?: unknown };
		return typeof value?.blockedUntil === "number" ? value.blockedUntil : null;
	} catch {
		return null;
	}
}

export default function restartSession(pi: Pi): void {
	const file = process.env[RESTART_FILE_ENV];
	pi.registerTool({
		name: RESTART_SESSION_TOOL,
		label: "Restart session",
		description: RESTART_DESCRIPTION,
		parameters: PARAMETERS,
		// Out of the model's tool list until the handler below puts it in for the main agent.
		defaultInactive: true,
		loadMode: "essential",
		// It changes nothing in the workspace by itself: a permission mode never stops the agent to ask about it.
		approval: "read",
		async execute(_id: string, _params: unknown, _signal: unknown, _onUpdate: unknown, ctx?: Context) {
			const kind = ctx?.agent?.kind;
			if (kind !== undefined && kind !== "main")
				throw new Error("Only the conversation's main agent can restart its process. Tell the main agent instead.");
			const until = blockedUntil(file);
			if (until !== null && Date.now() < until)
				throw new Error(
					`Refused: this conversation was restarted 3 times in the last hour already. The next restart is possible after ${new Date(until).toISOString()}. Carry on in this process, or tell the person what is wrong.`,
				);
			return { content: [{ type: "text", text: RESTART_ACCEPTED_RESULT }], details: {} };
		},
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		// The main agent's turns only: a subagent's own prompt and a title's request are left alone.
		if (ctx?.agent?.kind !== "main") return undefined;
		try {
			const active = await pi.getActiveTools();
			if (!active.includes(RESTART_SESSION_TOOL)) await pi.setActiveTools([...active, RESTART_SESSION_TOOL]);
		} catch {
			// The tool stays out: the conversation goes on without it.
		}
		return undefined;
	});
}
