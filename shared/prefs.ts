/**
 * The web UI's preferences, which follow the person instead of the browser origin.
 *
 * localStorage is per origin (`127.0.0.1:<port>`), and the macOS app takes another port whenever its usual one is
 * taken. So the server keeps these keys in its data dir (`ui-prefs.json`) and hands them to every page it serves;
 * `web/index.html` applies them to localStorage before first paint, and `web/src/lib/prefs.ts` sends changes back.
 *
 * Only what the person chose and expects to find again is here. Per-tab scratch stays out: the chunk-reload guard
 * (`ompw.chunkReloadAt`, sessionStorage), the sync marker below, and unsent composer drafts (memory only).
 */

import { STATUS_FILTERS, TIME_FILTERS } from "./graph-filter.ts";
import { parsePanes } from "./panes.ts";
import { USAGE_RANGES } from "./usage-range.ts";

/** Every synced key, by the name the app uses for it. */
export const PREF = {
	theme: "ompw.theme",
	palette: "ompw.palette",
	lang: "ompw.lang",
	sidebarWidth: "ompw.sidebarWidth",
	panelWidth: "ompw.panelWidth",
	/** The side panel's two panes: the tab each shows, which one is folded, where the divider is (`shared/panes.ts`). */
	panelPanes: "ompw.panelPanes",
	/** Whether notifications are wanted; what the browser allows is per origin and is asked again where it is not granted. */
	notify: "ompw.notify",
	/** Whether the end of a GitHub Actions run of the folder's branch is notified while the CI tab's badge watches it: `on` or `off` (the default). */
	ciNotify: "ompw.ciNotify",
	autoTitle: "ompw.autoTitle",
	keepThinking: "ompw.keepThinking",
	/** The folder of the last new conversation. */
	cwd: "ompw.cwd",
	usageDays: "ompw.usageDays",
	star: "ompw.star",
	dismissed: "ompw.omp.dismissed",
	/** Whether the app looks for a newer release of itself on its own (`on`, the default, or `off`); Check now always looks. */
	appUpdateCheck: "ompw.appUpdateCheck",
	/**
	 * What quitting the macOS app does (`ask`, the default, `background` or `quit`; see `QUIT_ACTIONS`): the shell reads it
	 * from the server when it is asked to quit, and writes it when the person ticks "Don't ask again".
	 */
	quitAction: "ompw.quitAction",
	/**
	 * Whether the macOS app shows its menu bar icon while it has its window too (`on`, the default, or `off`). It always shows
	 * it while it runs in the background: that is the only way back. The app hears it from the server (`/api/shell/events`).
	 */
	menuIcon: "ompw.menuIcon",
	/**
	 * What to do with dropped, pasted and picked files by kind, once the person chose "remember" (`DropChoices`,
	 * `shared/attachment.ts`): a JSON object. Kept apart for the macOS app and for a page in a browser (a local one, or
	 * one through the tunnel): "insert the path" writes the real path in the app and sends a copy of the file to the
	 * server in a browser, so a choice made in one place must not act in the other.
	 */
	dropChoicesApp: "ompw.dropChoices.app",
	dropChoicesPage: "ompw.dropChoices.page",
	/**
	 * The model that answers side questions (the Ask tab), one model as `provider/id` for every conversation; unset: the
	 * conversation's own model, answered by omp itself (`server/omp/btw-fork.ts` answers the others).
	 */
	btwModel: "ompw.btwModel",
	/** Whether a conversation started from New chat is unattended from the start (#646): `on` or `off` (the default). Each conversation has its own switch. */
	unattended: "ompw.unattended",
	/** Whether the Mac is kept from idle sleep while a conversation works (#647; `server/sleep.ts`). Unset is on. */
	keepAwake: "ompw.keepAwake",
	/** Which tool calls show how long they ran (#657): `all` (the default), `shell` (`bash` and the user's own `!commands`) or `off`; see `TOOL_TIMERS` in `web/src/lib/tool-timer.ts`. */
	toolTimer: "ompw.toolTimer",
	/** Where a compact queued while the agent works runs (#651): `turn` (the default: when the turn ends) or `step` (between two steps of it); see `CompactWhere` in `shared/compact-queue.ts`. A conversation's own choice, in This session, starts from it. */
	compactWhere: "ompw.compactWhere",
	/** The quick prompts of the message box (#659): a JSON list (`shared/quick-prompts.ts`); unset is the defaults. */
	quickPrompts: "ompw.quickPrompts",
	/** The built-in quick prompts the saved list was made with (a JSON list of ids): one added later joins the list once. */
	quickPromptsSeen: "ompw.quickPromptsSeen",
	/**
	 * The model guidance template a conversation started from New chat is given until the person picks another there (its
	 * id; v0.11.18 §6). Unset: none, as before. A template that is deleted stops being it.
	 */
	guidanceDefault: "ompw.guidanceDefault",
	/**
	 * Whether saving a conversation's guidance (or switching it to another template) checks it for conflicts with the folder's
	 * AGENTS.md and similar files and with omp's memories of the project (v0.13.0): `on` (the default) or `off`. One request
	 * to the guard reviewer's model per check; see `shared/guidance-conflict.ts`.
	 */
	guidanceCheck: "ompw.guidanceCheck",
	/** The order of the sidebar's conversations (#701): `activity` (the default), `created` or `title`; see `web/src/lib/session-order.ts`. */
	sessionSort: "ompw.sessionSort",
	/** Whether the sidebar's Pinned group is folded (#700): `on` or `off` (the default). */
	pinnedFolded: "ompw.pinnedFolded",
	/** How far back Usage & cost looks (#714): `24h`, `7d`, `30d` (the default) or `all`; see `shared/usage-range.ts`. */
	usageRange: "ompw.usageRange",
	/** Whether the session panel's Advanced settings are unfolded (#716): `on` or `off` (the default). */
	controlsAdvanced: "ompw.controlsAdvanced",
	/**
	 * How the agent graph is looked at, one choice for every conversation's graph (v0.12.2): siblings in a grid and the focus
	 * view with its minimap, each `on` or `off` (the default); the status filter (`all`, the default, `running` or `failed`)
	 * and the time filter (`all`, the default, `hour` or `today`), see `shared/graph-filter.ts`.
	 */
	graphGrid: "ompw.agentGraph.grid",
	graphFocus: "ompw.agentGraph.focus",
	graphStatus: "ompw.agentGraph.status",
	graphTime: "ompw.agentGraph.time",
	/**
	 * What each conversation's guard was under before the header's guard switch turned it off (v0.12.2): a JSON object of the
	 * conversation's session file (or process id) to `reviewer`, `ask` or `follow`, the most recent last; see `web/src/lib/guard-toggle.ts`.
	 */
	guardBefore: "ompw.guardBefore",
} as const;

