import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { isRecord } from "../../shared/guards.ts";
import {
	activePreset,
	type ConversationModels,
	clearedAgents,
	DEFAULT_THINKING_LEVELS,
	isDefaultThinkingLevel,
	type ModelConfig,
	type ModelPreset,
	normalizeRoles,
	PRESET_NAME_MAX,
	parsePresetEntry,
	parseSelector,
	presetNameProblem,
	presetPatternProblem,
	putOwn,
	SELECTOR_MAX,
	selectorProblem,
	switchedModels,
} from "../../shared/model-config.ts";
import type { Config } from "../config.ts";
import { availableModels } from "./models.ts";
import { run } from "./run.ts";

/**
 * Model roles, presets and the default thinking level, through `omp config get|set` (omp's public CLI), so
 * they stay the ones the terminal UI uses: `modelRoles`, `modelPresets`, `defaultThinkingLevel` in omp's
 * global config. omp's `config set` stores whatever it is given and has no way to change one preset, so a
 * change reads the whole `modelPresets` record and writes it back, with every entry it does not touch exactly
 * as it was. Our own changes are serialized; omp locks the file for the rest.
 *
 * Global values are read from a folder without project config: `omp config` merges the project's own
 * `.omp/config.yml` into what it prints, and writing that back would copy project values into the global config.
 */

class ConfigError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

const TIMEOUT_MS = 30_000;

/**
 * What a failed omp command says. omp is a Bun program: an error it does not catch is printed as an excerpt of its own
 * bundled source, then `error: <message>`, then the stack, and the message is what the reader needs. Output without
 * such a line is cut from the end, where a failure says what went wrong.
 */
export function ompFailure(output: string): string {
	const lines = output.trim().split("\n");
	const at = lines.findIndex((line) => line.startsWith("error:"));
	if (at < 0) return output.trim().slice(-300);
	const said = [lines[at].slice("error:".length).trim()];
	for (const line of lines.slice(at + 1)) {
		if (line.trim() === "" || /^\s+at\s/.test(line)) break;
		said.push(line.trim());
	}
	return said.join(" ").slice(0, 600);
}

/**
 * The copy omp made of a config.yml it could not read (`… (moved to <path>): …` in its message). It then starts from
 * its defaults, so what the page shows is not what the person had: told with every answer while the copy exists.
 */
let movedAside: string | null = null;

/**
 * What makes `omp config` read the configuration of a conversation's process rather than the server's own: omp's global
 * flags (`--profile`, which picks the agent directory) and environment (the agent directory itself, `PI_CONFIG_FILES`).
 */
export interface ConfigScope {
	flags?: readonly string[];
	env?: Record<string, string | undefined>;
}

export async function ompConfig(
	bin: string,
	cwd: string,
	args: string[],
	timeoutMs = TIMEOUT_MS,
	scope: ConfigScope = {},
): Promise<string> {
	const { code, stdout, stderr } = await run([bin, ...(scope.flags ?? []), "config", ...args], {
		cwd,
		timeoutMs,
		env: scope.env,
	});
	if (code !== 0) {
		const said = ompFailure(stderr || stdout);
		const moved = /\(moved to (.+?)\): /.exec(said);
		if (moved) movedAside = moved[1];
		throw new Error(`omp config ${args.slice(0, 2).join(" ")} exited ${code}: ${said}`);
	}
	return stdout;
}

/** The value of one config key (`omp config get <key> --json`); `key` is never user input. */
export async function readKey(bin: string, cwd: string, key: string, scope: ConfigScope = {}): Promise<unknown> {
	const out = await ompConfig(bin, cwd, ["get", key, "--json"], undefined, scope);
	const parsed: unknown = JSON.parse(out.slice(Math.max(0, out.indexOf("{"))));
	return isRecord(parsed) ? parsed.value : undefined;
}

/** Every setting of one `omp config list --json` by its key, each as omp describes it (`value`, `type`, …). */
async function listSettings(
	bin: string,
	cwd: string,
	timeoutMs: number,
	scope: ConfigScope = {},
): Promise<Record<string, unknown>> {
	const out = await ompConfig(bin, cwd, ["list", "--json"], timeoutMs, scope);
	const all: unknown = JSON.parse(out.slice(Math.max(0, out.indexOf("{"))));
	return isRecord(all) ? all : {};
}

