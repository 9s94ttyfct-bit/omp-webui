import {
	isPrefKey,
	isValidPref,
	MAX_PREF_LENGTH,
	PREF_KEYS,
	PREFS_ELEMENT_ID,
	PREFS_SYNC_KEY,
	type PrefKey,
	type PrefsChanges,
	type PrefsSnapshot,
	reconcile,
	syncMarker,
} from "@shared/prefs.ts";

/**
 * Preferences (the keys of shared/prefs.ts) live in two places: this origin's localStorage, which everything reads
 * synchronously, and the server's data dir, which is what survives a change of port (localStorage is per origin, and the
 * macOS app moves to another port when its own is taken).
 *
 * The server puts its copy into the page it serves; `web/index.html` applies it to localStorage before first paint. From
 * here on a change is written to localStorage as before and sent to the server a moment later (and when the page is hidden
 * or closed). When a page starts, whatever this origin has that the server does not (an upgrade from before the server
 * kept preferences, a change that never arrived) goes to the server: see `reconcile`.
 *
 * Other pages show a change as it is made: the server tells every open page (`receiveSnapshot`), and another tab of the same
 * origin is also heard through the storage event. What the page shows is repainted by whoever subscribed (`onPrefsChanged`).
 */

const DEBOUNCE_MS = 250;
const JSON_POST = { "content-type": "application/json", "x-omp-webui": "1" };

/** Changes not yet acknowledged by the server; a newer choice of a key replaces an older one. */
const pending = new Map<PrefKey, string | null>();
/** The keys of the request on its way: the answer to an older request must not undo them. */
const inflight = new Set<PrefKey>();
let started = false;
/** The page has met the server's copy (the start-up merge is done): from here on the server's word is taken live. */
let synced = false;
/** The newest store state this page has taken in; an older one, arriving late, is ignored. */
let seen: { id: string; rev: number } | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let chain: Promise<void> = Promise.resolve();

type Listener = (keys: PrefKey[]) => void;
const changeListeners = new Set<Listener>();

/** Be told which preferences changed under the page (another tab or window chose them): re-read them from localStorage. */
export function onPrefsChanged(fn: Listener): () => void {
	changeListeners.add(fn);
	return () => changeListeners.delete(fn);
}

function announce(keys: PrefKey[]): void {
	if (keys.length > 0) for (const fn of changeListeners) fn(keys);
}

/** Remember a preference (null forgets it): in localStorage now, on the server shortly. */
export function setPref(key: PrefKey, value: string | null): void {
	if (value === null) localStorage.removeItem(key);
	else localStorage.setItem(key, value);
	pending.set(key, value);
	if (started && timer === undefined) {
		timer = setTimeout(() => {
			timer = undefined;
			void flushPrefs();
		}, DEBOUNCE_MS);
	}
}

/** localStorage as the code that keeps its own record in it (the star prompt) wants it, with every write kept. */
export const prefStorage: Pick<Storage, "getItem" | "setItem"> = {
	getItem: (key) => localStorage.getItem(key),
	setItem: (key, value) => (isPrefKey(key) ? setPref(key, value) : localStorage.setItem(key, value)),
};

/** This origin now holds exactly what the server does: say so, so that the next visit knows it need not take the server's word. */
function markIfCurrent(snapshot: PrefsSnapshot): void {
	if (pending.size === 0 && PREF_KEYS.every((k) => localStorage.getItem(k) === snapshot.values[k])) {
		localStorage.setItem(PREFS_SYNC_KEY, syncMarker(snapshot));
	}
}

async function send(keepalive: boolean): Promise<void> {
	if (pending.size === 0) return;
	// What the server would refuse is not sent: one such key would take the whole request down with it.
	const changes: PrefsChanges = Object.fromEntries(
		[...pending].filter(([k, v]) => v === null || (v.length <= MAX_PREF_LENGTH && isValidPref(k, v))),
	);
	pending.clear();
	if (Object.keys(changes).length === 0) return;
	for (const k of Object.keys(changes)) inflight.add(k as PrefKey);
	try {
		const res = await fetch("/api/prefs", {
			method: "POST",
			headers: JSON_POST,
			body: JSON.stringify({ changes }),
			keepalive,
		});
		// A refusal is final (the page asked for something the server does not keep); only a lost connection is retried.
		if (res.ok) {
			const snapshot = (await res.json()) as PrefsSnapshot;
			inflight.clear();
			// What other pages changed meanwhile is in the answer too.
			receiveSnapshot(snapshot);
			markIfCurrent(snapshot);
		}
	} catch {
		// Back in the queue for the next attempt, unless a newer choice of the same key is already there.
		for (const [key, value] of Object.entries(changes) as [PrefKey, string | null][]) {
			if (!pending.has(key)) pending.set(key, value);
		}
	} finally {
		inflight.clear();
	}
}

/**
 * Send what is waiting; requests go one after another, so the server sees changes in the order they were made. `keepalive`
 * lets the request outlive a page that is closing.
 */
