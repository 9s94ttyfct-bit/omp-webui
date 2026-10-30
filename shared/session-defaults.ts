/**
 * The session controls that can be made the global default ("Set as default" in the controls of a conversation), and
 * the omp settings each one stands for. omp has them as ordinary settings (`omp config set <key> <value>`): a new
 * process starts with them, and a running one that has not been given a value of its own follows a change of them.
 *
 * Slow mode is not here: omp keeps it global to begin with (`slowModeScope: "global"`), so changing it in a
 * conversation already is changing the default.
 */

/** What `omp config set` is given, and what an overlay file says (omp has settings that are numbers too). */
export type ConfigValue = string | number | boolean;

/** The model families omp has a service tier (`tier.<family>`) for. */
export const SERVICE_TIER_FAMILIES = ["anthropic", "openai", "google"] as const;
export type ServiceTierFamily = (typeof SERVICE_TIER_FAMILIES)[number];

/** What a model says of itself in omp's `get_state`. */
export interface ModelIdentity {
	provider?: unknown;
	api?: unknown;
}

/**
 * The family `/fast` acts on for the model a conversation runs on, as omp works it out from the provider and the API
 * the model speaks; null when this cannot say. omp also looks at what a model *is* for the providers that route others
 * (OpenRouter) and for custom OpenAI-compatible ones, which `get_state` does not tell: those have no star.
 */
export function serviceTierFamily(model: ModelIdentity | null | undefined): ServiceTierFamily | null {
	if (!model) return null;
	const { provider, api } = model;
	if (provider === "openrouter") return null;
	if (provider === "openai" || provider === "openai-codex") return "openai";
	if (api === "anthropic-messages") return "anthropic";
	if (provider === "google" || provider === "google-vertex") return "google";
	return null;
}

/** The tiers that are "fast mode" in omp: `/fast off` clears these and no other. */
export const FAST_TIERS: readonly ConfigValue[] = ["priority", "ultrafast"];

/** One omp setting to write. */
export interface Write {
	key: string;
	value: ConfigValue;
	/** Only while the setting is one of these: any other value is the user's own choice and is left as it is. */
	over?: readonly ConfigValue[];
}

export interface Definition {
	/** What the controls offer, as the page names them. */
	values: readonly string[];
	/** The settings that say `value`; null when the control has none for this model (`family`). */
	writes(value: string, family: ServiceTierFamily | null): Write[] | null;
}

const ON_OFF = ["on", "off"] as const;
const DELIVERY = ["one-at-a-time", "all"] as const;

export const SESSION_DEFAULTS = {
	autoCompaction: { values: ON_OFF, writes: (v) => [{ key: "compaction.enabled", value: v === "on" }] },
	autoRetry: { values: ON_OFF, writes: (v) => [{ key: "retry.enabled", value: v === "on" }] },
	steeringMode: { values: DELIVERY, writes: (v) => [{ key: "steeringMode", value: v }] },
	followUpMode: { values: DELIVERY, writes: (v) => [{ key: "followUpMode", value: v }] },
	interruptMode: { values: ["immediate", "wait"], writes: (v) => [{ key: "interruptMode", value: v }] },
	// omp's `/fast` sets (on) or clears (off) the priority tier of the family of the model in use, and touches no other.
	fastMode: {
		values: ON_OFF,
		writes: (v, family) =>
			family === null
				? null
				: [
						v === "on"
							? { key: `tier.${family}`, value: "priority" }
							: { key: `tier.${family}`, value: "none", over: FAST_TIERS },
					],
	},
	cacheWarming: { values: ["off", "streaming", "idle"], writes: (v) => [{ key: "providers.cacheWarming", value: v }] },
} satisfies Record<string, Definition>;

export type SessionDefault = keyof typeof SESSION_DEFAULTS;

/** Every omp setting a default can write, which is all a process's overlay may be asked to hold for one. */
export const SESSION_DEFAULT_KEYS: Readonly<Record<string, true>> = Object.fromEntries(
	Object.values(SESSION_DEFAULTS).flatMap((d: Definition) =>
		d.values.flatMap((v) =>
			[null, ...SERVICE_TIER_FAMILIES].flatMap((family) => (d.writes(v, family) ?? []).map((w) => [w.key, true])),
		),
	),
);