/** The value of `key` in what `listSettings` read; undefined where omp gives none. */
function valueIn(all: Record<string, unknown>, key: string): unknown {
	const setting = all[key];
	return isRecord(setting) ? setting.value : undefined;
}

/**
 * The values of `keys` (settings of omp, never user input) as a process with `scope` reads them in `cwd`, in one
 * `omp config list --json`: one omp start, whatever the number of keys. A key omp gives no value for is undefined.
 */
export async function readKeys(
	bin: string,
	cwd: string,
	keys: readonly string[],
	scope: ConfigScope,
	timeoutMs: number,
): Promise<Record<string, unknown>> {
	const all = await listSettings(bin, cwd, timeoutMs, scope);
	return Object.fromEntries(keys.map((key) => [key, valueIn(all, key)]));
}

interface RawView {
	roles: unknown;
	thinking: unknown;
	storage: unknown;
	agents: unknown;
	presets: unknown;
}

/**
 * Roles, default thinking level, role storage and presets of a view in one `omp config list --json` (run in a project
 * folder, it includes that project's config): one omp start per view, not one per key.
 */
async function readView(bin: string, cwd: string, timeoutMs = TIMEOUT_MS): Promise<RawView> {
	const all = await listSettings(bin, cwd, timeoutMs);
	return {
		roles: valueIn(all, "modelRoles"),
		thinking: valueIn(all, "defaultThinkingLevel"),
		storage: valueIn(all, "modelRoleStorage"),
		agents: valueIn(all, "task.agentModelOverrides"),
		presets: valueIn(all, "modelPresets"),
	};
}

function jsonEqual(a: unknown, b: unknown): boolean {
	if (Array.isArray(a) || Array.isArray(b)) {
		return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
	}
	if (isRecord(a) && isRecord(b)) {
		const keys = Object.keys(a);
		return keys.length === Object.keys(b).length && keys.every((k) => Object.hasOwn(b, k) && jsonEqual(a[k], b[k]));
	}
	return a === b;
}

/**
 * The configuration of `view`; with `global` (the view without project config) given, a preset that is not in
 * the global config as it is — defined by the project, or overridden by it — is marked as the project's.
 */
function describeConfig(view: RawView, global?: RawView): ModelConfig {
	const roles = normalizeRoles(view.roles);
	const defaultThinkingLevel = typeof view.thinking === "string" ? view.thinking : "high";
	const entries = isRecord(view.presets) ? view.presets : {};
	const globalEntries = global && isRecord(global.presets) ? global.presets : {};
	const presets: ModelPreset[] = Object.entries(entries).map(([name, entry]) => {
		const parsed = parsePresetEntry(entry);
		// A name omp would not have saved. (Our own length cap is for new names only.)
		const badName = presetPatternProblem(name);
		const problem =
			badName !== null
				? `“${name}” is not a preset name omp accepts: a letter, then letters, digits, - or _`
				: typeof parsed === "string"
					? parsed
					: undefined;
		const projectOwned =
			global !== undefined && !(Object.hasOwn(globalEntries, name) && jsonEqual(globalEntries[name], entry));
		return {
			name,
			roles: typeof parsed === "string" ? {} : parsed.roles,
			...(typeof parsed !== "string" && parsed.defaultThinkingLevel
				? { defaultThinkingLevel: parsed.defaultThinkingLevel }
				: {}),
			...(typeof parsed !== "string" && parsed.agentModelOverrides
				? { agentModelOverrides: parsed.agentModelOverrides }
				: {}),
			source: projectOwned ? "project" : "global",
			...(problem ? { problem } : {}),
		};
	});
	presets.sort((a, b) => a.name.localeCompare(b.name));
	const agentModelOverrides = normalizeRoles(view.agents);
	return {
		roles,
		agentModelOverrides,
		defaultThinkingLevel,
		roleStorage: view.storage === "project" ? "project" : "global",
		presets,
		active: activePreset({ roles, defaultThinkingLevel, presets }),
	};
}

