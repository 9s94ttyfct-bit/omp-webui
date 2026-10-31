import type { OfflineSettings } from "./offline.ts";
import { PREF, type PrefKey } from "./prefs.ts";

/**
 * "Ask agent for help" (Settings, v0.13.0): a conversation of its own whose agent explains the app's settings (with the
 * read-only `webui_docs` tool every conversation has) and changes them for the person with `webui_settings`, a tool the
 * server serves that one conversation alone (`server/settings-help/`). What is shared by the server and the pages is here:
 * the names, the limits, the shapes the pages are told, and which setting is which kind.
 */

/** The tool's name. */
export const SETTINGS_TOOL = "webui_settings";

/** How long the conversation may change settings after it was started (or the access was given again). */
export const SETTINGS_GRANT_MS = 30 * 60_000;

/** How long the agent waits for the person to Allow or Deny a security-sensitive change; then it is denied. */
export const SETTINGS_CONFIRM_MS = 5 * 60_000;

/** The most entries the change log keeps (the oldest go first). */
export const SETTINGS_LOG_MAX = 200;

/** The most changes one call of the tool may ask for. */
export const SETTINGS_CHANGES_MAX = 20;

/**
 * What kind of setting a key is:
 *
 * - `normal`: the agent changes it directly (appearance, layout, notifications of CI runs, Light's models, …).
 * - `sensitive`: it weakens or reaches past a protection (the guard, remote access and its shells and files, unattended
 *   mode, the permission mode, keeping the Mac awake while the agent works, the app's update checks, where Light sends
 *   the conversation and what it may run): applied only after the person allowed that one change in the page.
 * - `unavailable`: the agent cannot change it here — what the app remembers for itself rather than a choice (the last
 *   folder, dismissed notices, the guard switch's memory), and omp's own configuration (model roles, compaction, session
 *   defaults), which is changed in Settings or by `omp config` and shared with omp in the terminal.
 */
export type SettingClass = "normal" | "sensitive" | "unavailable";

/**
 * Every synced preference, classified. A `Record` of `PrefKey`: a preference added to `shared/prefs.ts` does not compile
 * until it is put here, and `tests/unit/settings-help.test.ts` checks the same at run time.
 */
export const PREF_CLASS: Readonly<Record<PrefKey, SettingClass>> = {
	[PREF.theme]: "normal",
	[PREF.palette]: "normal",
	[PREF.lang]: "normal",
	[PREF.sidebarWidth]: "normal",
	[PREF.panelWidth]: "normal",
	[PREF.panelPanes]: "normal",
	// Whether notifications are on is part of whether the guard has somebody to ask (`ShellEvents.reaches`).
	[PREF.notify]: "sensitive",
	[PREF.ciNotify]: "normal",
	[PREF.autoTitle]: "normal",
	[PREF.keepThinking]: "normal",
	[PREF.cwd]: "unavailable",
	[PREF.usageDays]: "unavailable",
	[PREF.star]: "unavailable",
	[PREF.dismissed]: "unavailable",
	// The app's own update checks.
	[PREF.appUpdateCheck]: "sensitive",
	[PREF.quitAction]: "normal",
	[PREF.menuIcon]: "normal",
	// Remembered answers of the drop dialog: "insert the path" in the app, a copy sent to the server in a browser.
	[PREF.dropChoicesApp]: "unavailable",
	[PREF.dropChoicesPage]: "unavailable",
	[PREF.btwModel]: "normal",
	// Unattended mode: a conversation that runs without the person answering its questions.
	[PREF.unattended]: "sensitive",
	// The server refuses it to a page that is not this computer's: off, the Mac may sleep in the middle of a turn.
	[PREF.keepAwake]: "sensitive",
	[PREF.toolTimer]: "normal",
	[PREF.compactWhere]: "normal",
	[PREF.quickPrompts]: "normal",
	[PREF.quickPromptsSeen]: "unavailable",
	[PREF.guidanceDefault]: "normal",
	[PREF.guidanceCheck]: "normal",
	[PREF.sessionSort]: "normal",
	[PREF.pinnedFolded]: "normal",
	[PREF.usageRange]: "normal",
	[PREF.controlsAdvanced]: "normal",
	[PREF.graphGrid]: "normal",
	[PREF.graphFocus]: "normal",
	[PREF.graphStatus]: "normal",
	[PREF.graphTime]: "normal",
	// What each conversation's guard was under before the header's switch turned it off.
	[PREF.guardBefore]: "unavailable",
};

