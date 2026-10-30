/**
 * Model roles and presets as omp keeps them in its config (`modelRoles`, `modelPresets`,
 * `defaultThinkingLevel`), and the rules omp applies to them. The server reads and writes them through
 * `omp config`; the web UI validates input and decides which preset is active with the same functions,
 * so the two cannot disagree. The rules are omp's observable behaviour (its CLI messages and what
 * `/modelpreset` does), nothing more.
 */

import { isRecord } from "./guards.ts";

/** What `omp config set defaultThinkingLevel` accepts, and what a preset's `defaultThinkingLevel` may be. */
export const DEFAULT_THINKING_LEVELS = ["minimal", "low", "medium", "high", "xhigh", "max", "auto"] as const;
export type DefaultThinkingLevel = (typeof DEFAULT_THINKING_LEVELS)[number];

/** A role's selector may end in `:<level>`; unlike the global default, that can also be `off`. */
export const SELECTOR_LEVELS = ["off", ...DEFAULT_THINKING_LEVELS] as const;
export type SelectorLevel = (typeof SELECTOR_LEVELS)[number];

export function isDefaultThinkingLevel(value: unknown): value is DefaultThinkingLevel {
	return typeof value === "string" && (DEFAULT_THINKING_LEVELS as readonly string[]).includes(value);
}

export function isSelectorLevel(value: unknown): value is SelectorLevel {
	return typeof value === "string" && (SELECTOR_LEVELS as readonly string[]).includes(value);
}

export const PRESET_NAME_MAX = 64;
export const ROLE_KEY_MAX = 32;
export const SELECTOR_MAX = 512;

export type TextProblem = "empty" | "invalid" | "tooLong";

/** omp's preset names, and ours for role keys: a letter, then letters, digits, `-` or `_`. */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]*$/;

function identifierProblem(value: string, max: number): TextProblem | null {
	if (value.trim() === "") return "empty";
	if (value.length > max) return "tooLong";
	return IDENTIFIER.test(value) ? null : "invalid";
}

/** Why `/modelpreset save <name>` would refuse the name (plus our length cap), or null when it is fine. */
export function presetNameProblem(name: string): TextProblem | null {
	return identifierProblem(name, PRESET_NAME_MAX);
}

/**
 * Why omp would not accept the name of an existing preset: its pattern only. Our length cap is for names we
 * create; omp has none, so a long name already in the config can still be applied, switched to or renamed from.
 */
export function presetPatternProblem(name: string): Exclude<TextProblem, "tooLong"> | null {
	if (name.trim() === "") return "empty";
	return IDENTIFIER.test(name) ? null : "invalid";
}

/**
 * Whether we would let a person *create* a role of this name (the "Add role" field): the same pattern as presets.
 * omp itself checks no role name, so a role that already exists under any other name is kept, shown, saved and applied.
 */
export function roleKeyProblem(key: string): TextProblem | null {
	return identifierProblem(key, ROLE_KEY_MAX);
}

/** Own property definition: a key like `__proto__` in a hand-edited config (a role, a preset) must stay an ordinary entry. */
export function putOwn(target: Record<string, unknown>, key: string, value: unknown): void {
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

/**
 * A role's value is a model selector as omp reads it: `provider/id`, optionally `:level`, but also fallback
 * lists (`a/b,c/d`), aliases (`pi/slow`) and globs. All of those exist in real configs, so only what is never
 * a selector is refused: blanks, control characters, absurd lengths.
 */
export function selectorProblem(value: string): TextProblem | null {
	if (value.trim() === "") return "empty";
	if (value.length > SELECTOR_MAX) return "tooLong";
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) return "invalid";
	}
	return null;
}

export interface Selector {
	provider: string;
	id: string;
	level?: SelectorLevel;
}

const SELECTOR = /^([^/\s,:*?]+)\/([^\s,*?]+?)(?::(off|minimal|low|medium|high|xhigh|max|auto))?$/;

/**
 * A selector that names exactly one model: `provider/id` with an optional thinking level. Anything else
 * (aliases, lists, globs, bare ids) is null: the UI shows those as text and compares them as strings.
 * A `:suffix` that is not a thinking level stays in the id (`…/llama-3.3-70b-instruct:free`).
 */
export function parseSelector(value: string): Selector | null {
	const m = SELECTOR.exec(value.trim());
	// `pi/<role>` is omp's alias for another role's model, not a provider.
	if (!m || m[1] === "pi") return null;
	return m[3] ? { provider: m[1], id: m[2], level: m[3] as SelectorLevel } : { provider: m[1], id: m[2] };
}