/** Run `fn` after every earlier job, one at a time; a failed job does not stop the next. */
let tail: Promise<unknown> = Promise.resolve();
export function queued<T>(fn: () => Promise<T>): Promise<T> {
	const run = tail.then(fn);
	tail = run.catch(() => {});
	return run;
}

/**
 * Reads waiting their turn behind writes, by view. A caller joins a read that has not started yet, never one
 * already reading: that one may have read the config before the change this caller was told about (omp saves a
 * preset switch a moment after making it), and the caller would get the old configuration as the new one.
 */
const waitingReads = new Map<string, Promise<ModelConfig>>();

async function load(cfg: Config, cwd: string): Promise<ModelConfig> {
	const [global, project] = await Promise.all([
		readView(cfg.ompBin, cfg.dataDir),
		cwd ? readView(cfg.ompBin, cwd) : Promise.resolve(null),
	]);
	return project ? describeConfig(project, global) : describeConfig(global);
}

function readConfig(cfg: Config, cwd: string): Promise<ModelConfig> {
	const waiting = waitingReads.get(cwd);
	if (waiting) return waiting;
	const read = queued(() => {
		waitingReads.delete(cwd);
		return load(cfg, cwd);
	});
	waitingReads.set(cwd, read);
	return read;
}

/** A write: runs alone, and answers with the global configuration as it is afterwards. */
function write(cfg: Config, change: () => Promise<void>): Promise<ModelConfig> {
	return queued(async () => {
		await change();
		return load(cfg, "");
	});
}

// ------------------------------------------------------------------ input

/**
 * A preset name from the request. A name to create must also fit our length cap; `existing` (a preset already in
 * the config, that omp itself accepts at any length) is held to omp's pattern only.
 */
function requireName(value: unknown, label: string, existing = false): string {
	if (typeof value !== "string") throw new ConfigError(`${label} must be text`, 400);
	const problem = existing ? presetPatternProblem(value) : presetNameProblem(value);
	if (problem === "empty") throw new ConfigError(`${label} is required`, 400);
	if (problem === "tooLong") throw new ConfigError(`${label} is too long (at most ${PRESET_NAME_MAX} characters)`, 400);
	if (problem) throw new ConfigError(`${label} must start with a letter, then use only letters, digits, - and _`, 400);
	return value;
}

/** A name of an existing preset: anything that is one in the config, however odd, but never nothing. */
function requireExisting(value: unknown, label: string): string {
	if (typeof value !== "string" || value === "") throw new ConfigError(`${label} is required`, 400);
	return value;
}

function requireRoles(value: unknown, allowEmpty: boolean): Record<string, string> {
	if (!isRecord(value)) throw new ConfigError("Roles must be an object of role name → model selector", 400);
	const roles: Record<string, string> = {};
	for (const [key, selector] of Object.entries(value)) {
		// omp checks no role name (see `normalizeRoles`): any role it holds can be saved again.
		if (key.trim() === "") throw new ConfigError("A role name must not be empty", 400);
		if (typeof selector !== "string") throw new ConfigError(`Role “${key}” needs a model selector`, 400);
		const problem = selectorProblem(selector);
		if (problem === "empty") throw new ConfigError(`Role “${key}” needs a model selector`, 400);
		if (problem === "tooLong")
			throw new ConfigError(`The selector for role “${key}” is too long (at most ${SELECTOR_MAX} characters)`, 400);
		if (problem) throw new ConfigError(`Role “${key}” has an invalid model selector (no control characters)`, 400);
		// An own property, not a plain assignment: a role named `__proto__` would otherwise hit the prototype setter
		// and be dropped (omp stores it as an ordinary key).
		putOwn(roles, key, selector.trim());
	}
	if (!allowEmpty && Object.keys(roles).length === 0) throw new ConfigError("A preset needs at least one role", 400);
	return roles;
}

