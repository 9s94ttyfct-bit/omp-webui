import { existsSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import {
	isFailure,
	type LoadedCommand,
	type LoadedData,
	type LoadedFailure,
	type LoadedMcpServer,
	type LoadedPlugin,
	type LoadedRule,
	type LoadedSkill,
	type LoadedTool,
	type LoadedTools,
	type ToolState,
} from "../../shared/loaded.ts";
import { summarizeStderr } from "./rpc-client.ts";
import { run } from "./run.ts";

/**
 * What is loaded in one conversation (the terminal's `/status`), gathered from omp itself and never from its
 * files: tools, MCP servers, commands and skills from the conversation's running process, plugins and rules from
 * omp's CLI, run where the conversation runs and with the agent directory it was started with.
 */

/** What this needs of a running omp (`Live` is one). */
export interface LoadedProcess {
	rpc(command: Record<string, unknown>): Promise<{ success: boolean; data?: unknown; error?: string }>;
	/** Run a builtin slash command and return what it printed; null when omp did not take it for a command. */
	command(message: string): Promise<string | null>;
}

export interface LoadedRequest {
	bin: string;
	cwd: string;
	/** When the conversation's process started (ms): a config written after it is not what the process runs. */
	startedAt: number | null;
	/** Where the conversation's process was told to keep its agent directory (its `mcp.json` is the user's MCP config). */
	agentDir: string;
	/** Added to the server's environment: where the conversation's process was told to keep its agent directory. */
	env: Record<string, string>;
	/** The conversation runs in Light mode: it loads no plugins, and its MCP servers are the ones chosen in Settings. */
	light: boolean;
	/** The conversation's process; none: only what omp's CLI says. */
	process: LoadedProcess | null;
}

const CLI_MS = 30_000;
const DESCRIPTION_CHARS = 160;

const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((s): s is string => typeof s === "string") : []);

async function section<T>(work: () => Promise<T>): Promise<T | LoadedFailure> {
	try {
		return await work();
	} catch (e) {
		return { error: e instanceof Error ? e.message : String(e) };
	}
}

// ------------------------------------------------------------------ text omp prints

/**
 * `/tools`: one line per registered tool. `* name` is offered to the model directly, `~ xd://name` is mounted as a
 * device it writes to, `- name` is registered but not enabled (an mounted tool has a `-` line too). In the order
 * omp lists them; null when the text is not that listing.
 */
export function parseTools(text: string): Map<string, ToolState> | null {
	const flags = new Map<string, { active: boolean; mounted: boolean }>();
	for (const line of Bun.stripANSI(text).split("\n")) {
		const m = /^([*~-]) (?:xd:\/\/)?(\S+)$/.exec(line.trim());
		if (!m) continue;
		const tool = flags.get(m[2]) ?? { active: false, mounted: false };
		if (m[1] === "*") tool.active = true;
		if (m[1] === "~") tool.mounted = true;
		flags.set(m[2], tool);
	}
	if (!flags.size) return null;
	return new Map(
		[...flags].map(([name, f]): [string, ToolState] => [name, f.active ? "active" : f.mounted ? "mounted" : "off"]),
	);
}

export interface McpListing {
	name: string;
	transport: string;
	enabled: boolean;
	target: string;
	scope: string | null;
}

/**
 * `/mcp list`: `name | transport | enabled | command-or-url [scope]` per configured server. It says what is
 * configured, not whether the server connected. null when the text is not that listing.
 */
export function parseMcpList(text: string): McpListing[] | null {
	const plain = Bun.stripANSI(text).trim();
	if (/^No MCP servers/i.test(plain)) return [];
	const servers: McpListing[] = [];
	for (const line of plain.split("\n")) {
		const m = /^(.+?) \| (\S+) \| (enabled|disabled) \| (.*?)(?: \[([^\]]*)\])?$/.exec(line.trim());
		if (m)
			servers.push({ name: m[1], transport: m[2], enabled: m[3] === "enabled", target: m[4], scope: m[5] ?? null });
	}
	return servers.length ? servers : null;
}

// ------------------------------------------------------------------ tools and MCP servers

/** omp's name for a server in the names of its tools: lowercase letters, digits and single underscores. */
function mountName(server: string): string {
	return server
		.toLowerCase()
		.replace(/[^a-z0-9_]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_|_$/g, "");
}