export function flushPrefs(keepalive = false): Promise<void> {
	clearTimeout(timer);
	timer = undefined;
	chain = chain.then(() => send(keepalive));
	return chain;
}

function injectedSnapshot(): PrefsSnapshot | null {
	try {
		const text = document.getElementById(PREFS_ELEMENT_ID)?.textContent;
		return text ? (JSON.parse(text) as PrefsSnapshot) : null;
	} catch {
		return null;
	}
}

/** The server's preferences when the page was not served with them (the dev server's page). */
async function fetchSnapshot(): Promise<PrefsSnapshot | null> {
	try {
		const res = await fetch("/api/prefs");
		return res.ok ? ((await res.json()) as PrefsSnapshot) : null;
	} catch {
		return null;
	}
}

const localValues = (): PrefsSnapshot["values"] =>
	Object.fromEntries(PREF_KEYS.map((k) => [k, localStorage.getItem(k)])) as PrefsSnapshot["values"];

function writeLocal(changes: PrefsChanges): PrefKey[] {
	const changed: PrefKey[] = [];
	for (const [key, value] of Object.entries(changes) as [PrefKey, string | null][]) {
		if (localStorage.getItem(key) === value) continue;
		if (value === null) localStorage.removeItem(key);
		else localStorage.setItem(key, value);
		changed.push(key);
	}
	return changed;
}

/**
 * The server's copy as another page (or this page's own request) left it: take it in, key by key, except what this page
 * has chosen and the server has not heard yet. Older than what was seen is ignored; a store this page never met (a data dir
 * that was replaced under it) is merged as at start-up, so that this page's own choices are not wiped by it.
 */
export function receiveSnapshot(snapshot: PrefsSnapshot): void {
	if (!synced) return;
	if (seen?.id === snapshot.id) {
		if (snapshot.rev <= seen.rev) return;
		seen = { id: snapshot.id, rev: snapshot.rev };
		const take: PrefsChanges = {};
		for (const key of PREF_KEYS) {
			if (!pending.has(key) && !inflight.has(key)) take[key] = snapshot.values[key];
		}
		announce(writeLocal(take));
	} else {
		seen = { id: snapshot.id, rev: snapshot.rev };
		const { adopt, upload } = reconcile(snapshot, null, localValues());
		announce(writeLocal(adopt));
		for (const [key, value] of Object.entries(upload) as [PrefKey, string | null][]) {
			if (!pending.has(key)) pending.set(key, value);
		}
		if (pending.size > 0) void flushPrefs();
	}
	markIfCurrent(snapshot);
}

/** Ask the server what it holds now and show it: for when no one told this page (it was asleep, the connection was down). */
export async function refreshPrefs(): Promise<void> {
	const snapshot = await fetchSnapshot();
	if (snapshot) receiveSnapshot(snapshot);
}

/** Another tab of this origin changed a preference: localStorage already holds it, so only what is shown is left to do. */
function onStorage(e: StorageEvent): void {
	if (e.storageArea && e.storageArea !== localStorage) return;
	const keys = e.key === null ? [...PREF_KEYS] : isPrefKey(e.key) ? [e.key] : [];
	// That tab's choice is the newer one; this page's unsent edit of the same key is older.
	for (const key of keys) pending.delete(key);
	announce(keys);
}

/**
 * Start keeping the server's copy in step with this origin's. Once per page; the page does not wait for it.
 * `web/index.html` has already applied the server's values where the server put them into the page.
 */
export async function startPrefsSync(): Promise<void> {
	if (started) return;
	started = true;
	addEventListener("pagehide", () => void flushPrefs(true));
	addEventListener("storage", onStorage as (e: Event) => void);
	document.addEventListener("visibilitychange", () => {
		if (document.visibilityState === "hidden") void flushPrefs(true);
	});
	const snapshot = injectedSnapshot() ?? (await fetchSnapshot());
	if (!snapshot) return;
	// A value no part of the app ever writes (an older build's, or a hand edit) is dropped, so that it shows as the default
	// and does not make the server refuse what is sent with it.
	const stale: PrefsChanges = {};
	for (const key of PREF_KEYS) {
		const value = localStorage.getItem(key);
		if (value !== null && !isValidPref(key, value)) stale[key] = null;
	}
	const dropped = writeLocal(stale);
	const { adopt, upload } = reconcile(snapshot, localStorage.getItem(PREFS_SYNC_KEY), localValues());
	// Already so where the page carried the snapshot; on a page that did not, the values show now.
	announce([...dropped, ...writeLocal(adopt)]);
	for (const [key, value] of Object.entries(upload) as [PrefKey, string | null][]) {
		if (!pending.has(key)) pending.set(key, value);
	}
	seen = { id: snapshot.id, rev: snapshot.rev };
	synced = true;
	if (pending.size > 0) await flushPrefs();
	else markIfCurrent(snapshot);
}
