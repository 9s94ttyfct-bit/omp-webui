import { DEFAULT_GUARD_CONFIG, type GuardMode, type GuardOverridePatch, type LiveGuard } from "@shared/guard.ts";
import { MAX_PREF_LENGTH } from "@shared/prefs.ts";

/**
 * The guard's switch in a conversation's header (`GuardToggle`): Off for this conversation alone, and back on to what it
 * was under before. What it was under is kept per conversation in a preference (`ompw.guardBefore`, synced to every page
 * of the server like the others), written while the guard is on for it, whichever control put it there (the switch, This
 * session, Settings). Only the page on the computer the server runs on switches it, as it is the only one that may change
 * a conversation's guard (`isLocalOnlyRoute`).
 */

/** What a conversation was under while its guard was on: a mode of its own, or following Settings › Safety. */
export type GuardOnChoice = Exclude<GuardMode, "off"> | "follow";

const CHOICES: readonly GuardOnChoice[] = ["reviewer", "ask", "follow"];

/** Conversations remembered; the least recently changed go first, so that the preference stays far below its size limit. */
export const MAX_REMEMBERED = 40;

export const guardIsOn = (guard: LiveGuard): boolean => guard.config.mode !== "off";

/**
 * What the switch gives back to a conversation whose guard is on now; null while it is off. A conversation whose kept record
 * was damaged is under a mode none of its choices names (the stricter of Settings and the default): that mode, as its own.
 */
export function onChoiceOf(guard: LiveGuard): GuardOnChoice | null {
	const mode = guard.config.mode;
	if (mode === "off") return null;
	if (guard.damaged) return mode;
	// Its own mode is the one it is under (an own Off would have made it off), or it follows Settings.
	return guard.own?.mode === undefined ? "follow" : mode;
}

/** The change that turns the guard off for this conversation alone, whatever Settings say. */
export const GUARD_OFF: GuardOverridePatch = { mode: "off" };

/**
 * The change that turns the guard back on: the mode the conversation was under before (`previous`), else Settings' mode
 * (`settings`: the conversation follows it again). Following Settings is no way back on while Settings say Off, nor when
 * they could not be read: the conversation is then given the shipped default as its own.
 */
export function guardOnPatch(previous: GuardOnChoice | null, settings: GuardMode | null): GuardOverridePatch {
	if (previous !== null && previous !== "follow") return { mode: previous };
	if (settings !== null && settings !== "off") return { mode: null };
	return { mode: DEFAULT_GUARD_CONFIG.mode };
}

/** Why the switch cannot be used on this page; null: it can. */
export type GuardToggleBlock = "remote";

/**
 * `local`: the page is the computer omp-webui runs on (`meta.local`; false until the page knows), the only one the server
 * lets change a conversation's guard (`/api/guard*` is `isLocalOnlyRoute`'s). Any other page (through the tunnel, over a
 * network address, another Mac's app) is shown the switch and cannot use it. A conversation with no running omp has no
 * switch at all: what its guard is (`LiveInfo.guard`) is its process's.
 */
export const guardToggleBlock = ({ local }: { local: boolean }): GuardToggleBlock | null => (local ? null : "remote");

/** What the preference holds: conversation → what it was under. Whatever does not read as that is dropped, not trusted. */
export function readRemembered(raw: string | null): Map<string, GuardOnChoice> {
	const out = new Map<string, GuardOnChoice>();
	if (!raw) return out;
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return out;
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return out;
	for (const [key, value] of Object.entries(parsed)) {
		const choice = CHOICES.find((c) => c === value);
		if (key !== "" && choice) out.set(key, choice);
	}
	return out;
}

/** What the conversation `key` was under before, from what the preference holds. */
export const rememberedChoice = (raw: string | null, key: string): GuardOnChoice | null =>
	readRemembered(raw).get(key) ?? null;

/**
 * The preference with `choice` kept for the conversation `key`, as the newest entry; null when it already says so (nothing
 * to write: every write goes to the server).
 */
export function withRemembered(raw: string | null, key: string, choice: GuardOnChoice): string | null {
	const kept = readRemembered(raw);
	if (kept.get(key) === choice) return null;
	kept.delete(key);
	kept.set(key, choice);
	let rows = [...kept].slice(-MAX_REMEMBERED);
	let json = JSON.stringify(Object.fromEntries(rows));
	// Long paths: the oldest go until it fits what the server keeps of a preference. The newest is always kept.
	while (json.length > MAX_PREF_LENGTH && rows.length > 1) {
		rows = rows.slice(1);
		json = JSON.stringify(Object.fromEntries(rows));
	}
	return json;
}