/** Full / Light (`mode.json`), classified the same way; the Light settings under `offline` are `OFFLINE_CLASS`. */
export const MODE_CLASS: Readonly<Record<"mode" | "lightModels", SettingClass>> = {
	mode: "normal",
	lightModels: "normal",
};

/** The Light settings (`mode.json:offline.<field>`). A `Record` of every field: one added does not compile until it is here. */
export const OFFLINE_CLASS: Readonly<Record<keyof OfflineSettings, SettingClass>> = {
	backend: "normal",
	// Where a Light conversation is sent: the whole conversation goes to that address.
	baseUrls: "sensitive",
	model: "normal",
	thinking: "normal",
	// What a Light process may run: MCP servers, built-in tools (bash among them) and skills.
	mcp: "sensitive",
	tools: "sensitive",
	skills: "sensitive",
	agentsMd: "normal",
};

/**
 * The files whose every field is security-sensitive, whatever it is: the guard (`guard.json`), remote access
 * (`remote.json`), the permission mode new conversations start in (`approval.json:default`) and what an unattended
 * conversation is told (`unattended.json:instruction`). A field added to one of them is sensitive without a word here.
 */
export const SENSITIVE_FILES = ["guard.json", "remote.json", "approval.json", "unattended.json"] as const;

/** Prefixes of keys that name omp's own configuration (`docs/agents`: `omp:<key>`, `session:<name>`): not changed here. */
export const OMP_PREFIXES = ["omp:", "session:"] as const;

/** The kind of `key` (see `SettingClass`); null for a key that is not a setting at all. */
export function classOf(key: string): SettingClass | null {
	if (Object.hasOwn(PREF_CLASS, key)) return PREF_CLASS[key as PrefKey];
	if (key === "mode.json:mode" || key === "mode.json:lightModels")
		return MODE_CLASS[key.slice("mode.json:".length) as "mode" | "lightModels"];
	if (key.startsWith("mode.json:offline.")) {
		const field = key.slice("mode.json:offline.".length);
		return Object.hasOwn(OFFLINE_CLASS, field) ? OFFLINE_CLASS[field as keyof OfflineSettings] : null;
	}
	if (SENSITIVE_FILES.some((file) => key.startsWith(`${file}:`) && key.length > file.length + 1)) return "sensitive";
	if (OMP_PREFIXES.some((prefix) => key.startsWith(prefix))) return "unavailable";
	return null;
}

/** A conversation that may change settings now, until `expiresAt` (ms since the epoch). */
export interface SettingsGrant {
	liveId: string;
	startedAt: number;
	expiresAt: number;
}

/** Why a conversation can no longer change settings. */
export type GrantEnd = "expired" | "revoked" | "ended";

/** A conversation whose access ended, and why (kept while the server runs, so its header can say so). */
export interface SettingsGrantEnded {
	liveId: string;
	reason: GrantEnd;
	at: number;
}

/** A security-sensitive change that waits for the person's Allow or Deny. */
export interface SettingsRequest {
	id: string;
	liveId: string;
	key: string;
	old: unknown;
	new: unknown;
	askedAt: number;
	/** Denied by itself at this time when nobody answered. */
	expiresAt: number;
}

/** Who let a change through: the agent alone (a normal setting), or the person (Allow on a sensitive one). */
export type ConfirmedBy = "agent" | "person";

/** One change made through the feature, in the log Settings shows. */
export interface SettingsChange {
	id: string;
	/** When it was made (ms since the epoch). */
	at: number;
	/** The conversation that made it. */
	liveId: string;
	key: string;
	old: unknown;
	new: unknown;
	confirmedBy: ConfirmedBy;
	/** When the person undid it; null while it stands. */
	undoneAt: number | null;
}

/** What a page on this computer is told of the feature: `GET /api/settings-help` and the `settings_help` message. */
export interface SettingsHelpState {
	/** The folder the dedicated conversations run in, so that a page knows one when it shows it. */
	folder: string;
	grants: SettingsGrant[];
	ended: SettingsGrantEnded[];
	requests: SettingsRequest[];
	/** Newest first. */
	changes: SettingsChange[];
}

/** Two values of a setting are the same one (values are JSON: strings, numbers, booleans, null, lists and objects). */
export function sameValue(a: unknown, b: unknown): boolean {
	return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}