/** Subagent models from a request: agent name → model selector. Empty is fine (a preset that sets none, or no change). */
function requireAgentModels(value: unknown): Record<string, string> {
	if (!isRecord(value)) throw new ConfigError("Subagent models must be an object of agent name → model selector", 400);
	const agents: Record<string, string> = {};
	for (const [key, selector] of Object.entries(value)) {
		// omp checks no agent name (see `normalizeRoles`): any agent it holds can be saved again.
		if (key.trim() === "") throw new ConfigError("An agent name must not be empty", 400);
		const problem = typeof selector === "string" ? selectorProblem(selector) : "empty";
		if (problem === "empty") throw new ConfigError(`Agent “${key}” needs a model selector`, 400);
		if (problem === "tooLong")
			throw new ConfigError(`The selector for agent “${key}” is too long (at most ${SELECTOR_MAX} characters)`, 400);
		if (problem) throw new ConfigError(`Agent “${key}” has an invalid model selector (no control characters)`, 400);
		putOwn(agents, key, (selector as string).trim());
	}
	return agents;
}

function optionalLevel(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (!isDefaultThinkingLevel(value)) {
		throw new ConfigError(`Default thinking level must be one of: ${DEFAULT_THINKING_LEVELS.join(", ")}`, 400);
	}
	return value;
}

/**
 * A folder to read project config from: absolute. Empty means the global config only, and so does a folder that is not
 * there any more (a conversation whose folder was moved or deleted): it has no project config to read, and its presets
 * and roles are the global ones. Refusing it made the page's preset chip say "could not load presets" for such a
 * conversation, where omp itself, started elsewhere, would read the global config.
 */
function requireFolder(value: string | null): string {
	if (!value) return "";
	if (!isAbsolute(value)) throw new ConfigError("cwd must be an absolute path", 400);
	let isDirectory: boolean;
	try {
		isDirectory = statSync(value).isDirectory();
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === "ENOENT" || code === "ENOTDIR") return "";
		throw new ConfigError(`cwd can't be read: ${code ?? (e as Error).message}`, 400);
	}
	if (!isDirectory) throw new ConfigError("cwd is not a folder", 400);
	return value;
}

// ------------------------------------------------------------------ presets record

async function readPresets(cfg: Config): Promise<Record<string, unknown>> {
	const value = await readKey(cfg.ompBin, cfg.dataDir, "modelPresets");
	return isRecord(value) ? { ...value } : {};
}

async function writePresets(cfg: Config, presets: Record<string, unknown>): Promise<void> {
	await ompConfig(cfg.ompBin, cfg.dataDir, ["set", "modelPresets", JSON.stringify(presets)]);
}

/** omp's `task.agentModelOverrides`, replaced by `agents`: the subagents have these models and no other. */
async function writeAgentModels(cfg: Config, agents: Record<string, string>): Promise<void> {
	await ompConfig(cfg.ompBin, cfg.dataDir, ["set", "task.agentModelOverrides", JSON.stringify(agents)]);
}

/**
 * `roles` (what the page holds: every role of omp's `modelRoles` that has a model selector, whatever its name) together
 * with the entries the page cannot hold — blank or non-text values. omp keeps and uses every key, and `config set`
 * replaces the whole record: whatever the page was not given is not its to delete.
 */
async function rolesWithUnshown(cfg: Config, roles: Record<string, string>): Promise<Record<string, unknown>> {
	const stored = await readKey(cfg.ompBin, cfg.dataDir, "modelRoles");
	const shown = normalizeRoles(stored);
	const merged: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(roles)) putOwn(merged, key, value);
	if (isRecord(stored)) {
		for (const [key, value] of Object.entries(stored)) {
			if (!Object.hasOwn(shown, key) && !Object.hasOwn(merged, key)) putOwn(merged, key, value);
		}
	}
	return merged;
}

function entryOf(presets: Record<string, unknown>, name: string): unknown {
	if (!Object.hasOwn(presets, name)) {
		throw new ConfigError(
			`There is no preset “${name}” in your global config (presets defined by a project or --config file can only be changed there)`,
			404,
		);
	}
	return presets[name];
}

/** The configured default model must be one omp can use now, as omp itself checks before it switches. */
async function assertUsable(cfg: Config, name: string, roles: Record<string, string>): Promise<void> {
	const selector = roles.default ? parseSelector(roles.default) : null;
	if (!selector) return;
	const listed = (models: unknown[]) =>
		models.some((m) => isRecord(m) && m.provider === selector.provider && m.id === selector.id);
	try {
		// The list is cached; a provider signed in a moment ago may be missing from it.
		if (listed(await availableModels(cfg.ompBin)) || listed(await availableModels(cfg.ompBin, true))) return;
	} catch {
		// Cannot tell: omp decides when the model is used.
		return;
	}
	throw new ConfigError(
		`Preset “${name}” not applied: its default model ${selector.provider}/${selector.id} is not available (is ${selector.provider} signed in?)`,
		409,
	);
}

