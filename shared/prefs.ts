/**
 * The web UI's preferences, which follow the person instead of the browser origin.
 *
 * localStorage is per origin (`127.0.0.1:<port>`), and the macOS app takes another port whenever its usual one is
 * taken. So the server keeps these keys in its data dir (`ui-prefs.json`) and hands them to every page it serves;
 * `web/index.html` applies them to localStorage before first paint, and `web/src/lib/prefs.ts` sends changes back.
 *
 * How the app looks and is laid out (`DEVICE_PREF_KEYS`) belongs, unless the person turns that off (`ompw.devicePrefs`), to
 * the device it is shown on: the server shares those keys between the pages of this computer only, and a page from
 * anywhere else keeps its own in its own localStorage.
 *
 * Only what the person chose and expects to find again is here. Per-tab scratch stays out: the chunk-reload guard
 * (`ompw.chunkReloadAt`, sessionStorage), the sync marker below, and unsent composer drafts (memory only).
 */

import { parseBrowserSize } from "./browser-protocol.ts";
import { STATUS_FILTERS, TIME_FILTERS } from "./graph-filter.ts";
import { GUIDANCE_ID_MAX, GUIDANCE_MAX } from "./model-guidance.ts";
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
	/**
	 * Whether the look and layout (`DEVICE_PREF_KEYS`) are kept per device: `on` (the default) shares them only between the
	 * pages of this computer, `off` gives every page the same, as the app did before v0.18.9. Itself the same on every page.
	 */
	devicePrefs: "ompw.devicePrefs",
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
	 * Whether the app installs a newer release of itself on its own (`on`, or `off`, the default): once nothing is working,
	 * asking, paused or waiting, it downloads, checks and installs it and restarts (`server/update/service.ts`, `autoTry`).
	 */
	appAutoUpdate: "ompw.appAutoUpdate",
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
	 * The guidance the last conversation started from New chat was started with (v0.17.0): JSON `{"template": id}`,
	 * `{"text": …}` (written there) or `{"none": true}`. New chat starts from it; unset, or a template deleted since, from
	 * `guidanceDefault`. See `web/src/lib/guidance-start.ts`.
	 */
	guidanceLast: "ompw.guidanceLast",
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
	/**
	 * Whether the sidebar's footer is folded: `on` gives its pages as one row of icons and leaves out the versions line,
	 * so a short window keeps more conversations in sight; `off` (the default) lists them as labelled rows.
	 */
	navFolded: "ompw.navFolded",
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
	/**
	 * Live animations that follow what the agent does (v0.15.0): `on` or `off` (the default), and how much of them there is,
	 * `subtle`, `normal` (the default) or `lively` (`ANIMATION_INTENSITIES`). The system's reduced motion turns them off
	 * whatever these say; see `web/src/lib/live-motion.ts`.
	 */
	animations: "ompw.animations",
	animationIntensity: "ompw.animationIntensity",
	/**
	 * The desktop size a page of the built-in browser is laid out at (Settings › Browser), as `<width>x<height>` in CSS
	 * pixels; unset is 1280×800 (`DESKTOP_SIZE`, `shared/browser-protocol.ts`). See `parseBrowserSize`.
	 */
	browserSize: "ompw.browserSize",
	/**
	 * Whether the built-in browser is used at all (v0.18.4): `on` (the default) or `off`. Off, the side panel has no Browser
	 * tab, no conversation is given its endpoint and omp's own browser tool is turned off (`browser.enabled: false` in each
	 * conversation's overlay), until it is turned on again. Changed only where the browser is managed (`canManageBrowser`).
	 */
	browser: "ompw.browser",
	/**
	 * Whether the built-in browser updates itself: `on` (the default) or `off`. On, the server looks for a newer version a
	 * minute after it starts and every 24 hours, downloads it in the background and switches to it once no conversation
	 * uses the browser (`server/browser/autoupdate.ts`). Changed only where the browser is managed (`canManageBrowser`).
	 */
	browserAutoUpdate: "ompw.browserAutoUpdate",
} as const;

export type PrefKey = (typeof PREF)[keyof typeof PREF];

export const PREF_KEYS: readonly PrefKey[] = Object.values(PREF);

export const isPrefKey = (k: unknown): k is PrefKey => (PREF_KEYS as readonly unknown[]).includes(k);

