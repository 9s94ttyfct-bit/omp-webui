import { isRecord } from "../../shared/guards.ts";
import { mcpSwitchable } from "../../shared/loaded.ts";
import { hasCommand, mcpConfigs, parseMcpList, runJson } from "./loaded.ts";

/**
 * The switches of the Loaded dialog, which the terminal has in `/extensions` and `omp plugin`: each is carried out by
 * omp (its CLI and its own commands), never by editing its files.
 *
 * A skill is turned off by `skill:<name>` in the global `disabledExtensions` setting, which is what the terminal's
 * Extension Control Center writes; omp's processes watch their `config.yml` and rediscover skills when it changes,
 * so no restart is needed. A plugin is switched by `omp plugin enable|disable`; a running omp is then told to
 * `/reload-plugins`, which refreshes its skills and commands at once.
 *
 * An MCP server is switched by the conversation's own omp with `/mcp enable|disable <name>` (omp has no CLI for it),
 * which writes `enabled` where the server is configured, the project's `.omp/mcp.json` or the user's `mcp.json`.
 * That only edits the config: a running omp connects its MCP servers when it starts and never again, so the change
 * applies once the conversation's omp is started anew.
 */

/** Where omp's CLI is run for a conversation: its folder, and the environment its process was started with. */
export interface ToggleTarget {
	bin: string;
	/** The conversation's folder: a folder's own `.omp/config.yml` can override a setting there. */
	cwd: string;
	/** A folder with no `.omp` of its own: the global value of a setting is read there, free of project values. */
	neutral: string;
	/** The process's agent directory: its `mcp.json` is the user's MCP config. */
	agentDir: string;
	env: Record<string, string>;
}

/** A skill's name goes into a JSON value of omp's config, never onto a command line: any one-line name will do. */
export function validSkill(name: unknown): name is string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: this is the check for them
	return typeof name === "string" && name.length > 0 && name.length <= 200 && !/[\u0000-\u001f\u007f]/.test(name);
}

/** A plugin's name is an argument of omp's CLI: only what omp itself names plugins with (never a flag). */
const PLUGIN_NAME = /^[\w@][\w@./:+-]{0,199}$/u;
export function validPlugin(name: unknown): name is string {
	return typeof name === "string" && PLUGIN_NAME.test(name);
}

/** omp's config is written from one place at a time here: two switches clicked together must not lose one. */
let writing: Promise<unknown> = Promise.resolve();
function serialized<T>(work: () => Promise<T>): Promise<T> {
	const run = writing.then(work, work);
	writing = run.catch(() => {});
	return run;
}

async function globalDisabled(t: ToggleTarget): Promise<string[]> {
	const doc = await runJson(t.bin, ["config", "get", "disabledExtensions", "--json"], t.neutral, t.env);
	const value = isRecord(doc) ? doc.value : undefined;
	return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}

/**
 * Turn one skill on or off for every conversation. Returns where another layer of omp's settings decides, which
 * makes the change without effect for this conversation's folder (`project`, `overlay`…), or null.
 */
export function setSkillEnabled(t: ToggleTarget, name: string, enabled: boolean): Promise<string | null> {
	const id = `skill:${name}`;
	// What this folder's omp reads, every layer merged: whether it already says what was asked.
	const disagrees = async () => {
		const effective = await runJson(t.bin, ["config", "get", "disabledExtensions", "--json"], t.cwd, t.env);
		const off = isRecord(effective) && Array.isArray(effective.value) && effective.value.includes(id);
		return off === enabled;
	};
	return serialized(async () => {
		// Read where no project's value is merged in: writing that back would copy it into the global config.
		const current = await globalDisabled(t);
		const next = enabled ? current.filter((x) => x !== id) : current.includes(id) ? current : [...current, id];
		// The global list already says it, yet the folder's own setting may not: `config set` names the layer that decides
		// (writing the same list again changes nothing), which only a write reports.
		if (next.length === current.length && !(await disagrees())) return null;
		const doc = await runJson(
			t.bin,
			["config", "set", "disabledExtensions", JSON.stringify(next), "--json"],
			t.cwd,
			t.env,
		);
		if (!isRecord(doc) || typeof doc.overriddenBy !== "string") return null;
		// Another layer wins here; whether it already says what was asked is what counts.
		return (await disagrees()) ? doc.overriddenBy : null;
	});
}

/**
 * omp rediscovers its skills a moment after its config changes (it watches the file). Wait, a few seconds at most,
 * until the process's own command list has the skill where the switch put it, so that what is asked of omp next (the
 * dialog's refresh) is what it now offers, not what it offered before. False: it did not catch up in time.
 */
export async function skillSettled(omp: PluginProcess, name: string, enabled: boolean, ms = 4000): Promise<boolean> {
	const command = `skill:${name}`;
	const stop = Date.now() + ms;
	for (;;) {
		const catalog = await omp.rpc({ type: "get_available_commands" }, { user: true });
		const commands = catalog.success && isRecord(catalog.data) ? catalog.data.commands : undefined;
		const listed = Array.isArray(commands) && commands.some((c) => isRecord(c) && c.name === command);
		if (listed === enabled) return true;
		if (Date.now() >= stop) return false;
		await Bun.sleep(100);
	}
}