export function formatSelector(s: Selector): string {
	return `${s.provider}/${s.id}${s.level ? `:${s.level}` : ""}`;
}

export type PresetSource = "global" | "project";

export interface ModelPreset {
	name: string;
	/** Role → selector; empty when the entry is malformed. */
	roles: Record<string, string>;
	defaultThinkingLevel?: DefaultThinkingLevel;
	/**
	 * The subagent models the preset carries: omp's `task.agentModelOverrides` (agent name → model selector) as it was when
	 * the preset was saved. Kept in the preset's own entry, under a key omp does not read (see `parsePresetEntry`); absent
	 * when the preset sets none, which leaves the models the subagents have as they are when it is applied.
	 */
	agentModelOverrides?: Record<string, string>;
	/** `project`: defined by the project's config, so it cannot be renamed or deleted from the global config. */
	source: PresetSource;
	/** Why omp cannot apply the preset (a malformed entry, a name it would not have saved); absent when it can. */
	problem?: string;
}

/** omp's `modelRoleStorage`: where it saves role changes made in a terminal (the model selector's role assignments). */
export type RoleStorage = "global" | "project";

export interface ModelConfig {
	/** The role → selector assignments in effect (the global config, plus the project's when asked for a folder). */
	roles: Record<string, string>;
	/** omp's `task.agentModelOverrides` in effect (the global config, plus the project's when asked for a folder): agent name → selector. */
	agentModelOverrides: Record<string, string>;
	/** In effect; omp's default (`high`) when unset. */
	defaultThinkingLevel: string;
	/** In effect (a project's config can set it); omp's default (`global`) when unset. */
	roleStorage: RoleStorage;
	/** By name, as omp lists them. */
	presets: ModelPreset[];
	/** The preset omp counts as active for these roles, or null. */
	active: string | null;
	/** Where omp put its config.yml when it could not read it (it then starts from its defaults, which is what this holds); absent otherwise. */
	movedAside?: string;
}

/** What a project's config changes in the global one, for roles and the default thinking level. */
export interface ProjectOverrides {
	/** The project's roles that the global config does not have, or has with another selector. */
	roles: Record<string, string>;
	/** The project's default thinking level, when it differs from the global one. */
	defaultThinkingLevel?: string;
}

/**
 * omp merges a project's config over the global one, so the folder's view holds both; what the project overrides is what
 * differs from the global view (the same value set in both is no override anyone can see).
 */
export function projectOverrides(
	global: Pick<ModelConfig, "roles" | "defaultThinkingLevel">,
	project: Pick<ModelConfig, "roles" | "defaultThinkingLevel">,
): ProjectOverrides {
	const roles: Record<string, string> = {};
	for (const [role, selector] of Object.entries(project.roles)) {
		if (!Object.hasOwn(global.roles, role) || global.roles[role] !== selector) putOwn(roles, role, selector);
	}
	return project.defaultThinkingLevel === global.defaultThinkingLevel
		? { roles }
		: { roles, defaultThinkingLevel: project.defaultThinkingLevel };
}

/**
 * The roles of a config value as omp reads them: strings as they are, an array of strings as one comma-separated
 * fallback list, under any name; blanks and other types are dropped.
 */
export function normalizeRoles(raw: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (!isRecord(raw)) return out;
	for (const [key, value] of Object.entries(raw)) {
		const text =
			typeof value === "string"
				? value
				: Array.isArray(value) && value.length > 0 && value.every((v) => typeof v === "string" && v.trim() !== "")
					? value.join(",")
					: "";
		if (text.trim() !== "") putOwn(out, key, text);
	}
	return out;
}

/**
 * A preset entry omp can apply, or the reason it cannot (omp reports the same cases as "malformed").
 *
 * An entry may also carry `agentModelOverrides` (agent name → model selector, the shape of omp's `task.agentModelOverrides`).
 * omp reads only `modelRoles` and `defaultThinkingLevel` of an entry — it keeps the other keys in config.yml untouched and
 * never applies them — so the key is ours: the page applies it where omp's own switch does not. It is read leniently (omp
 * would not call an entry with a bad one malformed): what is not a model selector is dropped, and none left is no key.
 */
