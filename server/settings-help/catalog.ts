import { type ApprovalMode, isApprovalMode } from "../../shared/approval.ts";
import { DEFAULT_GUARD_CONFIG, type GuardConfig, parseGuardPatch } from "../../shared/guard.ts";
import { isLightModels, isMode, type LightModels, type Mode, type OfflineSettings } from "../../shared/offline.ts";
import { isValidPref, MAX_PREF_LENGTH, PREF_KEYS, type PrefKey, type PrefsChanges } from "../../shared/prefs.ts";
import { DEFAULT_REMOTE_CONFIG, parseRemoteConfigPatch, type RemoteConfig } from "../../shared/remote.ts";
import { classOf, OFFLINE_CLASS, type SettingClass } from "../../shared/settings-help.ts";
import { INSTRUCTION_MAX, instructionText } from "../../shared/unattended.ts";
import { mergeOffline } from "../offline/settings.ts";

/**
 * The settings `webui_settings` reads and changes, each through the validated setter its own Settings card uses: the
 * synced preferences (`UiPrefs.apply`), the guard (`GuardSettings.set`), remote access (`RemoteService.saveConfig`), Full
 * / Light (`ModeService.update`), the permission mode of new conversations (`ApprovalStore.setDefault`) and unattended
 * mode's instruction (`UnattendedService.setInstruction`). A value is checked by the same parser the setter runs before
 * anything is asked or written (`check`), and the setter checks it again. Nothing here writes a file itself.
 *
 * Key names are those of `docs/agents/` (`ompw.theme`, `guard.json:mode`, `mode.json:offline.thinking`), so that what the
 * agent reads with `webui_docs` is what it passes here; two have no Key table there: `approval.json:default` and
 * `unattended.json:instruction`.
 */

/** What changes each kind of setting: the server's own objects, behind the side effects its routes have. */
export interface SettingsBackends {
	prefs: { values(): Record<PrefKey, string | null>; apply(changes: PrefsChanges): void };
	guard: { get(): GuardConfig; set(patch: Partial<GuardConfig>): void };
	remote: { get(): Promise<RemoteConfig>; save(patch: Partial<RemoteConfig>): Promise<void> };
	mode: {
		get(): { mode: Mode; lightModels: LightModels; offline: OfflineSettings };
		update(patch: { mode?: Mode; lightModels?: LightModels; offline?: Partial<OfflineSettings> }): void;
	};
	approval: { get(): ApprovalMode | null; set(mode: ApprovalMode | null): void };
	/** The person's own instruction; null: the shipped one. */
	unattended: { get(): string | null; set(text: string | null): void };
}

/** A value a setting cannot hold, in words the agent passes on. */
export class SettingValueError extends Error {}

/** One setting the tool knows. */
interface Entry {
	read(b: SettingsBackends): Promise<unknown>;
	/** The value as the setter will keep it; throws `SettingValueError` (or the setter's own error) for one it refuses. */
	check(b: SettingsBackends, value: unknown): Promise<unknown>;
	write(b: SettingsBackends, value: unknown): Promise<void>;
}

const mistake = (e: unknown) => new SettingValueError(e instanceof Error ? e.message : String(e));

function prefEntry(key: PrefKey): Entry {
	return {
		read: async (b) => b.prefs.values()[key] ?? null,
		async check(_b, value) {
			if (value !== null && typeof value !== "string")
				throw new SettingValueError(`${key} holds text (or null to forget it)`);
			if (typeof value === "string" && (value.length > MAX_PREF_LENGTH || !isValidPref(key, value)))
				throw new SettingValueError(`${key} cannot hold ${JSON.stringify(value)} (see webui_docs for its values)`);
			return value;
		},
		write: async (b, value) => b.prefs.apply({ [key]: value as string | null }),
	};
}

function guardEntry(field: keyof GuardConfig): Entry {
	const parse = (value: unknown) => {
		try {
			return parseGuardPatch({ [field]: value })[field];
		} catch (e) {
			throw mistake(e);
		}
	};
	return {
		read: async (b) => b.guard.get()[field],
		check: async (_b, value) => parse(value),
		write: async (b, value) => b.guard.set({ [field]: parse(value) }),
	};
}

function remoteEntry(field: keyof RemoteConfig): Entry {
	const parse = (value: unknown) => {
		try {
			return parseRemoteConfigPatch({ [field]: value })[field];
		} catch (e) {
			throw mistake(e);
		}
	};
	return {
		read: async (b) => (await b.remote.get())[field] ?? null,
		check: async (_b, value) => parse(value),
		write: async (b, value) => b.remote.save({ [field]: parse(value) }),
	};
}