export type PrefKey = (typeof PREF)[keyof typeof PREF];

export const PREF_KEYS: readonly PrefKey[] = Object.values(PREF);

export const isPrefKey = (k: unknown): k is PrefKey => (PREF_KEYS as readonly unknown[]).includes(k);

/** The longest value kept for a key (a folder path, or a JSON list of days, is far below it). */
export const MAX_PREF_LENGTH = 16 * 1024;

/** Light, dark or whatever the OS is set to: the modes `ompw.theme` can hold. */
export const THEMES = ["dark", "light", "system"] as const;
/** The palettes `ompw.palette` can hold (web/src/palettes.css has each one's colours). Claude is the default. */
export const PALETTES = ["claude", "chatgpt", "terminal", "omp", "hermes"] as const;
export const LANGS = ["en", "zh-CN"] as const;
/** What `ompw.quitAction` can hold: ask each time, run in the background (the window goes, the app and its server run on), or quit. */
export const QUIT_ACTIONS = ["ask", "background", "quit"] as const;
export type QuitAction = (typeof QUIT_ACTIONS)[number];
/** The action a stored value names; anything else (not set, a value from another version) asks. */
export const quitActionOf = (v: string | null): QuitAction => QUIT_ACTIONS.find((a) => a === v) ?? "ask";

const oneOf = (list: readonly string[]) => (v: string) => list.includes(v);
const switchValue = oneOf(["on", "off"]);
const json = (shape: (parsed: unknown) => boolean) => (v: string) => {
	try {
		return shape(JSON.parse(v));
	} catch {
		return false;
	}
};
const isRecord = (x: unknown) => typeof x === "object" && x !== null && !Array.isArray(x);