export function parsePresetEntry(entry: unknown):
	| {
			roles: Record<string, string>;
			defaultThinkingLevel?: DefaultThinkingLevel;
			agentModelOverrides?: Record<string, string>;
	  }
	| string {
	if (!isRecord(entry)) return "it is not a mapping";
	if (!isRecord(entry.modelRoles)) return "`modelRoles` is missing or not a mapping";
	const roles: Record<string, string> = {};
	for (const [key, value] of Object.entries(entry.modelRoles)) {
		if (typeof value !== "string" || value.trim() === "") return `role \`${key}\` is not a model selector`;
		putOwn(roles, key, value);
	}
	const level = entry.defaultThinkingLevel;
	if (level !== undefined && !isDefaultThinkingLevel(level)) return "`defaultThinkingLevel` is not a thinking level";
	const agents = normalizeRoles(entry.agentModelOverrides);
	return {
		roles,
		...(level === undefined ? {} : { defaultThinkingLevel: level }),
		...(Object.keys(agents).length > 0 ? { agentModelOverrides: agents } : {}),
	};
}

/**
 * The model roles one conversation runs on, when it was switched to a preset: the preset's roles and thinking level
 * as they were when it was switched to, held by the conversation (the server keeps them in that conversation's own
 * omp settings overlay and remembers them by session file), never written to omp's global config. A conversation
 * without them follows the global config, as a new one does.
 */
export interface ConversationModels {
	/** The preset the conversation was switched to. */
	preset: string;
	/** Role → selector: exactly the preset's; a role the preset lacks is not set for this conversation. */
	roles: Record<string, string>;
	defaultThinkingLevel?: DefaultThinkingLevel;
	/**
	 * Agent → selector: the subagent models the conversation runs on (exactly the preset's: an agent it lacks has none for
	 * this conversation). Absent while the conversation follows the config's `task.agentModelOverrides`; a preset that sets
	 * none leaves what the conversation has (see `switchedModels`).
	 */
	agentModelOverrides?: Record<string, string>;
}

/** `raw` (as stored or as the wire carries it) as a conversation's models, or null when it is none. */
export function parseConversationModels(raw: unknown): ConversationModels | null {
	if (!isRecord(raw) || typeof raw.preset !== "string" || raw.preset === "") return null;
	const parsed = parsePresetEntry({
		modelRoles: raw.roles,
		defaultThinkingLevel: raw.defaultThinkingLevel,
		agentModelOverrides: raw.agentModelOverrides,
	});
	if (typeof parsed === "string") return null;
	return {
		preset: raw.preset,
		roles: parsed.roles,
		...(parsed.defaultThinkingLevel ? { defaultThinkingLevel: parsed.defaultThinkingLevel } : {}),
		...(parsed.agentModelOverrides ? { agentModelOverrides: parsed.agentModelOverrides } : {}),
	};
}

/**
 * What a conversation runs on once it is switched to `next`: the preset's roles and thinking level, and its subagent
 * models when it has any. A preset that sets no subagent models leaves the ones the conversation has — the preset it was on
 * before, if that had some — as applying it to the configuration leaves `task.agentModelOverrides` as it is.
 */
export function switchedModels(
	previous: ConversationModels | null | undefined,
	next: ConversationModels,
): ConversationModels {
	if (next.agentModelOverrides || !previous?.agentModelOverrides) return next;
	return { ...next, agentModelOverrides: previous.agentModelOverrides };
}

/** What a conversation actually runs: `provider/id` of its model and its thinking level. */
export interface SessionModel {
	model?: string;
	thinking?: string;
}

type Comparison = "same" | "different" | "unknown";

/** Does the selector name this model? `unknown` for selectors that are not one plain model (aliases, lists). */
function sameModel(selector: string, model: string): Comparison {
	const parsed = parseSelector(selector);
	if (!parsed) return "unknown";
	return `${parsed.provider}/${parsed.id}` === model ? "same" : "different";
}

/** The thinking level a preset gives the conversation it is switched to: the default role's own, else the preset's. */
function expectedThinking(p: ModelPreset): string | undefined {
	const selector = p.roles.default ? parseSelector(p.roles.default) : null;
	return selector?.level ?? p.defaultThinkingLevel;
}

/**
 * The active preset for roles `cfg`, by omp's rule: the first preset by name that omp can apply, with the same
 * roles holding the same selectors, and the same default thinking level when it sets one. The subagent models a preset
 * carries play no part: omp's own rule knows nothing of them, and applying a preset that sets none leaves the current
 * ones, so two presets that differ only in them cannot be told apart from the configuration.
 *
 * With `session` (what a conversation runs), the default role is judged by the conversation, not the config:
 * the conversation's model can be moved off the configured default (the model picker only changes the
 * conversation), and a preset saved from that state is the active one while its other roles match. A preset
 * for another model than the conversation runs is not active even when the config says it is. Selectors that
 * cannot be compared with a model (aliases, lists) fall back to omp's own comparison. When several presets
 * match, the one whose thinking level the conversation runs wins.
 *
 * `chosen` is the preset the conversation was switched to. Among the presets that match, it wins over the name order, so
 * of two that differ only in their subagent models the one picked is the one shown. It never makes a preset active that
 * does not match: a conversation moved off it by a picker is on no preset.
 */
