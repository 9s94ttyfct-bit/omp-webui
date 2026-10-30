import { isRecord } from "./guards.ts";
import type { Mode } from "./offline.ts";

/**
 * What is loaded in one conversation, as `GET /api/loaded` reports it: the terminal's Extension Control Center
 * (`/status`), gathered from what omp itself says. Every section stands on its own — one that omp could not
 * answer carries its reason (`LoadedFailure`) while the others still arrive.
 */

/** A section omp could not answer: why, in omp's own words where it gave any. */
export interface LoadedFailure {
	error: string;
	/** Not omp's to say: the conversation's folder is gone, so omp's CLI could not be run there. */
	folderMissing?: true;
}

/** Where a tool is: offered to the model directly, mounted as an `xd://` device, or registered but not enabled. */
export type ToolState = "active" | "mounted" | "off";

export interface LoadedTool {
	/** The name omp registers it under (`mcp__<server>_<tool>` for an MCP tool). */
	name: string;
	/** What to show: the tool's own name, without the `mcp__<server>_` prefix. */
	label: string;
	state: ToolState;
	/** First line of the tool's description; only the tools offered directly come with one (`get_state.dumpTools`). */
	description?: string;
}

export interface LoadedMcpServer {
	name: string;
	/** `stdio`, `http`, `sse`… as `/mcp list` prints it. */
	transport: string;
	/** Not switched off (`/mcp disable`). */
	enabled: boolean;
	/** The command or URL, and where the server is configured (`user`, `project`…). */
	target: string;
	scope: string | null;
	tools: LoadedTool[];
	/**
	 * The name is defined in both the user's and the folder's MCP config. omp lists the user's entry but `/mcp enable|disable`
	 * writes the folder's, so the page cannot switch it: it is edited in the terminal.
	 */
	inBoth?: true;
	/**
	 * The running omp does not follow this server's config yet: it connects its servers once, when it starts, so a switch
	 * (here, in another tab, or in the terminal) applies after a restart. Derived from the config files and the process's
	 * start, not remembered by a page.
	 */
	restartOwed?: true;
}

/**
 * Whether omp's `/mcp enable|disable <name>` can take this server's name: it reads one word, and a name with a space
 * (omp allows "MaaS Slack" in a config someone wrote by hand) would name another server, or none.
 */
export const mcpSwitchable = (name: string): boolean => /^[A-Za-z0-9_.:-]{1,100}$/.test(name);

export interface LoadedCommand {
	name: string;
	description: string;
	/** `builtin`, `extension`, `custom`, `file`, `skill`: omp's own word for where the command comes from. */
	source: string;
	aliases: string[];
	/** Number of subcommands (`/mcp list`, `/mcp test`…). */
	subcommands: number;
}

export interface LoadedPlugin {
	name: string;
	version: string | null;
	/** `npm` covers linked and git installs too, as `omp plugin list` groups them. */
	kind: "npm" | "marketplace";
	/** `user` or `project`, where omp says. */
	scope: string | null;
	enabled: boolean;
	path: string | null;
	/** A user-scoped marketplace plugin that the folder also has enabled: the folder's copy is the one omp loads. */
	shadowedBy?: "project";
}

export interface LoadedRule {
	name: string;
	description: string;
	/** Where omp found it: `native` (a project or user rule file), `builtin-defaults`… */
	provider: string;
	path: string;
	/** The tool calls it applies to, e.g. `tool:edit(*.ts)`; empty: all. */
	scope: string[];
	/** Text and AST patterns that trigger it. */
	triggers: string[];
}

export interface LoadedSkill {
	name: string;
	description: string;
	/**
	 * Not turned off: `skill:<name>` is not in omp's global `disabledExtensions` setting, which is how its Extension
	 * Control Center turns a skill off. A turned-off skill is no longer offered by omp, so it has no description here.
	 */
	enabled: boolean;
}

/** The tools of the conversation: ones the model has, grouped. */
export interface LoadedTools {
	/** Built-in and host tools. */
	builtin: LoadedTool[];
	/** MCP servers (`/mcp list`), each with the tools it provides. */
	servers: LoadedMcpServer[];
	/** MCP tools none of the listed servers claims. */
	otherMcp: LoadedTool[];
}

/**
 * Each section of omp's answer, or why it has none. `null`: the conversation has no running omp to ask — its tools,
 * commands and skills are the process's, while plugins and rules come from omp's CLI and need none.
 */
export interface LoadedData {
	/** Where the conversation runs; Light processes load no plugins. */
	mode: Mode;
	cwd: string;
	tools: LoadedTools | LoadedFailure | null;
	/** Every slash command but the skills' (`/skill:name`), which are listed apart. */
	commands: LoadedCommand[] | LoadedFailure | null;
	/** omp offers skills as slash commands, and only while `skills.enableSkillCommands` is on. */
	skills: LoadedSkill[] | LoadedFailure | null;
	plugins: LoadedPlugin[] | LoadedFailure;
	rules: LoadedRule[] | LoadedFailure;
}

export function isFailure(v: unknown): v is LoadedFailure {
	return isRecord(v) && typeof v.error === "string";
}