function firstLine(description: unknown): string | undefined {
	const line = str(description)
		?.split("\n")
		.find((l) => l.trim())
		?.trim();
	if (!line) return undefined;
	return line.length > DESCRIPTION_CHARS ? `${line.slice(0, DESCRIPTION_CHARS - 1)}…` : line;
}

/**
 * The conversation's tools by where they come from. An MCP tool is named `mcp__<server>_<tool>`, which does not say
 * where the server's name ends, so each goes to the server of `/mcp list` with the longest matching name.
 */
export function groupTools(
	states: Map<string, ToolState>,
	descriptions: Map<string, string>,
	listing: McpListing[] | null,
): LoadedTools {
	const prefixes = (listing ?? [])
		.map((s) => ({ server: s.name, prefix: `mcp__${mountName(s.name)}_` }))
		.sort((a, b) => b.prefix.length - a.prefix.length);
	const servers: LoadedMcpServer[] = (listing ?? []).map((s) => ({ ...s, tools: [] }));
	const builtin: LoadedTool[] = [];
	const otherMcp: LoadedTool[] = [];
	for (const [name, state] of states) {
		const description = descriptions.get(name);
		const tool = (label: string): LoadedTool => ({ name, label, state, ...(description ? { description } : {}) });
		if (!name.startsWith("mcp__")) {
			builtin.push(tool(name));
			continue;
		}
		const owner = prefixes.find((p) => name.startsWith(p.prefix));
		if (owner) servers.find((s) => s.name === owner.server)?.tools.push(tool(name.slice(owner.prefix.length)));
		else otherMcp.push(tool(name.slice("mcp__".length)));
	}
	return { builtin, servers, otherMcp };
}

interface Catalog {
	commands: LoadedCommand[];
	skills: LoadedSkill[];
}

/** `get_available_commands`: slash commands with where each comes from; skills (`/skill:name`) apart. */
function readCatalog(data: unknown): Catalog {
	const raw = isRecord(data) && Array.isArray(data.commands) ? data.commands : null;
	if (!raw) throw new Error("omp did not list its commands");
	const catalog: Catalog = { commands: [], skills: [] };
	for (const c of raw) {
		if (!isRecord(c) || typeof c.name !== "string") continue;
		const description = str(c.description) ?? "";
		if (c.source === "skill") {
			catalog.skills.push({ name: c.name.replace(/^skill:/, ""), description, enabled: true });
			continue;
		}
		catalog.commands.push({
			name: c.name,
			description,
			source: str(c.source) ?? "unknown",
			aliases: strings(c.aliases),
			subcommands: Array.isArray(c.subcommands) ? c.subcommands.length : 0,
		});
	}
	return catalog;
}

/** Whether omp lists `name` (and, with `sub`, that subcommand of it): only then is the line a command and not a prompt. */
export function hasCommand(commands: unknown, name: string, sub?: string): boolean {
	if (!Array.isArray(commands)) return false;
	const c = commands.find((x) => isRecord(x) && x.name === name);
	if (!isRecord(c)) return false;
	return !sub || (Array.isArray(c.subcommands) && c.subcommands.some((s) => isRecord(s) && s.name === sub));
}

async function ask(omp: LoadedProcess, command: Record<string, unknown>): Promise<unknown> {
	const r = await omp.rpc(command);
	if (!r.success) throw new Error(r.error ?? `${String(command.type)} failed`);
	return r.data;
}

/**
 * The process's tools, MCP servers, commands and skills. `/tools` and `/mcp list` are asked only when the command
 * catalog has them: a line omp does not know would go to the model as a message. Where a command's text is missing
 * or not what this reads, the answer falls back on what `get_state` offers (the tools given to the model directly).
 */