// ------------------------------------------------------------------ one conversation

/** What a conversation is switched to: its models, and what its folder's configuration sets that the preset leaves out. */
export interface ConversationPreset {
	models: ConversationModels;
	/** What the configuration of the conversation's folder sets that `models` leave out, which the conversation does without. */
	absent: Absent;
	/** The default thinking level the folder's configuration has, which a preset that sets none leaves the conversation on. */
	fallbackLevel: string;
}

/** What a configuration sets that a conversation's `models` do not: the conversation has none of it (see `ProcessOverlay.absent`). */
export interface Absent {
	/** Roles the global config or the folder's project sets and the preset does not. */
	roles: string[];
	/** Agents the configuration's `task.agentModelOverrides` gives a model and the conversation's subagent models do not. */
	agents: string[];
}

function absentFrom(view: RawView, models: Pick<ConversationModels, "roles" | "agentModelOverrides">): Absent {
	return {
		roles: Object.keys(normalizeRoles(view.roles)).filter((role) => !Object.hasOwn(models.roles, role)),
		agents: clearedAgents(normalizeRoles(view.agents), models),
	};
}

/** What the configuration of `cwd` (global and project) sets that `models` leave out. */
export async function absentModels(
	cfg: Config,
	cwd: string,
	models: Pick<ConversationModels, "roles" | "agentModelOverrides">,
	timeoutMs = TIMEOUT_MS,
): Promise<Absent> {
	const view = await queued(() => readView(cfg.ompBin, requireFolder(cwd) || cfg.dataDir, timeoutMs));
	return absentFrom(view, models);
}

/**
 * The preset `name`, as `/modelpreset switch` would find it from `cwd` (the global config's and the project's), checked
 * the way omp checks it before it switches: the entry is one omp can apply, and its default model is available. Nothing
 * is written: the caller gives the conversation what this returns. `previous` (what the conversation runs on now) keeps
 * the subagent models of a preset that sets none (see `switchedModels`).
 */
export async function conversationPreset(
	cfg: Config,
	cwd: string,
	name: string,
	previous?: ConversationModels | null,
): Promise<ConversationPreset> {
	const preset = requireName(name, "Preset name", true);
	const view = await queued(() => readView(cfg.ompBin, requireFolder(cwd) || cfg.dataDir));
	const entries = isRecord(view.presets) ? view.presets : {};
	if (!Object.hasOwn(entries, preset)) throw new ConfigError(`There is no preset “${preset}”`, 404);
	const parsed = parsePresetEntry(entries[preset]);
	if (typeof parsed === "string") throw new ConfigError(`Preset “${preset}” can't be applied: ${parsed}`, 409);
	await assertUsable(cfg, preset, parsed.roles);
	const models = switchedModels(previous, {
		preset,
		roles: parsed.roles,
		...(parsed.defaultThinkingLevel ? { defaultThinkingLevel: parsed.defaultThinkingLevel } : {}),
		...(parsed.agentModelOverrides ? { agentModelOverrides: parsed.agentModelOverrides } : {}),
	});
	return {
		models,
		absent: absentFrom(view, models),
		fallbackLevel: typeof view.thinking === "string" ? view.thinking : "high",
	};
}

// ------------------------------------------------------------------ actions

type Action = (cfg: Config, body: Record<string, unknown>) => Promise<ModelConfig>;

