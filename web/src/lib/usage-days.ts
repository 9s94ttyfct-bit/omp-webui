/**
 * Days on which the user sent a message, the measure of sustained use behind the GitHub star prompt.
 * Everything takes the clock and the storage as parameters; the app passes `Date.now()` and `prefStorage`.
 */

import { PREF } from "@shared/prefs.ts";
import { prefStorage } from "./prefs.ts";

export interface KeyValueStorage {
	getItem(key: string): string | null;
	setItem(key: string, value: string): void;
}

const DAYS_KEY = PREF.usageDays;
const STAR_KEY = PREF.star;

/** Distinct days with a sent message after which the prompt may show. */
export const STAR_AFTER_DAYS = 5;
/** "Not now" hides the prompt this long. */
export const STAR_SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;
/** A lookup that could not tell whether the repository is public is made again after this long. */
export const STAR_LOOKUP_RETRY_MS = 24 * 60 * 60 * 1000;
/** Days kept: enough to count to the threshold, bounded so storage never grows. */
const KEEP_DAYS = 60;

/** The calendar day (local time) of `ms`, `2026-10-18`. */
export function dayKey(ms: number): string {
	const d = new Date(ms);
	const two = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
}

function read(storage: KeyValueStorage, key: string): unknown {
	try {
		return JSON.parse(storage.getItem(key) ?? "null");
	} catch {
		return null;
	}
}

/** The recorded days, oldest first; anything in storage that is not a day is ignored. */
export function usageDays(storage: KeyValueStorage): string[] {
	const raw = read(storage, DAYS_KEY);
	if (!Array.isArray(raw)) return [];
	const days = raw.filter((d): d is string => typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d));
	return [...new Set(days)].sort();
}

/** A message was sent at `now`: count its day. Returns whether the count changed. */
export function recordUsageDay(storage: KeyValueStorage, now: number): boolean {
	const days = usageDays(storage);
	const today = dayKey(now);
	if (days.includes(today)) return false;
	try {
		storage.setItem(DAYS_KEY, JSON.stringify([...days, today].sort().slice(-KEEP_DAYS)));
	} catch {
		return false;
	}
	return true;
}

/** What the user answered the prompt: never again, or not now (until `until`). */
export type StarAnswer = { never: true } | { until: number };

function starAnswer(storage: KeyValueStorage): StarAnswer | null {
	const raw = read(storage, STAR_KEY);
	if (typeof raw !== "object" || raw === null) return null;
	if ("never" in raw && raw.never === true) return { never: true };
	return "until" in raw && typeof raw.until === "number" && Number.isFinite(raw.until) ? { until: raw.until } : null;
}

export function answerStarPrompt(storage: KeyValueStorage, answer: StarAnswer): void {
	try {
		storage.setItem(STAR_KEY, JSON.stringify(answer));
	} catch {
		// Not remembered: the prompt may come back on a later visit.
	}
}

/** Whether the user's own history allows the prompt: enough days, and not told to stop or wait. */
export function starPromptDue(storage: KeyValueStorage, now: number): boolean {
	if (usageDays(storage).length < STAR_AFTER_DAYS) return false;
	const answer = starAnswer(storage);
	if (!answer) return true;
	return !("never" in answer) && now >= answer.until;
}

/** Whether the user wants to be asked at all: Settings and "Don't ask again" share this one answer. */
export function starPromptEnabled(storage: KeyValueStorage): boolean {
	return !("never" in (starAnswer(storage) ?? {}));
}

/** Settings: ask again (as if the last "Not now" had run out), or never ask and so never look the repository up. */
export function setStarPromptEnabled(storage: KeyValueStorage, enabled: boolean): void {
	answerStarPrompt(storage, enabled ? { until: 0 } : { never: true });
}

/** What the page's last lookup of the repository's visibility found, and when; `public: null` means it could not tell. */
export interface RepoLookup {
	public: boolean | null;
	at: number;
}

/** Whether the page should ask the server now: never asked yet, or the last try could not tell and a day has passed. */
export function starLookupWanted(last: RepoLookup | null, now: number): boolean {
	return last === null || (last.public === null && now - last.at >= STAR_LOOKUP_RETRY_MS);
}

/** The prompt shows only when it is due and the repository is public (a private repository has nothing to star). */
export function showStarPrompt(storage: KeyValueStorage, now: number, repoPublic: boolean): boolean {
	return repoPublic && starPromptDue(storage, now);
}

/** Pages that show the prompt listen here; the storage event covers another tab. */
const listeners = new Set<() => void>();

export function onUsageChange(fn: () => void): () => void {
	listeners.add(fn);
	const onStorage = (e: StorageEvent) => (e.key === DAYS_KEY || e.key === STAR_KEY) && fn();
	window.addEventListener("storage", onStorage);
	return () => {
		listeners.delete(fn);
		window.removeEventListener("storage", onStorage);
	};
}

/** A message was sent: count today and tell the listeners if it was a new day. */
export function noteMessageSent(): void {
	// Counting must never break sending: storage may be blocked or absent.
	try {
		if (recordUsageDay(prefStorage, Date.now())) for (const fn of listeners) fn();
	} catch {}
}

/** The user answered the prompt here: remember it and tell the listeners. */
export function answerStar(answer: StarAnswer): void {
	answerStarPrompt(prefStorage, answer);
	for (const fn of listeners) fn();
}

/** Settings turned the prompt on or off here: remember it and tell the listeners. */
export function setStarPrompt(enabled: boolean): void {
	setStarPromptEnabled(prefStorage, enabled);
	for (const fn of listeners) fn();
}
