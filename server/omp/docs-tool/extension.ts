import { createLookup, type Lookup } from "./lookup.ts";

/**
 * The `webui_docs` tool and the browser note, an omp extension: the web UI starts every conversation's omp with it (`--extension`), so an agent
 * running in omp-webui can look up how omp-webui itself works — its features, every setting with its key, values and
 * default, its API routes and which of them are local-only — instead of guessing. It answers from `docs/agents/`, the
 * agent-facing documentation that ships with the app.
 *
 * Read-only by construction:
 *
 * - The docs are a module beside this file (`docs-data.ts`, written by the server from the copy compiled into it,
 *   `install.ts`), imported the first time the tool is called: the extension opens no file, so no argument can name one,
 *   and a conversation that never asks pays nothing at start.
 * - It changes nothing: it writes no file, sends nothing to the server and holds no credential. A topic name that is not
 *   one of the docs' (a path, `..`) is refused by the lookup (`lookup.ts`), which only ever looks names up in that module.
 * - `approval: "read"`: a permission mode never stops the agent to ask about it.
 * - `loadMode: "discoverable"`: omp mounts it at `xd://webui_docs` with its summary, and its schema is read only when the
 *   agent asks for it, so a conversation that never uses it carries one line.
 *
 * It also tells every agent of the conversation (the main agent and its subagents) where to look at web pages
 * (`BROWSER_NOTE`): omp's `browser` tool, which the server points at the built-in browser (`browser.cdpUrl`), and never a
 * window on the person's desktop — their own Safari or Chrome opened through computer use or `open`, or a headed
 * Playwright. omp does not know that a browser of the app's own is there, so without this an agent picks whichever
 * browser it thinks of first. The note is the same for every conversation: a `before_agent_start` handler that reads
 * nothing and writes nothing.
 *
 * It is copied into the app's data folder with `lookup.ts` and `docs-data.ts` (`install.ts`), because omp reads an extension
 * from a file; it runs in omp's own process and imports nothing of the app.
 */

/** The tool's name. */
export const DOCS_TOOL = "webui_docs";

/** The block appended to every agent's system prompt: where web pages are looked at. */
export const BROWSER_NOTE = [
	"## Browser",
	"This conversation runs in omp-webui, which has a built-in browser for its agents: omp's browser (the `browser` object in eval) is connected to it and opens pages there, where the person sees them too. Use it for every web page you need to see, test or drive, pages served on localhost included; for a local HTML file, serve it on localhost or set it as the page's content. Do not pass it another browser (`app.path`, `app.cdp_url`, the relay).",
	"Never show a page in a window on the person's desktop: do not open their Safari, Chrome or Firefox (through computer use, `open`, AppleScript or a URL), and do not launch a headed Playwright or Puppeteer browser. A test suite or script that launches its own headless browser may still do so.",
	"Where eval has no `browser` (the person turned the built-in browser off), use a headless browser of your own or ask the person; still never a window on their desktop.",
].join("\n");

/** What omp passes a `before_agent_start` handler, as far as this reads it. */
interface BeforeAgentStart {
	systemPrompt?: unknown;
}

/** The session of the agent whose turn it is: `main`, or `sub` for a task subagent; absent for a title's request. */
interface Context {
	agent?: { kind?: string };
}

/** What this uses of omp's extension API. */
interface Pi {
	registerTool(tool: Record<string, unknown>): void;
	on(event: "before_agent_start", handler: (event: BeforeAgentStart, ctx: Context) => unknown): void;
}

/** The system prompt with the browser note after its blocks; undefined for a request that has no agent (a title's). */
export function withBrowserNote(event: BeforeAgentStart, ctx: Context): { systemPrompt: string[] } | undefined {
	if (!ctx?.agent?.kind) return undefined;
	const blocks = Array.isArray(event?.systemPrompt)
		? event.systemPrompt.filter((b): b is string => typeof b === "string")
		: [];
	return { systemPrompt: [...blocks, BROWSER_NOTE] };
}

export const DOCS_TOOL_DESCRIPTION =
	"Look up omp-webui's own documentation (the web UI and macOS app this conversation runs in): its features, where they are in the UI, every setting with its key, values and default, its API routes and which are local-only. Read-only. Actions: `list` (every topic), `search` (keywords; sections holding all of them), `read` (a topic, or one `section` of it).";

const PARAMETERS = {
	type: "object",
	properties: {
		action: {
			type: "string",
			enum: ["list", "search", "read"],
			description: "`list` the topics, `search` them by keywords, or `read` one topic (or one section of it).",
		},
		query: { type: "string", description: "For `search`: keywords; a section must contain every one." },
		topic: { type: "string", description: "For `read`: a topic name as `list` gives it (e.g. `guard`)." },
		section: {
			type: "string",
			description: "For `read`, optional: a heading of the topic (e.g. `Settings`); the section with its subsections.",
		},
		limit: { type: "integer", minimum: 1, maximum: 30, description: "For `search`: the most sections to return (10)." },
	},
	required: ["action"],
	additionalProperties: false,
};

/** What the tool answers `params` from `lookup`; a question the docs cannot answer throws, which omp shows as the tool's error. */
export function answer(lookup: Lookup, params: unknown): string {
	const p = (typeof params === "object" && params !== null ? params : {}) as Record<string, unknown>;
	switch (p.action) {
		case "list":
			return lookup.list();
		case "search":
			return lookup.search(p.query, p.limit);
		case "read":
			return lookup.read(p.topic, p.section);
		default:
			throw new Error('`action` must be "list", "search" or "read".');
	}
}

export default function webuiDocs(pi: Pi): void {
	let lookup: Lookup | null = null;
	pi.registerTool({
		name: DOCS_TOOL,
		label: "omp-webui docs",
		description: DOCS_TOOL_DESCRIPTION,
		parameters: PARAMETERS,
		loadMode: "discoverable",
		approval: "read",
		async execute(_id: string, params: unknown) {
			// Loaded on the first call, not at omp's start: the docs are ~150 KB that most conversations never ask for.
			lookup ??= createLookup((await import("./docs-data.ts")).default);
			return { content: [{ type: "text", text: answer(lookup, params) }], details: {} };
		},
	});
	pi.on("before_agent_start", (event, ctx) => withBrowserNote(event, ctx));
}
