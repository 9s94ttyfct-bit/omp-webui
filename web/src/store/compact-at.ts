import type { CompactAt, CompactSettings } from "@shared/compact-at.ts";
import { useEffect } from "react";
import { create } from "zustand";
import { type CompactAtState, sessionActions } from "../lib/api.ts";
import { socket } from "../lib/ws.ts";

/**
 * Where a conversation compacts ("Compact at": omp's `compaction.thresholdPercent` / `thresholdTokens`) — omp's own
 * default and the point single conversations chose. The server reads omp's value from omp itself, so this is a copy:
 * loaded when something first shows it, loaded again when omp's config.yml changes (`model_config_changed`: a change made
 * in the terminal, or by another tab) and after a reconnect. A conversation's own point is its overlay's, which omp
 * reloads by itself, so a change applies from its next turn.
 */
interface State {
	/** omp's own settings for the point; undefined until the server has said, null when omp could not be asked. */
	omp: CompactSettings | null | undefined;
	/** The point chosen for a conversation, by session file; null: it follows omp's. Absent until the server has said. */
	sessions: Record<string, CompactAt | null>;
}

const useStore = create<State>(() => ({ omp: undefined, sessions: {} }));

let following = false;
/** How many places show each file's point right now: those files are asked again together with omp's value. */
const shown = new Map<string, number>();

function load(file: string | null): void {
	void sessionActions
		.compactAt(file)
		.then((r) =>
			useStore.setState((s) => ({
				omp: r.omp,
				sessions: file === null ? s.sessions : { ...s.sessions, [file]: r.session },
			})),
		)
		.catch(() => {});
}

function reload(): void {
	load(null);
	for (const file of shown.keys()) load(file);
}

function follow(): void {
	if (following) return;
	following = true;
	socket.on((msg) => {
		if (msg.t === "model_config_changed") reload();
	});
	socket.onStatus((connected) => connected && reload());
}

/**
 * Show omp's own point, and the point chosen for `file` (null: only omp's), and keep both true until the returned
 * function is called: while shown they are asked again after a reconnect and a change of omp's config.
 */
export function watchCompactAt(file: string | null): () => void {
	follow();
	load(file);
	if (file === null) return () => {};
	shown.set(file, (shown.get(file) ?? 0) + 1);
	return () => {
		const left = (shown.get(file) ?? 1) - 1;
		if (left > 0) shown.set(file, left);
		else shown.delete(file);
	};
}

/** omp's own point and the one chosen for `file` (null while none is shown). `loaded`: the server has answered. */
export function useCompactAt(file: string | null): {
	loaded: boolean;
	omp: CompactSettings | null;
	session: CompactAt | null;
} {
	useEffect(() => watchCompactAt(file), [file]);
	const omp = useStore((s) => s.omp);
	const session = useStore((s) => (file === null ? undefined : s.sessions[file]));
	return {
		loaded: omp !== undefined && (file === null || session !== undefined),
		omp: omp ?? null,
		session: session ?? null,
	};
}

/** Show `next` at once and keep the server's answer instead when it comes; a refusal puts the old state back and throws. */
async function change(
	next: (s: State) => State,
	ask: () => Promise<CompactAtState>,
	file: string | null,
): Promise<void> {
	const before = useStore.getState();
	useStore.setState(next(before));
	try {
		const r = await ask();
		useStore.setState((s) => ({
			omp: r.omp,
			sessions: file === null ? s.sessions : { ...s.sessions, [file]: r.session },
		}));
	} catch (e) {
		useStore.setState(before);
		throw e;
	}
}

/** Set omp's own point, as `omp config set` does; null: omp's default again. */
export function setCompactAtDefault(at: CompactAt | null): Promise<void> {
	return change(
		(s) => ({
			...s,
			omp: at
				? { percent: "percent" in at ? at.percent : -1, tokens: "tokens" in at ? at.tokens : -1 }
				: { percent: -1, tokens: -1 },
		}),
		() => sessionActions.setCompactAt(at),
		null,
	);
}

/** `at` null: the conversation follows omp's configuration again. */
export function setConversationCompactAt(file: string, at: CompactAt | null): Promise<void> {
	return change(
		(s) => ({ ...s, sessions: { ...s.sessions, [file]: at } }),
		() => sessionActions.setSessionCompactAt(file, at),
		file,
	);
}