const ACTIONS: Record<string, Action> = {
	"/roles": (cfg, body) => {
		const roles = requireRoles(body.roles, true);
		const level = optionalLevel(body.defaultThinkingLevel);
		// A conversation's "Set as default" brings the subagent models it runs on; the roles editor sends none. None leaves
		// the configuration's as they are (an empty record is no change either, as for a preset that sets none).
		const agents = body.agentModelOverrides === undefined ? {} : requireAgentModels(body.agentModelOverrides);
		return write(cfg, async () => {
			await ompConfig(cfg.ompBin, cfg.dataDir, [
				"set",
				"modelRoles",
				JSON.stringify(await rolesWithUnshown(cfg, roles)),
			]);
			if (level) await ompConfig(cfg.ompBin, cfg.dataDir, ["set", "defaultThinkingLevel", level]);
			if (Object.keys(agents).length > 0) await writeAgentModels(cfg, agents);
		});
	},

	"/preset/save": (cfg, body) => {
		const name = requireName(body.name, "Preset name");
		const explicit = body.roles === undefined ? undefined : requireRoles(body.roles, false);
		const level = optionalLevel(body.defaultThinkingLevel);
		const given = body.agentModelOverrides === undefined ? undefined : requireAgentModels(body.agentModelOverrides);
		return write(cfg, async () => {
			const presets = await readPresets(cfg);
			if (Object.hasOwn(presets, name) && body.overwrite !== true) {
				throw new ConfigError(`A preset named “${name}” already exists`, 409);
			}
			let entry: Record<string, unknown>;
			// The subagent models the preset stores: the ones given, else the configuration's as they are now.
			let agents: Record<string, string>;
			if (explicit) {
				entry = { modelRoles: explicit, ...(level ? { defaultThinkingLevel: level } : {}) };
				agents = given ?? normalizeRoles(await readKey(cfg.ompBin, cfg.dataDir, "task.agentModelOverrides"));
			} else {
				// What `/modelpreset save` takes: the roles and the default thinking level as they are now.
				const current = await readView(cfg.ompBin, cfg.dataDir);
				const roles = normalizeRoles(current.roles);
				if (Object.keys(roles).length === 0) throw new ConfigError("There are no model roles to save", 400);
				entry = {
					modelRoles: roles,
					...(isDefaultThinkingLevel(current.thinking) ? { defaultThinkingLevel: current.thinking } : {}),
				};
				agents = given ?? normalizeRoles(current.agents);
			}
			// A preset without subagent models leaves the ones the subagents have when it is applied: it has no key for them.
			if (Object.keys(agents).length > 0) entry.agentModelOverrides = agents;
			putOwn(presets, name, entry);
			await writePresets(cfg, presets);
		});
	},

	"/preset/agents": (cfg, body) => {
		const name = requireExisting(body.name, "Preset name");
		const agents = requireAgentModels(body.agentModelOverrides);
		return write(cfg, async () => {
			const presets = await readPresets(cfg);
			const entry = entryOf(presets, name);
			if (!isRecord(entry)) throw new ConfigError(`Preset “${name}” can't be changed: it is not a mapping`, 409);
			// Every other key of the entry exactly as it is (roles, thinking level, whatever else the entry holds).
			const changed: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(entry)) if (key !== "agentModelOverrides") putOwn(changed, key, value);
			if (Object.keys(agents).length > 0) putOwn(changed, "agentModelOverrides", agents);
			putOwn(presets, name, changed);
			await writePresets(cfg, presets);
		});
	},

	"/preset/edit": (cfg, body) => {
		const name = requireExisting(body.name, "Preset name");
		const roles = requireRoles(body.roles, false);
		// Explicit, so a request that forgot it does not silently drop the preset's level: null is "the preset sets none".
		if (!Object.hasOwn(body, "defaultThinkingLevel")) throw new ConfigError("Default thinking level is required", 400);
		const level = body.defaultThinkingLevel === null ? undefined : optionalLevel(body.defaultThinkingLevel);
		const agents = requireAgentModels(body.agentModelOverrides);
		return write(cfg, async () => {
			const presets = await readPresets(cfg);
			const entry = entryOf(presets, name);
			if (!isRecord(entry)) throw new ConfigError(`Preset “${name}” can't be changed: it is not a mapping`, 409);
			// The three keys the dialog edits are replaced where they stand (or dropped, or added at the end); every other
			// key of the entry, known to us or not, is carried over exactly as it is.
			const edited: Record<string, unknown> = {};
			const put = (key: string, value: unknown) => putOwn(edited, key, value);
			const own = (key: string) => Object.hasOwn(entry, key);
			for (const [key, value] of Object.entries(entry)) {
				if (key === "modelRoles") put(key, roles);
				else if (key === "defaultThinkingLevel") {
					if (level) put(key, level);
				} else if (key === "agentModelOverrides") {
					if (Object.keys(agents).length > 0) put(key, agents);
				} else put(key, value);
			}
			if (!own("modelRoles")) put("modelRoles", roles);
			if (!own("defaultThinkingLevel") && level) put("defaultThinkingLevel", level);
			if (!own("agentModelOverrides") && Object.keys(agents).length > 0) put("agentModelOverrides", agents);
			putOwn(presets, name, edited);
			await writePresets(cfg, presets);
		});
	},

	"/preset/rename": (cfg, body) => {
		const from = requireExisting(body.from, "Preset name");
		const to = requireName(body.to, "New preset name");
		return write(cfg, async () => {
			const presets = await readPresets(cfg);
			entryOf(presets, from);
			if (Object.hasOwn(presets, to)) throw new ConfigError(`A preset named “${to}” already exists`, 409);
			// Same place in the file, new name.
			const renamed: Record<string, unknown> = {};
			for (const [key, value] of Object.entries(presets)) putOwn(renamed, key === from ? to : key, value);
			await writePresets(cfg, renamed);
		});
	},

	"/preset/duplicate": (cfg, body) => {
		const from = requireExisting(body.from, "Preset name");
		const to = requireName(body.to, "New preset name");
		return write(cfg, async () => {
			const presets = await readPresets(cfg);
			const entry = entryOf(presets, from);
			if (Object.hasOwn(presets, to)) throw new ConfigError(`A preset named “${to}” already exists`, 409);
			putOwn(presets, to, structuredClone(entry));
			await writePresets(cfg, presets);
		});
	},

	"/preset/delete": (cfg, body) => {
		const name = requireExisting(body.name, "Preset name");
		return write(cfg, async () => {
			const presets = await readPresets(cfg);
			entryOf(presets, name);
			delete presets[name];
			await writePresets(cfg, presets);
		});
	},

	"/preset/apply": (cfg, body) => {
		const name = requireName(body.name, "Preset name", true);
		return write(cfg, async () => {
			const presets = await readPresets(cfg);
			const parsed = parsePresetEntry(entryOf(presets, name));
			if (typeof parsed === "string") throw new ConfigError(`Preset “${name}” can't be applied: ${parsed}`, 409);
			await assertUsable(cfg, name, parsed.roles);
			// As `/modelpreset switch` leaves the config: the preset's roles, and only those.
			await ompConfig(cfg.ompBin, cfg.dataDir, ["set", "modelRoles", JSON.stringify(parsed.roles)]);
			if (parsed.defaultThinkingLevel) {
				await ompConfig(cfg.ompBin, cfg.dataDir, ["set", "defaultThinkingLevel", parsed.defaultThinkingLevel]);
			}
			// The preset's subagent models replace the configuration's; a preset with none leaves them as they are.
			if (parsed.agentModelOverrides) await writeAgentModels(cfg, parsed.agentModelOverrides);
		});
	},
};

const json = (data: unknown, status = 200) =>
	new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const fail = (error: string, status: number) => json({ error }, status);

/** `config` as the page is told it: with the copy of an unreadable config.yml, while there is one. */
function answer(config: ModelConfig): ModelConfig {
	return movedAside && existsSync(movedAside) ? { ...config, movedAside } : config;
}

/** `GET /api/model-config[?cwd=<folder>]`, and the `POST /api/model-config/<action>` writes in {@link ACTIONS}. */
export async function handleModelConfig(req: Request, url: URL, cfg: Config): Promise<Response> {
	try {
		const action = url.pathname.slice("/api/model-config".length);
		if (action === "") {
			if (req.method !== "GET") return fail("GET required", 405);
			return json(answer(await readConfig(cfg, requireFolder(url.searchParams.get("cwd")))));
		}
		if (!Object.hasOwn(ACTIONS, action)) return fail("Not found", 404);
		if (req.method !== "POST") return fail("POST required", 405);
		const body: unknown = await req.json().catch(() => null);
		if (!isRecord(body)) return fail("The body must be a JSON object", 400);
		return json(answer(await ACTIONS[action](cfg, body)));
	} catch (e) {
		if (e instanceof ConfigError) return fail(e.message, e.status);
		throw e;
	}
}