/** The settings `setting` stands for when it is `value`, or null when either is not one a default can be here. */
export function defaultWrites(
	setting: unknown,
	value: unknown,
	family: ServiceTierFamily | null = null,
): Write[] | null {
	if (typeof setting !== "string" || !Object.hasOwn(SESSION_DEFAULTS, setting)) return null;
	const def: Definition = SESSION_DEFAULTS[setting as SessionDefault];
	return typeof value === "string" && def.values.includes(value) ? def.writes(value, family) : null;
}

/**
 * The controls whose value omp's `get_state` does not report. omp's RPC can set them (`set_auto_retry`,
 * `set_cache_warming`: a value of this process's own, over every file) and never read them, so what the process uses is
 * the server's to work out: what it was told, else what its configuration says (see `server/omp/session-settings.ts`).
 */
export const UNREPORTED = ["autoRetry", "cacheWarming"] as const satisfies readonly SessionDefault[];
export type Unreported = (typeof UNREPORTED)[number];

/** What a process uses of the `UNREPORTED` controls, in the words of their choices; a control is absent where that is not known. */
export type SessionSettings = Partial<Record<Unreported, string>>;

/** The omp setting that holds `setting`'s value (`retry.enabled` for auto-retry). */
export function configKey(setting: Unreported): string {
	const def: Definition = SESSION_DEFAULTS[setting];
	return (def.writes(def.values[0], null) ?? [])[0].key;
}

/** Whether `value` is a choice the control offers. */
export function isChoice(setting: Unreported, value: unknown): value is string {
	const def: Definition = SESSION_DEFAULTS[setting];
	return typeof value === "string" && def.values.includes(value);
}

/** The choice that omp's setting being `value` stands for (`retry.enabled: true` is "on"); undefined when it is none. */
export function choiceOf(setting: Unreported, value: unknown): string | undefined {
	const def: Definition = SESSION_DEFAULTS[setting];
	return def.values.find((v) => def.writes(v, null)?.some((w) => w.value === value));
}

/** What `value` says of the `UNREPORTED` controls, as far as it is one of their choices (a record from disk, or from a page). */
export function sessionSettingsOf(value: unknown): SessionSettings {
	const out: SessionSettings = {};
	if (typeof value !== "object" || value === null) return out;
	for (const setting of UNREPORTED) {
		const choice = (value as Record<string, unknown>)[setting];
		if (isChoice(setting, choice)) out[setting] = choice;
	}
	return out;
}

/**
 * The omp setting of Claude's slow mode: `auto` keeps requests going at low priority when the plan's usage limit is
 * reached, `off` waits for the reset. It is global (omp's `config.yml`), whatever model a conversation runs on.
 */
export const CLAUDE_SLOW_KEY = "providers.anthropic.slowMode";

/** Claude's slow mode in the words of its choices. */
export type ClaudeSlowMode = "on" | "off";

/**
 * Whether what a control shows (`shown`, in the words of its choices) is what omp's configuration (`defaults`: the value
 * of each setting a default can write, as omp resolves it for the conversation's folder, without the process's own
 * overrides) already has for new conversations: the star of that row is then filled. Null `defaults`: the configuration
 * could not be read, so nothing is claimed.
 *
 * It is the setting's value that is compared, not the words: a configured value that is none of a control's choices is
 * the choice it stands for, as omp reads it. Fast mode is "on" for a fast tier (`FAST_TIERS`: `priority`, `ultrafast`)
 * and "off" for any other value of the family's tier (`none`, `default`, `flex`, `scale`) or none at all, which is how
 * `/fast` itself tells them (`writes("off")` clears a fast tier and no other).
 */
export function matchesDefault(
	setting: SessionDefault,
	shown: string | undefined,
	family: ServiceTierFamily | null,
	defaults: Readonly<Record<string, ConfigValue>> | null | undefined,
): boolean {
	if (!defaults || shown === undefined) return false;
	const writes = defaultWrites(setting, shown, family);
	if (!writes || writes.length === 0) return false;
	if (setting === "fastMode") {
		const tier = defaults[writes[0].key];
		return (shown === "on") === (tier !== undefined && FAST_TIERS.includes(tier));
	}
	return writes.every((w) => defaults[w.key] === w.value);
}