/** What each key may hold. A key that is free text (a folder) is not here. */
const VALID: Partial<Record<PrefKey, (value: string) => boolean>> = {
	[PREF.theme]: oneOf(THEMES),
	[PREF.palette]: oneOf(PALETTES),
	[PREF.lang]: oneOf(LANGS),
	// Pixels: a whole number of at most four digits. The page keeps it inside the window's room.
	[PREF.sidebarWidth]: (v) => /^[1-9]\d{0,3}$/.test(v),
	[PREF.panelWidth]: (v) => /^[1-9]\d{0,3}$/.test(v),
	[PREF.panelPanes]: (v) => parsePanes(v) !== null,
	[PREF.notify]: switchValue,
	[PREF.ciNotify]: switchValue,
	[PREF.autoTitle]: switchValue,
	[PREF.keepThinking]: switchValue,
	[PREF.quitAction]: oneOf(QUIT_ACTIONS),
	[PREF.menuIcon]: switchValue,
	[PREF.appUpdateCheck]: switchValue,
	[PREF.keepAwake]: switchValue,
	[PREF.toolTimer]: oneOf(["all", "shell", "off"]),
	[PREF.compactWhere]: oneOf(["turn", "step"]),
	// What a list holds is read by `parseQuickPrompts`, which leaves out what it does not know: here only the shape.
	[PREF.quickPrompts]: json(Array.isArray),
	[PREF.quickPromptsSeen]: json(Array.isArray),
	[PREF.usageDays]: json(Array.isArray),
	[PREF.star]: json(isRecord),
	[PREF.dismissed]: json(isRecord),
	[PREF.dropChoicesApp]: json(isRecord),
	[PREF.dropChoicesPage]: json(isRecord),
	// One model, not an alias, a list or a glob: the server starts omp on it (`--model`), and the page says which answered.
	[PREF.btwModel]: (v) => /^[^/\s,:*?]+\/[^\s,*?]+$/.test(v) && !v.startsWith("pi/"),
	[PREF.unattended]: switchValue,
	[PREF.sessionSort]: oneOf(["activity", "created", "title"]),
	[PREF.pinnedFolded]: switchValue,
	[PREF.usageRange]: oneOf(USAGE_RANGES),
	[PREF.controlsAdvanced]: switchValue,
	[PREF.graphGrid]: switchValue,
	[PREF.graphFocus]: switchValue,
	[PREF.graphStatus]: oneOf(STATUS_FILTERS),
	[PREF.graphTime]: oneOf(TIME_FILTERS),
	// What each entry says is read by `readRemembered`, which leaves out what it does not know: here only the shape.
	[PREF.guardBefore]: json(isRecord),
	// A template's id, as the store bounds it (`GUIDANCE_ID_MAX`).
	[PREF.guidanceDefault]: (v) => /^[^\s]{1,80}$/.test(v),
	[PREF.guidanceCheck]: switchValue,
};

/** Whether `value` is something the app ever writes under `key` (length is checked apart: `MAX_PREF_LENGTH`). */
export const isValidPref = (key: PrefKey, value: string): boolean => VALID[key]?.(value) ?? true;

/** What the server holds: every key, null where none is set. */
export interface PrefsSnapshot {
	/** Names this store: a data dir that was wiped or replaced gets another, and pages stop trusting their copy. */
	id: string;
	/** Counts the changes made to the store. */
	rev: number;
	values: Record<PrefKey, string | null>;
}

/** A change to the store: a string sets a key, null forgets it. */
export type PrefsChanges = Partial<Record<PrefKey, string | null>>;

/** The `<script type="application/json">` the server puts the snapshot in, ahead of the page's own scripts. */
export const PREFS_ELEMENT_ID = "ompw-prefs";

/**
 * localStorage key of the origin's sync marker, `<store id>:<rev>`: the store and revision this origin's copy is known to
 * match. Never synced itself. `web/index.html` reads it by this name.
 */
export const PREFS_SYNC_KEY = "ompw.prefsSync";

/**
 * localStorage key of what a browser knows of itself for Web Push (`{ device, id }`, `lib/push-presence.ts`): per browser, never
 * synced, and read by `lib/attention.ts` on every page, which is why it is here and not in `shared/push.ts`.
 */
export const PUSH_DEVICE_KEY = "ompw.pushDevice";

/** `<store id>:<rev>` as `syncMarker` writes it; null for anything else. */
export function parseSyncMarker(marker: string | null): { id: string; rev: number } | null {
	const at = marker?.lastIndexOf(":") ?? -1;
	if (!marker || at <= 0 || !/^\d+$/.test(marker.slice(at + 1))) return null;
	return { id: marker.slice(0, at), rev: Number(marker.slice(at + 1)) };
}

export const syncMarker = (s: Pick<PrefsSnapshot, "id" | "rev">): string => `${s.id}:${s.rev}`;

/**
 * How an origin's copy and the server's snapshot are brought together, key by key.
 *
 * - A copy known to be of this store, and older than it (`behind`: the store changed from elsewhere since): the server's
 *   values win, a key it lacks is forgotten.
 * - A copy known to be current, or ahead of the server: its own edits stand and go to the server.
 * - A copy that never met this store (a first visit after an upgrade, a new port, a replaced data dir): its own values stand
 *   and go to the server, and keys it has none of are taken from the server.
 *
 * `adopt` is what to write into this origin, `upload` what to send to the server; a key is in at most one of them.
 */
export function reconcile(
	snapshot: PrefsSnapshot,
	marker: string | null,
	local: Record<PrefKey, string | null>,
): { adopt: PrefsChanges; upload: PrefsChanges } {
	const seen = parseSyncMarker(marker);
	const known = seen?.id === snapshot.id;
	const behind = known && seen.rev < snapshot.rev;
	const adopt: PrefsChanges = {};
	const upload: PrefsChanges = {};
	for (const key of PREF_KEYS) {
		const mine = local[key];
		const theirs = snapshot.values[key];
		if (mine === theirs) continue;
		if (behind || (!known && mine === null)) adopt[key] = theirs;
		else upload[key] = mine;
	}
	return { adopt, upload };
}