async function fromProcess(omp: LoadedProcess): Promise<Pick<LoadedData, "tools" | "commands" | "skills">> {
	const [catalogData, state] = await Promise.all([
		section(() => ask(omp, { type: "get_available_commands" })),
		section(() => ask(omp, { type: "get_state" })),
	]);
	const catalog = await section(async () => {
		if (isFailure(catalogData)) throw new Error(catalogData.error);
		return readCatalog(catalogData);
	});
	const commandList = isRecord(catalogData) ? catalogData.commands : null;
	// Sequential: a command's output is collected from the process's frames, which two at once would mix up.
	const toolsText = hasCommand(commandList, "tools") ? await section(() => omp.command("/tools")) : null;
	const mcpText = hasCommand(commandList, "mcp", "list") ? await section(() => omp.command("/mcp list")) : null;

	const dump = isRecord(state) && Array.isArray(state.dumpTools) ? state.dumpTools : [];
	const descriptions = new Map<string, string>();
	for (const t of dump) {
		const description = isRecord(t) ? firstLine(t.description) : undefined;
		if (isRecord(t) && typeof t.name === "string" && description) descriptions.set(t.name, description);
	}
	let states = typeof toolsText === "string" ? parseTools(toolsText) : null;
	if (!states) {
		const active = dump.flatMap((t) => (isRecord(t) && typeof t.name === "string" ? [t.name] : []));
		states = active.length ? new Map(active.map((n) => [n, "active"])) : null;
	}
	const listing = typeof mcpText === "string" ? parseMcpList(mcpText) : null;

	let tools: LoadedTools | LoadedFailure;
	if (states) tools = groupTools(states, descriptions, listing);
	else tools = isFailure(state) ? state : { error: "omp listed no tools" };
	return {
		tools,
		commands: isFailure(catalog) ? catalog : catalog.commands,
		skills: isFailure(catalog) ? catalog : catalog.skills,
	};
}

// ------------------------------------------------------------------ plugins and rules

export async function runJson(
	bin: string,
	args: string[],
	cwd: string,
	env: Record<string, string>,
	timeoutMs = CLI_MS,
): Promise<unknown> {
	const { code, stdout, stderr } = await run([bin, ...args], { cwd, env: { ...env, NO_COLOR: "1" }, timeoutMs });
	if (code !== 0) throw new Error(summarizeStderr(stderr) || `omp ${args.join(" ")} exited with code ${code}`);
	try {
		return JSON.parse(stdout);
	} catch {
		throw new Error(`omp ${args.join(" ")} did not print JSON`);
	}
}

/** `omp plugin list --json`: `npm` (linked and git installs too) and `marketplace` plugins. */
export function parsePlugins(doc: unknown): LoadedPlugin[] {
	if (!isRecord(doc)) throw new Error("omp plugin list answered in a form this does not know");
	const plugins: LoadedPlugin[] = [];
	for (const p of Array.isArray(doc.npm) ? doc.npm : []) {
		if (!isRecord(p) || typeof p.name !== "string") continue;
		plugins.push({
			name: p.name,
			version: str(p.version),
			kind: "npm",
			scope: str(p.scope),
			enabled: p.enabled !== false,
			path: str(p.path),
		});
	}
	for (const p of Array.isArray(doc.marketplace) ? doc.marketplace : []) {
		if (!isRecord(p) || typeof p.id !== "string") continue;
		const entry = Array.isArray(p.entries) && isRecord(p.entries[0]) ? p.entries[0] : {};
		plugins.push({
			name: p.id,
			version: str(entry.version),
			kind: "marketplace",
			scope: str(p.scope) ?? str(entry.scope),
			// A marketplace plugin's switch is on each of its entries (`omp plugin disable` writes it there).
			enabled: p.enabled !== false && entry.enabled !== false,
			path: str(entry.installPath),
			...(p.shadowedBy === "project" ? { shadowedBy: "project" as const } : {}),
		});
	}
	return plugins;
}

/** One `mcp.json`: its servers as omp reads them, and when it was last written (0: no such file). */
export interface McpConfigFile {
	servers: Record<string, unknown>;
	changedAt: number;
}

/**
 * The MCP servers of the user's `mcp.json` and the folder's `.omp/mcp.json`, as omp reads them (`/mcp list` shows the
 * user's entry of a name both define, `/mcp enable|disable` writes the folder's). Read only: a file that is missing or
 * is not a JSON object has no servers here, and omp's own commands say what is wrong with it.
 */
export async function mcpConfigs(
	agentDir: string,
	cwd: string,
): Promise<{ user: McpConfigFile; project: McpConfigFile }> {
	const read = async (path: string): Promise<McpConfigFile> => {
		const file = Bun.file(path);
		try {
			const doc: unknown = await file.json();
			return { servers: isRecord(doc) && isRecord(doc.mcpServers) ? doc.mcpServers : {}, changedAt: file.lastModified };
		} catch {
			return { servers: {}, changedAt: 0 };
		}
	};
	const [user, project] = await Promise.all([read(join(agentDir, "mcp.json")), read(join(cwd, ".omp", "mcp.json"))]);
	return { user, project };
}