/**
 * The keys that belong to the device the page is shown on: its look (theme, palette, language) and its layout (the widths
 * of the sidebar and the side panel, the side panel's panes, the sidebar footer's fold). A phone, or a browser on another
 * computer, is in another light, another language and on another screen than this computer, and a choice made there must
 * not repaint the pages here (nor the other way round). The server still keeps them, for the pages of this computer
 * alone: those are on one device whatever port they are on (see above). See `pageSnapshot`.
 */
export const DEVICE_PREF_KEYS: readonly PrefKey[] = [
	PREF.theme,
	PREF.palette,
	PREF.lang,
	PREF.sidebarWidth,
	PREF.panelWidth,
	PREF.panelPanes,
	PREF.navFolded,
];

export const isDevicePref = (k: unknown): k is PrefKey => (DEVICE_PREF_KEYS as readonly unknown[]).includes(k);

/** Whether the store keeps the look and layout per device (`ompw.devicePrefs`, on unless set to `off`). */
export const perDevice = (snapshot: Pick<StoreSnapshot, "values">): boolean =>
	snapshot.values[PREF.devicePrefs] !== "off";

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
/** How much the live animations move (`ompw.animationIntensity`). Normal is the default. */
export const ANIMATION_INTENSITIES = ["subtle", "normal", "lively"] as const;

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

/** A template's id, as the store bounds it. */
const TEMPLATE_ID = new RegExp(`^[^\\s]{1,${GUIDANCE_ID_MAX}}$`);

/** The shapes `ompw.guidanceLast` holds: exactly one of a template id, text within the editor's bound, or none. */
export function isRememberedGuidance(v: unknown): v is { template: string } | { text: string } | { none: true } {
	if (!isRecord(v) || Object.keys(v as object).length !== 1) return false;
	const r = v as Record<string, unknown>;
	if ("template" in r) return typeof r.template === "string" && TEMPLATE_ID.test(r.template);
	if ("text" in r) return typeof r.text === "string" && r.text.length > 0 && r.text.length <= GUIDANCE_MAX;
	return r.none === true;
}

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
	[PREF.appAutoUpdate]: switchValue,
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
	[PREF.navFolded]: switchValue,
	[PREF.devicePrefs]: switchValue,
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
	[PREF.guidanceLast]: json(isRememberedGuidance),
	[PREF.guidanceCheck]: switchValue,
	[PREF.animations]: switchValue,
	[PREF.animationIntensity]: oneOf(ANIMATION_INTENSITIES),
	[PREF.browserSize]: (v) => parseBrowserSize(v) !== null,
	[PREF.browser]: switchValue,
	[PREF.browserAutoUpdate]: switchValue,
};

/** Whether `value` is something the app ever writes under `key` (length is checked apart: `MAX_PREF_LENGTH`). */
export const isValidPref = (key: PrefKey, value: string): boolean => VALID[key]?.(value) ?? true;

/**
 * What a page is given of the server's store: each key the server keeps for that page, null where none is set. A key that is
 * not there at all (a device key, for a page that is not on this computer: `pageSnapshot`) is not the server's to say for
 * that page, and the page keeps whatever it has of it; it never means "none".
 */
export interface PrefsSnapshot {
	/** Names this store: a data dir that was wiped or replaced gets another, and pages stop trusting their copy. */
	id: string;
	/** Counts the changes made to the store. */
	rev: number;
	values: Partial<Record<PrefKey, string | null>>;
}

/** What the server holds: every key, null where none is set. */
export interface StoreSnapshot extends PrefsSnapshot {
	values: Record<PrefKey, string | null>;
}

/**
 * The store as a page is given it: whole to a page on this computer (`isThisComputer` on the server), without the device keys
 * (`DEVICE_PREF_KEYS`) to any other, so that this computer's look and layout never reach a phone or another computer; whole
 * to every page while the person has the look and layout follow them everywhere (`perDevice`).
 */
export function pageSnapshot(snapshot: StoreSnapshot, onThisComputer: boolean): PrefsSnapshot {
	if (onThisComputer || !perDevice(snapshot)) return snapshot;
	const values = Object.fromEntries(Object.entries(snapshot.values).filter(([k]) => !isDevicePref(k)));
	return { id: snapshot.id, rev: snapshot.rev, values };
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
 * A key the snapshot does not carry (a device key, on a page that is not on this computer) is in neither: the origin's own
 * value is all there is of it.
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
		if (theirs === undefined || mine === theirs) continue;
		if (behind || (!known && mine === null)) adopt[key] = theirs;
		else upload[key] = mine;
	}
	return { adopt, upload };
}
