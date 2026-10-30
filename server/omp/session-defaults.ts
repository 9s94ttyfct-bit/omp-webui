import { existsSync } from "node:fs";
import { isRecord } from "../../shared/guards.ts";
import {
	type ConfigValue,
	defaultWrites,
	FAST_TIERS,
	type ServiceTierFamily,
	type SessionDefault,
	serviceTierFamily,
	type Write,
} from "../../shared/session-defaults.ts";
import type { Config } from "../config.ts";
import type { Live, LivePool } from "../live.ts";
import { type ConfigScope, ompConfig, queued, readKey } from "./model-config.ts";
import { defaultsScope } from "./session-settings.ts";

/** A default that cannot be made, with the HTTP status the page is answered with. */
export class SessionDefaultError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

/** The control's own value in omp's `get_state` (the words of its choices), for the settings omp reports. */
function reported(setting: SessionDefault, state: Record<string, unknown>): string | undefined {
	const onOff = (v: unknown) => (typeof v === "boolean" ? (v ? "on" : "off") : undefined);
	const text = (v: unknown) => (typeof v === "string" ? v : undefined);
	switch (setting) {
		case "autoCompaction":
			return onOff(state.autoCompactionEnabled);
		case "steeringMode":
			return text(state.steeringMode);
		case "followUpMode":
			return text(state.followUpMode);
		case "interruptMode":
			return text(state.interruptMode);
		case "fastMode":
			return onOff(state.fastModeEnabled);
		default:
			// Auto-retry and cache warming are write-only: omp does not say what a process has.
			return undefined;
	}
}

/** Whether the process was started with a `--config` or `--profile` of its own, which its settings may come from. */
const hasOwnConfig = (args: readonly string[]) => args.some((a) => /^--(config|profile)(=|$)/.test(a));

/** The scalar a setting has in the folder `cwd`, as omp resolves it there (a folder that is gone has only the global one). */
async function configured(
	cfg: Config,
	cwd: string,
	key: string,
	scope: ConfigScope = {},
): Promise<ConfigValue | undefined> {
	const held = await readKey(cfg.ompBin, existsSync(cwd) ? cwd : cfg.dataDir, key, scope);
	return typeof held === "string" || typeof held === "boolean" ? held : undefined;
}

/**
 * What the settings `writes` stand for are in `other`'s omp right now, to be held for it while the config changes. The
 * process says so itself (`get_state`) wherever omp reports it, which is the truth whatever its own `--config` or
 * `--profile` sets. A setting omp does not report is read from the configuration of its folder, unless the process
 * has a configuration of its own, which that would override: it is then left as it was. A fast mode that is on or off
 * holds the tier the configuration has when that is a fast one (or not), so `flex` and `ultrafast` stay what they are;
 * a process with a configuration of its own is not held for it at all (`get_state` does not say which tier it has).
 */
export async function heldBy(
	cfg: Config,
	other: Live,
	setting: SessionDefault,
	writes: readonly Write[],
	family: ServiceTierFamily | null,
	state: Record<string, unknown> | null,
): Promise<Record<string, ConfigValue>> {
	const held: Record<string, ConfigValue> = {};
	if (setting === "fastMode") {
		// Another family's tier is not what this process runs on: nothing changes for it. `get_state` says whether a fast
		// tier is on, not which, so a process with a configuration of its own, whose file may set `flex` or `ultrafast`,
		// is left as it is: a pin made from the folder's configuration would override its file.
		if (
			!state ||
			family === null ||
			hasOwnConfig(other.ownArgs) ||
			serviceTierFamily(isRecord(state.model) ? state.model : null) !== family
		)
			return held;
		const key = `tier.${family}`;
		const on = state.fastModeEnabled === true;
		const now = await configured(cfg, other.info.cwd, key);
		const fast = now !== undefined && FAST_TIERS.includes(now);
		held[key] = fast === on && now !== undefined ? now : on ? "priority" : "none";
		return held;
	}
	const shown = state ? reported(setting, state) : undefined;
	const own = hasOwnConfig(other.ownArgs);
	for (const { key } of writes) {
		if (shown !== undefined) {
			const now = defaultWrites(setting, shown);
			const value = now?.find((w) => w.key === key)?.value;
			if (value !== undefined) held[key] = value;
		} else if (!own) {
			const now = await configured(cfg, other.info.cwd, key);
			if (now !== undefined) held[key] = now;
		}
	}
	return held;
}

/**
 * Make what a session control says omp's global default, as `omp config set` does in the terminal: new conversations
 * start with it. omp's running processes follow the global config for every setting they were not given a value of
 * their own for, so the change is not left to reach them: every other conversation first holds the settings as they
 * are now (`ProcessOverlay.pin`), and only then is the config written. The conversation it was chosen in keeps its
 * value, which is the one being written. Fast mode is the tier of one family, the one `live`'s model is in, as for
 * omp's `/fast`. Serialized with the other writes of the config.
 */
export function setSessionDefault(
	cfg: Config,
	pool: LivePool,
	live: Live,
	agentDir: string,
	setting: unknown,
	value: unknown,
): Promise<void> {
	return queued(async () => {
		let family: ServiceTierFamily | null = null;
		if (setting === "fastMode") {
			const state = await live.lookState(true);
			family = serviceTierFamily(state && isRecord(state.model) ? state.model : null);
			if (family === null)
				throw new SessionDefaultError("This conversation's model has no service tier for fast mode", 409);
		}
		// Where the page reads defaults (`readPanelConfig`): the process's agent directory and `--profile`.
		const scope = defaultsScope(live);
		const asked = defaultWrites(setting, value, family);
		if (!asked) throw new SessionDefaultError("setting and value required", 400);
		const key = setting as SessionDefault;
		// `/fast off` clears a fast tier and nothing else: another value of the setting is the user's own.
		const writes: Write[] = [];
		for (const w of asked) {
			const now = w.over ? await configured(cfg, cfg.dataDir, w.key, scope) : undefined;
			if (!w.over || (now !== undefined && w.over.includes(now))) writes.push(w);
		}
		if (writes.length === 0) return;
		const others = pool.otherLives(live, agentDir);
		await Promise.all(
			others.map(async (other) => {
				// A frozen process is not run for a look: its folder's configuration says what it has.
				const state = await other.lookState(false);
				const held = await heldBy(cfg, other, key, writes, family, state);
				// What the default will be is not a thing to hold.
				for (const w of writes) if (held[w.key] === w.value) delete held[w.key];
				await other.pinSettings(held);
			}),
		);
		for (const w of writes) await ompConfig(cfg.ompBin, cfg.dataDir, ["set", w.key, String(w.value)], undefined, scope);
	});
}