/**
 * Each listed server with what the page cannot read off `/mcp list`: `inBoth` (a name both configs define), and
 * `restartOwed`: the process does not run what its config says. omp connects its servers once, when it starts, so that
 * is a server the config turned off while its tools are still there, or one the config has on and nothing is loaded
 * for, in a file written after the process started (a server that never connected, or offers no tools, is not owed
 * anything: a restart would change nothing). Derived on each read, so a reload or another tab shows the same.
 */
export function markServers(
	servers: LoadedMcpServer[],
	configs: { user: McpConfigFile; project: McpConfigFile },
	startedAt: number | null,
): LoadedMcpServer[] {
	return servers.map((s) => {
		const inBoth = Object.hasOwn(configs.user.servers, s.name) && Object.hasOwn(configs.project.servers, s.name);
		const file = s.scope === "project" ? configs.project : configs.user;
		const owed = s.enabled
			? s.tools.length === 0 && startedAt !== null && file.changedAt > startedAt
			: s.tools.length > 0;
		return inBoth || owed
			? { ...s, ...(inBoth ? { inBoth: true as const } : {}), ...(owed ? { restartOwed: true as const } : {}) }
			: s;
	});
}

/** `omp ttsr list --json`: the rules that watch the model's output (stream rules). */
export function parseRules(doc: unknown): LoadedRule[] {
	if (!Array.isArray(doc)) throw new Error("omp ttsr list answered in a form this does not know");
	return doc.flatMap((r): LoadedRule[] =>
		isRecord(r) && typeof r.name === "string"
			? [
					{
						name: r.name,
						description: str(r.description) ?? "",
						provider: str(r.provider) ?? "",
						path: str(r.path) ?? "",
						scope: strings(r.scope),
						triggers: [...strings(r.condition), ...strings(r.astCondition)],
					},
				]
			: [],
	);
}

/**
 * The skills `disabledExtensions` turns off (`skill:<name>`, how omp's Extension Control Center does it), as omp
 * resolves that setting for `cwd`: a folder's own `.omp/config.yml` that sets it replaces the global value.
 */
export async function disabledSkills(bin: string, cwd: string, env: Record<string, string>): Promise<string[]> {
	const doc = await runJson(bin, ["config", "get", "disabledExtensions", "--json"], cwd, env);
	return strings(isRecord(doc) ? doc.value : undefined)
		.filter((id) => id.startsWith("skill:"))
		.map((id) => id.slice("skill:".length));
}

/**
 * The skills omp lists, each marked off where the setting says so, then the ones the setting turns off that omp no
 * longer lists (a skill that is off is not offered, so it is only known by name).
 */
export function withDisabled(skills: LoadedSkill[], off: string[]): LoadedSkill[] {
	const names = new Set(off);
	const listed = new Set(skills.map((s) => s.name));
	const unlisted = [...names].filter((name) => !listed.has(name)).sort((a, b) => a.localeCompare(b));
	return [
		...skills.map((s) => (names.has(s.name) ? { ...s, enabled: false } : s)),
		...unlisted.map((name) => ({ name, description: "", enabled: false })),
	];
}

export async function collectLoaded(r: LoadedRequest): Promise<LoadedData> {
	// omp's CLI runs in the conversation's folder: where it is gone, spawning there fails naming `omp`, as if omp were missing.
	const folder: LoadedFailure | null = existsSync(r.cwd)
		? null
		: { error: `Folder no longer exists: ${r.cwd}`, folderMissing: true };
	const [running, plugins, rules, off] = await Promise.all([
		r.process ? fromProcess(r.process) : null,
		folder ?? section(async () => parsePlugins(await runJson(r.bin, ["plugin", "list", "--json"], r.cwd, r.env))),
		folder ?? section(async () => parseRules(await runJson(r.bin, ["ttsr", "list", "--json"], r.cwd, r.env))),
		// The setting is not something the process reports. Where it cannot be read, every listed skill stays on.
		r.process && !folder ? disabledSkills(r.bin, r.cwd, r.env).catch((): string[] => []) : [],
	]);
	const skills = running?.skills ?? null;
	let tools = running?.tools ?? null;
	if (tools && !isFailure(tools) && tools.servers.length > 0) {
		const configs = await mcpConfigs(r.agentDir, r.cwd);
		tools = { ...tools, servers: markServers(tools.servers, configs, r.startedAt) };
	}
	return {
		mode: r.light ? "light" : "full",
		cwd: r.cwd,
		tools,
		commands: running?.commands ?? null,
		skills: Array.isArray(skills) ? withDisabled(skills, off) : skills,
		plugins,
		rules,
	};
}