export function activePreset(
	cfg: Pick<ModelConfig, "roles" | "defaultThinkingLevel" | "presets">,
	session?: SessionModel,
	chosen?: string | null,
): string | null {
	const current = cfg.roles;
	const others = Object.keys(current).filter((k) => k !== "default");
	const matches: ModelPreset[] = [];
	for (const p of [...cfg.presets].sort((a, b) => a.name.localeCompare(b.name))) {
		if (p.problem) continue;
		if (p.defaultThinkingLevel !== undefined && p.defaultThinkingLevel !== cfg.defaultThinkingLevel) continue;
		// Every role but the default must be the configured one; the default is judged below.
		const own = Object.keys(p.roles).filter((k) => k !== "default");
		if (own.length !== others.length) continue;
		if (!own.every((k) => Object.hasOwn(current, k) && p.roles[k] === current[k])) continue;
		const wanted = p.roles.default;
		const configured = current.default;
		if (wanted !== configured) {
			// Differs from the config only in the default role: active for a conversation that runs that model.
			if (!session?.model || !wanted || sameModel(wanted, session.model) !== "same") continue;
		} else if (wanted && session?.model && sameModel(wanted, session.model) === "different") {
			continue;
		}
		matches.push(p);
	}
	// The ones whose thinking level the conversation runs, when there are any.
	const exact = session?.thinking ? matches.filter((p) => expectedThinking(p) === session.thinking) : [];
	const candidates = exact.length > 0 ? exact : matches;
	return candidates.find((p) => p.name === chosen)?.name ?? candidates[0]?.name ?? null;
}

/**
 * The preset after (`step` 1) or before (-1) `active` among those omp can apply, wrapping around; the first (or
 * last) when none is active. Null when there is nothing to switch to.
 */
export function nextPreset(
	presets: readonly ModelPreset[],
	active: string | null,
	step: 1 | -1 = 1,
): ModelPreset | null {
	const usable = presets.filter((p) => !p.problem);
	if (usable.length === 0) return null;
	const i = usable.findIndex((p) => p.name === active);
	if (i < 0) return step > 0 ? usable[0] : usable[usable.length - 1];
	return usable[(i + step + usable.length) % usable.length];
}

/**
 * `presets` with the active one listed first; the others keep their order. `active` is a result of `activePreset` — this
 * only moves what that found, so a preset that does not match is never made to look active.
 */
export function activeFirst<T extends { name: string }>(presets: readonly T[], active: string | null | undefined): T[] {
	const at = active == null ? -1 : presets.findIndex((p) => p.name === active);
	if (at <= 0) return [...presets];
	return [presets[at], ...presets.slice(0, at), ...presets.slice(at + 1)];
}

/**
 * The roles "save current" stores for a conversation: the configured roles, except that the default role follows
 * what the conversation runs when that differs — the model and thinking pickers change the conversation, not the
 * config. A selector that is an alias or a list cannot be compared with a model, so it stays.
 */
export function currentRoles(
	cfg: Pick<ModelConfig, "roles" | "defaultThinkingLevel">,
	session?: SessionModel,
): Record<string, string> {
	const roles = { ...cfg.roles };
	const running = session?.model ? parseSelector(session.model) : null;
	if (!running) return roles;
	const configured = roles.default ? parseSelector(roles.default) : null;
	if (roles.default && !configured) return roles;
	const level = isSelectorLevel(session?.thinking) ? session.thinking : undefined;
	const sameModel = configured?.provider === running.provider && configured.id === running.id;
	if (sameModel && (!level || level === (configured.level ?? cfg.defaultThinkingLevel))) return roles;
	roles.default = formatSelector({ provider: running.provider, id: running.id, level: level ?? configured?.level });
	return roles;
}

/**
 * The agents `configured` (a configuration's `task.agentModelOverrides`) gives a model that `models` does not: a conversation
 * on `models` has none for them, as it has no role the preset lacks. None while `models` carries no subagent models, since
 * the conversation then follows the configuration's own.
 */
export function clearedAgents(
	configured: Record<string, string>,
	models: Pick<ConversationModels, "agentModelOverrides">,
): string[] {
	const kept = models.agentModelOverrides;
	return kept ? Object.keys(configured).filter((agent) => !Object.hasOwn(kept, agent)) : [];
}
