import type { HostDisk } from "@shared/host.ts";
import { PREF } from "@shared/prefs.ts";
import { useSyncExternalStore } from "react";
import { onPrefsChanged, setPref } from "./prefs.ts";

/**
 * Which disks the host load pane shows (#613): the preference `ompw.hostDisks`, a JSON list of disk ids (mount points), read
 * as everything reads a preference (`localStorage`, kept in step with the server by `lib/prefs.ts`). None chosen (unset, an
 * empty list, or a value from another version) is every disk in the pane, and the system's disk on the sidebar's line.
 * Imported only by the lazy chunks of the pane, of the sidebar's line and of the card in Settings.
 */

const changed = new Set<() => void>();

/** The ids a stored value names; anything that is not a list of strings is none (every disk). */
export function hostDisksOf(v: string | null): string[] {
	try {
		const parsed: unknown = JSON.parse(v ?? "[]");
		return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
	} catch {
		return [];
	}
}

/** The stored value, as it is (`useSyncExternalStore` compares it: a string, not a new list each time). */
const stored = (): string => localStorage.getItem(PREF.hostDisks) ?? "";

/** Choose the disks (none: every disk); remembered here and on the server (`setPref`), and every reader told. */
export function setHostDisks(ids: readonly string[]): void {
	setPref(PREF.hostDisks, ids.length ? JSON.stringify(ids) : null);
	for (const fn of changed) fn();
}

function subscribe(fn: () => void): () => void {
	changed.add(fn);
	const stop = onPrefsChanged((keys) => keys.includes(PREF.hostDisks) && fn());
	return () => {
		changed.delete(fn);
		stop();
	};
}

/** The chosen ids now (empty: every disk); the component draws again only when the choice changes. */
export function useHostDisks(): string[] {
	return hostDisksOf(useSyncExternalStore(subscribe, stored, () => "") || null);
}

/** The disks a pane shows of `disks`: the chosen ones, or every one when none is chosen. */
export function shownDisks<D extends Pick<HostDisk, "id">>(disks: readonly D[], chosen: readonly string[]): D[] {
	return chosen.length === 0 ? [...disks] : disks.filter((d) => chosen.includes(d.id));
}

/**
 * The disks the sidebar's line tells the free space of: the chosen ones, or, when none is chosen, the system's disk only
 * (`/`, Windows' `C:\`; else the one that holds omp-webui's data; else the first listed). None when the server lists none.
 */
export function lineDisks<D extends Pick<HostDisk, "id">>(
	disks: readonly D[],
	chosen: readonly string[],
	dataDisk: string | null,
): D[] {
	if (chosen.length > 0) return shownDisks(disks, chosen);
	const system =
		disks.find((d) => d.id === "/") ??
		disks.find((d) => /^c:\\?$/i.test(d.id)) ??
		disks.find((d) => d.id === dataDisk) ??
		disks[0];
	return system ? [system] : [];
}
