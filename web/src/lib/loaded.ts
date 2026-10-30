import type { LoadedCommand, LoadedData, LoadedMcpServer, LoadedTool } from "@shared/loaded.ts";
import { useEffect, useRef, useState } from "react";
import { create } from "zustand";

/** Where `/api/loaded` is asked: the conversation's running process, else its saved file. */
export interface LoadedTarget {
	liveId: string | null;
	file: string | null;
	/** The process is frozen: the server answers without asking it. */
	paused?: boolean;
}

/** Cache and request key of a conversation, or null when there is nothing to ask about. */
export function loadedKey({ liveId, file, paused }: LoadedTarget): string | null {
	// A paused process answers as no process does, so what is cached for it is not what its running self gave.
	if (liveId) return `live:${liveId}${paused ? ":paused" : ""}`;
	return file ? `file:${file}` : null;
}

export async function fetchLoaded(target: LoadedTarget): Promise<LoadedData> {
	const query = new URLSearchParams();
	if (target.liveId) query.set("live", target.liveId);
	if (target.file) query.set("file", target.file);
	const res = await fetch(`/api/loaded?${query}`);
	const body = await res.json().catch(() => ({}));
	if (!res.ok) throw new Error(body.error ?? res.statusText);
	return body as LoadedData;
}

/** The last answer for each conversation: shown at once when the dialog is opened again, while a fresh one is fetched. */
const answers = new Map<string, LoadedData>();
const KEPT_ANSWERS = 8;

/**
 * What a conversation has loaded; asked again whenever the conversation changes or `refresh` is called. `refresh`
 * resolves once the answer to it (or to a later one, when it is superseded) is on screen, or the dialog has gone.
 */
export function useLoaded(target: LoadedTarget) {
	const { liveId, file } = target;
	const key = loadedKey(target);
	const [data, setData] = useState<LoadedData | null>(() => (key ? (answers.get(key) ?? null) : null));
	const [error, setError] = useState<string | null>(null);
	const [loading, setLoading] = useState(false);
	const [round, setRound] = useState(0);
	const waiting = useRef<(() => void)[]>([]);
	const settle = () => {
		for (const done of waiting.current.splice(0)) done();
	};
	// biome-ignore lint/correctness/useExhaustiveDependencies: `round` only asks again.
	useEffect(() => {
		setData(key ? (answers.get(key) ?? null) : null);
		setError(null);
		if (!key) {
			settle();
			return;
		}
		let current = true;
		setLoading(true);
		fetchLoaded({ liveId, file })
			.then((fresh) => {
				answers.delete(key);
				answers.set(key, fresh);
				for (const old of [...answers.keys()].slice(0, -KEPT_ANSWERS)) answers.delete(old);
				if (current) setData(fresh);
			})
			.catch((e: Error) => current && setError(e.message))
			.finally(() => {
				if (!current) return;
				setLoading(false);
				settle();
			});
		return () => {
			current = false;
		};
	}, [key, liveId, file, round]);
	// Whoever still waits when the dialog goes has nothing left to wait for.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `settle` only drains a ref.
	useEffect(() => settle, []);
	return {
		data,
		error,
		loading,
		refresh: () =>
			new Promise<void>((resolve) => {
				waiting.current.push(resolve);
				setRound((n) => n + 1);
			}),
	};
}

/** Whether the Loaded dialog is open; its header button, the ⋯ menu and `/status`, `/extensions`, `/skills` open it. */
export const useLoadedDialog = create<{ open: boolean }>(() => ({ open: false }));

export function openLoaded(): void {
	useLoadedDialog.setState({ open: true });
}

// ------------------------------------------------------------------ filtering

/** Whether any of `texts` contains `query` (already trimmed and lowercased); an empty query matches everything. */
export function matchesQuery(query: string, ...texts: (string | null | undefined)[]): boolean {
	return !query || texts.some((t) => t?.toLowerCase().includes(query));
}

export function toolMatches(query: string, t: LoadedTool): boolean {
	return matchesQuery(query, t.name, t.label, t.description);
}

/** A server is shown when it, or any tool it provides, matches. */
export function serverMatches(query: string, s: LoadedMcpServer): boolean {
	return matchesQuery(query, s.name, s.target, s.transport) || s.tools.some((t) => toolMatches(query, t));
}

/** The order the sources of slash commands are listed in; any other source follows, by name. */
const SOURCE_ORDER = ["builtin", "extension", "custom", "file"];

/** Commands grouped by `source`, the known sources first. */
export function commandsBySource(commands: LoadedCommand[]): [string, LoadedCommand[]][] {
	const groups = new Map<string, LoadedCommand[]>();
	for (const c of commands) {
		const group = groups.get(c.source);
		if (group) group.push(c);
		else groups.set(c.source, [c]);
	}
	const rank = (source: string) => {
		const i = SOURCE_ORDER.indexOf(source);
		return i < 0 ? SOURCE_ORDER.length : i;
	};
	return [...groups].sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b));
}