const modeEntry: Entry = {
	read: async (b) => b.mode.get().mode,
	async check(_b, value) {
		if (!isMode(value)) throw new SettingValueError("mode.json:mode is full or light");
		return value;
	},
	write: async (b, value) => b.mode.update({ mode: value as Mode }),
};

const lightModelsEntry: Entry = {
	read: async (b) => b.mode.get().lightModels,
	async check(_b, value) {
		if (!isLightModels(value)) throw new SettingValueError("mode.json:lightModels is yours or local");
		return value;
	},
	write: async (b, value) => b.mode.update({ lightModels: value as LightModels }),
};

function offlineEntry(field: keyof OfflineSettings): Entry {
	const merged = (b: SettingsBackends, value: unknown) => {
		try {
			return mergeOffline(b.mode.get().offline, { [field]: value })[field];
		} catch (e) {
			throw mistake(e);
		}
	};
	return {
		read: async (b) => b.mode.get().offline[field],
		check: async (b, value) => merged(b, value),
		write: async (b, value) => b.mode.update({ offline: { [field]: merged(b, value) } }),
	};
}

const approvalEntry: Entry = {
	read: async (b) => b.approval.get(),
	async check(_b, value) {
		if (value !== null && !isApprovalMode(value))
			throw new SettingValueError(
				"approval.json:default is always-ask, always-ask-cached, write, yolo, or null (omp's own setting)",
			);
		return value;
	},
	write: async (b, value) => b.approval.set(value as ApprovalMode | null),
};

const instructionEntry: Entry = {
	read: async (b) => b.unattended.get(),
	async check(_b, value) {
		if (value === null) return null;
		if (typeof value !== "string") throw new SettingValueError("unattended.json:instruction is text, or null");
		const clean = instructionText(value);
		if (!clean) throw new SettingValueError("The instruction needs some text (null restores the shipped one)");
		if (clean.length > INSTRUCTION_MAX)
			throw new SettingValueError(`The instruction is at most ${INSTRUCTION_MAX} characters`);
		return clean;
	},
	write: async (b, value) => b.unattended.set(value as string | null),
};

/** Every setting the tool knows, by key. What `classOf` calls `unavailable` is not here. */
function entries(): Map<string, Entry> {
	const all = new Map<string, Entry>();
	for (const key of PREF_KEYS) all.set(key, prefEntry(key));
	for (const field of Object.keys(DEFAULT_GUARD_CONFIG) as (keyof GuardConfig)[])
		all.set(`guard.json:${field}`, guardEntry(field));
	for (const field of Object.keys(DEFAULT_REMOTE_CONFIG) as (keyof RemoteConfig)[])
		all.set(`remote.json:${field}`, remoteEntry(field));
	all.set("mode.json:mode", modeEntry);
	all.set("mode.json:lightModels", lightModelsEntry);
	for (const field of Object.keys(OFFLINE_CLASS) as (keyof OfflineSettings)[])
		all.set(`mode.json:offline.${field}`, offlineEntry(field));
	all.set("approval.json:default", approvalEntry);
	all.set("unattended.json:instruction", instructionEntry);
	for (const key of [...all.keys()]) if (classOf(key) === "unavailable") all.delete(key);
	return all;
}

/** A setting as `get` describes it to the agent. */
export interface SettingView {
	key: string;
	class: Exclude<SettingClass, "unavailable">;
	value: unknown;
}

/** The settings the tool knows, over `backends`. */
export class SettingsCatalog {
	private readonly all = entries();

	constructor(private readonly backends: SettingsBackends) {}

	/** Every key the tool can change, in a stable order. */
	keys(): string[] {
		return [...this.all.keys()];
	}

	/** Whether `key` is one the tool can change. */
	has(key: string): boolean {
		return this.all.has(key);
	}

	private entry(key: string): Entry {
		const entry = this.all.get(key);
		if (!entry) throw new SettingValueError(`Unknown setting: ${key}`);
		return entry;
	}

	read(key: string): Promise<unknown> {
		return this.entry(key).read(this.backends);
	}

	check(key: string, value: unknown): Promise<unknown> {
		return this.entry(key).check(this.backends, value);
	}

	write(key: string, value: unknown): Promise<void> {
		return this.entry(key).write(this.backends, value);
	}

	/** The settings of `keys` (every one when none), with their kind and value. */
	async view(keys?: readonly string[]): Promise<SettingView[]> {
		const out: SettingView[] = [];
		for (const key of keys ?? this.keys()) {
			const kind = classOf(key);
			if (kind === null || kind === "unavailable") continue;
			out.push({ key, class: kind, value: await this.read(key) });
		}
		return out;
	}
}
