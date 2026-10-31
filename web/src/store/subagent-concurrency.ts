import { useEffect } from "react";
import { create } from "zustand";
import { type ConcurrencyState, sessionActions } from "../lib/api.ts";
import { socket } from "../lib/ws.ts";

/**
 * How many subagents run at once ("Parallel subagents": omp's `task.maxConcurrency`) — omp's own value and the limits single
 * conversations chose. The server reads omp's value from omp itself, so this is a copy: loaded when something first shows
 * it, loaded again when omp's config.yml changes (`model_config_changed`: a change made in the terminal, or by another tab)
 * and after a reconnect. A conversation's own limit is its overlay's, which omp reloads by itself, so a change applies to
 * the next subagent that starts.
 */
interface State {
	/** omp's own value (`0`: no limit); undefined until the server has said, null when omp could not be asked. */
	omp: number | null | undefined;
	/** The limit chosen for a conversation, by session file; null: it follows omp's. Absent until the server has said. */
	sessions: Record<string, number | null>;
}

const useStore = create<State>(() => ({ omp: undefined, sessions: {} }));

let following = false;
/** How many places show each file's limit right now: those files are asked again together with omp's value. */
const shown = new Map<string, number>();

function load(file: string | null): void {
	void sessionActions
		.concurrency(file)
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

/** Show omp's own limit, and the one chosen for `file` (null: only omp's), and keep both true while shown. */
function watchConcurrency(file: string | null): () => void {
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

/** omp's own limit and the one chosen for `file` (null while none is shown). `loaded`: the server has answered. */
export function useConcurrency(file: string | null): { loaded: boolean; omp: number | null; session: number | null } {
	useEffect(() => watchConcurrency(file), [file]);
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
	ask: () => Promise<ConcurrencyState>,
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

/** Set omp's own limit, as `omp config set` does (`0`: no limit); null: omp's default again, which the server reads back. */
export function setConcurrencyDefault(limit: number | null): Promise<void> {
	return change(
		(s) => (limit === null ? s : { ...s, omp: limit }),
		() => sessionActions.setConcurrency(limit),
		null,
	);
}

/** `limit` null: the conversation follows omp's configuration again. */
export function setConversationConcurrency(file: string, limit: number | null): Promise<void> {
	return change(
		(s) => ({ ...s, sessions: { ...s.sessions, [file]: limit } }),
		() => sessionActions.setSessionConcurrency(file, limit),
		file,
	);
}