/** What this needs of a running omp (`Live` is one). */
export interface PluginProcess {
	rpc(
		command: Record<string, unknown>,
		options?: { user?: boolean },
	): Promise<{ success: boolean; data?: unknown; error?: string }>;
	command(message: string, options?: { user?: boolean }): Promise<string | null>;
}

/**
 * Enable or disable one plugin with omp's CLI, run where the conversation runs; the scope matters for a marketplace
 * plugin that is installed in both. With the conversation's process, then reload its plugins (it asks to be answered
 * even when paused). Returns whether that process reloaded: an omp without `/reload-plugins` picks the change up on its
 * next start.
 */
export async function setPluginEnabled(
	t: ToggleTarget,
	name: string,
	scope: "user" | "project" | null,
	enabled: boolean,
	omp: PluginProcess | null,
): Promise<boolean> {
	const args = ["plugin", enabled ? "enable" : "disable", ...(scope ? ["--scope", scope] : []), name, "--json"];
	await serialized(() => runJson(t.bin, args, t.cwd, t.env));
	if (!omp) return false;
	// A line omp does not know goes to the model as a prompt: look for the command first.
	const catalog = await omp.rpc({ type: "get_available_commands" }, { user: true });
	const commands = catalog.success && isRecord(catalog.data) ? catalog.data.commands : undefined;
	if (!hasCommand(commands, "reload-plugins")) return false;
	return (await omp.command("/reload-plugins", { user: true })) !== null;
}

/** An error with the HTTP status the page should get: omp's own words where it gave any. */
export class McpSwitchError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

export const validMcp = (name: unknown): name is string => typeof name === "string" && mcpSwitchable(name);

async function listedServers(omp: PluginProcess) {
	const text = await omp.command("/mcp list", { user: true });
	const servers = typeof text === "string" ? parseMcpList(text) : null;
	if (!servers) throw new McpSwitchError("omp did not list its MCP servers", 502);
	return servers;
}

/**
 * Turn one MCP server on or off in the config it is defined in, with the conversation's own omp (`/mcp enable|disable`
 * picks the project's `.omp/mcp.json` over the user's `mcp.json`, as omp loads them). The command is asked of omp only
 * when it lists it, and only for a server omp itself lists: a line omp does not know goes to the model as a prompt, and
 * `/mcp disable` of a name that is not configured would write it into a denylist. Whatever omp says is checked against
 * its own `/mcp list` afterwards, so a switch that did not take is an error and not a silent no-op.
 *
 * A name both configs define cannot be switched: `/mcp list` shows the user's entry while the command writes the folder's,
 * so the switch would change one file and the list would never follow (409, nothing written). Should the second config
 * appear after the check, the change that did not take is undone, not left half made.
 *
 * `changed`: the config said otherwise before. `scope`: where the server is configured, in omp's words.
 */
export async function setMcpServerEnabled(
	t: ToggleTarget,
	omp: PluginProcess,
	name: string,
	enabled: boolean,
): Promise<{ changed: boolean; scope: string | null }> {
	const verb = enabled ? "enable" : "disable";
	const catalog = await omp.rpc({ type: "get_available_commands" }, { user: true });
	const commands = catalog.success && isRecord(catalog.data) ? catalog.data.commands : undefined;
	if (!hasCommand(commands, "mcp", "list") || !hasCommand(commands, "mcp", verb))
		throw new McpSwitchError("This omp cannot switch MCP servers (no /mcp enable and /mcp disable)", 501);

	const before = (await listedServers(omp)).find((s) => s.name === name);
	if (!before) throw new McpSwitchError(`omp has no MCP server named ${name} in its user or project config`, 404);
	const configs = await mcpConfigs(t.agentDir, t.cwd);
	if (Object.hasOwn(configs.user.servers, name) && Object.hasOwn(configs.project.servers, name))
		throw new McpSwitchError(
			`${name} is defined in your config and in this folder's: edit it in the terminal (omp lists one entry but switches the other)`,
			409,
		);
	if (before.enabled === enabled) return { changed: false, scope: before.scope };

	const said = await omp.command(`/mcp ${verb} ${name}`, { user: true });
	if (said === null) throw new McpSwitchError(`omp did not take /mcp ${verb} for a command`, 501);
	const plain = Bun.stripANSI(said).trim();
	const done = /^Server ".*" (?:enabled|disabled) \((project|user) config\)\.?$/.exec(plain);
	if (!done) throw new McpSwitchError(plain || `omp did not ${verb} ${name}`, 422);

	const after = (await listedServers(omp)).find((s) => s.name === name);
	if (after?.enabled !== enabled) {
		// What the command wrote, if the entry said otherwise before, is put back.
		const entry = (done[1] === "project" ? configs.project : configs.user).servers[name];
		const wasEnabled = !isRecord(entry) || entry.enabled !== false;
		if (wasEnabled !== enabled) await omp.command(`/mcp ${enabled ? "disable" : "enable"} ${name}`, { user: true });
		throw new McpSwitchError(
			`omp changed the ${done[1]} config, but its MCP server list still shows ${name} as ${enabled ? "disabled" : "enabled"}; the change was undone`,
			409,
		);
	}
	return { changed: true, scope: after.scope };
}
